/**
 * dsh-mcp-manager — model-facing tools.
 *
 *   mcp_manager_status   read-only: plugin state, the bridge it drives, counts.
 *   mcp_manager_list     read-only: every server with its live tools and error.
 *   mcp_manager_add      add a stdio / Streamable HTTP server and connect it.
 *   mcp_manager_update   edit a server (including rename and enable/disable).
 *   mcp_manager_remove   delete a server. Without `confirm` it only previews.
 *   mcp_manager_test     connect a saved server — or an unsaved draft — and list
 *                        the tools it offers.
 *   mcp_manager_import   pull definitions out of another manager's file.
 *   mcp_manager_reload   re-read the state file and reconcile.
 *
 * The removal tool is deliberately two-step, matching the rest of the suite:
 * called without `confirm` it returns exactly what would be removed, so the
 * model can show the user before anything is written.
 */

import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools'

import type { McpManager, ManagerSnapshot, OpResult } from './manager.ts'
import { validateServer, type ServerEntry } from './servers.ts'
import { describe } from './runtime.ts'

/** One text content block (the only render shape these tools emit). */
function text(value: string): ContentBlock[] {
  return [{ type: 'text', text: value }]
}

/** A JSON data-model value, the shape the tool-output schema enforces. */
type Json = null | boolean | number | string | Json[] | { [key: string]: Json }

/**
 * Project a value onto the JSON data model the output schema validates.
 * Tool outputs are re-validated and replayed, so a rich object must be provably
 * JSON-safe before it is returned.
 * @param value - any JSON-serializable value.
 * @returns the JSON projection.
 */
function toJson(value: unknown): Json {
  return JSON.parse(JSON.stringify(value ?? null)) as Json
}

/** Render the tool's `message` field. */
function renderMessage(_args: unknown, value: Record<string, unknown>): ContentBlock[] {
  return text(String(value.message ?? ''))
}

/** The output schema shared by every mutating tool. */
const OP_OUTPUT = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ok: { type: 'boolean', required: true },
    message: { type: 'string', required: true },
    servers: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          name: { type: 'string', required: true },
          transport: { type: 'string', required: true },
          enabled: { type: 'boolean', required: true },
          phase: { type: 'string', required: true },
          toolCount: { type: 'number', required: true },
          error: { type: 'string' },
        },
      },
    },
  },
} as const

/** One row of the server table, as a JSON-safe record. */
function serverRows(snapshot: ManagerSnapshot): Json[] {
  const runtime = new Map(snapshot.runtime.map((view) => [view.name, view]))
  return snapshot.servers.map((server) => {
    const view = runtime.get(server.name)
    return {
      name: server.name,
      transport: server.transport,
      enabled: server.enabled,
      phase: view?.phase ?? 'stopped',
      toolCount: view?.toolCount ?? 0,
      ...(view?.error != null ? { error: view.error } : {}),
    } as Json
  })
}

/** Render a compact, human-readable server table. */
function renderServerTable(snapshot: ManagerSnapshot): string {
  if (snapshot.servers.length === 0) {
    return '(No MCP servers configured yet)'
  }
  const runtime = new Map(snapshot.runtime.map((view) => [view.name, view]))
  const lines = snapshot.servers.map((server) => {
    const view = runtime.get(server.name)
    const phase = view?.phase ?? 'stopped'
    const mark = phase === 'active' ? '●' : phase === 'error' ? '✖' : phase === 'starting' || phase === 'waiting' ? '◌' : '○'
    const short = server.transport === 'stdio' ? `${server.command} ${server.args.join(' ')}`.trim() : server.url
    const detail = view?.error != null ? `  ⚠️ ${view.error}` : ''
    return `${mark} ${server.name}  [${server.transport}]  ${phase}  ${view?.toolCount ?? 0} tools${detail}\n    ${short}`
  })
  return lines.join('\n')
}

/** Everything the tools need from the mounted plugin. */
export interface ToolContext {
  /** The operation facade. */
  manager: McpManager
  /** Whether servers may currently connect (both switches on). */
  enabled: () => boolean
  /** The persisted runtime master switch alone, for an honest status line. */
  masterSwitch: () => boolean
  /** The state-file path, for error messages. */
  file: () => string
}

