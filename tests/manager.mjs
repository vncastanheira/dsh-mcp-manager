/**
 * dsh-mcp-manager — the operation facade's two-switch semantics.
 *
 * The panel's master switch was originally wired to the *composition* row's
 * `enabled` and never consulted the settings file, so flipping it in the UI
 * wrote a value nothing read and every server stayed connected — a switch that
 * appears to work is worse than no switch. These tests pin the two switches as
 * genuinely independent and load-bearing, using a stub context so the runtime
 * lifecycle is observable without spawning anything.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { McpManager } from '../src/manager.ts'
import { emptyServer } from '../src/servers.ts'

/** A stub context that records every bridge load and yields an inert fiber. */
function stubContext() {
  const loaded = []
  const disposed = []
  const ctx = {
    loaded,
    disposed,
    tools: { schemas: () => [] },
    plugin: (module, config) => {
      loaded.push(config.serverName)
      const fiber = {
        dispose: async () => { disposed.push(config.serverName) },
        uid: loaded.length,
      }
      // `ctx.plugin` is awaited, so it must be thenable and resolve to the fiber.
      return { then: (resolve) => Promise.resolve(fiber).then(resolve) }
    },
  }
  return ctx
}

/** Build a manager over a throwaway home. */
function harness({ installed = true, servers = [] } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'dsh-mcp-manager-facade-'))
  const ctx = stubContext()
  const manager = new McpManager({ ctx, enabled: () => installed, home })
  return { home, ctx, manager, servers, cleanup: () => rmSync(home, { recursive: true, force: true }) }
}

test('active() requires both the installation and the runtime switch', async () => {
  const a = harness({ installed: true })
  try {
    assert.equal(a.manager.active(), true, 'both on by default')
    await a.manager.patchConfig({ enabled: false })
    assert.equal(a.manager.active(), false, 'the settings-file switch alone must disable it')
    assert.equal(a.manager.masterSwitch(), false)
    await a.manager.patchConfig({ enabled: true })
    assert.equal(a.manager.active(), true)
  } finally {
    a.cleanup()
  }

  const b = harness({ installed: false })
  try {
    assert.equal(b.manager.active(), false, 'a disabled installation can never serve')
  } finally {
    b.cleanup()
  }
})

test('a disabled runtime switch connects nothing, whatever the file lists', async () => {
  const h = harness()
  try {
    await h.manager.addServer({ name: 'one', command: 'node', enabled: true })
    await h.manager.patchConfig({ enabled: false })
    const before = h.ctx.loaded.length
    await h.manager.reconcile()
    assert.equal(h.ctx.loaded.length, before, 'no bridge may be loaded while the switch is off')
    const snapshot = h.manager.snapshot()
    assert.equal(snapshot.servers.length, 1, 'the definition is still listed')
    assert.equal(snapshot.runtime[0].phase, 'stopped', 'but nothing is live')
  } finally {
    h.cleanup()
  }
})

test('turning the switch back on connects every enabled definition', async () => {
  const h = harness()
  try {
    await h.manager.addServer({ name: 'one', command: 'node', enabled: true })
    await h.manager.addServer({ name: 'two', command: 'node', enabled: false })
    await h.manager.patchConfig({ enabled: false })
    h.ctx.loaded.length = 0
    await h.manager.patchConfig({ enabled: true })
    assert.deepEqual(h.ctx.loaded, ['one'], 'only the enabled definition connects')
  } finally {
    h.cleanup()
  }
})

test('disabling one server disposes exactly that bridge', async () => {
  const h = harness()
  try {
    await h.manager.addServer({ name: 'one', command: 'node', enabled: true })
    await h.manager.addServer({ name: 'two', command: 'node', enabled: true })
    h.ctx.disposed.length = 0
    await h.manager.setEnabled('one', false)
    assert.deepEqual(h.ctx.disposed, ['one'])
    const snapshot = h.manager.snapshot()
    assert.equal(snapshot.runtime.find((view) => view.name === 'one')?.phase, 'stopped')
    assert.notEqual(snapshot.runtime.find((view) => view.name === 'two')?.phase, 'stopped')
  } finally {
    h.cleanup()
  }
})

