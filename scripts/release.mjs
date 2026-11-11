#!/usr/bin/env node
/**
 * DSH plugin release script (zero dependencies, Node >= 22)
 * ---------------------------------------------------------------------------
 * Goal: make "release discipline" a hard gate inside the script instead of
 * something a human has to remember.
 *
 *   semver check/bump  →  git tag  →  npm publish --tag  →  aggregate sync  →  write CHANGELOG
 *
 * Core rules (the script refuses a non-compliant release):
 *   - a patch release only carries fixes, never breaking changes
 *   - 0.x phase: breaking → minor (^0.2.0 == >=0.2.0 <0.3.0, never crosses a minor)
 *   1.x+ phase: breaking → major
 *   features → minor; fixes → patch
 *
 * Usage (dry-run by default; only an explicit --publish writes to the registry):
 *   node scripts/release.mjs --bump auto                 # preview
 *   node scripts/release.mjs --bump auto --publish       # release for real
 *   node scripts/release.mjs --version 0.3.0 --publish
 *   node scripts/release.mjs --pre rc --bump minor --publish   # publish 0.3.0-rc.1 (dist-tag next)
 *   node scripts/release.mjs --line 0.1 --bump patch --publish # maintenance line: dist-tag 0-1
 *   node scripts/release.mjs --deprecate 0.2.1 "serious bug, please upgrade to 0.2.2"
 *   node scripts/release.mjs --check                     # validation only, for CI / before release
 *
 * Exit code: 0 success / 1 failure (including discipline violations and failed checks)
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

// ---------------------------------------------------------------------------
// 0. Infrastructure
// ---------------------------------------------------------------------------

const C = process.stdout.isTTY
  ? { r: '\x1b[31m', g: '\x1b[32m', y: '\x1b[33m', b: '\x1b[36m', d: '\x1b[2m', x: '\x1b[0m' }
  : { r: '', g: '', y: '', b: '', d: '', x: '' };

const log = (...a) => process.stdout.write(a.join(' ') + '\n');
const info = (m) => log(`${C.b}▸${C.x} ${m}`);
const ok = (m) => log(`${C.g}✓${C.x} ${m}`);
const warn = (m) => log(`${C.y}!${C.x} ${m}`);
const bad = (m) => log(`${C.r}✗${C.x} ${m}`);
const dim = (m) => log(`${C.d}  ${m}${C.x}`);

class Abort extends Error {}
const die = (m) => {
  throw new Abort(m);
};

/** Run a command; with throwOnFail=false it returns {code, stdout, stderr} instead of throwing. */
function sh(cmd, args, { cwd = process.cwd(), env = {}, throwOnFail = true, quiet = false } = {}) {
  const r = spawnSync(cmd, args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, ...env },
    stdio: quiet ? ['ignore', 'pipe', 'pipe'] : ['ignore', 'pipe', 'pipe'],
  });
  if (r.error) {
    if (throwOnFail) die(`Cannot run \`${cmd}\`: ${r.error.message}`);
    return { code: 127, stdout: '', stderr: r.error.message };
  }
  const out = { code: r.status ?? 1, stdout: (r.stdout ?? '').trim(), stderr: (r.stderr ?? '').trim() };
  if (out.code !== 0 && throwOnFail) die(`\`${cmd} ${args.join(' ')}\` failed (exit ${out.code})\n${out.stderr || out.stdout}`);
  return out;
}
const trySh = (cmd, args, opts) => sh(cmd, args, { ...opts, throwOnFail: false });

// ---------------------------------------------------------------------------
// 1. Minimal semver implementation (no dependencies)
// ---------------------------------------------------------------------------

const SEMVER_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?(?:\+([0-9A-Za-z.-]+))?$/;

function parseSemver(v) {
  const m = SEMVER_RE.exec(String(v || '').trim());
  if (!m) return null;
  return {
    raw: String(v).trim(),
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3]),
    prerelease: m[4] ? m[4].split('.') : [],
  };
}

const cmpPre = (a, b) => {
  if (a.length === 0 && b.length === 0) return 0;
  if (a.length === 0) return 1; // a stable release sorts above a prerelease
  if (b.length === 0) return -1;
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i], y = b[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const xn = /^\d+$/.test(x), yn = /^\d+$/.test(y);
    if (xn && yn) {
      if (Number(x) !== Number(y)) return Number(x) < Number(y) ? -1 : 1;
    } else if (xn !== yn) {
      return xn ? -1 : 1;
    } else if (x !== y) {
      return x < y ? -1 : 1;
    }
  }
  return 0;
};

function compareSemver(a, b) {
  const A = parseSemver(a), B = parseSemver(b);
  if (!A || !B) die(`Cannot compare invalid versions: ${a} / ${b}`);
  for (const k of ['major', 'minor', 'patch']) if (A[k] !== B[k]) return A[k] < B[k] ? -1 : 1;
  return cmpPre(A.prerelease, B.prerelease);
}