/** Guard every mutating tool behind the effective enablement. */
function disabled(enabled: () => boolean): OpResult | undefined {
  if (enabled()) return undefined
  return {
    ok: false,
    message: 'dsh-mcp-manager is disabled (the MCP master switch is off, or the plugin is disabled in the profile); '
      + 're-enable it from the "MCP Manager" card in Settings, or set enabled back to true in the config file.',
  }
}

/** Tool: plugin and connection status. */
export function statusTool(ctx: ToolContext): ToolDefinition {
  return defineTool({
    name: 'mcp_manager_status',
    description:
      'Show the dsh-mcp-manager plugin status: how many MCP servers are configured and connected, how many tools each ' +
      'contributes, whether the plugin is enabled, where the harness MCP bridge is loaded from, and the state file ' +
      'path. Read-only: it neither connects nor changes anything.',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          message: { type: 'string', required: true },
          enabled: { type: 'boolean' },
          total: { type: 'number' },
          active: { type: 'number' },
          idle: { type: 'number' },
          toolCount: { type: 'number' },
          bridge: { type: 'string' },
          bridgeError: { type: 'string' },
          file: { type: 'string' },
          servers: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                name: { type: 'string', required: true },
                transport: { type: 'string', required: true },
                enabled: { type: 'boolean', required: true },
                phase: { type: 'string', required: true },
                toolCount: { type: 'number', required: true },
                error: { type: 'string' },
              },
            },
          },
        },
      },
      render: renderMessage,
    },
    async execute() {
      const snapshot = ctx.manager.snapshot()
      const active = snapshot.runtime.filter((view) => view.phase === 'active').length
      const idle = snapshot.runtime.filter((view) => view.phase === 'waiting' || view.phase === 'starting').length
      const toolCount = snapshot.runtime.reduce((sum, view) => sum + view.toolCount, 0)
      const bridge = snapshot.bridge !== null ? `${snapshot.bridge.source} (${snapshot.bridge.via})` : ''
      const lines = [
        ctx.enabled() ? 'MCP master switch: on' : 'MCP master switch: off (all servers disconnected)',
        ctx.masterSwitch() ? '' : '(enabled=false in the config file)',
        `${snapshot.servers.length} servers configured: ${active} connected, ${idle} without tools`,
        `${toolCount} MCP tools in total`,
        snapshot.bridge !== null ? `MCP bridge ${bridge}` : 'MCP bridge not loaded',
        snapshot.bridgeError !== null ? `Bridge load failed: ${snapshot.bridgeError}` : '',
        `State file ${snapshot.file}`,
      ].filter((line) => line !== '')
      return {
        ok: snapshot.bridgeError === null,
        message: `dsh-mcp-manager: ${lines.join('; ')}.\n${renderServerTable(snapshot)}`,
        enabled: ctx.enabled(),
        total: snapshot.servers.length,
        active,
        idle,
        toolCount,
        bridge,
        ...(snapshot.bridgeError !== null ? { bridgeError: snapshot.bridgeError } : {}),
        file: snapshot.file,
        servers: serverRows(snapshot) as never,
      }
    },
  })
}

/** Tool: list servers with their live state. */
export function listTool(ctx: ToolContext): ToolDefinition {
  return defineTool({
    name: 'mcp_manager_list',
    description:
      'List every MCP server configured in dsh-mcp-manager: name, transport, enabled flag, current phase (active = ' +
      'connected / waiting = no tools yet / error = failed / stopped = not loaded), the tool count and full tool ' +
      'names it contributes, and its latest error. Read-only.',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          message: { type: 'string', required: true },
          servers: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                name: { type: 'string', required: true },
                transport: { type: 'string', required: true },
                enabled: { type: 'boolean', required: true },
                phase: { type: 'string', required: true },
                toolCount: { type: 'number', required: true },
                error: { type: 'string' },
                tools: { type: 'array', items: { type: 'string' } },
              },
            },
          },
        },
      },
      render: renderMessage,
    },
    async execute() {
      const snapshot = ctx.manager.snapshot()
      const detail = snapshot.runtime
        .filter((view) => view.tools.length > 0)
        .map((view) => `${view.name}: ${view.tools.join(', ')}`)
        .join('\n')
      return {
        ok: true,
        message: `${renderServerTable(snapshot)}\n\n${detail === '' ? '(no MCP tools are currently registered)' : detail}`,
        servers: snapshot.servers.map((server) => {
          const view = snapshot.runtime.find((item) => item.name === server.name)
          return {
            name: server.name,
            transport: server.transport,
            enabled: server.enabled,
            phase: view?.phase ?? 'stopped',
            toolCount: view?.toolCount ?? 0,
            ...(view?.error != null ? { error: view.error } : {}),
            tools: (view?.tools ?? []) as never,
          }
        }) as never,
      }
    },
  })
}

