/**
 * dsh-mcp-manager — persistence for the manager settings and the server list.
 *
 * One file under the harness home (`$DSH_HOME/dsh-mcp-manager.json`, mode 0600)
 * holds both the plugin switches and every server definition, so the whole
 * state is discoverable, diffable and editable outside the GUI while the
 * profile bundle row only seeds it on first run.
 *
 * Every read tolerates a missing or malformed file by falling back to the
 * defaults: a broken config must not take the settings panel — or the web boot —
 * down with it. Every write is atomic (temp file + rename) with 0600 applied
 * before the rename, so a crash can never leave a truncated list behind and the
 * file is never briefly world-readable.
 */

import { mkdir, open, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { dirname, join } from 'node:path'

import { configPath, dshHome } from './home.ts'
import {
  normalizeServer,
  normalizeServerList,
  type ServerEntry,
} from './servers.ts'

/** Plugin-level settings (the peer of the server list in the same file). */
export interface ManagerConfig {
  /** Master switch for routes, tools and the prompt section. */
  enabled: boolean
  /** Whether a system-prompt section announces the plugin. */
  announceToAgent: boolean
}

/** Defaults, applied to every missing or invalid field. */
export const DEFAULT_CONFIG: ManagerConfig = {
  enabled: true,
  announceToAgent: true,
}

/** The complete persisted state. */
export interface ManagerState {
  config: ManagerConfig
  servers: ServerEntry[]
}

/** A loaded state plus where it came from and whether anything was dropped. */
export interface StateView extends ManagerState {
  /** Whether the file existed. */
  exists: boolean
  /** The resolved path. */
  file: string
  /** Entries the normalizer discarded (unusable or duplicate names). */
  dropped: number
}

/** Coerce one raw value into a boolean, falling back on absence. */
function boolOf(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback
}

/**
 * Normalize a raw config object over the defaults.
 * @param raw - the parsed file contents (any shape).
 * @returns a complete configuration.
 */
export function normalizeConfig(raw: unknown): ManagerConfig {
  const source = raw !== null && typeof raw === 'object' && !Array.isArray(raw)
    ? raw as Record<string, unknown>
    : {}
  return {
    enabled: boolOf(source.enabled, DEFAULT_CONFIG.enabled),
    announceToAgent: boolOf(source.announceToAgent, DEFAULT_CONFIG.announceToAgent),
  }
}

/**
 * Load the manager state, falling back to the defaults.
 * @param home - the harness home.
 * @returns the state, whether the file existed, and its path.
 */
export async function loadState(home: string = dshHome()): Promise<StateView> {
  const file = configPath(home)
  try {
    const raw = await readFile(file, 'utf8')
    const parsed = JSON.parse(raw) as unknown
    const source = parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {}
    const servers = normalizeServerList(source.servers)
    const declared = Array.isArray(source.servers) ? source.servers.length : 0
    return {
      // The switches live under a nested `config` key. A hand-written flat file
      // (`{ enabled, servers }`) is still honoured, because the plugin must not
      // lose a setting to a shape it did not expect.
      config: normalizeConfig(source.config !== undefined ? source.config : source),
      servers,
      exists: true,
      file,
      dropped: Math.max(0, declared - servers.length),
    }
  } catch {
    return { config: { ...DEFAULT_CONFIG }, servers: [], exists: false, file, dropped: 0 }
  }
}

/**
 * Serialize the state exactly as it is written to disk.
 * @param state - the state to serialize.
 * @returns pretty-printed JSON with a trailing newline.
 */
export function serializeState(state: ManagerState): string {
  return `${JSON.stringify({ version: 1, ...state }, null, 2)}\n`
}

/**
 * Write the state atomically with 0600 permissions.
 * @param state - the complete state to persist.
 * @param home - the harness home.
 * @returns the resolved path that was written.
 */
export async function saveState(state: ManagerState, home: string = dshHome()): Promise<string> {
  const file = configPath(home)
  await mkdir(dirname(file), { recursive: true })
  const temp = join(dirname(file), `.dsh-mcp-manager.${randomBytes(6).toString('hex')}.tmp`)
  try {
    // Create with the restrictive mode first: the file must never exist with
    // default permissions, even for the instant before a chmod would land.
    const handle = await open(temp, 'w', 0o600)
    try {
      await handle.writeFile(serializeState(state), 'utf8')
    } finally {
      await handle.close()
    }
    await rename(temp, file)
  } catch (error) {
    await rm(temp, { force: true })
    throw error
  }
  return file
}

/**
 * Find one server definition by name.
 * @param servers - the list to search.
 * @param name - the definition name.
 * @returns the entry, or undefined.
 */
export function findServer(servers: readonly ServerEntry[], name: string): ServerEntry | undefined {
  return servers.find((server) => server.name === name)
}

/**
 * Insert or replace one definition, preserving list order.
 * @param servers - the current list.
 * @param server - the definition to write.
 * @returns a new list with the definition in place.
 */
export function upsertServer(servers: readonly ServerEntry[], server: ServerEntry): ServerEntry[] {
  const index = servers.findIndex((item) => item.name === server.name)
  if (index < 0) return [...servers, server]
  const next = [...servers]
  next[index] = server
  return next
}

/**
 * Remove one definition.
 * @param servers - the current list.
 * @param name - the definition name to drop.
 * @returns a new list without it.
 */
export function removeServer(servers: readonly ServerEntry[], name: string): ServerEntry[] {
  return servers.filter((server) => server.name !== name)
}

/**
 * Import definitions from another manager's file, without overwriting anything.
 *
 * Accepts both this plugin's own file shape and the `{ version, servers }` shape
 * written by the pre-existing npm package of the same purpose; unknown keys are
 * ignored and every entry arrives disabled unless it was explicitly enabled, so
 * a bulk import can never silently connect a pile of servers on first launch.
 *
 * @param raw - the parsed contents of the foreign file (any shape).
 * @returns the accepted entries and the names that were rejected or already present.
 */
export function importServers(raw: unknown): { accepted: ServerEntry[]; skipped: string[] } {
  const source = raw !== null && typeof raw === 'object' && !Array.isArray(raw)
    ? raw as Record<string, unknown>
    : {}
  const list = Array.isArray(source.servers) ? source.servers : Array.isArray(raw) ? raw : []
  const accepted: ServerEntry[] = []
  const skipped: string[] = []
  for (const item of list) {
    const server = normalizeServer(item)
    if (server === undefined || server.name === '') {
      skipped.push('(unnamed entry)')
      continue
    }
    accepted.push(server)
  }
  return { accepted, skipped }
}