function incSemver(v, kind) {
  const p = parseSemver(v);
  if (!p) die(`Invalid current version: ${v}`);
  if (kind === 'major') return `${p.major + 1}.0.0`;
  if (kind === 'minor') return `${p.major}.${p.minor + 1}.0`;
  if (kind === 'patch') return `${p.major}.${p.minor}.${p.patch + 1}`;
  die(`Unknown bump kind: ${kind}`);
}

/** `base` looks like 0.3.0; `current` like 0.3.0-rc.2 → rc.3, otherwise rc.1. */
const nextPreNumber = (current, base) => {
  const p = parseSemver(current);
  if (p && `${p.major}.${p.minor}.${p.patch}` === base && p.prerelease.length >= 2) {
    const n = Number(p.prerelease[p.prerelease.length - 1]);
    if (Number.isFinite(n)) return n + 1;
  }
  return 1;
};

// ---------------------------------------------------------------------------
// 2. Argument parsing
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const o = {
    bump: null, version: null, pre: null, tag: null, line: null,
    publish: false, check: false, yes: false, json: false,
    skipGit: false, skipNpm: false, skipAggregates: false, skipChangelog: false,
    deprecate: null, allowDirty: false, branch: null, remote: 'origin',
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const need = () => {
      const v = argv[++i];
      if (v === undefined) die(`Argument ${a} needs a value`);
      return v;
    };
    switch (a) {
      case '--bump': o.bump = need(); break;
      case '--version': case '-v': o.version = need(); break;
      case '--pre': case '--prerelease': o.pre = need(); break;
      case '--tag': o.tag = need(); break;
      case '--line': o.line = need(); break;
      case '--publish': o.publish = true; break;
      case '--dry-run': o.publish = false; break;
      case '--check': case '--verify': o.check = true; break;
      case '--yes': case '-y': o.yes = true; break;
      case '--json': o.json = true; break;
      case '--skip-git': o.skipGit = true; break;
      case '--skip-npm': o.skipNpm = true; break;
      case '--skip-aggregates': o.skipAggregates = true; break;
      case '--skip-changelog': o.skipChangelog = true; break;
      case '--allow-dirty': o.allowDirty = true; break;
      case '--branch': o.branch = need(); break;
      case '--remote': o.remote = need(); break;
      case '--deprecate': {
        const v = need();
        const m = argv[++i];
        if (m === undefined) die('--deprecate needs two arguments: <version> "<reason>"');
        o.deprecate = { version: v, message: m };
        break;
      }
      case '--help': case '-h': o.help = true; break;
      default:
        if (a.startsWith('--')) die(`Unknown argument: ${a} (see --help)`);
    }
  }
  return o;
}

const HELP = `
DSH plugin release script (dry-run by default; --publish actually releases)

  Version
    --bump <auto|patch|minor|major>   derive the bump from commits (auto = read conventional commits)
    --version <x.y.z>                 set the target version directly
    --pre <rc|beta|alpha>             publish a prerelease, e.g. --pre rc → 0.2.1-rc.1 (dist-tag next by default)
    --line <x.y>                      maintenance-line release (e.g. 0.1), dist-tag 0-1 by default

  Dist-tag
    --tag <name>                      npm dist-tag (default: stable → latest, prerelease → next)

  Actions
    --publish                         actually run (preview only otherwise)
    --check                           run the pre-release checks only (for CI)
    --deprecate <ver> "<msg>"         deprecate a published version (publishes nothing)
    --yes                             skip the interactive confirmation

  Skipping
    --skip-git / --skip-npm / --skip-aggregates / --skip-changelog / --allow-dirty
    --branch <name>                   release branch (defaults to the current branch)
    --remote <name>                   git remote (default origin)
    --json                            machine-readable output
`;

// ---------------------------------------------------------------------------
// 3. Repository context
// ---------------------------------------------------------------------------

function readJson(p) {
  try { return JSON.parse(readFileSync(p, 'utf8')); } catch (e) { die(`Cannot parse ${p}: ${e.message}`); }
}

function loadContext(cwd) {
  const root = resolve(cwd);
  const pkgPath = join(root, 'package.json');
  if (!existsSync(pkgPath)) die(`No package.json in the current directory: ${root}`);
  const pkg = readJson(pkgPath);

  const cfgPath = join(root, 'release.config.json');
  const cfg = existsSync(cfgPath) ? readJson(cfgPath) : {};

  const changelogPath = join(root, 'CHANGELOG.md');
  const gitReady = existsSync(join(root, '.git')) && trySh('git', ['rev-parse', '--git-dir'], { cwd: root }).code === 0;

  return { root, pkg, pkgPath, cfg, changelogPath, gitReady };
}

const git = (ctx, args, opts = {}) => trySh('git', args, { cwd: ctx.root, ...opts }).stdout;

// ---------------------------------------------------------------------------
// 4. Commit analysis and version discipline
// ---------------------------------------------------------------------------

