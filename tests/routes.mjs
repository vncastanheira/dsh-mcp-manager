/**
 * dsh-mcp-manager — loopback route surface.
 *
 * The guard is load-bearing: these routes write a config file that can contain an
 * Authorization header, so "loopback only" and "not while disabled" are asserted
 * rather than trusted. The probe's deliberate exemption is asserted too, because
 * it is the portability harness's health check.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { McpManager } from '../src/manager.ts'
import { MANAGER_API, makeRoutes } from '../src/routes.ts'

/** A stub context: the manager only reads the registry and loads plugins. */
const stubCtx = { tools: { schemas: () => [] } }

/** Build a manager + routes over a throwaway home. */
function harness({ enabled = true } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'dsh-mcp-manager-routes-'))
  const manager = new McpManager({ ctx: stubCtx, enabled: () => enabled, home })
  const routes = makeRoutes({ manager, home, enabled: () => enabled })
  return { home, manager, routes, cleanup: () => rmSync(home, { recursive: true, force: true }) }
}

/** Find one registered route by path. */
function routeOf(routes, path) {
  const route = routes.find((item) => item.path === path)
  assert.ok(route, `route ${path} must be registered`)
  return route
}

/** A fake IncomingMessage good enough for the guard and the body reader. */
function fakeRequest({ method = 'GET', body, address = '127.0.0.1', host = '127.0.0.1:3080', headers = {} } = {}) {
  const payload = body === undefined ? [] : [Buffer.from(JSON.stringify(body))]
  return {
    method,
    headers: { host, ...headers },
    socket: { remoteAddress: address },
    async *[Symbol.asyncIterator]() {
      for (const chunk of payload) yield chunk
    },
  }
}

/** A fake ServerResponse capturing status and parsed JSON. */
function fakeResponse() {
  const captured = { status: 0, body: undefined, headers: undefined }
  return {
    captured,
    writeHead(status, headers) {
      captured.status = status
      captured.headers = headers
    },
    end(text) {
      captured.body = text === undefined || text === '' ? undefined : JSON.parse(text)
    },
  }
}

/** Invoke a handler and return what it wrote. */
async function call(route, request) {
  const response = fakeResponse()
  await route.handler(request, response)
  return response.captured
}

test('every documented route is registered exactly once', () => {
  const { routes, cleanup } = harness()
  try {
    assert.equal(routes.length, Object.keys(MANAGER_API).length)
    const paths = routes.map((route) => route.path).sort()
    assert.deepEqual(paths, Object.values(MANAGER_API).sort())
    for (const route of routes) assert.equal(route.kind, 'exact')
  } finally {
    cleanup()
  }
})

test('the probe answers even while the plugin is disabled', async () => {
  const { routes, cleanup } = harness({ enabled: false })
  try {
    const result = await call(routeOf(routes, MANAGER_API.probe), fakeRequest())
    assert.equal(result.status, 200)
    assert.equal(result.body.ok, true)
    assert.equal(result.body.plugin, 'dsh-mcp-manager')
    assert.equal(result.body.enabled, false)
    assert.equal(typeof result.body.pid, 'number')
  } finally {
    cleanup()
  }
})

test('the probe rejects a non-loopback caller', async () => {
  const { routes, cleanup } = harness()
  try {
    const result = await call(routeOf(routes, MANAGER_API.probe), fakeRequest({ address: '10.0.0.4' }))
    assert.equal(result.status, 403)
  } finally {
    cleanup()
  }
})

test('every mutating route refuses while the plugin is disabled', async () => {
  const { routes, cleanup } = harness({ enabled: false })
  try {
    // /state is a GET route: the guard reports the method mismatch first, so the
    // refusal-while-disabled check exercises only the mutating (POST) family.
    for (const path of [MANAGER_API.config, MANAGER_API.server, MANAGER_API.serverRemove,
      MANAGER_API.serverToggle, MANAGER_API.test, MANAGER_API.import, MANAGER_API.reload]) {
      const result = await call(routeOf(routes, path), fakeRequest({ method: 'POST', body: {} }))
      assert.equal(result.status, 503, `${path} must refuse while disabled`)
    }
    const state = await call(routeOf(routes, MANAGER_API.state), fakeRequest())
    assert.equal(state.status, 503, '/state must refuse while disabled')
  } finally {
    cleanup()
  }
})

test('a cross-site caller is refused on a mutating route', async () => {
  const { routes, cleanup } = harness()
  try {
    const result = await call(routeOf(routes, MANAGER_API.config), fakeRequest({
      method: 'POST', body: {}, headers: { 'sec-fetch-site': 'cross-site' },
    }))
    assert.equal(result.status, 403)
  } finally {
    cleanup()
  }
})

test('a wrong method is refused', async () => {
  const { routes, cleanup } = harness()
  try {
    const result = await call(routeOf(routes, MANAGER_API.state), fakeRequest({ method: 'POST' }))
    assert.equal(result.status, 405)
  } finally {
    cleanup()
  }
})

test('state returns the shape the panel renders', async () => {
  const { routes, cleanup } = harness()
  try {
    const result = await call(routeOf(routes, MANAGER_API.state), fakeRequest())
    assert.equal(result.status, 200)
    assert.equal(result.body.ok, true)
    assert.deepEqual(result.body.servers, [])
    assert.deepEqual(result.body.runtime, [])
    assert.deepEqual(result.body.config, { enabled: true, announceToAgent: true })
    assert.ok(Array.isArray(result.body.legacyCandidates))
    assert.ok(typeof result.body.file === 'string' && result.body.file.endsWith('dsh-mcp-manager.json'))
  } finally {
    cleanup()
  }
})

test('a server can be added, listed, toggled and removed over the routes', async () => {
  const { routes, cleanup } = harness()
  try {
    const add = await call(routeOf(routes, MANAGER_API.server), fakeRequest({
      method: 'POST',
      body: { server: { name: 'fixture', transport: 'stdio', command: 'node', args: ['srv.mjs'], enabled: false } },
    }))
    assert.equal(add.status, 200)
    assert.equal(add.body.ok, true)
    assert.deepEqual(add.body.snapshot.servers.map((server) => server.name), ['fixture'])

    const toggle = await call(routeOf(routes, MANAGER_API.serverToggle), fakeRequest({
      method: 'POST', body: { name: 'fixture', enabled: false },
    }))
    assert.equal(toggle.status, 200)
    assert.equal(toggle.body.snapshot.servers[0].enabled, false)

    const remove = await call(routeOf(routes, MANAGER_API.serverRemove), fakeRequest({
      method: 'POST', body: { name: 'fixture' },
    }))
    assert.equal(remove.status, 200)
    assert.deepEqual(remove.body.snapshot.servers, [])
  } finally {
    cleanup()
  }
})

test('an invalid definition is rejected with the host message, not a 500', async () => {
  const { routes, cleanup } = harness()
  try {
    const result = await call(routeOf(routes, MANAGER_API.server), fakeRequest({
      method: 'POST', body: { server: { name: 'bad name', command: 'node' } },
    }))
    assert.equal(result.status, 400)
    assert.equal(result.body.ok, false)
    assert.match(result.body.message, /may only contain/)
  } finally {
    cleanup()
  }
})

test('the import route reports the locations it tried when nothing was found', async () => {
  const { routes, cleanup } = harness()
  try {
    const result = await call(routeOf(routes, MANAGER_API.import), fakeRequest({ method: 'POST', body: {} }))
    assert.equal(result.status, 400)
    assert.match(result.body.message, /No importable file found/)
  } finally {
    cleanup()
  }
})
