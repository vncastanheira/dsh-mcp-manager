/**
 * dsh-mcp-manager — server definition model conformance.
 *
 * Two of these assertions guard the interoperability this plugin exists for:
 * the on-disk shape must still accept a definition written by the manager
 * package this one replaces, and the projection must send the harness bridge
 * exactly the field names its schema validates.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  applyPatch, emptyServer, normalizeServer, normalizeServerList, normalizeReconnect,
  serverSignature, toBridgeConfig, validateServer,
  SERVER_NAME_PATTERN, TIMEOUT_DEFAULT_MS,
} from '../src/servers.ts'

test('normalizeServer fills every field and keeps the given values', () => {
  const server = normalizeServer({
    name: 'garmin',
    transport: 'stdio',
    enabled: false,
    command: '/opt/homebrew/bin/uvx',
    args: ['garmin-mcp'],
    env: { GARMIN_WRITE_ENABLED: '0' },
    description: 'health data',
  })
  assert.ok(server)
  assert.equal(server.name, 'garmin')
  assert.equal(server.transport, 'stdio')
  assert.equal(server.enabled, false)
  assert.deepEqual(server.args, ['garmin-mcp'])
  assert.deepEqual(server.env, { GARMIN_WRITE_ENABLED: '0' })
  assert.equal(server.toolCallTimeoutMs, TIMEOUT_DEFAULT_MS)
  assert.deepEqual(server.reconnect, {})
  assert.equal(server.url, '')
})

test('normalizeServer accepts the shape the replaced manager package wrote', () => {
  // Byte-for-byte the contents of ~/.dsh/backup-remove-mcp-manager-*/mcp-manager-mcp.json.
  const legacy = {
    version: 1,
    servers: [
      {
        name: 'garmin',
        transport: 'stdio',
        enabled: true,
        command: '/opt/homebrew/bin/uvx',
        args: ['garmin-mcp'],
        description: 'Garmin Connect personal health/activity data (read-only; write tools need GARMIN_WRITE_ENABLED=1, off by default)',
      },
    ],
  }
  const list = normalizeServerList(legacy.servers)
  assert.equal(list.length, 1)
  assert.equal(list[0].name, 'garmin')
  assert.equal(list[0].enabled, true)
  assert.deepEqual(list[0].args, ['garmin-mcp'])
  assert.match(list[0].description, /read-only/)
})

test('normalizeServer tolerates junk field types instead of discarding the server', () => {
  const server = normalizeServer({ name: 'x', args: 'not-an-array', env: [1, 2], enabled: 'yes' })
  assert.ok(server)
  assert.deepEqual(server.args, [])
  assert.deepEqual(server.env, {})
  // A non-boolean falls back to the default rather than being coerced truthily.
  assert.equal(server.enabled, true)
})

test('normalizeServer drops non-objects and normalizeServerList dedupes by name', () => {
  assert.equal(normalizeServer(null), undefined)
  assert.equal(normalizeServer([]), undefined)
  assert.equal(normalizeServer('x'), undefined)
  const list = normalizeServerList([
    { name: 'a', command: 'one' },
    { name: 'a', command: 'two' },
    { name: '', command: 'anon' },
    null,
    { name: 'b', command: 'three' },
  ])
  assert.deepEqual(list.map((item) => item.name), ['a', 'b'])
  assert.equal(list[0].command, 'one', 'first definition wins')
})

test('normalizeReconnect keeps only well-formed fields and floors integers', () => {
  assert.deepEqual(normalizeReconnect({ enabled: false, maxAttempts: 3.7 }), { enabled: false, maxAttempts: 3 })
  assert.deepEqual(normalizeReconnect({ nope: 1 }), {})
  assert.deepEqual(normalizeReconnect(null), {})
})

test('validateServer reports every reason a definition cannot connect', () => {
  const good = { ...emptyServer('ok'), command: 'node' }
  assert.deepEqual(validateServer(good), [])

  assert.match(validateServer(emptyServer('')).join('; '), /name must not be empty/)
  assert.match(validateServer({ ...emptyServer('has space'), command: 'x' }).join('; '), /may only contain/)
  assert.match(validateServer({ ...emptyServer('manager'), command: 'x' }).join('; '), /reserved/)
  assert.match(validateServer({ ...emptyServer('sig'), command: '' }).join('; '), /needs a command/)

  const http = normalizeServer({ name: 'remote', transport: 'streamable-http' })
  assert.ok(http)
  assert.match(validateServer(http).join('; '), /needs a url/)
  assert.deepEqual(validateServer({ ...http, url: 'https://example.com/mcp' }), [])
})

test('serverSignature ignores display-only edits and tracks the wire config', () => {
  const base = { ...emptyServer('a'), command: 'node', args: ['server.mjs'] }
  assert.equal(serverSignature(base), serverSignature({ ...base, description: 'changed', enabled: false }))
  assert.notEqual(serverSignature(base), serverSignature({ ...base, args: ['other.mjs'] }))
  assert.notEqual(serverSignature(base), serverSignature({ ...base, toolCallTimeoutMs: 5000 }))
})

test('toBridgeConfig emits the field names the harness bridge schema validates', () => {
  const stdio = toBridgeConfig({ ...emptyServer('g'), command: '/bin/uvx', args: ['garmin-mcp'], env: { A: 'b' }, cwd: '/tmp' })
  assert.deepEqual(stdio, {
    transport: 'stdio',
    serverName: 'g',
    toolCallTimeoutMs: TIMEOUT_DEFAULT_MS,
    failOnStartupError: false,
    command: '/bin/uvx',
    args: ['garmin-mcp'],
    env: { A: 'b' },
    cwd: '/tmp',
  })

  const http = toBridgeConfig(normalizeServer({ name: 'r', transport: 'streamable-http', url: 'https://x/mcp', headers: { A: 'b' } }))
  assert.deepEqual(http, {
    transport: 'streamable-http',
    serverName: 'r',
    toolCallTimeoutMs: TIMEOUT_DEFAULT_MS,
    failOnStartupError: false,
    url: 'https://x/mcp',
    headers: { A: 'b' },
  })
})

test('toBridgeConfig forwards a reconnect block only when it was configured', () => {
  const plain = toBridgeConfig({ ...emptyServer('p'), command: 'node' })
  assert.equal('reconnect' in plain, false)
  const tuned = toBridgeConfig({ ...emptyServer('t'), command: 'node', reconnect: { maxAttempts: 2 } })
  assert.deepEqual(tuned.reconnect, { maxAttempts: 2 })
})

test('applyPatch merges an edit and refuses to change nothing it was not given', () => {
  const current = { ...emptyServer('a'), command: 'node', args: ['x'], description: 'keep me' }
  const next = applyPatch(current, { args: ['y'] })
  assert.equal(next.name, 'a')
  assert.deepEqual(next.args, ['y'])
  assert.equal(next.description, 'keep me')
  assert.equal(next.command, 'node')
})

test('the server-name pattern matches the bridge namespace contract', () => {
  assert.ok(SERVER_NAME_PATTERN.test('garmin'))
  assert.ok(SERVER_NAME_PATTERN.test('a-b_c9'))
  assert.ok(SERVER_NAME_PATTERN.test('x'.repeat(32)))
  assert.equal(SERVER_NAME_PATTERN.test('x'.repeat(33)), false)
  assert.equal(SERVER_NAME_PATTERN.test('has space'), false)
  assert.equal(SERVER_NAME_PATTERN.test(''), false)
})
