# dsh-mcp-manager

[English](README.md) · [中文](README.zh.md)

> **MCP server manager for DeepSeek Harness.** Add, edit, enable and test Model Context Protocol
> servers from the Web settings page or from agent tools — connected and disconnected **at runtime,
> with no DSH restart**.

`@zhengjunyao/dsh-mcp-manager` · MIT · requires DSH `>= 0.1.5-rc.1` · Node `^22.19.0 || >=24.0.0`

---

## What it is for

An MCP server normally has to be wired into the harness composition to be loaded, so changing one
means restarting the host. This plugin turns "which MCP servers exist" into an ordinary JSON file and
makes it live:

- a settings card to **add / edit / enable / test / remove** a server;
- `mcp_manager_*` agent tools that do the same thing;
- the server's tools appear in the session as `mcp__<serverName>__<toolName>`;
- disabling or removing a server **unregisters its tools immediately**.

Two transports: **stdio** (a local child process: `command` / `args` / `env` / `cwd`) and
**Streamable HTTP** (a remote URL: `url` / `headers`).

## Getting started

> **No restart is needed at any point.** Adding the plugin to a profile makes the host reload its
> plugin tree by itself (`dsh.profile.patchReload` is unset here, which means live reload); you only
> need to **refresh the browser page** to see the panel.

1. **Install the plugin** — run:

   ```bash
   dsh plugin --profile web add @zhengjunyao/dsh-mcp-manager
   # from a checkout: dsh plugin --profile web add link:/path/to/dsh-mcp-manager
   ```

   Expected: the command ends with a line reading `+ @zhengjunyao/dsh-mcp-manager`, and the profile's
   dependencies and load list both contain it.

2. **Open the “MCP Manager” card** — refresh the Web GUI, open **Settings** in the left sidebar, and find
   the **MCP Manager** card.

   Expected: the card shows a master switch, the server list, and a phase badge per server
   (`active` / `starting` / `waiting` / `error` / `stopped`).

> 📷 **【Screenshot 2】Starting point: where the “MCP Manager” card lives and what it looks like**
> How to capture: refresh the Web GUI → Settings in the left sidebar → scroll to the “MCP Manager” card → stop with the whole card visible (title + master switch + server list in one frame)
> Redaction: if servers already exist, **blur server names and any local paths in commands**
> Replace: swap this whole block for `![MCP manager settings card](image-url)`

3. **Add a server** — click **Add** in the card, give it a name (it becomes the tool prefix
   `mcp__<name>__`), pick a transport (stdio → command, Streamable HTTP → URL), and save.

   Expected: the server appears immediately and its badge moves from `starting` to `active`; on
   failure it stays at `error` with the reason shown next to it.

> 📷 **【Screenshot 3】Key action: the add form and which fields matter**
> How to capture: click “Add” → fill the form (name + transport + command/URL) → stop before saving
> Redaction: **blur local paths, domains and tokens** in the command or URL
> Replace: swap this whole block for `![Adding an MCP server](image-url)`

4. **Confirm the tools really registered** — look at the server's **tool count** and expand its tool
   names, or simply ask the agent to call `mcp_manager_list`.

   Expected: tool count > 0, names shaped like `mcp__<name>__<tool>`, and those tools are **callable
   by the agent right away**.

> 📷 **【Screenshot 4】The step people get stuck on: proof that it connected and registered tools**
> How to capture: server in `active` → expand its tool names → stop with **badge, tool count and several `mcp__…__…` names visible at once**
> Redaction: tool names are usually fine; blur server names and paths if they carry personal data
> Replace: swap this whole block for `![Server connected with tools registered](image-url)`

5. **Probe it once** (optional but recommended) — click **Test** on that server, or have the agent call
   `mcp_manager_test`; you can also test a **draft** that is never written to disk.

   Expected: a success message, or a failure that names the cause (command not found / port closed /
   auth failed), so you can fix it directly.

> 📷 **【Screenshot 5】End state: one server going from config to usable**
> How to capture: stop at the success message after a test (or at the `mcp_manager_list` result on the agent side)
> Redaction: none (blur any URL or token)
> Replace: swap this whole block for `![Test connection succeeded](image-url)`

## Usage

Web GUI → Settings → **MCP Manager**. The card shows each server's live phase
(`● Connected` / `◌ No tools` / `✖ Failed` / `○ Not loaded`), its tool count and its tool names,
and offers a **test** button that really connects — a draft is tried and thrown away, so a typo is
caught before it is saved.