/** Tool: add a server. */
export function addTool(ctx: ToolContext): ToolDefinition {
  return defineTool({
    name: 'mcp_manager_add',
    description:
      'Add an MCP server to dsh-mcp-manager and connect it immediately (no DSH restart needed). For a stdio server pass ' +
      'command/args/env/cwd; for a remote server pass transport=streamable-http with url/headers. name becomes the tool ' +
      'namespace: the server\'s tools are published as mcp__<name>__<toolName>. Use mcp_manager_test with a draft first ' +
      'to verify the definition.',
    parameters: {
      name: { type: 'string', description: 'Server namespace: letters, digits, underscores and hyphens only, 1–32 characters', required: true },
      transport: { type: 'string', enum: ['stdio', 'streamable-http'], description: 'Transport (default stdio)' },
      command: { type: 'string', description: 'stdio: command that starts the server (e.g. /opt/homebrew/bin/uvx)' },
      args: { type: 'array', items: { type: 'string' }, description: 'stdio: command arguments, passed one by one without a shell' },
      env: { type: 'object', additionalProperties: true, description: 'stdio: extra environment variables (string keys and values)' },
      cwd: { type: 'string', description: 'stdio: working directory (optional)' },
      url: { type: 'string', description: 'streamable-http: MCP endpoint URL' },
      headers: { type: 'object', additionalProperties: true, description: 'streamable-http: extra request headers' },
      description: { type: 'string', description: 'Note for display only; not part of the connection config' },
      toolCallTimeoutMs: { type: 'number', description: 'Per-call timeout in milliseconds (default 60000)' },
      enabled: { type: 'boolean', description: 'Whether to enable it immediately (default true)' },
    },
    output: { schema: OP_OUTPUT, render: renderMessage },
    async execute(args) {
      const blocked = disabled(ctx.enabled)
      if (blocked !== undefined) return { ok: blocked.ok, message: blocked.message }
      const result = await ctx.manager.addServer(args as Record<string, unknown>)
      return {
        ok: result.ok,
        message: `${result.message}\n${renderServerTable(result.snapshot ?? ctx.manager.snapshot())}`,
        servers: serverRows(result.snapshot ?? ctx.manager.snapshot()) as never,
      }
    },
  })
}

/** Tool: update a server. */
export function updateTool(ctx: ToolContext): ToolDefinition {
  return defineTool({
    name: 'mcp_manager_update',
    description:
      'Edit an existing MCP server in dsh-mcp-manager: any of transport/command/args/env/cwd/url/headers/description/' +
      'toolCallTimeoutMs, and enabled to toggle it. Changing name renames it (the old namespace is disconnected and the ' +
      'server reconnects under the new name). Pass only the fields you want to change.',
    parameters: {
      name: { type: 'string', description: 'Current name of the server to update', required: true },
      newName: { type: 'string', description: 'New name (omit to keep the current name)' },
      transport: { type: 'string', enum: ['stdio', 'streamable-http'], description: 'Transport' },
      command: { type: 'string', description: 'stdio: command that starts the server' },
      args: { type: 'array', items: { type: 'string' }, description: 'stdio: command arguments' },
      env: { type: 'object', additionalProperties: true, description: 'stdio: extra environment variables' },
      cwd: { type: 'string', description: 'stdio: working directory' },
      url: { type: 'string', description: 'streamable-http: endpoint URL' },
      headers: { type: 'object', additionalProperties: true, description: 'streamable-http: extra request headers' },
      description: { type: 'string', description: 'Note' },
      toolCallTimeoutMs: { type: 'number', description: 'Per-call timeout in milliseconds' },
      enabled: { type: 'boolean', description: 'Enable / disable' },
    },
    output: { schema: OP_OUTPUT, render: renderMessage },
    async execute(args) {
      const blocked = disabled(ctx.enabled)
      if (blocked !== undefined) return { ok: blocked.ok, message: blocked.message }
      const patch: Record<string, unknown> = { ...(args as Record<string, unknown>) }
      delete patch.name
      const newName = patch.newName
      delete patch.newName
      if (typeof newName === 'string' && newName.trim() !== '') patch.name = newName
      const result = await ctx.manager.updateServer(String((args as Record<string, unknown>).name), patch)
      return {
        ok: result.ok,
        message: `${result.message}\n${renderServerTable(result.snapshot ?? ctx.manager.snapshot())}`,
        servers: serverRows(result.snapshot ?? ctx.manager.snapshot()) as never,
      }
    },
  })
}

