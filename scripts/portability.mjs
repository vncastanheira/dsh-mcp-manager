#!/usr/bin/env node
/**
 * dsh-release-kit / portability.mjs — turns "can this be moved to someone else's computer" into a scripted gate.
 *
 * During local development, `link:` mounting + your own profile + your own `~/.dsh` hide a pile of problems:
 * absolute paths, a hardcoded `~/.dsh`, assumptions that only hold on macOS, package files missed by the
 * tarball, a client half the shell never puts into the boot payload… these only break on someone else's
 * machine, and often look like "installed, but nothing happened".
 *
 * This script verifies the plugin the way "someone else's computer" would:
 *
 *   1. static audit   — local absolute paths / bare platform-specific commands / home dirs that ignore DSH_HOME
 *   2. pack           — npm pack, and check the declared entries really made it into the package
 *   3. clean install  — create an empty profile and install from the tarball (no link:)
 *   4. boot           — start on a free port
 *   5. host half      — hit the health route and confirm the plugin really mounted
 *   6. client half    — confirm the bundle is in __DSH_BOOT__.entries and can be fetched
 *   7. real action    — optional: POST a real restart and confirm the service returns with a new pid
 *   8. cleanup        — stop the instance, delete the profile and the tarball (--keep retains them)
 *
 * Zero dependencies, Node >= 20 (uses the built-in fetch / getSetCookie).
 *
 *   node scripts/portability.mjs
 *   node scripts/portability.mjs --health /api/foo/probe --restart-route /api/foo/restart
 *   node scripts/portability.mjs --no-isolate   # share this machine's ~/.dsh (the default is an isolated temp home)
 *   node scripts/portability.mjs --json         # machine-readable report
 *   node scripts/portability.mjs --stability 30 # keep watching longer after readiness (default 15 s)
 *   node scripts/portability.mjs --cwd <plugin directory>
 *
 * Exit code: 0 = passed (publishable), 1 = failed, 2 = usage / environment error.
 */

import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdtempSync, openSync, closeSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import net from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import process from 'node:process'

/* ------------------------------------------------------------------ Arguments */

const argv = process.argv.slice(2)
const flag = (name, fallback = undefined) => {
  const index = argv.indexOf(name)
  const value = index >= 0 ? argv[index + 1] : undefined
  return value !== undefined && !value.startsWith('--') ? value : fallback
}
const has = (name) => argv.includes(name)

const options = {
  cwd: path.resolve(flag('--cwd', process.cwd())),
  dsh: flag('--dsh', 'dsh'),
  health: flag('--health', ''),
  restartRoute: flag('--restart-route', ''),
  pluginId: flag('--plugin-id', ''),
  port: Number(flag('--port', '0')) || 0,
  bootTimeoutSec: Number(flag('--timeout', '90')) || 90,
  keep: has('--keep'),
  // Isolated by default: a second instance on the same machine would contend for the `~/.dsh/.credentials.yaml`
  // write lock and fail to boot, and using the developer's home hides "brand-new machine" problems.
  // Only --no-isolate shares the home.
  isolate: !has('--no-isolate'),
  json: has('--json'),
  skipAudit: has('--skip-audit'),
  /** Skip the post-readiness stability watch (it runs by default). */
  skipStability: has('--skip-stability'),
}

/* ------------------------------------------------------------------ Output */

const results = []
let failed = 0

function record(level, title, detail = '') {
  results.push({ level, title, detail })
  if (options.json) return
  const mark = level === 'pass' ? '✔' : level === 'fail' ? '✘' : level === 'warn' ? '!' : '·'
  const line = `  ${mark} ${title}${detail === '' ? '' : ' — ' + detail}`
  if (level === 'fail') console.error(line)
  else console.log(line)
}
const pass = (title, detail) => record('pass', title, detail)
const fail = (title, detail) => {
  failed++
  record('fail', title, detail)
}
const warn = (title, detail) => record('warn', title, detail)
const info = (title, detail) => record('info', title, detail)
const section = (title) => {
  if (!options.json) console.log(`\n${title}`)
}

