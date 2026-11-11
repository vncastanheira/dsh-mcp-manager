/**
 * dsh-mcp-manager — the runtime that connects and disconnects MCP servers.
 *
 * Responsibilities, and deliberately nothing else:
 *
 *   1. **Reconcile** — make the set of live bridge instances equal to the set of
 *      enabled definitions, without disturbing connections whose wire config did
 *      not change (editing a description must not drop a live session).
 *   2. **Report** — a per-server view built from one single enumeration of the
 *      tool registry, plus the last load error.
 *   3. **Probe** — load a definition without persisting it, so the panel can
 *      answer "does this work?" before the user commits an edit.
 *
 * Protocol work lives in `@deepseek-ai/dsh-mcp-client` (see core-mcp.ts).
 * Tool visibility is never touched: connecting registers tools, disconnecting
 * disposes them, and `tools.restrict()` is not used anywhere in this plugin.
 *
 * The one registry read this plugin performs is a single `ctx.tools.schemas()`
 * per observation, grouped in memory by the `mcp__<name>__` prefix. Asking the
 * registry once per server would recompute the whole view per server, which is
 * the quadratic shape that made the plugin this one replaces hang the host.
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Fiber } from '@deepseek-ai/cordis'

import { loadBridge, type BridgeLocation } from './core-mcp.ts'
import {
  serverSignature,
  toBridgeConfig,
  validateServer,
  type ServerEntry,
} from './servers.ts'

/** Where a server stands right now. */
export type ServerPhase =
  /** Not loaded (disabled, removed, or never started). */
  | 'stopped'
  /** A bridge instance is loading; the connection attempt is still in flight. */
  | 'starting'
  /** Loaded and contributing at least one tool. */
  | 'active'
  /** Loaded, contributing no tools — connecting, retrying, or genuinely empty. */
  | 'waiting'
  /** Could not be loaded (bad config, name conflict, or the bridge is missing). */
  | 'error'

/** The observable state of one server. */
export interface ServerRuntimeView {
  /** The `serverName` namespace. */
  name: string
  /** Current phase. */
  phase: ServerPhase
  /** Whether a bridge instance is currently loaded for it. */
  loaded: boolean
  /** The last load error, or null. */
  error: string | null
  /** Public tool names currently registered by this server, sorted. */
  tools: string[]
  /** `tools.length`, for panels that only show a count. */
  toolCount: number
  /** When the current phase began (epoch ms), or null before first start. */
  since: number | null
}

/** Outcome of connecting one definition. */
export interface StartOutcome {
  ok: boolean
  error?: string
  tools: string[]
  durationMs: number
}

/** Outcome of probing a definition that is not (yet) persisted. */
export interface ProbeOutcome extends StartOutcome {
  /** Validation problems found before any connection was attempted. */
  problems: string[]
}

/** One live bridge instance. */
interface Entry {
  /** The definition it was built from. */
  server: ServerEntry
  /** Wire-config fingerprint, for change detection. */
  signature: string
  /** The bridge fiber, or null when loading failed before a fiber existed. */
  fiber: Fiber | null
  phase: ServerPhase
  error: string | null
  since: number
}

/**
 * How long to wait for a bridge instance's first connection attempt before
 * reporting it as still-connecting.
 *
 * `apply` awaits `connection.ready`, which settles after the *first* attempt,
 * so this is a safety net for a server that never answers, not the normal path.
 * The fiber keeps retrying in the background either way.
 */
export const STARTUP_WAIT_MS = 25_000

/** The harness tool-name prefix owned by one server namespace. */
export function toolPrefix(serverName: string): string {
  return `mcp__${serverName}__`
}

/**
 * Group one tool-registry enumeration by server namespace.
 *
 * @param names - every currently registered public tool name.
 * @param ours - the server names this plugin manages.
 * @returns server name → its sorted public tool names.
 */