/** Commits since `since` (an empty `since` → the full history). */
function collectCommits(ctx, since) {
  const range = since ? `${since}..HEAD` : 'HEAD';
  const raw = git(ctx, ['log', range, '--no-merges', '--pretty=format:%s%x1f%b%x1e']);
  if (!raw) return [];
  return raw
    .split('\x1e')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((block) => {
      const [subject = '', body = ''] = block.split('\x1f');
      return { subject: subject.trim(), body: body.trim() };
    });
}

const HEADER_RE = /^(?<type>[a-z]+)(?:\((?<scope>[^)]*)\))?(?<bang>!)?:\s*(?<desc>.+)$/i;

function classifyCommits(commits) {
  const breaking = [], feat = [], fix = [], other = [];
  for (const c of commits) {
    const m = HEADER_RE.exec(c.subject);
    const isBreaking = Boolean(m?.groups?.bang) || /^BREAKING[ -]CHANGE:/im.test(c.body);
    if (isBreaking) breaking.push(c);
    else if (m?.groups?.type?.toLowerCase() === 'feat') feat.push(c);
    else if (m?.groups?.type?.toLowerCase() === 'fix') fix.push(c);
    else other.push(c);
  }
  return { breaking, feat, fix, other };
}

/**
 * Version discipline: derive the **minimum allowed** bump from the current
 * version and the nature of the changes.
 *   breaking: 0.x → minor; >=1.x → major
 *   feat:     minor
 *   other:    patch
 */
function requiredBump(currentVersion, changes) {
  const cur = parseSemver(currentVersion);
  if (!cur) die(`Invalid package.json version: ${currentVersion}`);
  if (changes.breaking.length > 0) return cur.major === 0 ? 'minor' : 'major';
  if (changes.feat.length > 0) return 'minor';
  return 'patch';
}

const RANK = { patch: 0, minor: 1, major: 2 };

/**
 * Check that the target version satisfies the discipline:
 *  - the target bump level must not be below `required` (a 0.x breaking change must go through minor)
 *  - a patch level may never contain a breaking change — the only case that really hurts ^x.y.z users
 */
function assertDiscipline(currentVersion, targetVersion, changes) {
  const cur = parseSemver(currentVersion);
  const tgt = parseSemver(targetVersion);
  if (!cur || !tgt) die('Invalid version numbers; cannot check the release discipline');
  if (compareSemver(targetVersion, currentVersion) <= 0) die(`Target version ${targetVersion} is not greater than the current version ${currentVersion}`);

  const req = requiredBump(currentVersion, changes);
  const curBase = `${cur.major}.${cur.minor}.${cur.patch}`;
  const tgtBase = `${tgt.major}.${tgt.minor}.${tgt.patch}`;

  // Prerelease: an unchanged base, or an increment consistent with `required`, is enough
  if (tgt.prerelease.length > 0) {
    const sameBase = tgtBase === curBase;
    const bumped = { major: tgt.major > cur.major, minor: tgt.major === cur.major && tgt.minor > cur.minor, patch: tgtBase === incSemver(curBase, 'patch') };
    if (sameBase) {
      // A prerelease of the same base rehearses a patch release of the next version; no breaking change may ride in it
      if (changes.breaking.length > 0) {
        die([
          `Breaking changes are not allowed inside a prerelease of the same base version (${curBase} → ${targetVersion}).`,
          `In the 0.x phase a breaking change must go through a minor: start at ${incSemver(curBase, 'minor')}-${(tgt.prerelease[0] || 'rc')}.1.`,
        ].join('\n'));
      }
      return { required: req, level: 'patch' };
    }
    if (req === 'major' && !bumped.major) die(`Breaking changes are present; this ${cur.major >= 1 ? 'must be a major' : 'must be a minor'} release: target ${targetVersion} is not enough`);
    if (req === 'minor' && !bumped.major && !bumped.minor) die(`There are ${changes.breaking.length ? 'breaking changes' : 'new features'}; this must be a minor release: target ${targetVersion} is not enough`);
    return { required: req, level: bumped.major ? 'major' : bumped.minor ? 'minor' : 'patch' };
  }

  if (changes.breaking.length > 0) {
    if (cur.major === 0 && !(tgt.major === 0 && tgt.minor > cur.minor)) {
      die([
        `Breaking changes must go through a minor (0.x phase): currently ${currentVersion}.`,
        `  Reason: ^${cur.major}.${cur.minor}.${cur.patch} means >=${cur.major}.${cur.minor}.${cur.patch} <${cur.major}.${cur.minor + 1}.0,`,
        `  so it never crosses a minor. With the breaking change in a minor, users staying on the old minor are not upgraded automatically.`,
        `  Suggested target: ${incSemver(currentVersion, 'minor')}`,
      ].join('\n'));
    }
    if (cur.major >= 1 && tgt.major === cur.major) {
      die(`Breaking changes must go through a major: currently ${currentVersion} → suggested ${incSemver(currentVersion, 'major')} (target ${targetVersion} is still ${cur.major}.x)`);
    }
  }
  if (changes.feat.length > 0 && tgt.major === cur.major && tgt.minor === cur.minor) {
    die(`There are new features, so this must be a minor release: currently ${currentVersion} → suggested ${incSemver(currentVersion, 'minor')} (target ${targetVersion} is only a patch)`);
  }

  const level = tgt.major > cur.major ? 'major' : tgt.minor > cur.minor ? 'minor' : 'patch';
  if (RANK[level] < RANK[req]) die(`Target version ${targetVersion} is a ${level} release, below the level the discipline requires (${req})`);
  return { required: req, level };
}