/* ------------------------------------------------------------------ Helpers */

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** Pick a free TCP port. */
function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      server.close(() => resolve(typeof address === 'object' && address !== null ? address.port : 0))
    })
  })
}

/** Whether something answers on that port. */
function probePort(port, host = '127.0.0.1', timeoutMs = 800) {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host })
    let settled = false
    const finish = (value) => {
      if (settled) return
      settled = true
      socket.destroy()
      resolve(value)
    }
    socket.setTimeout(timeoutMs)
    socket.once('connect', () => finish(true))
    socket.once('timeout', () => finish(false))
    socket.once('error', () => finish(false))
  })
}

/** Run one command synchronously; a failure is returned, not thrown. */
function run(file, args, runOptions = {}) {
  try {
    const stdout = execFileSync(file, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...runOptions })
    return { ok: true, stdout, stderr: '' }
  } catch (error) {
    return { ok: false, stdout: error.stdout ?? '', stderr: error.stderr ?? String(error.message ?? error) }
  }
}

/** Recursively list source files (skipping node_modules / .git / lib output). */
function listSources(dir, out = []) {
  if (!existsSync(dir)) return out
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === 'lib') continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) listSources(full, out)
    else if (/\.(ts|tsx|mjs|cjs|js|jsx)$/.test(entry.name)) out.push(full)
  }
  return out
}

/* ---------------------------------------------------------- 1. Static audit */

const USER_PATH = /(\/(?:Users|home)\/[A-Za-z0-9._-]+|C:\\Users\\[A-Za-z0-9._-]+)/
const PLATFORM_ONLY = /\b(launchctl|plutil|launchd)\b/
const PLATFORM_GUARD = /darwin|process\.platform/
const DSH_HOME_USE = /DSH_HOME/
const DOT_DSH = /\.dsh(?![\w-])/

function auditSources(cwd) {
  const files = ['src', 'helper', 'bin', 'scripts']
    .flatMap((dir) => listSources(path.join(cwd, dir)))
    // The browser half never shells out or resolves the home dir: scanning it would only create false positives
    .filter((file) => !file.endsWith('.min.js') && !file.includes(`${path.sep}client${path.sep}`))
  const hits = { absolute: [], platform: [], home: [] }
  for (const file of files) {
    const text = readFileSync(file, 'utf8')
    const relative = path.relative(cwd, file)
    text.split('\n').forEach((line, index) => {
      const trimmed = line.trim()
      if (trimmed.startsWith('*') || trimmed.startsWith('//')) return // comments do not count
      const absolute = USER_PATH.exec(line)
      if (absolute !== null) hits.absolute.push(`${relative}:${index + 1} → ${absolute[1]}`)
      if (PLATFORM_ONLY.test(line) && !PLATFORM_GUARD.test(text)) {
        hits.platform.push(`${relative}:${index + 1}`)
      }
    })
    // Writes ~/.dsh without honouring DSH_HOME: a relocated home would be written to the wrong place.
    // Only non-comment lines are considered, and `.dsh` must not be followed by a word character
    // (otherwise something like .dshwx-ball would be reported falsely).
    const homeHit = text
      .split('\n')
      .some((line) => {
        const trimmed = line.trim()
        if (trimmed.startsWith('*') || trimmed.startsWith('//')) return false
        return DOT_DSH.test(line)
      })
    if (homeHit && !DSH_HOME_USE.test(text)) hits.home.push(relative)
  }
  return { count: files.length, hits }
}

/* ------------------------------------------------------------------ Entry point */

const pkgPath = path.join(options.cwd, 'package.json')
if (!existsSync(pkgPath)) {
  console.error(`Cannot find package.json: ${pkgPath} (use --cwd <plugin directory>)`)
  process.exit(2)
}
const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
const id = options.pluginId !== '' ? options.pluginId : pkg.name
const hasClient = pkg.dsh?.client !== undefined
const bundlePatch = pkg.dsh?.bundle?.patch