export function groupByServer(
  names: readonly string[],
  ours: readonly string[],
): Map<string, string[]> {
  const out = new Map<string, string[]>()
  for (const name of ours) out.set(name, [])
  for (const name of names) {
    if (!name.startsWith('mcp__')) continue
    for (const owner of ours) {
      if (name.startsWith(toolPrefix(owner))) {
        out.get(owner)?.push(name)
        break
      }
    }
  }
  for (const list of out.values()) list.sort()
  return out
}

/** Resolve after `ms`, never rejecting. */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** How one bridge instance's first connection attempt ended. */
interface SettleResult {
  /** Whether the attempt completed without a load error. */
  ok: boolean
  /** The load error, when there was one. */
  error?: string
  /** Set by the timeout arm when the attempt is still in flight. */
  stalled?: boolean
}

/**
 * Supervises one bridge instance per enabled server.
 *
 * All mutating operations are serialized through an internal promise chain:
 * the panel, the agent tools and the startup path can each ask for a change at
 * any moment, and interleaving a dispose with a load would trip the bridge's
 * own "serverName already in use" guard.
 */
export class ManagerRuntime {
  private readonly entries = new Map<string, Entry>()
  private readonly ctx: Context
  private bridge: BridgeLocation | undefined
  private bridgeFailure: string | undefined
  private chain: Promise<unknown> = Promise.resolve()

  /**
   * @param ctx - the plugin context; `ctx.plugin` loads a bridge instance and
   *   `ctx.tools` is the registry this plugin reads (never writes).
   */
  constructor(ctx: Context) {
    // Written out rather than using a constructor parameter property: Node's
    // native TypeScript stripping only accepts erasable syntax, and parameter
    // properties are not erasable — the unit tests import these modules through
    // `node --test` with no build step.
    this.ctx = ctx
  }

  /** Serialize one operation after every operation already queued. */
  private run<T>(task: () => Promise<T>): Promise<T> {
    const next = this.chain.then(task, task)
    // Keep the chain alive whatever the task did, without swallowing the
    // caller's own view of the failure.
    this.chain = next.catch(() => undefined)
    return next
  }

  /** Load (once) the harness MCP bridge, remembering a failure. */
  private async ensureBridge(): Promise<BridgeLocation> {
    if (this.bridge !== undefined) return this.bridge
    if (this.bridgeFailure !== undefined) throw new Error(this.bridgeFailure)
    try {
      this.bridge = await loadBridge()
      return this.bridge
    } catch (error) {
      this.bridgeFailure = describe(error)
      throw error
    }
  }

  /** The resolved bridge location, for the status surfaces. */
  bridgeInfo(): { source: string; via: string } | undefined {
    return this.bridge === undefined ? undefined : { source: this.bridge.source, via: this.bridge.via }
  }

  /** The bridge-load failure, when it could not be resolved at all. */
  bridgeError(): string | undefined {
    return this.bridgeFailure
  }

  /** Every public tool name currently registered, in one registry read. */
  private toolNames(): string[] {
    type Schemas = { schemas?: (scope?: unknown) => Array<{ name?: unknown }> }
    const registry = this.ctx.tools as unknown as Schemas
    if (typeof registry.schemas !== 'function') return []
    const schemas = registry.schemas()
    if (!Array.isArray(schemas)) return []
    return schemas
      .map((schema) => (typeof schema?.name === 'string' ? schema.name : undefined))
      .filter((name): name is string => name !== undefined)
  }

  /**
   * One registry enumeration, filtered to a name prefix.
   *
   * Exposed so a health surface can report that this plugin's own agent tools
   * really mounted — a fact nothing else observes, since the manager's tools are
   * registered on the tool registry rather than exposed over HTTP.
   *
   * @param prefix - the name prefix to keep.
   * @returns the matching tool names, sorted.
   */
  namesWithPrefix(prefix: string): string[] {
    return this.toolNames().filter((name) => name.startsWith(prefix)).sort()
  }

