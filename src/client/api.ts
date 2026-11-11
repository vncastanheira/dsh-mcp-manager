/**
 * Browser-side API client for the /api/dsh-mcp-manager route family.
 *
 * The only data access path the settings panel uses — plain fetch, same origin,
 * so no credentials or CORS handling are involved.
 */

/** A server definition as the host reports and accepts it. */
export interface ServerView {
  name: string
  transport: 'stdio' | 'streamable-http'
  enabled: boolean
  description: string
  command: string
  args: string[]
  env: Record<string, string>
  cwd: string
  url: string
  headers: Record<string, string>
  toolCallTimeoutMs: number
  reconnect: Record<string, unknown>
}

/** Where one server stands right now. */
export interface ServerRuntimeView {
  name: string
  phase: 'stopped' | 'starting' | 'active' | 'waiting' | 'error'
  loaded: boolean
  error: string | null
  tools: string[]
  toolCount: number
  since: number | null
}

/** The plugin-level switches. */
export interface ManagerConfigView {
  enabled: boolean
  announceToAgent: boolean
}

/** The panel's state payload. */
export interface ManagerStateView {
  ok: boolean
  config: ManagerConfigView
  servers: ServerView[]
  runtime: ServerRuntimeView[]
  file: string
  exists: boolean
  dropped: number
  bridge: { source: string; via: string } | null
  bridgeError: string | null
  idle: string[]
  home: string
  legacyCandidates: string[]
}

/** A mutation response. */
export interface OpResponse {
  ok: boolean
  message: string
  snapshot: Omit<ManagerStateView, 'ok' | 'home' | 'legacyCandidates'> | null
}

/** A test response. */
export interface TestResponse {
  ok: boolean
  message: string
  tools: string[]
  snapshot: Omit<ManagerStateView, 'ok' | 'home' | 'legacyCandidates'> | null
}

/** An API failure carrying the host's message. */
export class ManagerApiError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ManagerApiError'
  }
}

/** Parse a JSON response or throw. */
async function readJson<T>(response: Response): Promise<T> {
  let body: unknown
  try {
    body = await response.json()
  } catch {
    throw new ManagerApiError(`HTTP ${response.status}: invalid JSON response`)
  }
  if (!response.ok) {
    const message = typeof body === 'object' && body !== null && typeof (body as { error?: unknown }).error === 'string'
      ? (body as { error: string }).error
      : typeof body === 'object' && body !== null && typeof (body as { message?: unknown }).message === 'string'
        ? (body as { message: string }).message
        : `HTTP ${response.status}`
    throw new ManagerApiError(message)
  }
  return body as T
}

/** Plain fetch helper with an error wrapper. */
async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response
  try {
    response = await fetch(path, init)
  } catch (error) {
    throw new ManagerApiError('Network request failed: ' + String(error instanceof Error ? error.message : error))
  }
  return await readJson<T>(response)
}

/** POST one JSON body to a route. */
async function post<T>(path: string, body: Record<string, unknown> = {}): Promise<T> {
  return await request<T>(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

/** The MCP manager panel API. */
export class ManagerApi {
  /** The full state (settings + servers + live runtime). */
  async state(): Promise<ManagerStateView> {
    return await request<ManagerStateView>('/api/dsh-mcp-manager/state')
  }

  /** Patch the plugin switches. */
  async setConfig(patch: Record<string, unknown>): Promise<OpResponse> {
    return await post<OpResponse>('/api/dsh-mcp-manager/config', patch)
  }

  /** Add a server, or update `originalName` with `server`. */
  async saveServer(server: Record<string, unknown>, originalName?: string): Promise<OpResponse> {
    return await post<OpResponse>('/api/dsh-mcp-manager/server', originalName === undefined
      ? { server }
      : { server, originalName })
  }

  /** Delete one server. */
  async removeServer(name: string): Promise<OpResponse> {
    return await post<OpResponse>('/api/dsh-mcp-manager/server/remove', { name })
  }

  /** Enable or disable one server. */
  async toggleServer(name: string, enabled: boolean): Promise<OpResponse> {
    return await post<OpResponse>('/api/dsh-mcp-manager/server/toggle', { name, enabled })
  }

  /** Reconnect one saved server, or try an unsaved draft. */
  async test(name: string, server?: Record<string, unknown>): Promise<TestResponse> {
    return await post<TestResponse>('/api/dsh-mcp-manager/test', server === undefined ? { name } : { name, server })
  }

  /** Import definitions from another manager's file. */
  async importServers(path?: string): Promise<OpResponse> {
    return await post<OpResponse>('/api/dsh-mcp-manager/import', path === undefined || path === '' ? {} : { path })
  }

  /** Re-read the state file and reconcile. */
  async reload(): Promise<OpResponse> {
    return await post<OpResponse>('/api/dsh-mcp-manager/reload')
  }
}
