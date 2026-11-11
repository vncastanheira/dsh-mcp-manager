/**
 * dsh-mcp-manager — the operation facade shared by the agent tools and the panel.
 *
 * Both surfaces must do exactly the same thing and report exactly the same
 * words, so every mutation lives here once: read the persisted state, change
 * it, write it atomically, then reconcile the live bridge instances. The tools
 * and the routes are thin adapters over this class.
 *
 * Two invariants the facade enforces on every path:
 *   - **A write is followed by a reconcile.** A definition that persists but
 *     never connects is the failure mode that makes a manager feel broken.
 *   - **Nothing throws past the facade.** A bad request becomes an `ok: false`
 *     result with a human message; an exception here would reach the web boot
 *     (for the routes) or the model (for the tools).
 */

import type { Context } from '@deepseek-ai/cordis'

import { loadBridge } from './core-mcp.ts'
import { legacyImportCandidates, configPath, dshHome } from './home.ts'
import { ManagerRuntime, describe, type ServerRuntimeView } from './runtime.ts'
import { readFile } from 'node:fs/promises'
import {
  applyPatch,
  emptyServer,
  normalizeServer,
  validateServer,
  type ServerEntry,
} from './servers.ts'
import {
  DEFAULT_CONFIG,
  findServer,
  importServers,
  loadState,
  normalizeConfig,
  removeServer,
  saveState,
  upsertServer,
  type ManagerConfig,
  type ManagerState,
} from './store.ts'

/** The complete observable state of the manager. */
export interface ManagerSnapshot {
  /** Plugin switches. */
  config: ManagerConfig
  /** Persisted definitions, in list order. */
  servers: ServerEntry[]
  /** Runtime state, one per definition. */
  runtime: ServerRuntimeView[]
  /** Where the state file lives. */
  file: string
  /** Whether the state file existed on disk. */
  exists: boolean
  /** Entries the normalizer discarded on load. */
  dropped: number
  /** The harness MCP bridge this plugin drives. */
  bridge: { source: string; via: string } | null
  /** Why the bridge could not be resolved, when that is the case. */
  bridgeError: string | null
  /** Names that are configured but currently contribute no tools. */
  idle: string[]
}

/** Result of one mutating operation. */
export interface OpResult {
  ok: boolean
  message: string
  /** The refreshed snapshot, when the operation changed something. */
  snapshot?: ManagerSnapshot
}

/** Everything the facade needs from the plugin instance. */
export interface ManagerDeps {
  /** Plugin context (bridge loading + the tool registry read). */
  ctx: Context
  /** Whether the plugin master switch is on. */
  enabled: () => boolean
  /** Harness home override (tests). */
  home?: string
}

/**
 * The state + runtime pair behind every surface.
 */
export class McpManager {
  private readonly deps: ManagerDeps
  private readonly runtime: ManagerRuntime
  private state: ManagerState = { config: { ...DEFAULT_CONFIG }, servers: [] }
  private meta = { exists: false, file: '', dropped: 0 }

  constructor(deps: ManagerDeps) {
    // Explicit assignment, not a constructor parameter property: see the note in
    // runtime.ts — the tests run the sources directly through `node --test`.
    this.deps = deps
    this.runtime = new ManagerRuntime(deps.ctx)
    // Resolved up front so a snapshot taken before the first load/commit still
    // reports where the state lives.
    this.meta.file = configPath(deps.home ?? dshHome())
  }

  /** The harness home this instance reads and writes. */
  private get home(): string {
    return this.deps.home ?? dshHome()
  }

  /**
   * Whether the servers are allowed to be connected right now.
   *
   * Two independent switches, both of which must be on:
   *
   *   - the composition row's `enabled` — the installation switch. Off means the
   *     plugin mounts no tools and no routes at all, and only a profile edit
   *     brings it back.
   *   - the settings file's `enabled` — the runtime master switch, flipped from
   *     the panel or by `mcp_manager_update`. Off disconnects every server and
   *     unregisters every `mcp__*` tool, while leaving the management surface
   *     (panel + `mcp_manager_*`) alive so the state can still be inspected and
   *     switched back on.
   *
   * @returns true when servers may connect.
   */
  active(): boolean {
    return this.deps.enabled() && this.state.config.enabled
  }

  /** The persisted runtime master switch, for status surfaces. */
  masterSwitch(): boolean {
    return this.state.config.enabled
  }

  /** Load the state from disk and connect every enabled server. */
  async initialize(): Promise<void> {
    const view = await loadState(this.home)
    this.state = { config: view.config, servers: view.servers }
    this.meta = { exists: view.exists, file: view.file, dropped: view.dropped }
    await this.reconcile()
  }

  /** Reload from disk and reconnect (used after an external edit). */
  async refresh(): Promise<ManagerSnapshot> {
    const view = await loadState(this.home)
    this.state = { config: view.config, servers: view.servers }
    this.meta = { exists: view.exists, file: view.file, dropped: view.dropped }
    await this.reconcile()
    return this.snapshot()
  }