  /** Tool names grouped by managed server, from one registry read. */
  private toolsByServer(): Map<string, string[]> {
    return groupByServer(this.toolNames(), [...this.entries.keys()])
  }

  /**
   * Bring the live set in line with the given definitions.
   *
   * Servers that are gone, disabled, or whose wire config changed are stopped;
   * the rest are left alone; everything enabled and not yet loaded is started.
   *
   * @param servers - the complete persisted definition list.
   */
  async reconcile(servers: readonly ServerEntry[]): Promise<void> {
    await this.run(async () => {
      const desired = new Map<string, ServerEntry>()
      for (const server of servers) if (server.enabled) desired.set(server.name, server)

      for (const [name, entry] of [...this.entries]) {
        const want = desired.get(name)
        if (want === undefined || serverSignature(want) !== entry.signature) {
          await this.stopLocked(name)
        }
      }
      for (const [name, server] of desired) {
        if (!this.entries.has(name)) await this.startLocked(server)
      }
      // The registry may not have reported the very last registration yet when a
      // caller reads the view immediately after; one microtask turn is enough.
      await Promise.resolve()
    })
  }

  /**
   * Stop one server (disposing its bridge instance and unregistering its tools).
   * @param name - the server namespace.
   */
  async stop(name: string): Promise<void> {
    await this.run(() => this.stopLocked(name))
  }

  /**
   * Start (or restart) one server from a definition, without persisting it.
   * @param server - the definition to connect.
   * @returns what happened, including the tools it contributed.
   */
  async start(server: ServerEntry): Promise<StartOutcome> {
    return await this.run(async () => {
      await this.stopLocked(server.name)
      return await this.startLocked(server)
    })
  }

  /**
   * Restart one server only if it is currently live.
   * @param server - the definition to reconnect.
   */
  async restart(server: ServerEntry): Promise<StartOutcome> {
    return await this.start(server)
  }

  /**
   * Connect a definition that is not persisted, report what it offers, then
   * disconnect it and bring the persisted set back.
   *
   * This is the "test before you save" path. It briefly takes over the server's
   * namespace, so a live server of the same name is stopped first and restored
   * afterwards from `saved`.
   *
   * @param server - the draft definition.
   * @param saved - the persisted list, used to restore the live set.
   * @returns the probe result (with validation problems, if any).
   */
  async probe(server: ServerEntry, saved: readonly ServerEntry[]): Promise<ProbeOutcome> {
    const problems = validateServer(server)
    if (problems.length > 0) {
      return { ok: false, problems, tools: [], durationMs: 0, error: problems.join('; ') }
    }
    return await this.run(async () => {
      await this.stopLocked(server.name)
      const outcome = await this.startLocked(server)
      await this.stopLocked(server.name)
      // Restore whatever the persisted list says should be live.
      const desired = new Map<string, ServerEntry>()
      for (const entry of saved) if (entry.enabled) desired.set(entry.name, entry)
      for (const [name, want] of desired) {
        if (!this.entries.has(name)) await this.startLocked(want)
      }
      return { ...outcome, problems: [] }
    })
  }

  /** Stop every server (plugin unload / HMR). */
  async disposeAll(): Promise<void> {
    await this.run(async () => {
      for (const name of [...this.entries.keys()]) await this.stopLocked(name)
    })
  }

  /**
   * Build the per-server view for the given persisted list.
   *
   * Definitions that are not live (disabled, or not yet started) still appear,
   * so a panel always shows what the user configured.
   *
   * @param servers - the persisted definitions.
   * @returns one view per definition, in list order.
   */
  view(servers: readonly ServerEntry[]): ServerRuntimeView[] {
    const byServer = this.toolsByServer()
    return servers.map((server) => {
      const entry = this.entries.get(server.name)
      const tools = byServer.get(server.name) ?? []
      const phase = phaseOf(entry, server.enabled, tools.length)
      return {
        name: server.name,
        phase,
        loaded: entry?.fiber !== undefined && entry?.fiber !== null,
        error: entry?.error ?? null,
        tools,
        toolCount: tools.length,
        since: entry?.since ?? null,
      }
    })
  }

