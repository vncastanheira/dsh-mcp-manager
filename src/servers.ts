/**
 * dsh-mcp-manager — the server registry model.
 *
 * One MCP server definition, its normalization from untrusted JSON, and the
 * validation that decides whether it may be handed to the harness MCP bridge.
 * This module is deliberately free of cordis and of the filesystem so it can be
 * unit-tested directly (see tests/servers.mjs).
 *
 * The on-disk shape is intentionally compatible with the `mcp-manager-mcp.json`
 * file written by the pre-existing npm package of the same purpose
 * (`{ version: 1, servers: [{ name, transport, enabled, command, args, … }] }`),
 * so an existing definition can be imported verbatim instead of retyped.
 */

/** Valid `serverName` — the harness bridge reserves the same namespace shape. */
export const SERVER_NAME_PATTERN = /^[A-Za-z0-9_-]{1,32}$/

/** Reserved because it would collide with the manager's own `mcp_manager_*` tools. */
export const RESERVED_NAMES: readonly string[] = ['manager', 'mcp_manager']

/** Supported transports. */
export type Transport = 'stdio' | 'streamable-http'

/** Every transport, in the order the settings panel offers them. */
export const TRANSPORTS: readonly Transport[] = ['stdio', 'streamable-http']

/** Automatic reconnect policy, mirrored from the harness MCP client. */
export interface ReconnectSettings {
  /** Reconnect after a lost connection (harness default true). */
  enabled?: boolean
  /** First retry delay in ms, doubling per consecutive failure (default 500). */
  initialDelayMs?: number
  /** Backoff ceiling, also the uptime that resets the attempt budget (default 30000). */
  maxDelayMs?: number
  /** Consecutive failed attempts before giving up (default 10). */
  maxAttempts?: number
}

/** One MCP server definition. */
export interface ServerEntry {
  /**
   * Stable local namespace for this server's tools: everything it exposes is
   * published to the model as `mcp__<name>__<toolName>`.
   */
  name: string
  /** Which transport reaches the server. */
  transport: Transport
  /** Whether the manager should keep this server connected. */
  enabled: boolean
  /** Free-form note shown in the panel (kept out of the wire config). */
  description: string
  /** stdio: executable used to start the server. Empty for streamable-http. */
  command: string
  /** stdio: arguments passed directly, without shell interpolation. */
  args: string[]
  /** stdio: extra environment variables merged on top of the scrubbed ambient env. */
  env: Record<string, string>
  /** stdio: working directory (empty = the harness's own cwd). */
  cwd: string
  /** streamable-http: MCP endpoint URL. Empty for stdio. */
  url: string
  /** streamable-http: extra request headers (e.g. an Authorization bearer). */
  headers: Record<string, string>
  /** Per-call timeout for this server's tools, in milliseconds. */
  toolCallTimeoutMs: number
  /** Reconnect policy forwarded to the harness bridge. */
  reconnect: ReconnectSettings
}

/** Bounds the panel and the tools enforce on the per-call timeout. */
export const TIMEOUT_MIN_MS = 1_000
export const TIMEOUT_MAX_MS = 30 * 60 * 1_000
/** Default per-call timeout, matching the harness bridge default. */
export const TIMEOUT_DEFAULT_MS = 60_000

/** A complete definition with every field resolved. */
export function emptyServer(name = ''): ServerEntry {
  return {
    name,
    transport: 'stdio',
    enabled: true,
    description: '',
    command: '',
    args: [],
    env: {},
    cwd: '',
    url: '',
    headers: {},
    toolCallTimeoutMs: TIMEOUT_DEFAULT_MS,
    reconnect: {},
  }
}

/** Coerce one raw value into a string, falling back on absence. */
function stringOf(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback
}

/** Coerce one raw value into a boolean, falling back on absence. */
function boolOf(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback
}

/** Coerce one raw value into an array of strings, dropping non-strings. */
function stringArrayOf(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((item): item is string => typeof item === 'string')
}

/** Coerce one raw value into a string dictionary, dropping non-string values. */
function stringDictOf(value: unknown): Record<string, string> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return {}
  const out: Record<string, string> = {}
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (typeof item === 'string') out[key] = item
  }
  return out
}

/** Coerce one raw value into a bounded integer, falling back on absence. */
function intOf(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.max(min, Math.min(max, Math.floor(value)))
}

/**
 * Normalize an untrusted reconnect block.
 * @param raw - the raw value from the config file or a panel request.
 * @returns only the fields that were present and well-formed.
 */
export function normalizeReconnect(raw: unknown): ReconnectSettings {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const source = raw as Record<string, unknown>
  const out: ReconnectSettings = {}
  if (typeof source.enabled === 'boolean') out.enabled = source.enabled
  if (typeof source.initialDelayMs === 'number') out.initialDelayMs = intOf(source.initialDelayMs, 500, 1, 2_147_483_647)
  if (typeof source.maxDelayMs === 'number') out.maxDelayMs = intOf(source.maxDelayMs, 30_000, 1, 2_147_483_647)
  if (typeof source.maxAttempts === 'number') out.maxAttempts = intOf(source.maxAttempts, 10, 1, Number.MAX_SAFE_INTEGER)
  return out
}

/**
 * Normalize one untrusted server definition.
 *
 * Tolerant by design: a malformed field falls back to its default instead of
 * discarding the whole server, because losing a hand-written definition to one
 * bad key is worse than showing it with a corrected value.
 *
 * @param raw - the raw value from the config file or a panel request.
 * @returns a complete definition, or `undefined` when the value is not an object.
 */