  /** Rebuild the live set from the current state. */
  async reconcile(): Promise<void> {
    const wanted = this.active() ? this.state.servers : []
    await this.runtime.reconcile(wanted)
  }

  /** Stop every server (unload / disable). */
  async shutdown(): Promise<void> {
    await this.runtime.disposeAll()
  }

  /**
   * The current snapshot: persisted state plus one runtime observation.
   *
   * Always derived live. An earlier version gated this on "has the state file
   * been read yet" and fell back to reporting every server as `stopped`, which
   * made a healthy manager look dead to any caller that had not run
   * `initialize()` — including the panel, briefly, on a slow boot.
   *
   * @returns everything a panel or a status tool renders.
   */
  snapshot(): ManagerSnapshot {
    const views = this.runtime.view(this.state.servers)
    const byName = new Map(views.map((view) => [view.name, view]))
    return {
      config: this.state.config,
      servers: this.state.servers,
      runtime: this.state.servers.map((server) => byName.get(server.name) ?? {
        name: server.name,
        phase: 'stopped' as const,
        loaded: false,
        error: null,
        tools: [],
        toolCount: 0,
        since: null,
      }),
      file: this.meta.file,
      exists: this.meta.exists,
      dropped: this.meta.dropped,
      bridge: this.runtime.bridgeInfo() ?? null,
      bridgeError: this.runtime.bridgeError() ?? null,
      idle: views.filter((view) => view.loaded && view.toolCount === 0).map((view) => view.name),
    }
  }

  /** One definition by name. */
  server(name: string): ServerEntry | undefined {
    return findServer(this.state.servers, name)
  }

  /**
   * This plugin's own agent tools, as the tool registry currently sees them.
   * @returns the registered `mcp_manager_*` names, sorted.
   */
  ownToolNames(): string[] {
    return this.runtime.namesWithPrefix('mcp_manager_')
  }

  /** Persist the given state, then reconcile. */
  private async commit(next: ManagerState, message: string): Promise<OpResult> {
    this.state = next
    try {
      this.meta.file = await saveState(next, this.home)
      this.meta.exists = true
    } catch (error) {
      return { ok: false, message: `Failed to write config: ${describe(error)}` }
    }
    try {
      await this.reconcile()
    } catch (error) {
      return { ok: false, message: `${message} (but reconnect failed: ${describe(error)})`, snapshot: this.snapshot() }
    }
    return { ok: true, message, snapshot: this.snapshot() }
  }

  /** Patch the plugin-level switches. */
  async patchConfig(patch: Record<string, unknown>): Promise<OpResult> {
    const merged = normalizeConfig({ ...this.state.config, ...patch })
    return await this.commit({ ...this.state, config: merged }, 'Plugin settings saved')
  }

  /**
   * Add one server.
   * @param raw - an untrusted definition.
   * @returns the operation result.
   */
  async addServer(raw: unknown): Promise<OpResult> {
    const server = normalizeServer(raw)
    if (server === undefined) return { ok: false, message: 'Invalid server definition: expected an object' }
    if (findServer(this.state.servers, server.name) !== undefined) {
      return { ok: false, message: `A server named "${server.name}" already exists; use update to change it` }
    }
    const problems = validateServer(server)
    if (problems.length > 0) return { ok: false, message: `Invalid definition: ${problems.join('; ')}` }
    const next = upsertServer(this.state.servers, server)
    return await this.commit({ ...this.state, servers: next }, `Added server "${server.name}"`)
  }

  /**
   * Update one server, optionally renaming it.
   * @param name - the current name.
   * @param patch - the fields to change.
   * @returns the operation result.
   */
  async updateServer(name: string, patch: Record<string, unknown>): Promise<OpResult> {
    const current = findServer(this.state.servers, name)
    if (current === undefined) return { ok: false, message: `No server named "${name}"` }
    const nextName = typeof patch.name === 'string' && patch.name.trim() !== '' ? patch.name.trim() : current.name
    const merged = applyPatch({ ...current, name: nextName }, patch)
    merged.name = nextName
    if (nextName !== current.name && findServer(this.state.servers, nextName) !== undefined) {
      return { ok: false, message: `The name "${nextName}" is already taken` }
    }
    const problems = validateServer(merged)
    if (problems.length > 0) return { ok: false, message: `Invalid definition: ${problems.join('; ')}` }

    let servers = this.state.servers
    if (nextName !== current.name) {
      // A rename changes the tool namespace, so it is a disconnect + reconnect
      // under a new name, never an in-place edit.
      servers = removeServer(servers, current.name)
      await this.runtime.stop(current.name)
    }
    servers = upsertServer(servers, merged)
    return await this.commit(
      { ...this.state, servers },
      nextName === current.name ? `Updated "${nextName}"` : `Renamed "${current.name}" to "${nextName}"`,
    )
  }

  /**
   * Remove one server and disconnect it.
   * @param name - the definition name.
   * @returns the operation result.
   */
  async removeServer(name: string): Promise<OpResult> {
    const current = findServer(this.state.servers, name)
    if (current === undefined) return { ok: false, message: `No server named "${name}"` }
    await this.runtime.stop(name)
    const next = removeServer(this.state.servers, name)
    return await this.commit({ ...this.state, servers: next }, `Removed server "${name}"; its MCP tools are unregistered`)
  }

