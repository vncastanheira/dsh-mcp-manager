/**
 * dsh-mcp-manager — loopback HTTP routes for the web panel.
 *
 * Route family: `/api/dsh-mcp-manager/*`. Every route is loopback-only
 * (127.0.0.1 / ::1, same-origin), matching the other dsh-* panels.
 *
 *   GET  /probe            tiny liveness probe (also the portability health route)
 *   GET  /state            settings + servers + live runtime, one snapshot
 *   POST /config           patch the plugin switches
 *   POST /server           add one server, or update one by originalName
 *   POST /server/remove    delete one server (disconnects it first)
 *   POST /server/toggle    enable / disable one server
 *   POST /test             connect a saved server, or try an unsaved draft
 *   POST /import           pull definitions from another manager's file
 *   POST /reload           re-read the state file and reconcile
 *
 * The probe deliberately answers even while the plugin is disabled: it is the
 * portability harness's health check, and a disabled plugin that reports 503
 * would read as "the install is broken" when it is in fact switched off.
 */

import type { IncomingMessage, ServerResponse } from 'node:http'

import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'

import { legacyImportCandidates } from './home.ts'
import type { McpManager } from './manager.ts'
import { describe } from './runtime.ts'

/** Route paths. */
export const MANAGER_API = {
  probe: '/api/dsh-mcp-manager/probe',
  state: '/api/dsh-mcp-manager/state',
  config: '/api/dsh-mcp-manager/config',
  server: '/api/dsh-mcp-manager/server',
  serverRemove: '/api/dsh-mcp-manager/server/remove',
  serverToggle: '/api/dsh-mcp-manager/server/toggle',
  test: '/api/dsh-mcp-manager/test',
  import: '/api/dsh-mcp-manager/import',
  reload: '/api/dsh-mcp-manager/reload',
} as const

/** Cap on JSON request bodies. */
const MAX_JSON_BODY_BYTES = 256 * 1024

/** What the routes need from the mounted plugin. */
export interface RouteDeps {
  /** The operation facade. */
  manager: McpManager
  /** The harness home. */
  home: string
  /** Whether the plugin is currently enabled. */
  enabled: () => boolean
}

/** Whether a request comes from this machine and this origin. */
function isLoopbackRequest(request: IncomingMessage): boolean {
  const address = request.socket.remoteAddress
  if (address !== '127.0.0.1' && address !== '::1' && address !== '::ffff:127.0.0.1') return false
  const host = request.headers.host
  if (typeof host !== 'string') return false
  let hostUrl: URL
  try {
    hostUrl = new URL(`http://${host}`)
  } catch {
    return false
  }
  if (hostUrl.hostname !== '127.0.0.1' && hostUrl.hostname !== 'localhost' && hostUrl.hostname !== '[::1]') return false
  if (request.headers['sec-fetch-site'] === 'cross-site') return false
  const origin = request.headers.origin
  if (origin === undefined) return true
  try {
    return new URL(origin).host === hostUrl.host
  } catch {
    return false
  }
}

/** One JSON response. */
function writeJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'referrer-policy': 'no-referrer',
  })
  res.end(JSON.stringify(body))
}

/** Read and parse a JSON request body (undefined when invalid or oversized). */
async function readJsonBody(request: IncomingMessage): Promise<Record<string, unknown> | undefined> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buffer.length
    if (size > MAX_JSON_BODY_BYTES) return undefined
    chunks.push(buffer)
  }
  if (chunks.length === 0) return {}
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : undefined
  } catch {
    return undefined
  }
}

/** Read a trimmed string field. */
function stringField(body: Record<string, unknown>, key: string): string {
  const value = body[key]
  return typeof value === 'string' ? value.trim() : ''
}

/**
 * Build the route list.
 * @param deps - the mounted plugin's services.
 * @returns the routes to register on the host web server.
 */