Agent tools: `mcp_manager_status`, `mcp_manager_list`, `mcp_manager_add`, `mcp_manager_update`,
`mcp_manager_remove` (previews unless `confirm: true`), `mcp_manager_test`, `mcp_manager_import`,
`mcp_manager_reload`.

### Configuration

`$DSH_HOME/dsh-mcp-manager.json` (default `~/.dsh/dsh-mcp-manager.json`, mode 0600).
It honours `DSH_HOME`, so a relocated home reads the relocated file. Hand edits are fine —
press "reload config" afterwards.

```json
{
  "version": 1,
  "config": { "enabled": true, "announceToAgent": true },
  "servers": [
    {
      "name": "garmin",
      "transport": "stdio",
      "enabled": true,
      "command": "/opt/homebrew/bin/uvx",
      "args": ["garmin-mcp"],
      "env": {}, "cwd": "",
      "url": "", "headers": {},
      "toolCallTimeoutMs": 60000,
      "reconnect": {}
    }
  ]
}
```

`name` becomes the tool namespace: the example above publishes `mcp__garmin__<tool>`. It must match
`[A-Za-z0-9_-]{1,32}`, the same constraint the harness bridge enforces.

## Two switches

| Switch | Where | When off |
| --- | --- | --- |
| installation | the profile bundle row (`cordis.patch.yml`) | nothing mounts: no tools, no panel |
| runtime | the config file / the panel's "disable" button | every MCP server disconnects and every `mcp__*` tool unregisters; the panel and `mcp_manager_*` stay, so it can be switched back on |

## Design: why it does not implement MCP itself

The plugin **does not reimplement the protocol**. It drives the harness's own bridge,
`@deepseek-ai/dsh-mcp-client`: one instance per enabled server, disposed to disconnect. That bridge
owns the stdio / Streamable HTTP transports, credential scrubbing, reconnect backoff, resource
publishing and the `mcp__<serverName>__<toolName>` naming contract. This plugin only decides which
instance should exist.

Resolution is a **ladder** (`src/core-mcp.ts`) that prefers the running harness's own copy of the
bridge and only falls back to the plugin's dependency tree — version skew is the classic failure of a
plugin that bundles its own client.

### Why it never calls `tools.restrict()`

The npm package this replaces (`@wingsky-1/dsh-mcp-manager`) reconciled tool visibility by calling the
core `tools.restrict()` **once per tool name**. Every such call rebuilds the entire registry view with
fresh Maps and Sets, so the loop cost O(tools × names²) on the host's event loop — measured at 94.7%
CPU, an 8-second unresponsive port and a 1080 MB heap.

This plugin **calls `restrict()` nowhere**: connecting registers tools, disconnecting unregisters
them, which is the bridge's own contract. Its single registry read is one `ctx.tools.schemas()` per
observation, grouped in memory by prefix — linear, and paid only when a panel or a status tool
actually looks.

## Verification

```bash
npm run typecheck
npm test                 # 54 unit tests
npm run verify:live      # real instance, end to end
npm run verify:full      # portability gate (isolated DSH_HOME, tarball install)
```

`verify:live` boots an **isolated** DSH instance (its own `DSH_HOME`; your install is untouched) and
runs `tests/fixtures/echo-mcp-server.mjs` — a dependency-free MCP server written for the check, so a
shared broken dependency cannot make both sides agree on a wrong wire format. It then asserts that the
seeded server becomes `active` with tools named `mcp__echo__*`, that adding a second server over HTTP
publishes its tools, that disabling it unregisters them, that removing it drops the definition, that a
draft probe reports tools without being persisted, and that the master switch drains and restores.

## Compatibility

- DSH `>= 0.1.5-rc.1` (verified on `0.1.7-rc.2`).
- Requires the harness-provided `@deepseek-ai/dsh-mcp-client`. If it is missing the plugin still
  boots; the panel and `/probe` report `bridgeError` instead of taking the host down.
- macOS / Linux / Windows (stdio uses an absolute `command`; on Windows remember the `.cmd` suffix). **Since this version** the `peerDependencies` range explicitly declares compatibility with **DSH 0.2.0-rc.2** (`^0.2.0-rc.2` is now included), so no compatibility warning appears on 0.2.0-rc.2. No functional change.

## License

MIT
