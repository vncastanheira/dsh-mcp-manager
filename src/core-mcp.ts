/**
 * dsh-mcp-manager — locating the harness MCP bridge.
 *
 * The manager does not reimplement the Model Context Protocol. The harness
 * already ships a tested bridge, `@deepseek-ai/dsh-mcp-client`, which owns the
 * stdio / Streamable HTTP transports, credential scrubbing, reconnect backoff,
 * resource publishing and the `mcp__<serverName>__<toolName>` naming contract.
 * The manager's job is to *drive* that bridge: load one instance per configured
 * server, and dispose the instance to disconnect.
 *
 * That indirection is why this plugin cannot inherit the failure mode of the
 * manager it replaces. That one maintained its own client and then reconciled
 * tool visibility by calling the core `tools.restrict()` **once per tool**, and
 * every one of those calls rebuilds the entire registry view — O(tools × names)
 * with fresh Maps and Sets each time. The cost landed on the host's event loop
 * (94.7% CPU, unresponsive port, 1 GB JS heap). Here, connecting registers tools
 * through the bridge and disconnecting disposes them; `restrict()` is never
 * called at all, so there is no per-tool work to get wrong.
 *
 * Resolution is a ladder because a plugin may live in three different layouts:
 *   - installed into a profile (the profile's `node_modules` farm already links
 *     the whole core tree, so a bare specifier resolves);
 *   - installed from a tarball into an isolated throwaway home (the farm exists
 *     there too, but only once the CLI has built it);
 *   - loaded straight from a `link:` development checkout, whose `node_modules`
 *     knows nothing about the core.
 *
 * The running harness's own copy is preferred over anything the plugin might
 * have installed locally: a second, older bridge would diverge from the host's
 * tool registry, and version skew is exactly the class of bug this plugin
 * exists to avoid.
 */

import { createRequire } from 'node:module'
import { realpathSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import path from 'node:path'

/** The package that provides the bridge. */
export const BRIDGE_PACKAGE = '@deepseek-ai/dsh-mcp-client'

/** The subset of the bridge's surface this plugin relies on. */
export interface BridgeModule {
  /** Cordis plugin name, for diagnostics. */
  name: string
  /** Services the bridge requires (must include `tools`). */
  inject: string[]
  /** Cordis plugin entry: connects one server and registers its tools. */
  apply(ctx: unknown, config: unknown): Promise<void> | void
}

/** A successful resolution. */
export interface BridgeLocation {
  /** The loaded ESM namespace. */
  module: BridgeModule
  /** Where it came from — the specifier or absolute path that resolved. */
  source: string
  /** Which rung of the ladder matched, for diagnostics. */
  via: 'profile' | 'harness' | 'bare'
}

/** Cached successful resolution (the module is a singleton per process). */
let cached: BridgeLocation | undefined

/**
 * Resolve a filesystem anchor from which the harness's own core packages are visible.
 *
 * `process.argv[1]` is the `dsh` CLI entry (often a symlink in a bin directory).
 * Resolving its real path lands inside the installed core package, whose own
 * `node_modules` carries the bridge — so requiring from there finds the exact
 * copy the running harness loaded.
 *
 * @returns absolute file paths to anchor resolution from, best first.
 */
function harnessAnchors(): string[] {
  const anchors: string[] = []
  const argv1 = process.argv[1]
  if (typeof argv1 === 'string' && argv1 !== '') {
    try {
      anchors.push(realpathSync(argv1))
    } catch {
      anchors.push(argv1)
    }
  }
  // The profile directory sits at <home>/profiles/<name>, so one level up is the
  // farm that links every core package.
  const profileDir = (process.env.DSH_PROFILE_DIR ?? '').trim()
  if (profileDir !== '') anchors.push(path.join(profileDir, 'noop.js'))
  return anchors
}

/** Resolve a specifier from one anchor, returning undefined when it is not visible there. */
function resolveFrom(anchor: string, specifier: string): string | undefined {
  try {
    return createRequire(anchor).resolve(specifier)
  } catch {
    return undefined
  }
}

/**
 * Load the harness MCP bridge module.
 *
 * @returns the loaded module and where it came from.
 * @throws when no rung of the ladder resolves — the caller decides whether that
 *   is fatal (it never should be: the settings panel stays up and reports it).
 */
export async function loadBridge(): Promise<BridgeLocation> {
  if (cached !== undefined) return cached
  const failures: string[] = []

  // Rung 1: the running harness's own copy.
  for (const anchor of harnessAnchors()) {
    const resolved = resolveFrom(anchor, BRIDGE_PACKAGE)
    if (resolved === undefined) {
      failures.push(`${anchor}: not found`)
      continue
    }
    try {
      const module = await import(pathToFileURL(resolved).href) as unknown as BridgeModule
      if (typeof module.apply !== 'function') throw new Error('module does not export apply()')
      const via = anchor.startsWith(process.env.DSH_PROFILE_DIR ?? '\u0000') ? 'profile' : 'harness'
      cached = { module, source: resolved, via }
      return cached
    } catch (error) {
      failures.push(`${resolved}: ${String(error instanceof Error ? error.message : error)}`)
    }
  }

  // Rung 2: whatever the plugin's own dependency tree provides. Reached only
  // when the harness copy is invisible (a layout we have not seen yet).
  try {
    const module = await import(BRIDGE_PACKAGE) as unknown as BridgeModule
    if (typeof module.apply !== 'function') throw new Error('module does not export apply()')
    cached = { module, source: BRIDGE_PACKAGE, via: 'bare' }
    return cached
  } catch (error) {
    failures.push(`${BRIDGE_PACKAGE}: ${String(error instanceof Error ? error.message : error)}`)
  }

  throw new Error(
    `Cannot find ${BRIDGE_PACKAGE} (the MCP bridge bundled with the harness). Tried: ${failures.join('; ')}. `
    + 'This package ships with DeepSeek Harness; if it is missing, make sure you are running the official dsh rather than a trimmed-down runtime.',
  )
}

/**
 * Drop the cached resolution. Used by tests that need to observe the ladder.
 */
export function resetBridgeCache(): void {
  cached = undefined
}

/** The specifiers/anchors the ladder consults, for a diagnostics panel. */
export function bridgeSearchDescription(): string {
  return [BRIDGE_PACKAGE, ...harnessAnchors()].join(' → ')
}