  /** Whether any server is currently live. */
  liveCount(): number {
    return [...this.entries.values()].filter((entry) => entry.fiber !== null).length
  }

  /* ------------------------------------------------------------ internals */

  /** Stop one server. Caller must already hold the serialization slot. */
  private async stopLocked(name: string): Promise<void> {
    const entry = this.entries.get(name)
    if (entry === undefined) return
    this.entries.delete(name)
    if (entry.fiber === null) return
    try {
      await entry.fiber.dispose()
    } catch {
      // A bridge instance that fails to dispose cleanly still leaves the
      // registry (cordis clears its effects); surfacing this would only turn a
      // recoverable disconnect into a panel error.
    }
  }

  /** Start one server. Caller must already hold the serialization slot. */
  private async startLocked(server: ServerEntry): Promise<StartOutcome> {
    const started = Date.now()
    const entry: Entry = {
      server,
      signature: serverSignature(server),
      fiber: null,
      phase: 'starting',
      error: null,
      since: started,
    }
    this.entries.set(server.name, entry)

    const problems = validateServer(server)
    if (problems.length > 0) {
      entry.phase = 'error'
      entry.error = problems.join('; ')
      return { ok: false, error: entry.error, tools: [], durationMs: Date.now() - started }
    }

    let bridge: BridgeLocation
    try {
      bridge = await this.ensureBridge()
    } catch (error) {
      entry.phase = 'error'
      entry.error = describe(error)
      return { ok: false, error: entry.error, tools: [], durationMs: Date.now() - started }
    }

    let fiber: Fiber
    try {
      fiber = await this.ctx.plugin(bridge.module, toBridgeConfig(server))
    } catch (error) {
      // A rejected plugin load can still have produced a half-built fiber;
      // drop the reservation so the same name can be retried.
      entry.phase = 'error'
      entry.error = describe(error)
      return { ok: false, error: entry.error, tools: [], durationMs: Date.now() - started }
    }
    entry.fiber = fiber

    const settled = (async (): Promise<SettleResult> => {
      try {
        await fiber
        return { ok: true }
      } catch (error) {
        return { ok: false, error: describe(error) }
      }
    })()
    const outcome: SettleResult = await Promise.race([
      settled,
      delay(STARTUP_WAIT_MS).then((): SettleResult => ({ ok: true, stalled: true })),
    ])
    if (outcome.stalled === true) {
      // Still connecting; the bridge keeps retrying on its own schedule.
      entry.phase = 'waiting'
      entry.error = null
    } else if (outcome.ok) {
      entry.error = null
    } else {
      entry.error = outcome.error ?? 'connection failed'
    }

    const tools = groupByServer(this.toolNames(), [server.name]).get(server.name) ?? []
    entry.phase = tools.length > 0 ? 'active' : (entry.error === null ? 'waiting' : 'error')
    entry.since = Date.now()
    return {
      ok: entry.phase === 'active',
      ...(entry.error === null ? {} : { error: entry.error }),
      tools,
      durationMs: Date.now() - started,
    }
  }
}

/** Derive the phase shown to the user. */
function phaseOf(entry: Entry | undefined, enabled: boolean, toolCount: number): ServerPhase {
  if (entry === undefined) return 'stopped'
  if (entry.phase === 'error') return 'error'
  if (entry.fiber === null) return 'stopped'
  if (toolCount > 0) return 'active'
  return entry.phase === 'starting' ? 'starting' : 'waiting'
}

/** A short, safe message for an unknown thrown value. */
export function describe(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === 'string') return error
  try {
    return JSON.stringify(error)
  } catch {
    return String(error)
  }
}

/** Whether a definition is currently live, for callers holding no runtime. */
export function isEnabled(server: ServerEntry): boolean {
  return server.enabled
}