export function normalizeServer(raw: unknown): ServerEntry | undefined {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const source = raw as Record<string, unknown>
  const base = emptyServer(stringOf(source.name).trim())
  const transport = source.transport === 'streamable-http' ? 'streamable-http' : 'stdio'
  return {
    ...base,
    transport,
    enabled: boolOf(source.enabled, base.enabled),
    description: stringOf(source.description),
    command: stringOf(source.command),
    args: stringArrayOf(source.args),
    env: stringDictOf(source.env),
    cwd: stringOf(source.cwd),
    url: stringOf(source.url),
    headers: stringDictOf(source.headers),
    toolCallTimeoutMs: intOf(source.toolCallTimeoutMs, base.toolCallTimeoutMs, TIMEOUT_MIN_MS, TIMEOUT_MAX_MS),
    reconnect: normalizeReconnect(source.reconnect),
  }
}

/**
 * Normalize a whole untrusted server list, dropping unusable and duplicate entries.
 * @param raw - the raw `servers` array.
 * @returns definitions in file order, deduplicated by name (first wins).
 */
export function normalizeServerList(raw: unknown): ServerEntry[] {
  if (!Array.isArray(raw)) return []
  const out: ServerEntry[] = []
  const seen = new Set<string>()
  for (const item of raw) {
    const server = normalizeServer(item)
    if (server === undefined) continue
    if (server.name === '') continue
    if (seen.has(server.name)) continue
    seen.add(server.name)
    out.push(server)
  }
  return out
}

/**
 * Report every reason a definition may not be connected.
 * @param server - the definition to check.
 * @returns human-readable problems; empty means the definition is connectable.
 */
export function validateServer(server: ServerEntry): string[] {
  const problems: string[] = []
  if (server.name === '') problems.push('name must not be empty')
  else if (!SERVER_NAME_PATTERN.test(server.name)) {
    problems.push(`name "${server.name}" may only contain letters, digits, underscores and hyphens, and be 1–32 characters long`)
  } else if (RESERVED_NAMES.includes(server.name.toLowerCase())) {
    problems.push(`name "${server.name}" is reserved and would collide with the mcp_manager_* tools`)
  }
  if (!TRANSPORTS.includes(server.transport)) problems.push(`transport "${String(server.transport)}" is not supported`)
  if (server.transport === 'stdio') {
    if (server.command.trim() === '') problems.push('a stdio server needs a command')
  } else if (server.url.trim() === '') {
    problems.push('a streamable-http server needs a url')
  }
  if (server.toolCallTimeoutMs < TIMEOUT_MIN_MS || server.toolCallTimeoutMs > TIMEOUT_MAX_MS) {
    problems.push(`toolCallTimeoutMs must be between ${TIMEOUT_MIN_MS} and ${TIMEOUT_MAX_MS}`)
  }
  return problems
}

/**
 * The part of a definition the harness bridge actually consumes.
 *
 * Used for change detection: editing a description or the enabled flag must not
 * tear down and rebuild a live connection, while editing the command must.
 *
 * @param server - the definition.
 * @returns a stable string that changes exactly when the wire config changes.
 */
export function serverSignature(server: ServerEntry): string {
  return JSON.stringify({
    transport: server.transport,
    command: server.command,
    args: server.args,
    env: server.env,
    cwd: server.cwd,
    url: server.url,
    headers: server.headers,
    toolCallTimeoutMs: server.toolCallTimeoutMs,
    reconnect: server.reconnect,
  })
}

/**
 * Project one definition onto the harness MCP bridge config.
 *
 * The bridge is a core plugin (`@deepseek-ai/dsh-mcp-client`); this is the only
 * place its config contract is written down on our side, so a harness change is
 * a one-line fix here rather than a hunt through the manager.
 *
 * `failOnStartupError` is deliberately false: an unreachable server must not
 * fail this plugin's activation (which would take the whole web boot down), and
 * must not stop the bridge from retrying in the background.
 *
 * @param server - a validated definition.
 * @returns the config object passed to the core bridge plugin.
 */
export function toBridgeConfig(server: ServerEntry): Record<string, unknown> {
  const shared = {
    serverName: server.name,
    toolCallTimeoutMs: server.toolCallTimeoutMs,
    failOnStartupError: false,
  }
  if (server.transport === 'stdio') {
    return {
      transport: 'stdio',
      ...shared,
      command: server.command,
      args: server.args,
      env: server.env,
      cwd: server.cwd,
      ...(Object.keys(server.reconnect).length > 0 ? { reconnect: server.reconnect } : {}),
    }
  }
  return {
    transport: 'streamable-http',
    ...shared,
    url: server.url,
    headers: server.headers,
    ...(Object.keys(server.reconnect).length > 0 ? { reconnect: server.reconnect } : {}),
  }
}

/**
 * Merge a partial edit onto an existing definition.
 * @param current - the definition being edited.
 * @param patch - the fields to change (absent fields are kept).
 * @returns a complete, normalized definition.
 */
export function applyPatch(current: ServerEntry, patch: Record<string, unknown>): ServerEntry {
  const merged: Record<string, unknown> = { ...current }
  for (const [key, value] of Object.entries(patch)) {
    if (key === 'name') continue // renaming is a remove + add, handled by the caller
    if (value === undefined) continue
    merged[key] = value
  }
  // An explicit transport switch must not carry the other transport's leftovers
  // into validation: keep both halves, the projection picks the right one.
  return normalizeServer(merged) ?? { ...current }
}