/** Tool: remove a server (two-step). */
export function removeTool(ctx: ToolContext): ToolDefinition {
  return defineTool({
    name: 'mcp_manager_remove',
    description:
      'Remove an MCP server from dsh-mcp-manager and unregister all of its tools. **Without confirm it only previews ' +
      'and returns exactly what would be removed, writing nothing** — show the preview to the user first, and only pass ' +
      'confirm: true after they agree.',
    parameters: {
      name: { type: 'string', description: 'Name of the server to remove', required: true },
      confirm: { type: 'boolean', description: 'Pass true to actually remove (means the user has agreed)' },
    },
    output: { schema: OP_OUTPUT, render: renderMessage },
    async execute(args) {
      const name = String((args as Record<string, unknown>).name)
      const confirm = (args as Record<string, unknown>).confirm === true
      const target = ctx.manager.server(name)
      if (target === undefined) {
        return { ok: false, message: `No server named "${name}".`, servers: serverRows(ctx.manager.snapshot()) as never }
      }
      const view = ctx.manager.snapshot().runtime.find((item) => item.name === name)
      if (!confirm) {
        const detail = target.transport === 'stdio'
          ? `${target.command} ${target.args.join(' ')}`
          : target.url
        return {
          ok: true,
          message: [
            `Preview: removing server "${name}" and unregistering its current ${view?.toolCount ?? 0} tools:`,
            `  Transport: ${target.transport}`,
            `  Definition: ${detail}`,
            view !== undefined && view.tools.length > 0 ? `  Tools: ${view.tools.join(', ')}` : '  Tools: (none)',
            'Nothing was written. To delete it, call again with confirm: true.',
          ].join('\n'),
          servers: serverRows(ctx.manager.snapshot()) as never,
        }
      }
      const blocked = disabled(ctx.enabled)
      if (blocked !== undefined) return { ok: blocked.ok, message: blocked.message }
      const result = await ctx.manager.removeServer(name)
      return {
        ok: result.ok,
        message: `${result.message}\n${renderServerTable(result.snapshot ?? ctx.manager.snapshot())}`,
        servers: serverRows(result.snapshot ?? ctx.manager.snapshot()) as never,
      }
    },
  })
}

/** Tool: test a saved server or an unsaved draft. */
export function testTool(ctx: ToolContext): ToolDefinition {
  return defineTool({
    name: 'mcp_manager_test',
    description:
      'Test whether an MCP server can connect, and list the tools it offers. Two modes: pass name to reconnect the ' +
      'saved server (it disconnects first); or pass name plus command/args (or url) as a **draft** — the draft is never ' +
      'saved, and it disconnects and restores the previous state when done. This is the most reliable way to verify a ' +
      'definition before adding it.',
    parameters: {
      name: { type: 'string', description: 'Server name (in draft mode, the namespace to use for this test)', required: true },
      draft: { type: 'boolean', description: 'When true, treat the fields of this call as a draft and do not save them' },
      transport: { type: 'string', enum: ['stdio', 'streamable-http'], description: 'Draft: transport' },
      command: { type: 'string', description: 'Draft: stdio command' },
      args: { type: 'array', items: { type: 'string' }, description: 'Draft: stdio command arguments' },
      env: { type: 'object', additionalProperties: true, description: 'Draft: stdio extra environment variables' },
      url: { type: 'string', description: 'Draft: streamable-http endpoint URL' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          message: { type: 'string', required: true },
          tools: { type: 'array', items: { type: 'string' } },
        },
      },
      render: renderMessage,
    },
    async execute(args) {
      const raw = args as Record<string, unknown>
      const name = String(raw.name)
      const useDraft = raw.draft === true || raw.command !== undefined || raw.url !== undefined
      try {
        if (useDraft) {
          const result = await ctx.manager.test(undefined, {
            name,
            transport: raw.transport,
            command: raw.command,
            args: raw.args,
            env: raw.env,
            url: raw.url,
            enabled: true,
          })
          return { ok: result.ok, message: result.message, tools: result.tools as never }
        }
        if (!ctx.enabled()) {
          return { ok: false, message: 'dsh-mcp-manager is disabled, so nothing can connect.', tools: [] as never }
        }
        const result = await ctx.manager.test(name, undefined)
        return { ok: result.ok, message: result.message, tools: result.tools as never }
      } catch (error) {
        return { ok: false, message: `Test failed: ${describe(error)}`, tools: [] as never }
      }
    },
  })
}