if (!options.json) {
  console.log(`\nPortability check: ${id}@${pkg.version ?? '?'}`)
  console.log(`  Directory: ${options.cwd}`)
  console.log(`  Client half: ${hasClient ? 'yes' : 'no'}   bundle patch: ${bundlePatch ?? 'none'}`)
}

let tarball
let isolatedHome = ''
let child
let port = 0
/** Name of the verification profile (declared early: cleanup/finish may run before it is assigned). */
let profile = ''
const dshEnv = { ...process.env }

/** Clean up: stop the verification instance, delete the profile and the tarball. */
function cleanup() {
  try {
    if (child !== undefined && child.exitCode === null) child.kill('SIGKILL')
    try {
      closeSync(bootLogFd)
    } catch {
      /* already closed */
    }
  } catch {
    /* already exited */
  }
  // After the real action (restart), the port is held by the new process the helper started, unrelated to child.
  if (port !== 0) {
    const found = run('/usr/sbin/lsof', ['-ti', `tcp:${port}`, '-sTCP:LISTEN'])
    for (const pid of found.stdout.split('\n').map((line) => line.trim()).filter(Boolean)) {
      try {
        process.kill(Number(pid), 'SIGKILL')
      } catch {
        /* already exited */
      }
    }
  }
  if (options.keep) return
  const rm = (target) => {
    if (target === '') return
    try {
      rmSync(target, { recursive: true, force: true, maxRetries: 10, retryDelay: 150 })
    } catch {
      /* the filesystem is still reclaiming; leave the temp directory to the OS */
    }
  }
  rm(path.join(dshHome(), 'profiles', profile))
  if (tarball !== undefined) rm(tarball)
  rm(isolatedHome)
}

const dshHome = () => dshEnv.DSH_HOME ?? process.env.DSH_HOME ?? path.join(process.env.HOME ?? '', '.dsh')

let finished = false
function finish() {
  if (finished) return
  finished = true
  cleanup()
  if (options.json) {
    console.log(JSON.stringify({ id, version: pkg.version ?? null, port, failed, tarball: tarball ?? null, results }, null, 2))
  } else {
    section('Conclusion')
    if (failed === 0) {
      console.log(`\n  ✅ Passed: ${id}@${pkg.version ?? '?'} verified the "someone else's computer" way; ready to publish\n`)
    } else {
      console.error(`\n  ❌ Failed: ${failed} checks failed — fix them before publishing\n`)
    }
    if (options.keep) console.log('  (--keep: kept the verification profile and tarball for debugging)\n')
    if (isolatedHome !== '' && !options.keep) console.log('  (verification ran in a temporary DSH_HOME, now deleted; use --keep to keep it)\n')
  }
  process.exit(failed === 0 ? 0 : 1)
}

/* ----------------------------------------------------------- 1. Static audit */

if (!options.skipAudit) {
  section('1. Static audit')
  const audit = auditSources(options.cwd)
  info(`Scanned ${audit.count} source files`)
  if (audit.hits.absolute.length === 0) pass('No local absolute paths')
  else fail('Local absolute paths in the source (they always break on someone else\'s machine)', audit.hits.absolute.slice(0, 5).join('; '))
  if (audit.hits.platform.length === 0) pass('No bare platform-specific commands')
  else warn('Platform-specific commands may lack a platform guard', audit.hits.platform.slice(0, 4).join(', '))
  if (audit.hits.home.length === 0) pass('Config locations resolved by convention (DSH_HOME aware)')
  else warn('Writes .dsh without honouring DSH_HOME (a relocated home would be written to the wrong place)', audit.hits.home.slice(0, 4).join(', '))
}

/* --------------------------------------------------------------- 2. Pack */