export function makeRoutes(deps: RouteDeps): WebRoute[] {
  const guard = (req: IncomingMessage, res: ServerResponse, method: string): boolean => {
    if (!isLoopbackRequest(req)) {
      writeJson(res, 403, { error: 'forbidden: loopback-only' })
      return false
    }
    if (req.method !== method) {
      writeJson(res, 405, { error: `method not allowed: ${req.method}` })
      return false
    }
    if (!deps.enabled()) {
      writeJson(res, 503, { error: 'plugin disabled' })
      return false
    }
    return true
  }

  return [
    {
      kind: 'exact' as const,
      path: MANAGER_API.probe,
      handler: (req: IncomingMessage, res: ServerResponse) => {
        if (!isLoopbackRequest(req)) {
          writeJson(res, 403, { error: 'forbidden: loopback-only' })
          return
        }
        if (req.method !== 'GET' && req.method !== 'HEAD') {
          writeJson(res, 405, { error: `method not allowed: ${req.method}` })
          return
        }
        const snapshot = deps.manager.snapshot()
        // `managerTools` is the only observable proof that the agent-tool half
        // mounted: those tools live on the tool registry, not behind a route.
        const managerTools = deps.manager.ownToolNames()
        writeJson(res, 200, {
          ok: true,
          plugin: 'dsh-mcp-manager',
          pid: process.pid,
          // Two switches, reported separately so a health check can tell
          // "switched off on purpose" from "failed to mount".
          enabled: deps.enabled(),
          masterSwitch: deps.manager.masterSwitch(),
          serving: deps.enabled() && deps.manager.masterSwitch(),
          home: deps.home,
          servers: snapshot.servers.length,
          toolCount: snapshot.runtime.reduce((sum, view) => sum + view.toolCount, 0),
          managerTools,
          managerToolCount: managerTools.length,
          bridge: snapshot.bridge?.via ?? null,
          bridgeError: snapshot.bridgeError,
        })
      },
    },
    {
      kind: 'exact' as const,
      path: MANAGER_API.state,
      handler: async (req: IncomingMessage, res: ServerResponse) => {
        if (!guard(req, res, 'GET')) return
        try {
          const snapshot = deps.manager.snapshot()
          writeJson(res, 200, {
            ok: true,
            ...snapshot,
            home: deps.home,
            legacyCandidates: legacyImportCandidates(deps.home),
          })
        } catch (error) {
          writeJson(res, 500, { error: describe(error) })
        }
      },
    },
    {
      kind: 'exact' as const,
      path: MANAGER_API.config,
      handler: async (req: IncomingMessage, res: ServerResponse) => {
        if (!guard(req, res, 'POST')) return
        const body = await readJsonBody(req)
        if (body === undefined) {
          writeJson(res, 400, { error: 'invalid JSON body' })
          return
        }
        const result = await deps.manager.patchConfig(body)
        writeJson(res, result.ok ? 200 : 400, { ok: result.ok, message: result.message, snapshot: result.snapshot ?? null })
      },
    },
    {
      kind: 'exact' as const,
      path: MANAGER_API.server,
      handler: async (req: IncomingMessage, res: ServerResponse) => {
        if (!guard(req, res, 'POST')) return
        const body = await readJsonBody(req)
        if (body === undefined) {
          writeJson(res, 400, { error: 'invalid JSON body' })
          return
        }
        const definition = body.server
        if (definition === null || typeof definition !== 'object' || Array.isArray(definition)) {
          writeJson(res, 400, { error: 'server must be an object' })
          return
        }
        const originalName = stringField(body, 'originalName')
        const result = originalName === ''
          ? await deps.manager.addServer(definition)
          : await deps.manager.updateServer(originalName, definition as Record<string, unknown>)
        writeJson(res, result.ok ? 200 : 400, { ok: result.ok, message: result.message, snapshot: result.snapshot ?? null })
      },
    },
    {
      kind: 'exact' as const,
      path: MANAGER_API.serverRemove,
      handler: async (req: IncomingMessage, res: ServerResponse) => {
        if (!guard(req, res, 'POST')) return
        const body = await readJsonBody(req)
        if (body === undefined) {
          writeJson(res, 400, { error: 'invalid JSON body' })
          return
        }
        const name = stringField(body, 'name')
        if (name === '') {
          writeJson(res, 400, { error: 'name is required' })
          return
        }
        const result = await deps.manager.removeServer(name)
        writeJson(res, result.ok ? 200 : 400, { ok: result.ok, message: result.message, snapshot: result.snapshot ?? null })
      },
    },
    {
      kind: 'exact' as const,
      path: MANAGER_API.serverToggle,
      handler: async (req: IncomingMessage, res: ServerResponse) => {
        if (!guard(req, res, 'POST')) return
        const body = await readJsonBody(req)
        if (body === undefined) {
          writeJson(res, 400, { error: 'invalid JSON body' })
          return
        }
        const name = stringField(body, 'name')
        const enabled = body.enabled === true
        if (name === '') {
          writeJson(res, 400, { error: 'name is required' })
          return
        }
        const result = await deps.manager.setEnabled(name, enabled)
        writeJson(res, result.ok ? 200 : 400, { ok: result.ok, message: result.message, snapshot: result.snapshot ?? null })
      },
    },
    {
      kind: 'exact' as const,
      path: MANAGER_API.test,
      handler: async (req: IncomingMessage, res: ServerResponse) => {
        if (!guard(req, res, 'POST')) return
        const body = await readJsonBody(req)
        if (body === undefined) {
          writeJson(res, 400, { error: 'invalid JSON body' })
          return
        }
        const name = stringField(body, 'name')
        const definition = body.server
        try {
          const result = definition !== null && typeof definition === 'object' && !Array.isArray(definition)
            ? await deps.manager.test(undefined, definition)
            : await deps.manager.test(name === '' ? undefined : name, undefined)
          writeJson(res, result.ok ? 200 : 400, {
            ok: result.ok,
            message: result.message,
            tools: result.tools,
            snapshot: result.snapshot,
          })
        } catch (error) {
          writeJson(res, 500, { error: describe(error) })
        }
      },
    },
    {
      kind: 'exact' as const,
      path: MANAGER_API.import,
      handler: async (req: IncomingMessage, res: ServerResponse) => {
        if (!guard(req, res, 'POST')) return
        const body = await readJsonBody(req)
        if (body === undefined) {
          writeJson(res, 400, { error: 'invalid JSON body' })
          return
        }
        const path = stringField(body, 'path')
        const result = await deps.manager.importFrom(path === '' ? undefined : path)
        writeJson(res, result.ok ? 200 : 400, { ok: result.ok, message: result.message, snapshot: result.snapshot ?? null })
      },
    },
    {
      kind: 'exact' as const,
      path: MANAGER_API.reload,
      handler: async (req: IncomingMessage, res: ServerResponse) => {
        if (!guard(req, res, 'POST')) return
        try {
          const snapshot = await deps.manager.refresh()
          writeJson(res, 200, { ok: true, message: 'Re-read the config and reconnected.', snapshot })
        } catch (error) {
          writeJson(res, 500, { error: describe(error) })
        }
      },
    },
  ]
}
