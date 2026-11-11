/**
 * dsh-mcp-manager — persistence behaviour.
 *
 * The state file holds credentials-adjacent data (a command line, an
 * Authorization header), so its permissions are asserted, not assumed; and a
 * malformed file must degrade to defaults rather than take the panel down.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, statSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { configPath } from '../src/home.ts'
import {
  findServer, importServers, loadState, normalizeConfig, removeServer, saveState, serializeState, upsertServer,
} from '../src/store.ts'
import { emptyServer } from '../src/servers.ts'

/** Run one body against a throwaway home and always clean up. */
async function withHome(body) {
  const home = mkdtempSync(join(tmpdir(), 'dsh-mcp-manager-test-'))
  try {
    return await body(home)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
}

test('a missing state file yields defaults and an empty list', async () => {
  await withHome(async (home) => {
    const view = await loadState(home)
    assert.equal(view.exists, false)
    assert.deepEqual(view.servers, [])
    assert.deepEqual(view.config, { enabled: true, announceToAgent: true })
    assert.equal(view.file, configPath(home))
  })
})

test('a malformed state file degrades to defaults instead of throwing', async () => {
  await withHome(async (home) => {
    writeFileSync(configPath(home), '{ this is not json', 'utf8')
    const view = await loadState(home)
    assert.equal(view.exists, false)
    assert.deepEqual(view.servers, [])
    assert.equal(view.config.enabled, true)
  })
})

test('save then load round-trips the servers and the switches', async () => {
  await withHome(async (home) => {
    const servers = [
      { ...emptyServer('garmin'), command: '/opt/homebrew/bin/uvx', args: ['garmin-mcp'], enabled: true },
      { ...emptyServer('off'), command: 'node', enabled: false },
    ]
    await saveState({ config: { enabled: false, announceToAgent: false }, servers }, home)
    const view = await loadState(home)
    assert.equal(view.exists, true)
    assert.equal(view.config.enabled, false)
    assert.equal(view.config.announceToAgent, false)
    assert.deepEqual(view.servers.map((server) => server.name), ['garmin', 'off'])
    assert.deepEqual(view.servers[0].args, ['garmin-mcp'])
    assert.equal(view.servers[1].enabled, false)
  })
})

test('the state file is written 0600', async () => {
  await withHome(async (home) => {
    const file = await saveState({ config: { enabled: true, announceToAgent: true }, servers: [] }, home)
    assert.equal(statSync(file).mode & 0o777, 0o600)
  })
})

test('loadState reports how many unusable entries were dropped', async () => {
  await withHome(async (home) => {
    writeFileSync(configPath(home), JSON.stringify({
      version: 1,
      servers: [{ name: 'a', command: 'node' }, { name: 'a', command: 'dup' }, { nope: true }],
    }), 'utf8')
    const view = await loadState(home)
    assert.equal(view.servers.length, 1)
    assert.equal(view.dropped, 2)
  })
})

test('the serialized document carries the version and a trailing newline', () => {
  const text = serializeState({ config: { enabled: true, announceToAgent: true }, servers: [] })
  assert.match(text, /"version": 1/)
  assert.ok(text.endsWith('\n'))
  assert.deepEqual(Object.keys(JSON.parse(text)).sort(), ['config', 'servers', 'version'])
})

test('normalizeConfig ignores junk and keeps booleans', () => {
  assert.deepEqual(normalizeConfig({ enabled: false }), { enabled: false, announceToAgent: true })
  assert.deepEqual(normalizeConfig({ enabled: 'no' }), { enabled: true, announceToAgent: true })
  assert.deepEqual(normalizeConfig(null), { enabled: true, announceToAgent: true })
})

test('list helpers preserve order and replace in place', () => {
  const list = [emptyServer('a'), emptyServer('b'), emptyServer('c')]
  const replaced = upsertServer(list, { ...emptyServer('b'), command: 'node' })
  assert.deepEqual(replaced.map((server) => server.name), ['a', 'b', 'c'])
  assert.equal(replaced[1].command, 'node')
  const appended = upsertServer(list, emptyServer('d'))
  assert.deepEqual(appended.map((server) => server.name), ['a', 'b', 'c', 'd'])
  assert.deepEqual(removeServer(list, 'b').map((server) => server.name), ['a', 'c'])
  assert.equal(findServer(list, 'c')?.name, 'c')
  assert.equal(findServer(list, 'zz'), undefined)
  assert.equal(list.length, 3, 'inputs are not mutated')
})

test('importServers reads both this plugin\'s shape and a bare array', () => {
  const wrapped = importServers({
    version: 1,
    servers: [{ name: 'garmin', transport: 'stdio', enabled: true, command: 'uvx', args: ['garmin-mcp'] }],
  })
  assert.equal(wrapped.accepted.length, 1)
  assert.equal(wrapped.accepted[0].name, 'garmin')

  const bare = importServers([{ name: 'x', command: 'node' }, { nope: 1 }])
  assert.equal(bare.accepted.length, 1)
  assert.deepEqual(bare.skipped, ['(unnamed entry)'])
})

test('a state file can be found through DSH_HOME', async () => {
  // The resolution the whole plugin depends on: a relocated home must be read,
  // never the conventional ~/.dsh.
  await withHome(async (home) => {
    mkdirSync(home, { recursive: true })
    await saveState({ config: { enabled: true, announceToAgent: true }, servers: [emptyServer('here')] }, home)
    const previous = process.env.DSH_HOME
    process.env.DSH_HOME = home
    try {
      const view = await loadState()
      assert.deepEqual(view.servers.map((server) => server.name), ['here'])
      assert.equal(configPath(), join(home, 'dsh-mcp-manager.json'))
    } finally {
      if (previous === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = previous
    }
  })
})