section('2. Pack')
// --ignore-scripts: `prepare` would write build logs to stdout and pollute the --json output (the caller is responsible for building)
const pack = run('npm', ['pack', '--json', '--ignore-scripts'], { cwd: options.cwd })
if (!pack.ok) {
  fail('npm pack failed', pack.stderr.trim().slice(0, 300))
  finish()
}
let packed = null
try {
  packed = JSON.parse(pack.stdout)[0]
} catch {
  // Still a fallback: grab the last JSON array in stdout (a build script may have inserted other output)
  const start = pack.stdout.lastIndexOf('[')
  const end = pack.stdout.lastIndexOf(']')
  if (start >= 0 && end > start) {
    try {
      packed = JSON.parse(pack.stdout.slice(start, end + 1))[0]
    } catch {
      packed = null
    }
  }
}
if (packed === null) {
  fail('Cannot parse the npm pack output')
  finish()
}

tarball = path.join(options.cwd, packed.filename)
const inside = new Set((packed.files ?? []).map((entry) => entry.path))
pass('Pack succeeded', `${packed.filename} (${(packed.size / 1024).toFixed(0)} kB / ${inside.size} files)`)

const declared = [
  ...(typeof pkg.main === 'string' ? [pkg.main] : []),
  ...Object.values(pkg.exports ?? {}).filter((value) => typeof value === 'string'),
  ...(typeof bundlePatch === 'string' ? [bundlePatch] : []),
  ...(pkg.files ?? []).filter((value) => value.includes('.')),
]
const missing = [...new Set(declared.map((entry) => entry.replace(/^\.\//, '')))].filter((entry) => !inside.has(entry))
if (missing.length === 0) pass('All declared entries are in the package', declared.slice(0, 4).join(', '))
else fail('Declared entries missing from the package (broken once installed)', missing.join(', '))
if (inside.has('package.json')) pass('package.json is in the package')
else fail('package.json is not in the package')

/* --------------------------------------------------------- 3. Clean install */

profile = `verify-${String(id).replace(/[^a-zA-Z0-9._-]/g, '-')}`
if (options.isolate) {
  isolatedHome = mkdtempSync(path.join(tmpdir(), 'dsh-verify-home-'))
  dshEnv.DSH_HOME = isolatedHome
}
section('3. Clean install (fresh profile + tarball, no link:)')
info(`profile: ${profile}${options.isolate ? `   DSH_HOME: ${isolatedHome}` : ''}`)

const dump = run(options.dsh, ['--profile', profile, '--from-default-profile', 'web', '--dump-config'], { env: dshEnv })
if (dump.ok) pass('Verification profile is ready')
else fail('Cannot create the verification profile', dump.stderr.trim().slice(0, 300))

const add = run(options.dsh, ['plugin', '--profile', profile, 'add', `file:${tarball}`], { env: dshEnv })
if (!add.ok) {
  fail('tarball install failed', (add.stderr || add.stdout).trim().slice(0, 400))
} else {
  pass('tarball installed successfully')
  try {
    const composed = JSON.parse(readFileSync(path.join(dshHome(), 'profiles', profile, 'package.json'), 'utf8'))
    const bundles = composed.dsh?.profile?.bundles ?? []
    if (bundles.includes(id)) pass('Added to the profile bundles (the host will load it)', id)
    else fail('Installed but not in bundles (it will not load)', bundles.slice(-3).join(', '))
  } catch (error) {
    warn('Cannot read the profile package.json', String(error.message ?? error))
  }
}

/* ------------------------------------------------------------- 4. Boot */

section('4. Boot the verification instance')
port = options.port !== 0 ? options.port : await freePort()
info(`Port: ${port}`)

// stdout/stderr go to a file rather than a pipe: `dsh web` forks the real server process;
// once the wrapper exits the pipe closes and the token written by the forked half is lost.
const bootLogPath = path.join(tmpdir(), `dsh-verify-${String(id).replace(/[^a-zA-Z0-9._-]/g, '-')}-boot.log`)
const bootLogFd = openSync(bootLogPath, 'w')
const readBootLog = () => {
  try {
    return readFileSync(bootLogPath, 'utf8')
  } catch {
    return ''
  }
}
child = spawn(options.dsh, ['--profile', profile, '--port', String(port), '--no-open'], {
  env: dshEnv,
  stdio: ['ignore', bootLogFd, bootLogFd],
})

const deadline = Date.now() + options.bootTimeoutSec * 1000
let listening = false
while (Date.now() < deadline) {
  if (await probePort(port)) {
    listening = true
    break
  }
  if (child.exitCode !== null) break
  await sleep(300)
}
/** Pick the error lines out of the boot output (the first-hand evidence for "it does not install elsewhere"). */
function bootErrors(text) {
  return text
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => /Error|error:|EADDRINUSE|MODULE_NOT_FOUND|Cannot find|failed to load|timeout|lock/i.test(line))
    .slice(0, 6)
}

if (options.keep) {
  const dump = path.join(tmpdir(), `dsh-verify-${String(id).replace(/[^a-zA-Z0-9._-]/g, '-')}-boot.log`)
  try {
    writeFileSync(dump, readBootLog())
    info(`Boot output saved to: ${dump}`)
  } catch {
    /* best effort */
  }
}
if (listening) pass('Verification instance is listening', `http://127.0.0.1:${port}`)
else fail('Verification instance did not start', readBootLog().split('\n').filter(Boolean).slice(-5).join(' | ').slice(0, 400))

// A listening port does not mean a successful boot: the plugin tree may fail after the port is bound.
{
  const errors = bootErrors(readBootLog())
  if (errors.length > 0) fail('Errors in the boot output', errors.join(' | ').slice(0, 500))
  else if (listening) pass('No errors in the boot output')
}

// Static checks of the client half (independent of whether the instance boots)
let clientEntry = ''
if (typeof pkg.exports?.['./client'] === 'string') clientEntry = pkg.exports['./client']
else if (typeof pkg.exports?.['./client'] === 'object') clientEntry = pkg.exports['./client'].default ?? ''
if (hasClient) {
  if (clientEntry === '') fail('dsh.client is declared but exports["./client"] is missing')
  else {
    const clientFile = path.join(options.cwd, clientEntry)
    if (!existsSync(clientFile)) fail('The file exports["./client"] points at does not exist', clientEntry)
    else {
      const source = readFileSync(clientFile, 'utf8')
      const declaredId = /__ModuleLoader__\.load\(\{\s*id:\s*"([^"]+)"/.exec(source)?.[1] ?? ''
      if (declaredId === '') fail('Cannot find __ModuleLoader__.load({ id }) in the client bundle; the shell will not register it')
      else if (declaredId !== id) fail('The bundle registration id differs from the package name (it would break loading of the whole plugin batch)', `bundle=${declaredId} package=${id}`)
      else pass('The bundle registration id matches the package name', declaredId)
      if (typeof pkg.dsh.client.platform === 'string') pass('Client platform declared', pkg.dsh.client.platform)
      else warn('dsh.client does not declare platform (a web panel plugin should use "web")')
      if (Array.isArray(pkg.dsh.client.inject) && pkg.dsh.client.inject.length > 0) pass('Client inject declared', `${pkg.dsh.client.inject.length} entries`)
      else warn('dsh.client.inject is empty (dependency resolution may fail)')
      if (inside.size > 0 && ![...inside].some((entry) => entry === clientEntry.replace(/^\.\//, ''))) {
        fail('The client bundle is not in the npm package', clientEntry)
      }
    }
  }
}

const base = `http://127.0.0.1:${port}`

/**
 * Get the token from the URL line — the only credential that opens the Web UI (DSH prints
 * `dsh web: http://…/?token=…` to stdout at boot).
 *
 * Watch the timing: the port is LISTENing early during plugin loading, but that URL line is printed only
 * once the whole app is ready, possibly a dozen seconds later. So wait for the line; do not read it as
 * soon as the port answers.
 */
async function waitForToken(timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const found = /token=([A-Za-z0-9_-]+)/.exec(readBootLog())
    if (found !== null) return found[1]
    if (child.exitCode !== null) return ''
    await sleep(300)
  }
  return ''
}

let token = await waitForToken(30_000)
if (token !== '') pass('Got the UI token (boot output is normal)')
else warn('No URL line with a token within 30 s (UI checks will be skipped; pass one with --token)')
const healthPath = options.health !== '' ? options.health : `/api/${id}/probe`

/** Fetch with a cookie jar; index needs the token exchanged for a cookie (303 → fetch again). */
const jar = new Map()
async function browse(url, depth = 0) {
  const response = await fetch(url, {
    redirect: 'manual',
    headers: jar.size === 0 ? {} : { cookie: [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ') },
  })
  for (const entry of response.headers.getSetCookie?.() ?? []) {
    const [pair] = entry.split(';')
    const index = pair.indexOf('=')
    jar.set(pair.slice(0, index), pair.slice(index + 1))
  }
  if (response.status >= 300 && response.status < 400 && depth < 3) {
    const location = response.headers.get('location')
    if (location !== null) return browse(new URL(location, url).toString(), depth + 1)
  }
  return response
}

// A port is not the UI: webServer binds the port first, and the index/dist fallbacks are registered later.
if (listening && token !== '') {
  const readyBy = Date.now() + 30_000
  let ready = false
  while (Date.now() < readyBy) {
    try {
      const response = await browse(`${base}/?token=${token}`)
      if (response.status === 200) {
        ready = true
        break
      }
      if (response.status !== 404 && response.status !== 502 && response.status !== 503) break
    } catch {
      /* still starting */
    }
    await sleep(500)
  }
  if (ready) pass('Web UI is ready (index 200)')
  else warn('Web UI did not become ready (index is not 200)')
}

/* --------------------------------------------------------- 5. Host half */

section('5. Host half')
if (!listening) {
  warn('The instance did not start; skipping the host-half check')
} else {
  try {
    const response = await fetch(`${base}${healthPath}`)
    const text = await response.text()
    if (response.ok) pass('Health route is available', `${healthPath} → ${response.status} ${text.slice(0, 70)}`)
    else fail('Health route returned a non-2xx status', `${healthPath} → ${response.status} ${text.slice(0, 120)}`)
  } catch (error) {
    fail('Health route is unreachable', `${healthPath}: ${String(error.message ?? error)}`)
    warn("If the path is wrong, pass the plugin's own health route with --health <path>")
  }
}

/* ------------------------------------------------------- 6. Client half */

section('6. Client half')
if (!hasClient) {
  info('This plugin has no client half (dsh.client is not declared); skipping')
} else if (!listening) {
  warn('The instance did not start; skipping')
} else {
  try {
    const index = await browse(token === '' ? `${base}/` : `${base}/?token=${token}`)
    const html = await index.text()
    // The delivery URL shape changed across DSH versions; accept both:
    //   - older: absolute path `/plugins/??<id>/client.js,…&rev=…`
    //   - since 0.1.7: **document-relative** (core dsh-client-modules comboReference =
    //     comboUrl.slice(1), see the core note web-document-relative-app-routes),
    //     i.e. `plugins/??<id>/client.js,…&rev=…`, with **no** leading slash in index.
    // Only the prefix is relaxed; the semantic assertion (this plugin must be in the manifest) is unchanged.
    const urls = [...html.matchAll(/\/?plugins\/\?\?[^"\\\s]+/g)].map((match) => match[0].replaceAll('&amp;', '&'))
    // The boot manifest is split into phases (several combos), and the longest one may not contain this
    // plugin — search **all** combos.
    const bundleUrl = urls.find((url) => url.includes(`${id}/client.js`)) ?? ''
    const toAbsolute = (path) => (path.startsWith('/') ? `${base}${path}` : `${base}/${path}`)
    if (index.status === 401) {
      warn('Fetching index was refused (no token); skipping the runtime UI checks (the static checks already passed)')
    } else if (urls.length === 0) fail('Cannot find the client bundle delivery URL in index (the client half did not register)', `HTTP ${index.status}${bootErrors(readBootLog()).length > 0 ? ' | ' + bootErrors(readBootLog())[0] : ''}`)
    else if (bundleUrl === '') fail('The bundle is not in the boot manifest (the panel/entry point will not appear)', urls.join(' | ').slice(0, 150))
    else pass('The bundle was picked up into the shell boot manifest', `${id}/client.js`)
    if (bundleUrl !== '') {
      const bundle = await (await fetch(toAbsolute(bundleUrl))).text()
      if (bundle.includes(id)) pass('The bundle is downloadable and contains the plugin marker', `${(bundle.length / 1024).toFixed(0)} kB`)
      else fail('Cannot find the plugin id in the bundle contents')
    }
  } catch (error) {
    fail('Client-half verification failed', String(error.message ?? error))
  }
}

/* --------------------------------------------------- 7. Real action (optional) */

if (options.restartRoute !== '') {
  section('7. Real action (restart)')
  if (!listening) {
    warn('The instance did not start; skipping')
  } else {
    try {
      const before = await (await fetch(`${base}${healthPath}`)).json().catch(() => null)
      const response = await fetch(`${base}${options.restartRoute}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ reason: 'portability check', source: 'portability' }),
      })
      if (response.status !== 202 && !response.ok) {
        fail('Restart request was rejected', `${options.restartRoute} → ${response.status}`)
      } else {
        pass('Restart request accepted', `HTTP ${response.status}`)
        const limit = Date.now() + 120_000
        let newPid = null
        while (Date.now() < limit) {
          try {
            const live = await (await fetch(`${base}${healthPath}`)).json()
            if (before === null || live.pid !== before.pid) {
              newPid = live.pid
              break
            }
          } catch {
            /* restarting; the port is temporarily unavailable */
          }
          await sleep(1000)
        }
        if (newPid === null) fail('The service did not come back after the restart (this is what it looks like on someone else\'s machine)', 'no new process within 120 s')
        else pass('The service returned after the restart', `new pid ${newPid} (old ${before?.pid ?? '?'})`)
      }
    } catch (error) {
      fail('Real action failed', String(error.message ?? error))
    }
  }
}

/* ------------------------------------------------- 8. Stability watch (late crash) */

// This has actually bitten us: `dsh web` binds the port before loading the plugin tree, so "port answers /
// UI returns 200" may be a **temporary** state — the new host dies a few seconds later with
// `plugin tree failed to load … writer lock`, and the gate had already declared success before it died.
// So after readiness, watch for a while to confirm it does not die in the background.
if (listening && !options.skipStability) {
  section('8. Stability watch (still alive after readiness?)')
  const watchSec = Number(flag('--stability', '15')) || 15
  const deadline2 = Date.now() + watchSec * 1000
  let alive = true
  let lastPid = null
  let checks = 0
  let firstError = ''
  while (Date.now() < deadline2) {
    try {
      const response = await fetch(`${base}${healthPath}`)
      if (!response.ok) {
        alive = false
        firstError = `health route ${response.status}`
        break
      }
      const body = await response.json().catch(() => null)
      const pid = body?.pid ?? null
      if (lastPid !== null && pid !== null && pid !== lastPid) {
        alive = false
        firstError = `process replaced (${lastPid} → ${pid})`
        break
      }
      lastPid = pid
      checks += 1
    } catch (error) {
      alive = false
      firstError = String(error.message ?? error)
      break
    }
    await sleep(2_000)
  }
  // Also take one more look at the boot output for new fatal lines
  const fatal = bootErrors(readBootLog())
  if (alive && fatal.length === 0) {
    pass(`Stable for ${watchSec}s after readiness`, `${checks} probes, pid ${lastPid ?? '?'}`)
  } else {
    fail('Did not stay up after readiness (a late crash = a false success)', firstError !== '' ? firstError : fatal.join(' | ').slice(0, 300))
  }
}

finish()

finish()