/** Tool: import definitions from another manager's file. */
export function importTool(ctx: ToolContext): ToolDefinition {
  return defineTool({
    name: 'mcp_manager_import',
    description:
      'Import server definitions from another MCP manager\'s config file (existing names are never overwritten; ' +
      'imported entries connect according to their own enabled flag). Without path it tries, in order: ' +
      '$DSH_HOME/@wingsky-1/dsh-mcp-manager/mcp.json (where the package this plugin replaces stores them), ' +
      '$DSH_HOME/mcp-servers.json, $DSH_HOME/mcp-manager-mcp.json, $DSH_HOME/dsh-mcp-manager/servers.json.',
    parameters: {
      path: { type: 'string', description: 'File to import (omit to try the default locations)' },
    },
    output: { schema: OP_OUTPUT, render: renderMessage },
    async execute(args) {
      const blocked = disabled(ctx.enabled)
      if (blocked !== undefined) return { ok: blocked.ok, message: blocked.message }
      const path = (args as Record<string, unknown>).path
      const result = await ctx.manager.importFrom(typeof path === 'string' ? path : undefined)
      return {
        ok: result.ok,
        message: `${result.message}\n${renderServerTable(result.snapshot ?? ctx.manager.snapshot())}`,
        servers: serverRows(result.snapshot ?? ctx.manager.snapshot()) as never,
      }
    },
  })
}

/** Tool: re-read the state file and reconcile. */
export function reloadTool(ctx: ToolContext): ToolDefinition {
  return defineTool({
    name: 'mcp_manager_reload',
    description:
      'Re-read $DSH_HOME/dsh-mcp-manager.json and reconnect according to its definitions (use it after editing the ' +
      'config file by hand, or to retry a server that failed to connect). It only affects connections, never the ' +
      'config content.',
    parameters: {},
    output: { schema: OP_OUTPUT, render: renderMessage },
    async execute() {
      if (!ctx.enabled()) {
        await ctx.manager.shutdown()
        return { ok: true, message: 'dsh-mcp-manager is disabled; all MCP servers have been disconnected.', servers: [] as never }
      }
      const snapshot = await ctx.manager.refresh()
      return {
        ok: true,
        message: `Re-read ${snapshot.file} and reconnected.\n${renderServerTable(snapshot)}`,
        servers: serverRows(snapshot) as never,
      }
    },
  })
}

/**
 * Build every agent-facing `mcp_manager_*` tool.
 * @param ctx - the tool context.
 * @returns registry-ready definitions.
 */
export function buildTools(ctx: ToolContext): ToolDefinition[] {
  return [
    statusTool(ctx),
    listTool(ctx),
    addTool(ctx),
    updateTool(ctx),
    removeTool(ctx),
    testTool(ctx),
    importTool(ctx),
    reloadTool(ctx),
  ]
}

/** Validate a definition on behalf of a surface (shared by tools and routes). */
export function checkServer(server: ServerEntry): string[] {
  return validateServer(server)
}

/** Serialize an operation result for transport over HTTP. */
export function opToJson(result: OpResult): Json {
  return toJson({ ok: result.ok, message: result.message, snapshot: result.snapshot ?? null })
}