// ---------------------------------------------------------------------------
// 5. Pre-release checks
// ---------------------------------------------------------------------------

function npmView(pkgName, field) {
  const r = trySh('npm', ['view', `${pkgName}@${field}`, '--json'], { quiet: true });
  if (r.code !== 0) return null;
  try { return JSON.parse(r.stdout); } catch { return r.stdout || null; }
}

function checkCompatDeclarations(ctx) {
  const issues = [];
  const notes = [];
  const pkg = ctx.pkg;

  if (!pkg.dsh?.engines?.dsh) {
    issues.push('Missing `dsh.engines.dsh` (the ecosystem convention; dshmarket actually reads the peer union, but both must be present)');
  } else {
    notes.push(`dsh.engines.dsh = ${pkg.dsh.engines.dsh}`);
  }

  const peers = Object.entries(pkg.peerDependencies || {}).filter(([n]) => n.startsWith('@deepseek-ai/dsh'));
  if (peers.length === 0) issues.push('Missing the `@deepseek-ai/dsh*` peerDependencies (the plugin marketplace computes the compatibility range from them)');
  else notes.push(`peer compatibility declarations (${peers.length}): ${peers.map(([n, v]) => `${n}@${v}`).join(', ')}`);

  if (!pkg.engines?.node) issues.push('Missing `engines.node` (an incompatible Node version should fail at install time instead of breaking silently)');

  const files = pkg.files || [];
  if (!files.includes('CHANGELOG.md')) issues.push('`files` does not include CHANGELOG.md (the changelog would not be in the tarball)');
  // The distribution directory must be covered by `files`. The traditional layout is `lib/`; bundle-style
  // plugins may keep their code in custom directories (e.g. dsh-wechat-clawbot has dsh-wechat-bot/ +
  // dsh-client-wechat-ui/ and no lib/ at all). In that case validate the entry paths actually declared by
  // main / exports / dsh.bundle.patch, so a legal layout is not reported as an error.
  // 2026-09-17: dsh-wechat-clawbot hit this false positive at release time; the check became layout-adaptive.
  if (existsSync(join(ctx.root, 'lib'))) {
    if (!files.includes('lib')) issues.push('`files` does not include lib');
  } else {
    const targets = new Set();
    if (typeof pkg.main === 'string') targets.add(pkg.main)
    for (const v of Object.values(pkg.exports || {})) {
      if (typeof v === 'string') targets.add(v)
      else if (v && typeof v === 'object') for (const vv of Object.values(v)) if (typeof vv === 'string') targets.add(vv)
    }
    if (pkg.dsh?.bundle?.patch) targets.add(pkg.dsh.bundle.patch)
    const uncovered = [...targets].filter((rel) => {
      const clean = String(rel).replace(/^\.\//, '')
      // package.json is always packed by npm regardless of `files`; README/LICENSE/CHANGELOG are included automatically.
      if (clean === 'package.json' || /^(README|LICENSE|CHANGELOG)(\.|$)/i.test(clean)) return false
      const top = clean.split('/')[0]
      return !files.some((f) => {
        const fc = String(f).replace(/^\.\//, '').replace(/\/$/, '')
        return fc === clean || fc === top || clean.startsWith(`${fc}/`)
      })
    })
    if (uncovered.length) issues.push(`\`files\` does not cover the declared entry paths: ${uncovered.join(', ')}`)
  }

  // cordis.patch.yml's name must match the package name (renaming is the easiest thing to forget here)
  const patchRel = pkg.dsh?.bundle?.patch;
  if (patchRel) {
    const patchPath = join(ctx.root, patchRel);
    if (!existsSync(patchPath)) issues.push(`dsh.bundle.patch points at a missing file: ${patchRel}`);
    else {
      const m = /^name:\s*(.+)$/m.exec(readFileSync(patchPath, 'utf8'));
      const declared = m?.[1]?.trim().replace(/^['"]|['"]$/g, '');
      if (declared && declared !== pkg.name) issues.push(`cordis.patch.yml name (${declared}) ≠ package.json name (${pkg.name})`);
      else if (declared) notes.push(`cordis bundle name matches: ${declared}`);
    }
  } else {
    issues.push('Missing `dsh.bundle.patch`');
  }

  if (!pkg.repository?.url) issues.push('Missing `repository.url`');
  return { issues, notes };
}

function checkChangelog(ctx) {
  const issues = [];
  if (!existsSync(ctx.changelogPath)) {
    issues.push('Missing CHANGELOG.md (every breaking release needs migration notes)');
    return { issues, notes: [] };
  }
  const text = readFileSync(ctx.changelogPath, 'utf8');
  const notes = [];
  if (!/\[Unreleased\]/i.test(text)) issues.push('CHANGELOG.md is missing the `## [Unreleased]` section');
  const cur = ctx.pkg.version;
  if (!text.includes(`[${cur}]`)) notes.push(`CHANGELOG.md has no [${cur}] section yet (it is written automatically on release)`);
  else notes.push(`CHANGELOG.md already has the [${cur}] section`);
  return { issues, notes };
}

function runChecks(ctx, { strict = true, allowDirty = false } = {}) {
  info(`Pre-release checks: ${ctx.pkg.name}@${ctx.pkg.version} (${ctx.root})`);
  const issues = [];
  const notes = [];

  if (!ctx.gitReady) issues.push('Not a git repository (or git is unavailable)');
  else {
    const dirty = git(ctx, ['status', '--porcelain']);
    if (dirty && !allowDirty) issues.push(`Working tree is dirty (${dirty.split('\n').length} changes); commit before releasing`);
    else if (dirty) notes.push(`Working tree is dirty (${dirty.split('\n').length} changes) — allowed by --allow-dirty`);
    const branch = git(ctx, ['rev-parse', '--abbrev-ref', 'HEAD']);
    notes.push(`Branch: ${branch}`);
  }

  const comp = checkCompatDeclarations(ctx);
  issues.push(...comp.issues);
  notes.push(...comp.notes);

  const cl = checkChangelog(ctx);
  issues.push(...cl.issues);
  notes.push(...cl.notes);

  // A directory name different from the package name is a historical trap in these repositories; call it out
  const dirName = ctx.root.split('/').pop();
  if (dirName !== ctx.pkg.name) notes.push(`Note: directory name ${dirName} ≠ package name ${ctx.pkg.name} (the script always trusts package.json)`);

  for (const n of notes) dim(n);
  if (issues.length > 0) {
    for (const i of issues) bad(i);
    if (strict) die(`${issues.length} checks failed`);
    return { ok: false, issues, notes };
  }
  ok('All checks passed');
  return { ok: true, issues: [], notes };
}

// ---------------------------------------------------------------------------
// 6. CHANGELOG generation
// ---------------------------------------------------------------------------

const CHANGELOG_HEADER = (name) => `# Changelog

> All version changes of ${name}. This file is written automatically by \`scripts/release.mjs\` at release time.
> Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), versions follow [Semantic Versioning](https://semver.org/).

`;

function categorize(changes) {
  const sec = [];
  if (changes.breaking.length) sec.push(['⚠️ Breaking changes (BREAKING)', changes.breaking]);
  if (changes.feat.length) sec.push(['Added', changes.feat]);
  if (changes.fix.length) sec.push(['Fixed', changes.fix]);
  if (changes.other.length) sec.push(['Changed', changes.other]);
  return sec;
}

function renderEntry(ctx, version, date, changes, extraNotes = []) {
  const pkg = ctx.pkg;
  const lines = [`## [${version}] - ${date}`, ''];
  for (const [title, items] of categorize(changes)) {
    lines.push(`### ${title}`, '');
    for (const c of items) lines.push(`- ${c.subject}`);
    lines.push('');
  }
  const dshRange = pkg.dsh?.engines?.dsh;
  lines.push('### Compatibility', '');
  if (dshRange) lines.push(`- DSH: \`${dshRange}\``);
  const nodeRange = pkg.engines?.node;
  if (nodeRange) lines.push(`- Node: \`${nodeRange}\``);
  const dshPeers = [...new Set(
    Object.entries(pkg.peerDependencies || {})
      .filter(([n]) => n.startsWith('@deepseek-ai/dsh'))
      .map(([, v]) => v),
  )];
  if (dshPeers.length) lines.push(`- DSH peer: ${dshPeers.join(' || ')}`);
  if (pkg.dependencies && Object.keys(pkg.dependencies).length) {
    lines.push(`- Runtime dependencies: ${Object.entries(pkg.dependencies).map(([n, v]) => `\`${n}@${v}\``).join(', ')}`);
  }
  for (const n of extraNotes) lines.push(`- ${n}`);
  lines.push('');
  if (changes.breaking.length) {
    lines.push('### Migration', '');
    lines.push('> Every breaking release must state here what users have to change. Mirror this into the GitHub Release after publishing.', '');
    for (const c of changes.breaking) lines.push(`- ${c.subject}`);
    lines.push('');
  }
  return lines.join('\n');
}

function writeChangelog(ctx, version, changes, { dryRun }) {
  const text = existsSync(ctx.changelogPath)
    ? readFileSync(ctx.changelogPath, 'utf8')
    : CHANGELOG_HEADER(ctx.pkg.name);
  const date = new Date().toISOString().slice(0, 10);
  const entry = renderEntry(ctx, version, date, changes);

  if (text.includes(`## [${version}]`)) {
    warn(`CHANGELOG.md already has the [${version}] section; skipping the write`);
    return false;
  }
  let next;
  const anchor = /^##\s*\[Unreleased\][^\n]*\n/m.exec(text);
  if (anchor) {
    const at = anchor.index + anchor[0].length;
    next = text.slice(0, at) + '\n' + entry + text.slice(at);
  } else {
    // Insert before the first version section, or append at the end of the file
    const first = /^##\s*\[/m.exec(text);
    next = first ? text.slice(0, first.index) + entry + text.slice(first.index) : `${text.trimEnd()}\n\n${entry}`;
  }
  if (dryRun) {
    info('Section that will be written to CHANGELOG.md:');
    dim(entry.split('\n').slice(0, 12).join('\n  '));
    return true;
  }
  writeFileSync(ctx.changelogPath, next);
  ok(`Wrote [${version}] to CHANGELOG.md`);
  return true;
}

// ---------------------------------------------------------------------------
// 7. Release actions
// ---------------------------------------------------------------------------

function npmAuthEnv() {
  // Credential priority: this machine's token in <DSH_HOME>/dsh-npm.json (npm itself is not logged in).
  // DSH_HOME honours a home relocated by the launcher / rescue capsule; only the default falls back to ~/.dsh.
  const dshHome = process.env.DSH_HOME || join(process.env.HOME || '', '.dsh');
  const dshNpm = join(dshHome, 'dsh-npm.json');
  const env = {};
  const cleanups = [];
  if (existsSync(dshNpm)) {
    const cfg = readJson(dshNpm);
    if (cfg.token) {
      const dir = mkdtempSync(join(tmpdir(), 'dsh-rel-rc-'));
      const rc = join(dir, '.npmrc');
      writeFileSync(rc, `//registry.npmjs.org/:_authToken=${cfg.token}\n`, { mode: 0o600 });
      chmodSync(rc, 0o600);
      env.NPM_CONFIG_USERCONFIG = rc;
      env.NPM_CONFIG_CACHE = mkdtempSync(join(tmpdir(), 'dsh-rel-cache-'));
      cleanups.push(dir, env.NPM_CONFIG_CACHE);
      env.__usedToken = 'yes';
    }
  }
  return { env, cleanups };
}

function doPublish(ctx, version, tag, { dryRun, env }) {
  const args = ['publish', '--tag', tag, '--access', 'public'];
  if (dryRun) {
    // A dry run must not literally call `npm publish --dry-run`: package.json has not been bumped yet at this
    // point, so it would validate the **old version** against the registry and complain "cannot publish over
    // previously published versions". Use `npm pack --dry-run` to verify the package contents (no registry
    // access), then print the command that would run.
    info('npm pack --dry-run (verify the package contents)');
    const pack = trySh('npm', ['pack', '--dry-run', '--json'], { cwd: ctx.root, quiet: true });
    if (pack.code === 0) {
      try {
        const j = JSON.parse(pack.stdout)[0];
        dim(`tarball: ${j.filename} · ${j.entryCount} files · ${(j.size / 1024).toFixed(1)} kB`);
        for (const f of j.files.map((f) => f.path)) dim(`  ${f}`);
      } catch { dim('(cannot parse the pack output)'); }
    } else {
      warn(`npm pack --dry-run failed: ${pack.stderr || pack.stdout}`);
    }
    info(`[dry-run] would run: npm ${args.join(' ')}`);
    return { processing: false };
  }
  info(`npm ${args.join(' ')}`);
  const r = trySh('npm', args, { cwd: ctx.root, env, quiet: true });
  if (r.code !== 0) {
    bad(`npm publish failed (exit ${r.code})`);
    dim(r.stderr || r.stdout);
    die('npm publish failed');
  }
  // 202 = being processed: not a failure, but the version is not visible immediately
  const processing = /202|being processed/i.test(r.stdout + r.stderr);
  if (processing) warn('The registry returned 202 "being processed": the version becomes visible in 2–3 minutes; do NOT rush a republish of the same version (it would 409)');
  else ok(`npm publish finished (tag=${tag})`);
  return { processing };
}

function doGit(ctx, version, { dryRun, branch, remote, tag }) {
  const tagName = `v${version}`;
  const b = branch || git(ctx, ['rev-parse', '--abbrev-ref', 'HEAD']) || 'main';

  const existing = git(ctx, ['tag', '-l', tagName]);
  if (existing) die(`git tag ${tagName} already exists (before republishing, make sure that version was never published)`);

  if (!dryRun) {
    git(ctx, ['add', '-A']);
    trySh('git', ['commit', '-m', `chore(release): ${version}`], { cwd: ctx.root });
    git(ctx, ['tag', '-a', tagName, '-m', `Release ${version}`]);
    ok(`Tagged ${tagName}`);
    const push = trySh('git', ['push', remote, b, '--follow-tags'], { cwd: ctx.root, quiet: true });
    if (push.code !== 0) {
      warn(`git push failed: ${push.stderr}`);
      warn(`You can push manually later: git push ${remote} ${b} --follow-tags`);
    } else ok(`Pushed ${remote}/${b} + tag ${tagName}`);
  } else {
    info(`[dry-run] would commit / tag ${tagName} / push ${remote} ${b} --follow-tags`);
  }
  return tagName;
}

function doAggregates(ctx, version, { dryRun }) {
  const aggs = ctx.cfg.aggregates || [];
  if (aggs.length === 0) {
    info('No aggregate sync configured (aggregates is empty in release.config.json)');
    return [];
  }
  const results = [];
  for (const a of aggs) {
    if (!a.command) {
      results.push({ name: a.name, status: 'skipped', note: a.note || 'No manual sync needed' });
      dim(`${a.name}: skipped (${a.note || 'auto-scanned / no manual sync needed'})`);
      continue;
    }
    const command = a.command.replaceAll('${VERSION}', version).replaceAll('${PKG}', ctx.pkg.name);
    if (dryRun) {
      results.push({ name: a.name, status: 'planned', command });
      info(`[dry-run] aggregate sync ${a.name}: ${command}`);
      continue;
    }
    const r = trySh('sh', ['-c', command], { cwd: ctx.root, quiet: true });
    results.push({ name: a.name, status: r.code === 0 ? 'ok' : 'failed', note: (r.stdout || r.stderr).slice(0, 400) });
    if (r.code === 0) ok(`Aggregate sync ${a.name} finished`);
    else warn(`Aggregate sync ${a.name} failed (does not block the release): ${(r.stderr || r.stdout).slice(0, 200)}`);
  }
  return results;
}

function doDeprecate(ctx, { version, message }, { dryRun }) {
  const { env, cleanups } = npmAuthEnv();
  try {
    if (!/^\d+\.\d+\.\d+/.test(version)) die(`Invalid --deprecate version: ${version}`);
    const args = ['deprecate', `${ctx.pkg.name}@${version}`, message];
    info(`npm ${args.join(' ')}`);
    if (dryRun) { dim('[dry-run] not executed'); return; }
    const r = trySh('npm', args, { cwd: ctx.root, env, quiet: true });
    if (r.code !== 0) die(`npm deprecate failed: ${r.stderr || r.stdout}`);
    ok(`Deprecated ${ctx.pkg.name}@${version} (it can still be installed; a warning is shown on install)`);
  } finally {
    for (const d of cleanups) try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

// ---------------------------------------------------------------------------
// 8. Main flow
// ---------------------------------------------------------------------------

function main() {
  const argv = process.argv.slice(2);
  const o = parseArgs(argv);
  if (o.help) { log(HELP); return 0; }

  const ctx = loadContext(process.cwd());

  if (o.deprecate) {
    doDeprecate(ctx, o.deprecate, { dryRun: !o.publish });
    return 0;
  }

  if (o.check) {
    const res = runChecks(ctx, { allowDirty: o.allowDirty });
    if (o.json) log(JSON.stringify({ ok: res.ok, issues: res.issues, notes: res.notes }, null, 2));
    return res.ok ? 0 : 1;
  }

  const current = ctx.pkg.version;
  if (!parseSemver(current)) die(`Invalid package.json version: ${current}`);

  // The previous release tag (bounds the commit range and the bump)
  const lastTagRaw = git(ctx, ['describe', '--tags', '--abbrev=0', '--match', 'v*']);
  const lastTag = lastTagRaw || null;
  const commits = collectCommits(ctx, lastTag);
  const changes = classifyCommits(commits);

  info(`Current version ${current}${lastTag ? ` (previous tag ${lastTag})` : ' (no tags yet; analysing the full history)'}`);
  dim(`Commits since the last release: ${commits.length} — breaking ${changes.breaking.length} / feat ${changes.feat.length} / fix ${changes.fix.length} / other ${changes.other.length}`);

  const req = requiredBump(current, changes);
  info(`Minimum level required by the discipline: ${req}${changes.breaking.length ? ' (breaking changes detected)' : ''}`);

  // Resolve the target version
  let target = o.version;
  if (!target) {
    const bump = o.bump || 'auto';
    let kind;
    if (bump === 'auto') kind = req;
    else if (['patch', 'minor', 'major'].includes(bump)) {
      if (RANK[bump] < RANK[req]) {
        die([
          `--bump ${bump} violates the version discipline: detected ${changes.breaking.length ? 'breaking changes' : changes.feat.length ? 'new features' : 'changes'}, at least ${req} is required.`,
          changes.breaking.length
            ? `  Rule: a patch release only carries fixes, never breaking changes (otherwise every ^${current} user upgrades to a broken version).`
            : '',
        ].filter(Boolean).join('\n'));
      }
      kind = bump;
    } else die(`--bump accepts only auto|patch|minor|major, got ${bump}`);
    target = incSemver(current, kind);
  }

  if (o.pre) {
    const base = target.split('-')[0];                 // 0.3.0
    if (!/^(rc|beta|alpha|next)$/i.test(o.pre)) {
      // Allow a custom prerelease identifier: --pre canary.1
      target = `${base}-${o.pre}`;
    } else {
      const label = o.pre.toLowerCase() === 'next' ? 'rc' : o.pre.toLowerCase();
      target = `${base}-${label}.${nextPreNumber(current, base)}`;
    }
  }

  // Discipline check (including "a patch must not contain a breaking change")
  const discipline = assertDiscipline(current, target, changes);
  ok(`Version bump is compliant: ${current} → ${target} (level ${discipline.level}, discipline requires ${discipline.required})`);

  // dist-tag selection
  const isPre = parseSemver(target).prerelease.length > 0;
  let tag = o.tag;
  if (!tag) {
    if (o.line) tag = o.line.replace(/\./g, '-');        // 0.1 → 0-1 (maintenance-line dist-tag)
    else if (isPre) tag = 'next';                        // rc/beta → next
    else tag = 'latest';                                 // stable → latest
  }
  info(`dist-tag: ${tag}${o.line ? ` (maintenance line ${o.line})` : ''}`);

  // The target version must not exist yet
  if (!o.skipNpm) {
    const exists = trySh('npm', ['view', `${ctx.pkg.name}@${target}`, 'version'], { quiet: true });
    if (exists.code === 0 && exists.stdout) die(`${ctx.pkg.name}@${target} already exists in the registry; republishing is not allowed (overwriting needs force, a high-risk operation this script does not offer)`);
    else ok(`${ctx.pkg.name}@${target} is not in the registry yet`);
  }

  const dryRun = !o.publish;
  if (dryRun) {
    warn('DRY-RUN: no registry write / no commit / no push. Add --publish to release for real.');
  } else if (!o.yes) {
    die('A real release needs both --publish and --yes (to avoid accidents)');
  }

  runChecks(ctx, { strict: true, allowDirty: o.allowDirty });

  // 1) Write the CHANGELOG (first, so the commit includes it)
  const extraNotes = o.line ? [`Maintenance release (release/${o.line}): cherry-picked bug / security fixes only`] : [];
  if (!o.skipChangelog) writeChangelog(ctx, target, changes, { dryRun });

  // 2) Bump the package.json version
  if (!dryRun) {
    const pkgRaw = readFileSync(ctx.pkgPath, 'utf8');
    const bumped = pkgRaw.replace(/("version"\s*:\s*")[^"]+(")/, `$1${target}$2`);
    writeFileSync(ctx.pkgPath, bumped);
    ok(`package.json version → ${target}`);
  } else {
    info(`[dry-run] package.json version → ${target}`);
  }

  // 3) Build (only when there is a build script)
  const buildCmd = ctx.cfg.build ?? (ctx.pkg.scripts?.build ? 'npm run build' : null);
  if (buildCmd && !/^none$/i.test(buildCmd)) {
    if (dryRun) info(`[dry-run] build: ${buildCmd}`);
    else {
      info(`Build: ${buildCmd}`);
      const r = trySh('sh', ['-c', buildCmd], { cwd: ctx.root, quiet: true });
      if (r.code !== 0) { dim(r.stdout || r.stderr); die('Build failed; release aborted'); }
      ok('Build passed');
    }
  }

  let tagName = null;
  if (!o.skipGit) tagName = doGit(ctx, target, { dryRun, branch: o.branch, remote: o.remote, tag });

  if (!o.skipNpm) {
    const { env, cleanups } = npmAuthEnv();
    try {
      doPublish(ctx, target, tag, { dryRun, env });
    } finally {
      for (const d of cleanups) try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  }

  const aggregates = o.skipAggregates ? [] : doAggregates(ctx, target, { dryRun });

  const result = {
    package: ctx.pkg.name,
    from: current,
    to: target,
    distTag: tag,
    gitTag: tagName,
    dryRun,
    discipline,
    changes: { breaking: changes.breaking.length, feat: changes.feat.length, fix: changes.fix.length, other: changes.other.length },
    aggregates,
    installHint: `dsh plugin --profile web add ${ctx.pkg.name}@${target}`,
  };

  if (o.json) log(JSON.stringify(result, null, 2));
  else {
    log('');
    ok(`${dryRun ? '[DRY-RUN] planned' : 'Release'} complete: ${ctx.pkg.name}@${target} (tag=${tag})`);
    dim(`Users install with: dsh plugin --profile web add ${ctx.pkg.name}@${target}`);
    if (isPre) dim(`Prerelease dist-tag: npm i ${ctx.pkg.name}@next`);
    if (o.line) dim(`Maintenance dist-tag: npm i ${ctx.pkg.name}@${tag}`);
    if (!dryRun) dim('Do not forget: write the migration notes in the GitHub Release (required for breaking releases), backfill Obsidian, sync the aggregate platforms');
  }
  return 0;
}

try {
  process.exit(main());
} catch (e) {
  if (e instanceof Abort) {
    bad(e.message);
    process.exit(1);
  }
  bad(`Unexpected error: ${e?.stack || e}`);
  process.exit(1);
}