  /**
   * Turn one server on or off.
   * @param name - the definition name.
   * @param enabled - the desired state.
   * @returns the operation result.
   */
  async setEnabled(name: string, enabled: boolean): Promise<OpResult> {
    const current = findServer(this.state.servers, name)
    if (current === undefined) return { ok: false, message: `No server named "${name}"` }
    const next = upsertServer(this.state.servers, { ...current, enabled })
    return await this.commit(
      { ...this.state, servers: next },
      enabled ? `Enabled "${name}"` : `Disabled "${name}"; its MCP tools are unregistered`,
    )
  }

  /**
   * Connect a definition and report what it offers.
   *
   * With `draft` the definition is tried without being persisted (the panel's
   * "test before save"); with `name` the *persisted* definition is reconnected
   * from scratch, which is the honest check that the saved config works.
   *
   * @param name - a persisted server to reconnect.
   * @param draft - an unsaved definition to try.
   * @returns a human summary plus the tool list.
   */
  async test(name?: string, draft?: unknown): Promise<{ ok: boolean; message: string; tools: string[]; snapshot: ManagerSnapshot }> {
    if (draft !== undefined) {
      const server = normalizeServer(draft)
      if (server === undefined) {
        return { ok: false, message: 'Invalid draft definition: expected an object', tools: [], snapshot: this.snapshot() }
      }
      const outcome = await this.runtime.probe(server, this.state.servers)
      const head = outcome.ok
        ? `"${server.name}" connected successfully, serving ${outcome.tools.length} tools (${outcome.durationMs} ms)`
        : `"${server.name}" failed to connect: ${outcome.error ?? 'unknown cause'}`
      return {
        ok: outcome.ok,
        message: outcome.tools.length > 0 ? `${head}: ${outcome.tools.slice(0, 12).join(', ')}${outcome.tools.length > 12 ? ' …' : ''}` : head,
        tools: outcome.tools,
        snapshot: this.snapshot(),
      }
    }

    const target = name !== undefined ? findServer(this.state.servers, name) : undefined
    if (target === undefined) {
      return { ok: false, message: 'Provide the name of the server to test, or a draft definition', tools: [], snapshot: this.snapshot() }
    }
    const outcome = await this.runtime.start(target)
    const head = outcome.ok
      ? `"${target.name}" reconnected successfully, serving ${outcome.tools.length} tools (${outcome.durationMs} ms)`
      : `"${target.name}" failed to connect: ${outcome.error ?? 'no tools registered (it may still be reconnecting, or the server exposes no tools)'}`
    return {
      ok: outcome.ok,
      message: outcome.tools.length > 0 ? `${head}: ${outcome.tools.slice(0, 12).join(', ')}${outcome.tools.length > 12 ? ' …' : ''}` : head,
      tools: outcome.tools,
      snapshot: this.snapshot(),
    }
  }

  /**
   * Import definitions from another manager's file.
   *
   * Existing names are never overwritten: an import must not silently replace a
   * working definition. Imported entries keep their own `enabled` flag, so a
   * file that says a server is on will connect right after the import.
   *
   * @param path - an explicit file to read, or empty to try the conventional locations.
   * @returns the operation result.
   */
  async importFrom(path?: string): Promise<OpResult> {
    const candidates = path !== undefined && path.trim() !== '' ? [path.trim()] : legacyImportCandidates(this.home)
    const tried: string[] = []
    for (const candidate of candidates) {
      tried.push(candidate)
      let raw: unknown
      try {
        raw = JSON.parse(await readFile(candidate, 'utf8'))
      } catch {
        continue
      }
      const { accepted } = importServers(raw)
      if (accepted.length === 0) continue
      const additions = accepted.filter((server) => findServer(this.state.servers, server.name) === undefined)
      const skipped = accepted.length - additions.length
      if (additions.length === 0) {
        return { ok: true, message: `All ${accepted.length} servers in ${candidate} already exist; nothing changed`, snapshot: this.snapshot() }
      }
      let servers = this.state.servers
      for (const server of additions) servers = upsertServer(servers, server)
      const result = await this.commit(
        { ...this.state, servers },
        `Imported ${additions.length} servers from ${candidate}`
        + (skipped > 0 ? ` (${skipped} skipped: the name already existed)` : ''),
      )
      return result
    }
    return { ok: false, message: `No importable file found. Tried: ${tried.join(', ')}` }
  }

  /** Whether the harness bridge is resolvable (used by status surfaces). */
  async bridgeStatus(): Promise<{ ok: boolean; source?: string; via?: string; error?: string }> {
    try {
      const bridge = await loadBridge()
      return { ok: true, source: bridge.source, via: bridge.via }
    } catch (error) {
      return { ok: false, error: describe(error) }
    }
  }
}

/** A fresh, empty definition (re-exported for the panel's "new server" form). */
export { emptyServer }