test('removing a server disposes its bridge and drops the definition', async () => {
  const h = harness()
  try {
    await h.manager.addServer({ name: 'gone', command: 'node', enabled: true })
    h.ctx.disposed.length = 0
    const result = await h.manager.removeServer('gone')
    assert.equal(result.ok, true)
    assert.deepEqual(h.ctx.disposed, ['gone'])
    assert.deepEqual(h.manager.snapshot().servers, [])
  } finally {
    h.cleanup()
  }
})

test('a reconnecting definition is rebuilt, an unchanged one is left alone', async () => {
  const h = harness()
  try {
    await h.manager.addServer({ name: 'stable', command: 'node', args: ['a'], enabled: true })
    h.ctx.loaded.length = 0
    // A display-only edit must not tear the connection down.
    await h.manager.updateServer('stable', { description: 'a note' })
    assert.deepEqual(h.ctx.loaded, [])
    assert.deepEqual(h.ctx.disposed, [])
    // A wire-config edit must.
    await h.manager.updateServer('stable', { args: ['b'] })
    assert.deepEqual(h.ctx.disposed, ['stable'])
    assert.deepEqual(h.ctx.loaded, ['stable'])
  } finally {
    h.cleanup()
  }
})

test('a rejected definition never reaches the bridge', async () => {
  const h = harness()
  try {
    const bad = await h.manager.addServer({ name: 'bad name', command: 'node' })
    assert.equal(bad.ok, false)
    assert.match(bad.message, /may only contain/)
    assert.deepEqual(h.ctx.loaded, [])
    assert.deepEqual(h.manager.snapshot().servers, [])
  } finally {
    h.cleanup()
  }
})

test('a rename disconnects the old namespace before the new one connects', async () => {
  const h = harness()
  try {
    await h.manager.addServer({ name: 'before', command: 'node', enabled: true })
    h.ctx.loaded.length = 0
    h.ctx.disposed.length = 0
    const result = await h.manager.updateServer('before', { name: 'after' })
    assert.equal(result.ok, true)
    assert.deepEqual(h.ctx.disposed, ['before'])
    assert.deepEqual(h.ctx.loaded, ['after'])
    assert.deepEqual(h.manager.snapshot().servers.map((server) => server.name), ['after'])
  } finally {
    h.cleanup()
  }
})

test('importing never overwrites an existing definition', async () => {
  const h = harness()
  try {
    await h.manager.addServer({ name: 'keep', command: 'original', enabled: false })
    const { writeFileSync } = await import('node:fs')
    const file = join(h.home, '@wingsky-1', 'dsh-mcp-manager', 'mcp.json')
    const { mkdirSync } = await import('node:fs')
    mkdirSync(join(h.home, '@wingsky-1', 'dsh-mcp-manager'), { recursive: true })
    writeFileSync(file, JSON.stringify({
      servers: [
        { name: 'keep', command: 'IMPOSTOR' },
        { name: 'fresh', command: 'node', enabled: false },
      ],
    }), 'utf8')
    const result = await h.manager.importFrom()
    assert.equal(result.ok, true)
    assert.match(result.message, /mcp\.json/)
    const names = h.manager.snapshot().servers.map((server) => server.name).sort()
    assert.deepEqual(names, ['fresh', 'keep'])
    assert.equal(h.manager.server('keep')?.command, 'original', 'the existing definition is untouched')
  } finally {
    h.cleanup()
  }
})

test('import reports every location it tried when none exists', async () => {
  const h = harness()
  try {
    const result = await h.manager.importFrom()
    assert.equal(result.ok, false)
    assert.match(result.message, /No importable file found/)
    // The replaced package's real layout must be among the candidates.
    assert.match(result.message, /@wingsky-1/)
  } finally {
    h.cleanup()
  }
})

test('a rejected plugin load is reported per server, not thrown', async () => {
  const h = harness()
  try {
    h.ctx.plugin = () => { throw new Error('bridge refused the config') }
    const result = await h.manager.addServer({ name: 'boom', command: 'node', enabled: true })
    assert.equal(result.ok, true, 'persisting succeeded')
    const row = h.manager.snapshot().runtime.find((view) => view.name === 'boom')
    assert.equal(row?.phase, 'error')
    assert.match(String(row?.error), /bridge refused the config/)
  } finally {
    h.cleanup()
  }
})

test('a fresh definition carries the defaults the panel expects', () => {
  const server = emptyServer('x')
  assert.equal(server.transport, 'stdio')
  assert.equal(server.enabled, true)
  assert.equal(server.toolCallTimeoutMs, 60_000)
  assert.deepEqual(server.args, [])
})
