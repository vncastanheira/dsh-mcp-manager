# Changelog

This file records every release of `@zhengjunyao/dsh-mcp-manager`.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow [SemVer](https://semver.org/).

## [Unreleased]

### Changed

- Translated all user-facing strings, tool descriptions, comments and documentation from Chinese to English. `README.zh.md` stays as the Chinese edition and now describes the English UI labels.

## [0.1.2] - 2026-09-29

### Compatibility

- Declares compatibility with **DSH 0.2.0-rc.2**: `^0.2.0-rc.2` was appended to the version range of the official DSH packages in `peerDependencies`. No functional or behavioural change; it only removes the compatibility warning on newer DSH versions.


## [0.1.1] - 2026-09-27

### Changed

- docs(readme): correct the restart claim and add guided setup steps

### Compatibility

- DSH: `>=0.1.5-rc.1`
- Node: `^22.19.0 || >=24.0.0`
- DSH peer: ^0.1.0-rc.6 || ^0.1.1-rc.1 || ^0.1.2-alpha.1 || ^0.1.5-rc.1 || ^0.1.5-rc.2 || ^0.1.5-rc.3 || ^0.1.7-rc.1 || ^0.1.7-rc.2

## [0.1.0] - 2026-09-27

First release. Built after `@wingsky-1/dsh-mcp-manager` was uninstalled (it reconciled tool visibility
per tool name through the core `tools.restrict()`, and every call recomputed the whole registry view,
pushing the web host to 94.7% CPU / an unresponsive port for 8 seconds / a 1080 MB JS heap).

### Capabilities

- **Add, remove, enable and disable MCP servers at runtime**, with no DSH restart. Two transports:
  stdio (`command`/`args`/`env`/`cwd`) and Streamable HTTP (`url`/`headers`).
- **Web settings "MCP Manager" panel**: live phase, tool count and tool names, test connection
  (draft not persisted), enable/disable, edit, remove, import from the old manager plugin, reload config.
- **8 agent tools**: `mcp_manager_status` / `list` / `add` / `update` / `remove` / `test` / `import` / `reload`.
  Removal is two-step: without `confirm` it only previews.
- **Config in `$DSH_HOME/dsh-mcp-manager.json`** (0600, honours `DSH_HOME`, atomic writes).
  The on-disk shape is compatible with the old manager plugin's `mcp-manager-mcp.json`, so it can be
  imported directly.
- **Two independent switches**: the installation switch (profile composition row) and the runtime
  switch (config file / panel); their semantics are documented in the README.

### Architecture

- **Does not implement MCP itself**; it mounts the harness's own `@deepseek-ai/dsh-mcp-client`
  dynamically with `ctx.plugin()`, one instance per enabled server, and `fiber.dispose()` disconnects.
  Transport, credential scrubbing, reconnect backoff, resource publishing and the naming contract
  all reuse the core implementation.
- **Never calls `tools.restrict()`**. The only registry read is "one `ctx.tools.schemas()` per
  observation, grouped by prefix in memory", so the cost is linear.
- **Bridge resolution is a ladder**: first the running harness's own copy (resolved by realpath from
  the CLI entry), then the profile's link farm, and only then the plugin's own dependency tree;
  `/probe` reports which rung was used.
- Every host-half entry point is exception-guarded: an unreachable MCP server or a missing bridge
  never fails the web boot.

### Fixes (caught by end-to-end verification during development)

- **The "disable plugin" switch used to be fake**: the panel wrote the config file's `enabled`, while
  the runtime read the composition row's `enabled`, so flipping the switch had no effect and every
  server stayed connected. The two switches are now independent and both effective, pinned by
  11 dedicated regression tests (`tests/manager.mjs`).
- **`snapshot()` used to short-circuit to "everything stopped" based on "has the state file been
  read yet"**, making any caller that had not called `initialize()` (including the panel during a
  slow boot) see a dead machine. It now always computes the live state.

### Verification

- `npm test`: 54 unit tests (definition model / persistence and 0600 / runtime grouping and phases /
  two-switch semantics / bridge resolution ladder / loopback routes and guards).
- `npm run verify:live`: live isolated instance end to end — config → bridge → real stdio MCP server
  (a zero-dependency hand-written fixture) → `mcp__echo__*` tools; then HTTP add / disable (tools
  unregistered immediately) / remove / draft probe / master switch, all without a restart.
- `npm run verify:full`: portability gate (isolated `DSH_HOME` + tarball install + health route +
  client bundle).
