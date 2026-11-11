import { createRequire } from "node:module";
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import path, { dirname, join } from "node:path";
import { homedir } from "node:os";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { defineTool } from "@deepseek-ai/dsh-tools";
//#region src/core-mcp.ts
/**
* dsh-mcp-manager — locating the harness MCP bridge.
*
* The manager does not reimplement the Model Context Protocol. The harness
* already ships a tested bridge, `@deepseek-ai/dsh-mcp-client`, which owns the
* stdio / Streamable HTTP transports, credential scrubbing, reconnect backoff,
* resource publishing and the `mcp__<serverName>__<toolName>` naming contract.
* The manager's job is to *drive* that bridge: load one instance per configured
* server, and dispose the instance to disconnect.
*
* That indirection is why this plugin cannot inherit the failure mode of the
* manager it replaces. That one maintained its own client and then reconciled
* tool visibility by calling the core `tools.restrict()` **once per tool**, and
* every one of those calls rebuilds the entire registry view — O(tools × names)
* with fresh Maps and Sets each time. The cost landed on the host's event loop
* (94.7% CPU, unresponsive port, 1 GB JS heap). Here, connecting registers tools
* through the bridge and disconnecting disposes them; `restrict()` is never
* called at all, so there is no per-tool work to get wrong.
*
* Resolution is a ladder because a plugin may live in three different layouts:
*   - installed into a profile (the profile's `node_modules` farm already links
*     the whole core tree, so a bare specifier resolves);
*   - installed from a tarball into an isolated throwaway home (the farm exists
*     there too, but only once the CLI has built it);
*   - loaded straight from a `link:` development checkout, whose `node_modules`
*     knows nothing about the core.
*
* The running harness's own copy is preferred over anything the plugin might
* have installed locally: a second, older bridge would diverge from the host's
* tool registry, and version skew is exactly the class of bug this plugin
* exists to avoid.
*/
/** The package that provides the bridge. */
const BRIDGE_PACKAGE = "@deepseek-ai/dsh-mcp-client";
/** Cached successful resolution (the module is a singleton per process). */
let cached;
/**
* Resolve a filesystem anchor from which the harness's own core packages are visible.
*
* `process.argv[1]` is the `dsh` CLI entry (often a symlink in a bin directory).
* Resolving its real path lands inside the installed core package, whose own
* `node_modules` carries the bridge — so requiring from there finds the exact
* copy the running harness loaded.
*
* @returns absolute file paths to anchor resolution from, best first.
*/
function harnessAnchors() {
	const anchors = [];
	const argv1 = process.argv[1];
	if (typeof argv1 === "string" && argv1 !== "") try {
		anchors.push(realpathSync(argv1));
	} catch {
		anchors.push(argv1);
	}
	const profileDir = (process.env.DSH_PROFILE_DIR ?? "").trim();
	if (profileDir !== "") anchors.push(path.join(profileDir, "noop.js"));
	return anchors;
}
/** Resolve a specifier from one anchor, returning undefined when it is not visible there. */
function resolveFrom(anchor, specifier) {
	try {
		return createRequire(anchor).resolve(specifier);
	} catch {
		return;
	}
}
/**
* Load the harness MCP bridge module.
*
* @returns the loaded module and where it came from.
* @throws when no rung of the ladder resolves — the caller decides whether that
*   is fatal (it never should be: the settings panel stays up and reports it).
*/
async function loadBridge() {
	if (cached !== void 0) return cached;
	const failures = [];
	for (const anchor of harnessAnchors()) {
		const resolved = resolveFrom(anchor, BRIDGE_PACKAGE);
		if (resolved === void 0) {
			failures.push(`${anchor}: not found`);
			continue;
		}
		try {
			const module = await import(pathToFileURL(resolved).href);
			if (typeof module.apply !== "function") throw new Error("module does not export apply()");
			cached = {
				module,
				source: resolved,
				via: anchor.startsWith(process.env.DSH_PROFILE_DIR ?? "\0") ? "profile" : "harness"
			};
			return cached;
		} catch (error) {
			failures.push(`${resolved}: ${String(error instanceof Error ? error.message : error)}`);
		}
	}
	try {
		const module = await import(BRIDGE_PACKAGE);
		if (typeof module.apply !== "function") throw new Error("module does not export apply()");
		cached = {
			module,
			source: BRIDGE_PACKAGE,
			via: "bare"
		};
		return cached;
	} catch (error) {
		failures.push(`${BRIDGE_PACKAGE}: ${String(error instanceof Error ? error.message : error)}`);
	}
	throw new Error(`Cannot find ${BRIDGE_PACKAGE} (the MCP bridge bundled with the harness). Tried: ${failures.join("; ")}. This package ships with DeepSeek Harness; if it is missing, make sure you are running the official dsh rather than a trimmed-down runtime.`);
}
//#endregion
//#region src/home.ts
/**
* dsh-mcp-manager — DeepSeek Harness home resolution.
*
* Every path this plugin owns is derived from the harness home, never from a
* hardcoded `~/.dsh`. A relocated home (DSH_HOME, a rescue capsule, the
* isolated throwaway home the portability harness spins up) would otherwise
* make the plugin read and write a second, wrong home — and the user would see
* an empty server list while their real definitions sat untouched elsewhere.
*
* Resolution order (per the DSH plugin portability checklist):
*   1. an explicit override (tests / per-plugin relocation);
*   2. `DSH_HOME` — set by the host before plugins load;
*   3. `~/.dsh` — the conventional machine-wide location.
*/
/** The harness home directory: `DSH_HOME` when set (non-empty), else ~/.dsh. */
function dshHome() {
	const shared = (process.env.DSH_HOME ?? "").trim();
	return shared !== "" ? shared : path.join(homedir(), ".dsh");
}
/** The plugin's own settings file: server definitions plus plugin switches. */
function configPath(home = dshHome()) {
	return path.join(home, "dsh-mcp-manager.json");
}
/**
* Locations a previous MCP manager may have left behind, best first.
*
* The first entry is the real one: `@wingsky-1/dsh-mcp-manager` (the package
* this plugin replaces) keeps its servers in
* `$DSH_HOME/@wingsky-1/dsh-mcp-manager/mcp.json`, which is one click away from
* being re-imported instead of retyped. The bare `mcp-servers.json` name is the
* layout the unrelated npm package `dsh-mcp-manager` uses; the rest cover
* plausible hand-written placements.
*
* Nothing is written here — these are read-only import sources, and an import
* never overwrites a definition that already exists.
*
* @param home - the harness home.
* @returns absolute candidate paths (existence is checked by the caller).
*/
function legacyImportCandidates(home = dshHome()) {
	return [
		path.join(home, "@wingsky-1", "dsh-mcp-manager", "mcp.json"),
		path.join(home, "mcp-servers.json"),
		path.join(home, "mcp-manager-mcp.json"),
		path.join(home, "dsh-mcp-manager", "servers.json")
	];
}
//#endregion
//#region src/servers.ts
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
const SERVER_NAME_PATTERN = /^[A-Za-z0-9_-]{1,32}$/;
/** Reserved because it would collide with the manager's own `mcp_manager_*` tools. */
const RESERVED_NAMES = ["manager", "mcp_manager"];
/** Every transport, in the order the settings panel offers them. */
const TRANSPORTS = ["stdio", "streamable-http"];
/** Bounds the panel and the tools enforce on the per-call timeout. */
const TIMEOUT_MIN_MS = 1e3;
const TIMEOUT_MAX_MS = 1800 * 1e3;
/** Default per-call timeout, matching the harness bridge default. */
const TIMEOUT_DEFAULT_MS = 6e4;
/** A complete definition with every field resolved. */
function emptyServer(name = "") {
	return {
		name,
		transport: "stdio",
		enabled: true,
		description: "",
		command: "",
		args: [],
		env: {},
		cwd: "",
		url: "",
		headers: {},
		toolCallTimeoutMs: TIMEOUT_DEFAULT_MS,
		reconnect: {}
	};
}
/** Coerce one raw value into a string, falling back on absence. */
function stringOf(value, fallback = "") {
	return typeof value === "string" ? value : fallback;
}
/** Coerce one raw value into a boolean, falling back on absence. */
function boolOf$1(value, fallback) {
	return typeof value === "boolean" ? value : fallback;
}
/** Coerce one raw value into an array of strings, dropping non-strings. */
function stringArrayOf(value) {
	if (!Array.isArray(value)) return [];
	return value.filter((item) => typeof item === "string");
}
/** Coerce one raw value into a string dictionary, dropping non-string values. */
function stringDictOf(value) {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return {};
	const out = {};
	for (const [key, item] of Object.entries(value)) if (typeof item === "string") out[key] = item;
	return out;
}
/** Coerce one raw value into a bounded integer, falling back on absence. */
function intOf(value, fallback, min, max) {
	if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
	return Math.max(min, Math.min(max, Math.floor(value)));
}
/**
* Normalize an untrusted reconnect block.
* @param raw - the raw value from the config file or a panel request.
* @returns only the fields that were present and well-formed.
*/
function normalizeReconnect(raw) {
	if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return {};
	const source = raw;
	const out = {};
	if (typeof source.enabled === "boolean") out.enabled = source.enabled;
	if (typeof source.initialDelayMs === "number") out.initialDelayMs = intOf(source.initialDelayMs, 500, 1, 2147483647);
	if (typeof source.maxDelayMs === "number") out.maxDelayMs = intOf(source.maxDelayMs, 3e4, 1, 2147483647);
	if (typeof source.maxAttempts === "number") out.maxAttempts = intOf(source.maxAttempts, 10, 1, Number.MAX_SAFE_INTEGER);
	return out;
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
function normalizeServer(raw) {
	if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return void 0;
	const source = raw;
	const base = emptyServer(stringOf(source.name).trim());
	const transport = source.transport === "streamable-http" ? "streamable-http" : "stdio";
	return {
		...base,
		transport,
		enabled: boolOf$1(source.enabled, base.enabled),
		description: stringOf(source.description),
		command: stringOf(source.command),
		args: stringArrayOf(source.args),
		env: stringDictOf(source.env),
		cwd: stringOf(source.cwd),
		url: stringOf(source.url),
		headers: stringDictOf(source.headers),
		toolCallTimeoutMs: intOf(source.toolCallTimeoutMs, base.toolCallTimeoutMs, TIMEOUT_MIN_MS, TIMEOUT_MAX_MS),
		reconnect: normalizeReconnect(source.reconnect)
	};
}
/**
* Normalize a whole untrusted server list, dropping unusable and duplicate entries.
* @param raw - the raw `servers` array.
* @returns definitions in file order, deduplicated by name (first wins).
*/
function normalizeServerList(raw) {
	if (!Array.isArray(raw)) return [];
	const out = [];
	const seen = /* @__PURE__ */ new Set();
	for (const item of raw) {
		const server = normalizeServer(item);
		if (server === void 0) continue;
		if (server.name === "") continue;
		if (seen.has(server.name)) continue;
		seen.add(server.name);
		out.push(server);
	}
	return out;
}
/**
* Report every reason a definition may not be connected.
* @param server - the definition to check.
* @returns human-readable problems; empty means the definition is connectable.
*/
function validateServer(server) {
	const problems = [];
	if (server.name === "") problems.push("name must not be empty");
	else if (!SERVER_NAME_PATTERN.test(server.name)) problems.push(`name "${server.name}" may only contain letters, digits, underscores and hyphens, and be 1–32 characters long`);
	else if (RESERVED_NAMES.includes(server.name.toLowerCase())) problems.push(`name "${server.name}" is reserved and would collide with the mcp_manager_* tools`);
	if (!TRANSPORTS.includes(server.transport)) problems.push(`transport "${String(server.transport)}" is not supported`);
	if (server.transport === "stdio") {
		if (server.command.trim() === "") problems.push("a stdio server needs a command");
	} else if (server.url.trim() === "") problems.push("a streamable-http server needs a url");
	if (server.toolCallTimeoutMs < 1e3 || server.toolCallTimeoutMs > 18e5) problems.push(`toolCallTimeoutMs must be between ${TIMEOUT_MIN_MS} and ${TIMEOUT_MAX_MS}`);
	return problems;
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
function serverSignature(server) {
	return JSON.stringify({
		transport: server.transport,
		command: server.command,
		args: server.args,
		env: server.env,
		cwd: server.cwd,
		url: server.url,
		headers: server.headers,
		toolCallTimeoutMs: server.toolCallTimeoutMs,
		reconnect: server.reconnect
	});
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
function toBridgeConfig(server) {
	const shared = {
		serverName: server.name,
		toolCallTimeoutMs: server.toolCallTimeoutMs,
		failOnStartupError: false
	};
	if (server.transport === "stdio") return {
		transport: "stdio",
		...shared,
		command: server.command,
		args: server.args,
		env: server.env,
		cwd: server.cwd,
		...Object.keys(server.reconnect).length > 0 ? { reconnect: server.reconnect } : {}
	};
	return {
		transport: "streamable-http",
		...shared,
		url: server.url,
		headers: server.headers,
		...Object.keys(server.reconnect).length > 0 ? { reconnect: server.reconnect } : {}
	};
}
/**
* Merge a partial edit onto an existing definition.
* @param current - the definition being edited.
* @param patch - the fields to change (absent fields are kept).
* @returns a complete, normalized definition.
*/
function applyPatch(current, patch) {
	const merged = { ...current };
	for (const [key, value] of Object.entries(patch)) {
		if (key === "name") continue;
		if (value === void 0) continue;
		merged[key] = value;
	}
	return normalizeServer(merged) ?? { ...current };
}
//#endregion
//#region src/runtime.ts
/**
* How long to wait for a bridge instance's first connection attempt before
* reporting it as still-connecting.
*
* `apply` awaits `connection.ready`, which settles after the *first* attempt,
* so this is a safety net for a server that never answers, not the normal path.
* The fiber keeps retrying in the background either way.
*/
const STARTUP_WAIT_MS = 25e3;
/** The harness tool-name prefix owned by one server namespace. */
function toolPrefix(serverName) {
	return `mcp__${serverName}__`;
}
/**
* Group one tool-registry enumeration by server namespace.
*
* @param names - every currently registered public tool name.
* @param ours - the server names this plugin manages.
* @returns server name → its sorted public tool names.
*/
function groupByServer(names, ours) {
	const out = /* @__PURE__ */ new Map();
	for (const name of ours) out.set(name, []);
	for (const name of names) {
		if (!name.startsWith("mcp__")) continue;
		for (const owner of ours) if (name.startsWith(toolPrefix(owner))) {
			out.get(owner)?.push(name);
			break;
		}
	}
	for (const list of out.values()) list.sort();
	return out;
}
/** Resolve after `ms`, never rejecting. */
function delay(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
/**
* Supervises one bridge instance per enabled server.
*
* All mutating operations are serialized through an internal promise chain:
* the panel, the agent tools and the startup path can each ask for a change at
* any moment, and interleaving a dispose with a load would trip the bridge's
* own "serverName already in use" guard.
*/
var ManagerRuntime = class {
	entries = /* @__PURE__ */ new Map();
	ctx;
	bridge;
	bridgeFailure;
	chain = Promise.resolve();
	/**
	* @param ctx - the plugin context; `ctx.plugin` loads a bridge instance and
	*   `ctx.tools` is the registry this plugin reads (never writes).
	*/
	constructor(ctx) {
		this.ctx = ctx;
	}
	/** Serialize one operation after every operation already queued. */
	run(task) {
		const next = this.chain.then(task, task);
		this.chain = next.catch(() => void 0);
		return next;
	}
	/** Load (once) the harness MCP bridge, remembering a failure. */
	async ensureBridge() {
		if (this.bridge !== void 0) return this.bridge;
		if (this.bridgeFailure !== void 0) throw new Error(this.bridgeFailure);
		try {
			this.bridge = await loadBridge();
			return this.bridge;
		} catch (error) {
			this.bridgeFailure = describe(error);
			throw error;
		}
	}
	/** The resolved bridge location, for the status surfaces. */
	bridgeInfo() {
		return this.bridge === void 0 ? void 0 : {
			source: this.bridge.source,
			via: this.bridge.via
		};
	}
	/** The bridge-load failure, when it could not be resolved at all. */
	bridgeError() {
		return this.bridgeFailure;
	}
	/** Every public tool name currently registered, in one registry read. */
	toolNames() {
		const registry = this.ctx.tools;
		if (typeof registry.schemas !== "function") return [];
		const schemas = registry.schemas();
		if (!Array.isArray(schemas)) return [];
		return schemas.map((schema) => typeof schema?.name === "string" ? schema.name : void 0).filter((name) => name !== void 0);
	}
	/**
	* One registry enumeration, filtered to a name prefix.
	*
	* Exposed so a health surface can report that this plugin's own agent tools
	* really mounted — a fact nothing else observes, since the manager's tools are
	* registered on the tool registry rather than exposed over HTTP.
	*
	* @param prefix - the name prefix to keep.
	* @returns the matching tool names, sorted.
	*/
	namesWithPrefix(prefix) {
		return this.toolNames().filter((name) => name.startsWith(prefix)).sort();
	}
	/** Tool names grouped by managed server, from one registry read. */
	toolsByServer() {
		return groupByServer(this.toolNames(), [...this.entries.keys()]);
	}
	/**
	* Bring the live set in line with the given definitions.
	*
	* Servers that are gone, disabled, or whose wire config changed are stopped;
	* the rest are left alone; everything enabled and not yet loaded is started.
	*
	* @param servers - the complete persisted definition list.
	*/
	async reconcile(servers) {
		await this.run(async () => {
			const desired = /* @__PURE__ */ new Map();
			for (const server of servers) if (server.enabled) desired.set(server.name, server);
			for (const [name, entry] of [...this.entries]) {
				const want = desired.get(name);
				if (want === void 0 || serverSignature(want) !== entry.signature) await this.stopLocked(name);
			}
			for (const [name, server] of desired) if (!this.entries.has(name)) await this.startLocked(server);
			await Promise.resolve();
		});
	}
	/**
	* Stop one server (disposing its bridge instance and unregistering its tools).
	* @param name - the server namespace.
	*/
	async stop(name) {
		await this.run(() => this.stopLocked(name));
	}
	/**
	* Start (or restart) one server from a definition, without persisting it.
	* @param server - the definition to connect.
	* @returns what happened, including the tools it contributed.
	*/
	async start(server) {
		return await this.run(async () => {
			await this.stopLocked(server.name);
			return await this.startLocked(server);
		});
	}
	/**
	* Restart one server only if it is currently live.
	* @param server - the definition to reconnect.
	*/
	async restart(server) {
		return await this.start(server);
	}
	/**
	* Connect a definition that is not persisted, report what it offers, then
	* disconnect it and bring the persisted set back.
	*
	* This is the "test before you save" path. It briefly takes over the server's
	* namespace, so a live server of the same name is stopped first and restored
	* afterwards from `saved`.
	*
	* @param server - the draft definition.
	* @param saved - the persisted list, used to restore the live set.
	* @returns the probe result (with validation problems, if any).
	*/
	async probe(server, saved) {
		const problems = validateServer(server);
		if (problems.length > 0) return {
			ok: false,
			problems,
			tools: [],
			durationMs: 0,
			error: problems.join("; ")
		};
		return await this.run(async () => {
			await this.stopLocked(server.name);
			const outcome = await this.startLocked(server);
			await this.stopLocked(server.name);
			const desired = /* @__PURE__ */ new Map();
			for (const entry of saved) if (entry.enabled) desired.set(entry.name, entry);
			for (const [name, want] of desired) if (!this.entries.has(name)) await this.startLocked(want);
			return {
				...outcome,
				problems: []
			};
		});
	}
	/** Stop every server (plugin unload / HMR). */
	async disposeAll() {
		await this.run(async () => {
			for (const name of [...this.entries.keys()]) await this.stopLocked(name);
		});
	}
	/**
	* Build the per-server view for the given persisted list.
	*
	* Definitions that are not live (disabled, or not yet started) still appear,
	* so a panel always shows what the user configured.
	*
	* @param servers - the persisted definitions.
	* @returns one view per definition, in list order.
	*/
	view(servers) {
		const byServer = this.toolsByServer();
		return servers.map((server) => {
			const entry = this.entries.get(server.name);
			const tools = byServer.get(server.name) ?? [];
			const phase = phaseOf(entry, server.enabled, tools.length);
			return {
				name: server.name,
				phase,
				loaded: entry?.fiber !== void 0 && entry?.fiber !== null,
				error: entry?.error ?? null,
				tools,
				toolCount: tools.length,
				since: entry?.since ?? null
			};
		});
	}
	/** Whether any server is currently live. */
	liveCount() {
		return [...this.entries.values()].filter((entry) => entry.fiber !== null).length;
	}
	/** Stop one server. Caller must already hold the serialization slot. */
	async stopLocked(name) {
		const entry = this.entries.get(name);
		if (entry === void 0) return;
		this.entries.delete(name);
		if (entry.fiber === null) return;
		try {
			await entry.fiber.dispose();
		} catch {}
	}
	/** Start one server. Caller must already hold the serialization slot. */
	async startLocked(server) {
		const started = Date.now();
		const entry = {
			server,
			signature: serverSignature(server),
			fiber: null,
			phase: "starting",
			error: null,
			since: started
		};
		this.entries.set(server.name, entry);
		const problems = validateServer(server);
		if (problems.length > 0) {
			entry.phase = "error";
			entry.error = problems.join("; ");
			return {
				ok: false,
				error: entry.error,
				tools: [],
				durationMs: Date.now() - started
			};
		}
		let bridge;
		try {
			bridge = await this.ensureBridge();
		} catch (error) {
			entry.phase = "error";
			entry.error = describe(error);
			return {
				ok: false,
				error: entry.error,
				tools: [],
				durationMs: Date.now() - started
			};
		}
		let fiber;
		try {
			fiber = await this.ctx.plugin(bridge.module, toBridgeConfig(server));
		} catch (error) {
			entry.phase = "error";
			entry.error = describe(error);
			return {
				ok: false,
				error: entry.error,
				tools: [],
				durationMs: Date.now() - started
			};
		}
		entry.fiber = fiber;
		const settled = (async () => {
			try {
				await fiber;
				return { ok: true };
			} catch (error) {
				return {
					ok: false,
					error: describe(error)
				};
			}
		})();
		const outcome = await Promise.race([settled, delay(STARTUP_WAIT_MS).then(() => ({
			ok: true,
			stalled: true
		}))]);
		if (outcome.stalled === true) {
			entry.phase = "waiting";
			entry.error = null;
		} else if (outcome.ok) entry.error = null;
		else entry.error = outcome.error ?? "connection failed";
		const tools = groupByServer(this.toolNames(), [server.name]).get(server.name) ?? [];
		entry.phase = tools.length > 0 ? "active" : entry.error === null ? "waiting" : "error";
		entry.since = Date.now();
		return {
			ok: entry.phase === "active",
			...entry.error === null ? {} : { error: entry.error },
			tools,
			durationMs: Date.now() - started
		};
	}
};
/** Derive the phase shown to the user. */
function phaseOf(entry, enabled, toolCount) {
	if (entry === void 0) return "stopped";
	if (entry.phase === "error") return "error";
	if (entry.fiber === null) return "stopped";
	if (toolCount > 0) return "active";
	return entry.phase === "starting" ? "starting" : "waiting";
}
/** A short, safe message for an unknown thrown value. */
function describe(error) {
	if (error instanceof Error) return error.message;
	if (typeof error === "string") return error;
	try {
		return JSON.stringify(error);
	} catch {
		return String(error);
	}
}
//#endregion
//#region src/store.ts
/**
* dsh-mcp-manager — persistence for the manager settings and the server list.
*
* One file under the harness home (`$DSH_HOME/dsh-mcp-manager.json`, mode 0600)
* holds both the plugin switches and every server definition, so the whole
* state is discoverable, diffable and editable outside the GUI while the
* profile bundle row only seeds it on first run.
*
* Every read tolerates a missing or malformed file by falling back to the
* defaults: a broken config must not take the settings panel — or the web boot —
* down with it. Every write is atomic (temp file + rename) with 0600 applied
* before the rename, so a crash can never leave a truncated list behind and the
* file is never briefly world-readable.
*/
/** Defaults, applied to every missing or invalid field. */
const DEFAULT_CONFIG = {
	enabled: true,
	announceToAgent: true
};
/** Coerce one raw value into a boolean, falling back on absence. */
function boolOf(value, fallback) {
	return typeof value === "boolean" ? value : fallback;
}
/**
* Normalize a raw config object over the defaults.
* @param raw - the parsed file contents (any shape).
* @returns a complete configuration.
*/
function normalizeConfig(raw) {
	const source = raw !== null && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
	return {
		enabled: boolOf(source.enabled, DEFAULT_CONFIG.enabled),
		announceToAgent: boolOf(source.announceToAgent, DEFAULT_CONFIG.announceToAgent)
	};
}
/**
* Load the manager state, falling back to the defaults.
* @param home - the harness home.
* @returns the state, whether the file existed, and its path.
*/
async function loadState(home = dshHome()) {
	const file = configPath(home);
	try {
		const raw = await readFile(file, "utf8");
		const parsed = JSON.parse(raw);
		const source = parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
		const servers = normalizeServerList(source.servers);
		const declared = Array.isArray(source.servers) ? source.servers.length : 0;
		return {
			config: normalizeConfig(source.config !== void 0 ? source.config : source),
			servers,
			exists: true,
			file,
			dropped: Math.max(0, declared - servers.length)
		};
	} catch {
		return {
			config: { ...DEFAULT_CONFIG },
			servers: [],
			exists: false,
			file,
			dropped: 0
		};
	}
}
/**
* Serialize the state exactly as it is written to disk.
* @param state - the state to serialize.
* @returns pretty-printed JSON with a trailing newline.
*/
function serializeState(state) {
	return `${JSON.stringify({
		version: 1,
		...state
	}, null, 2)}\n`;
}
/**
* Write the state atomically with 0600 permissions.
* @param state - the complete state to persist.
* @param home - the harness home.
* @returns the resolved path that was written.
*/
async function saveState(state, home = dshHome()) {
	const file = configPath(home);
	await mkdir(dirname(file), { recursive: true });
	const temp = join(dirname(file), `.dsh-mcp-manager.${randomBytes(6).toString("hex")}.tmp`);
	try {
		const handle = await open(temp, "w", 384);
		try {
			await handle.writeFile(serializeState(state), "utf8");
		} finally {
			await handle.close();
		}
		await rename(temp, file);
	} catch (error) {
		await rm(temp, { force: true });
		throw error;
	}
	return file;
}
/**
* Find one server definition by name.
* @param servers - the list to search.
* @param name - the definition name.
* @returns the entry, or undefined.
*/
function findServer(servers, name) {
	return servers.find((server) => server.name === name);
}
/**
* Insert or replace one definition, preserving list order.
* @param servers - the current list.
* @param server - the definition to write.
* @returns a new list with the definition in place.
*/
function upsertServer(servers, server) {
	const index = servers.findIndex((item) => item.name === server.name);
	if (index < 0) return [...servers, server];
	const next = [...servers];
	next[index] = server;
	return next;
}
/**
* Remove one definition.
* @param servers - the current list.
* @param name - the definition name to drop.
* @returns a new list without it.
*/
function removeServer(servers, name) {
	return servers.filter((server) => server.name !== name);
}
/**
* Import definitions from another manager's file, without overwriting anything.
*
* Accepts both this plugin's own file shape and the `{ version, servers }` shape
* written by the pre-existing npm package of the same purpose; unknown keys are
* ignored and every entry arrives disabled unless it was explicitly enabled, so
* a bulk import can never silently connect a pile of servers on first launch.
*
* @param raw - the parsed contents of the foreign file (any shape).
* @returns the accepted entries and the names that were rejected or already present.
*/
function importServers(raw) {
	const source = raw !== null && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
	const list = Array.isArray(source.servers) ? source.servers : Array.isArray(raw) ? raw : [];
	const accepted = [];
	const skipped = [];
	for (const item of list) {
		const server = normalizeServer(item);
		if (server === void 0 || server.name === "") {
			skipped.push("(unnamed entry)");
			continue;
		}
		accepted.push(server);
	}
	return {
		accepted,
		skipped
	};
}
//#endregion
//#region src/manager.ts
/**
* The state + runtime pair behind every surface.
*/
var McpManager = class {
	deps;
	runtime;
	state = {
		config: { ...DEFAULT_CONFIG },
		servers: []
	};
	meta = {
		exists: false,
		file: "",
		dropped: 0
	};
	constructor(deps) {
		this.deps = deps;
		this.runtime = new ManagerRuntime(deps.ctx);
		this.meta.file = configPath(deps.home ?? dshHome());
	}
	/** The harness home this instance reads and writes. */
	get home() {
		return this.deps.home ?? dshHome();
	}
	/**
	* Whether the servers are allowed to be connected right now.
	*
	* Two independent switches, both of which must be on:
	*
	*   - the composition row's `enabled` — the installation switch. Off means the
	*     plugin mounts no tools and no routes at all, and only a profile edit
	*     brings it back.
	*   - the settings file's `enabled` — the runtime master switch, flipped from
	*     the panel or by `mcp_manager_update`. Off disconnects every server and
	*     unregisters every `mcp__*` tool, while leaving the management surface
	*     (panel + `mcp_manager_*`) alive so the state can still be inspected and
	*     switched back on.
	*
	* @returns true when servers may connect.
	*/
	active() {
		return this.deps.enabled() && this.state.config.enabled;
	}
	/** The persisted runtime master switch, for status surfaces. */
	masterSwitch() {
		return this.state.config.enabled;
	}
	/** Load the state from disk and connect every enabled server. */
	async initialize() {
		const view = await loadState(this.home);
		this.state = {
			config: view.config,
			servers: view.servers
		};
		this.meta = {
			exists: view.exists,
			file: view.file,
			dropped: view.dropped
		};
		await this.reconcile();
	}
	/** Reload from disk and reconnect (used after an external edit). */
	async refresh() {
		const view = await loadState(this.home);
		this.state = {
			config: view.config,
			servers: view.servers
		};
		this.meta = {
			exists: view.exists,
			file: view.file,
			dropped: view.dropped
		};
		await this.reconcile();
		return this.snapshot();
	}
	/** Rebuild the live set from the current state. */
	async reconcile() {
		const wanted = this.active() ? this.state.servers : [];
		await this.runtime.reconcile(wanted);
	}
	/** Stop every server (unload / disable). */
	async shutdown() {
		await this.runtime.disposeAll();
	}
	/**
	* The current snapshot: persisted state plus one runtime observation.
	*
	* Always derived live. An earlier version gated this on "has the state file
	* been read yet" and fell back to reporting every server as `stopped`, which
	* made a healthy manager look dead to any caller that had not run
	* `initialize()` — including the panel, briefly, on a slow boot.
	*
	* @returns everything a panel or a status tool renders.
	*/
	snapshot() {
		const views = this.runtime.view(this.state.servers);
		const byName = new Map(views.map((view) => [view.name, view]));
		return {
			config: this.state.config,
			servers: this.state.servers,
			runtime: this.state.servers.map((server) => byName.get(server.name) ?? {
				name: server.name,
				phase: "stopped",
				loaded: false,
				error: null,
				tools: [],
				toolCount: 0,
				since: null
			}),
			file: this.meta.file,
			exists: this.meta.exists,
			dropped: this.meta.dropped,
			bridge: this.runtime.bridgeInfo() ?? null,
			bridgeError: this.runtime.bridgeError() ?? null,
			idle: views.filter((view) => view.loaded && view.toolCount === 0).map((view) => view.name)
		};
	}
	/** One definition by name. */
	server(name) {
		return findServer(this.state.servers, name);
	}
	/**
	* This plugin's own agent tools, as the tool registry currently sees them.
	* @returns the registered `mcp_manager_*` names, sorted.
	*/
	ownToolNames() {
		return this.runtime.namesWithPrefix("mcp_manager_");
	}
	/** Persist the given state, then reconcile. */
	async commit(next, message) {
		this.state = next;
		try {
			this.meta.file = await saveState(next, this.home);
			this.meta.exists = true;
		} catch (error) {
			return {
				ok: false,
				message: `Failed to write config: ${describe(error)}`
			};
		}
		try {
			await this.reconcile();
		} catch (error) {
			return {
				ok: false,
				message: `${message} (but reconnect failed: ${describe(error)})`,
				snapshot: this.snapshot()
			};
		}
		return {
			ok: true,
			message,
			snapshot: this.snapshot()
		};
	}
	/** Patch the plugin-level switches. */
	async patchConfig(patch) {
		const merged = normalizeConfig({
			...this.state.config,
			...patch
		});
		return await this.commit({
			...this.state,
			config: merged
		}, "Plugin settings saved");
	}
	/**
	* Add one server.
	* @param raw - an untrusted definition.
	* @returns the operation result.
	*/
	async addServer(raw) {
		const server = normalizeServer(raw);
		if (server === void 0) return {
			ok: false,
			message: "Invalid server definition: expected an object"
		};
		if (findServer(this.state.servers, server.name) !== void 0) return {
			ok: false,
			message: `A server named "${server.name}" already exists; use update to change it`
		};
		const problems = validateServer(server);
		if (problems.length > 0) return {
			ok: false,
			message: `Invalid definition: ${problems.join("; ")}`
		};
		const next = upsertServer(this.state.servers, server);
		return await this.commit({
			...this.state,
			servers: next
		}, `Added server "${server.name}"`);
	}
	/**
	* Update one server, optionally renaming it.
	* @param name - the current name.
	* @param patch - the fields to change.
	* @returns the operation result.
	*/
	async updateServer(name, patch) {
		const current = findServer(this.state.servers, name);
		if (current === void 0) return {
			ok: false,
			message: `No server named "${name}"`
		};
		const nextName = typeof patch.name === "string" && patch.name.trim() !== "" ? patch.name.trim() : current.name;
		const merged = applyPatch({
			...current,
			name: nextName
		}, patch);
		merged.name = nextName;
		if (nextName !== current.name && findServer(this.state.servers, nextName) !== void 0) return {
			ok: false,
			message: `The name "${nextName}" is already taken`
		};
		const problems = validateServer(merged);
		if (problems.length > 0) return {
			ok: false,
			message: `Invalid definition: ${problems.join("; ")}`
		};
		let servers = this.state.servers;
		if (nextName !== current.name) {
			servers = removeServer(servers, current.name);
			await this.runtime.stop(current.name);
		}
		servers = upsertServer(servers, merged);
		return await this.commit({
			...this.state,
			servers
		}, nextName === current.name ? `Updated "${nextName}"` : `Renamed "${current.name}" to "${nextName}"`);
	}
	/**
	* Remove one server and disconnect it.
	* @param name - the definition name.
	* @returns the operation result.
	*/
	async removeServer(name) {
		if (findServer(this.state.servers, name) === void 0) return {
			ok: false,
			message: `No server named "${name}"`
		};
		await this.runtime.stop(name);
		const next = removeServer(this.state.servers, name);
		return await this.commit({
			...this.state,
			servers: next
		}, `Removed server "${name}"; its MCP tools are unregistered`);
	}
	/**
	* Turn one server on or off.
	* @param name - the definition name.
	* @param enabled - the desired state.
	* @returns the operation result.
	*/
	async setEnabled(name, enabled) {
		const current = findServer(this.state.servers, name);
		if (current === void 0) return {
			ok: false,
			message: `No server named "${name}"`
		};
		const next = upsertServer(this.state.servers, {
			...current,
			enabled
		});
		return await this.commit({
			...this.state,
			servers: next
		}, enabled ? `Enabled "${name}"` : `Disabled "${name}"; its MCP tools are unregistered`);
	}
	/**
	* Connect a definition and report what it offers.
	*
	* With `draft` the definition is tried without being persisted (the panel's
	* "test before save"); with `name` the *persisted* definition is reconnected
	* from scratch, which is the honest check that the saved config works.
	*
	* @param name - a persisted server to reconnect.
	* @param draft - an unsaved definition to try.
	* @returns a human summary plus the tool list.
	*/
	async test(name, draft) {
		if (draft !== void 0) {
			const server = normalizeServer(draft);
			if (server === void 0) return {
				ok: false,
				message: "Invalid draft definition: expected an object",
				tools: [],
				snapshot: this.snapshot()
			};
			const outcome = await this.runtime.probe(server, this.state.servers);
			const head = outcome.ok ? `"${server.name}" connected successfully, serving ${outcome.tools.length} tools (${outcome.durationMs} ms)` : `"${server.name}" failed to connect: ${outcome.error ?? "unknown cause"}`;
			return {
				ok: outcome.ok,
				message: outcome.tools.length > 0 ? `${head}: ${outcome.tools.slice(0, 12).join(", ")}${outcome.tools.length > 12 ? " …" : ""}` : head,
				tools: outcome.tools,
				snapshot: this.snapshot()
			};
		}
		const target = name !== void 0 ? findServer(this.state.servers, name) : void 0;
		if (target === void 0) return {
			ok: false,
			message: "Provide the name of the server to test, or a draft definition",
			tools: [],
			snapshot: this.snapshot()
		};
		const outcome = await this.runtime.start(target);
		const head = outcome.ok ? `"${target.name}" reconnected successfully, serving ${outcome.tools.length} tools (${outcome.durationMs} ms)` : `"${target.name}" failed to connect: ${outcome.error ?? "no tools registered (it may still be reconnecting, or the server exposes no tools)"}`;
		return {
			ok: outcome.ok,
			message: outcome.tools.length > 0 ? `${head}: ${outcome.tools.slice(0, 12).join(", ")}${outcome.tools.length > 12 ? " …" : ""}` : head,
			tools: outcome.tools,
			snapshot: this.snapshot()
		};
	}
	/**
	* Import definitions from another manager's file.
	*
	* Existing names are never overwritten: an import must not silently replace a
	* working definition. Imported entries keep their own `enabled` flag, so a
	* file that says a server is on will connect right after the import.
	*
	* @param path - an explicit file to read, or empty to try the conventional locations.
	* @returns the operation result.
	*/
	async importFrom(path) {
		const candidates = path !== void 0 && path.trim() !== "" ? [path.trim()] : legacyImportCandidates(this.home);
		const tried = [];
		for (const candidate of candidates) {
			tried.push(candidate);
			let raw;
			try {
				raw = JSON.parse(await readFile(candidate, "utf8"));
			} catch {
				continue;
			}
			const { accepted } = importServers(raw);
			if (accepted.length === 0) continue;
			const additions = accepted.filter((server) => findServer(this.state.servers, server.name) === void 0);
			const skipped = accepted.length - additions.length;
			if (additions.length === 0) return {
				ok: true,
				message: `All ${accepted.length} servers in ${candidate} already exist; nothing changed`,
				snapshot: this.snapshot()
			};
			let servers = this.state.servers;
			for (const server of additions) servers = upsertServer(servers, server);
			return await this.commit({
				...this.state,
				servers
			}, `Imported ${additions.length} servers from ${candidate}` + (skipped > 0 ? ` (${skipped} skipped: the name already existed)` : ""));
		}
		return {
			ok: false,
			message: `No importable file found. Tried: ${tried.join(", ")}`
		};
	}
	/** Whether the harness bridge is resolvable (used by status surfaces). */
	async bridgeStatus() {
		try {
			const bridge = await loadBridge();
			return {
				ok: true,
				source: bridge.source,
				via: bridge.via
			};
		} catch (error) {
			return {
				ok: false,
				error: describe(error)
			};
		}
	}
};
//#endregion
//#region src/routes.ts
/** Route paths. */
const MANAGER_API = {
	probe: "/api/dsh-mcp-manager/probe",
	state: "/api/dsh-mcp-manager/state",
	config: "/api/dsh-mcp-manager/config",
	server: "/api/dsh-mcp-manager/server",
	serverRemove: "/api/dsh-mcp-manager/server/remove",
	serverToggle: "/api/dsh-mcp-manager/server/toggle",
	test: "/api/dsh-mcp-manager/test",
	import: "/api/dsh-mcp-manager/import",
	reload: "/api/dsh-mcp-manager/reload"
};
/** Cap on JSON request bodies. */
const MAX_JSON_BODY_BYTES = 256 * 1024;
/** Whether a request comes from this machine and this origin. */
function isLoopbackRequest(request) {
	const address = request.socket.remoteAddress;
	if (address !== "127.0.0.1" && address !== "::1" && address !== "::ffff:127.0.0.1") return false;
	const host = request.headers.host;
	if (typeof host !== "string") return false;
	let hostUrl;
	try {
		hostUrl = new URL(`http://${host}`);
	} catch {
		return false;
	}
	if (hostUrl.hostname !== "127.0.0.1" && hostUrl.hostname !== "localhost" && hostUrl.hostname !== "[::1]") return false;
	if (request.headers["sec-fetch-site"] === "cross-site") return false;
	const origin = request.headers.origin;
	if (origin === void 0) return true;
	try {
		return new URL(origin).host === hostUrl.host;
	} catch {
		return false;
	}
}
/** One JSON response. */
function writeJson(res, status, body) {
	res.writeHead(status, {
		"content-type": "application/json; charset=utf-8",
		"cache-control": "no-store",
		"referrer-policy": "no-referrer"
	});
	res.end(JSON.stringify(body));
}
/** Read and parse a JSON request body (undefined when invalid or oversized). */
async function readJsonBody(request) {
	const chunks = [];
	let size = 0;
	for await (const chunk of request) {
		const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
		size += buffer.length;
		if (size > MAX_JSON_BODY_BYTES) return void 0;
		chunks.push(buffer);
	}
	if (chunks.length === 0) return {};
	try {
		const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
		return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : void 0;
	} catch {
		return;
	}
}
/** Read a trimmed string field. */
function stringField(body, key) {
	const value = body[key];
	return typeof value === "string" ? value.trim() : "";
}
/**
* Build the route list.
* @param deps - the mounted plugin's services.
* @returns the routes to register on the host web server.
*/
function makeRoutes(deps) {
	const guard = (req, res, method) => {
		if (!isLoopbackRequest(req)) {
			writeJson(res, 403, { error: "forbidden: loopback-only" });
			return false;
		}
		if (req.method !== method) {
			writeJson(res, 405, { error: `method not allowed: ${req.method}` });
			return false;
		}
		if (!deps.enabled()) {
			writeJson(res, 503, { error: "plugin disabled" });
			return false;
		}
		return true;
	};
	return [
		{
			kind: "exact",
			path: MANAGER_API.probe,
			handler: (req, res) => {
				if (!isLoopbackRequest(req)) {
					writeJson(res, 403, { error: "forbidden: loopback-only" });
					return;
				}
				if (req.method !== "GET" && req.method !== "HEAD") {
					writeJson(res, 405, { error: `method not allowed: ${req.method}` });
					return;
				}
				const snapshot = deps.manager.snapshot();
				const managerTools = deps.manager.ownToolNames();
				writeJson(res, 200, {
					ok: true,
					plugin: "dsh-mcp-manager",
					pid: process.pid,
					enabled: deps.enabled(),
					masterSwitch: deps.manager.masterSwitch(),
					serving: deps.enabled() && deps.manager.masterSwitch(),
					home: deps.home,
					servers: snapshot.servers.length,
					toolCount: snapshot.runtime.reduce((sum, view) => sum + view.toolCount, 0),
					managerTools,
					managerToolCount: managerTools.length,
					bridge: snapshot.bridge?.via ?? null,
					bridgeError: snapshot.bridgeError
				});
			}
		},
		{
			kind: "exact",
			path: MANAGER_API.state,
			handler: async (req, res) => {
				if (!guard(req, res, "GET")) return;
				try {
					writeJson(res, 200, {
						ok: true,
						...deps.manager.snapshot(),
						home: deps.home,
						legacyCandidates: legacyImportCandidates(deps.home)
					});
				} catch (error) {
					writeJson(res, 500, { error: describe(error) });
				}
			}
		},
		{
			kind: "exact",
			path: MANAGER_API.config,
			handler: async (req, res) => {
				if (!guard(req, res, "POST")) return;
				const body = await readJsonBody(req);
				if (body === void 0) {
					writeJson(res, 400, { error: "invalid JSON body" });
					return;
				}
				const result = await deps.manager.patchConfig(body);
				writeJson(res, result.ok ? 200 : 400, {
					ok: result.ok,
					message: result.message,
					snapshot: result.snapshot ?? null
				});
			}
		},
		{
			kind: "exact",
			path: MANAGER_API.server,
			handler: async (req, res) => {
				if (!guard(req, res, "POST")) return;
				const body = await readJsonBody(req);
				if (body === void 0) {
					writeJson(res, 400, { error: "invalid JSON body" });
					return;
				}
				const definition = body.server;
				if (definition === null || typeof definition !== "object" || Array.isArray(definition)) {
					writeJson(res, 400, { error: "server must be an object" });
					return;
				}
				const originalName = stringField(body, "originalName");
				const result = originalName === "" ? await deps.manager.addServer(definition) : await deps.manager.updateServer(originalName, definition);
				writeJson(res, result.ok ? 200 : 400, {
					ok: result.ok,
					message: result.message,
					snapshot: result.snapshot ?? null
				});
			}
		},
		{
			kind: "exact",
			path: MANAGER_API.serverRemove,
			handler: async (req, res) => {
				if (!guard(req, res, "POST")) return;
				const body = await readJsonBody(req);
				if (body === void 0) {
					writeJson(res, 400, { error: "invalid JSON body" });
					return;
				}
				const name = stringField(body, "name");
				if (name === "") {
					writeJson(res, 400, { error: "name is required" });
					return;
				}
				const result = await deps.manager.removeServer(name);
				writeJson(res, result.ok ? 200 : 400, {
					ok: result.ok,
					message: result.message,
					snapshot: result.snapshot ?? null
				});
			}
		},
		{
			kind: "exact",
			path: MANAGER_API.serverToggle,
			handler: async (req, res) => {
				if (!guard(req, res, "POST")) return;
				const body = await readJsonBody(req);
				if (body === void 0) {
					writeJson(res, 400, { error: "invalid JSON body" });
					return;
				}
				const name = stringField(body, "name");
				const enabled = body.enabled === true;
				if (name === "") {
					writeJson(res, 400, { error: "name is required" });
					return;
				}
				const result = await deps.manager.setEnabled(name, enabled);
				writeJson(res, result.ok ? 200 : 400, {
					ok: result.ok,
					message: result.message,
					snapshot: result.snapshot ?? null
				});
			}
		},
		{
			kind: "exact",
			path: MANAGER_API.test,
			handler: async (req, res) => {
				if (!guard(req, res, "POST")) return;
				const body = await readJsonBody(req);
				if (body === void 0) {
					writeJson(res, 400, { error: "invalid JSON body" });
					return;
				}
				const name = stringField(body, "name");
				const definition = body.server;
				try {
					const result = definition !== null && typeof definition === "object" && !Array.isArray(definition) ? await deps.manager.test(void 0, definition) : await deps.manager.test(name === "" ? void 0 : name, void 0);
					writeJson(res, result.ok ? 200 : 400, {
						ok: result.ok,
						message: result.message,
						tools: result.tools,
						snapshot: result.snapshot
					});
				} catch (error) {
					writeJson(res, 500, { error: describe(error) });
				}
			}
		},
		{
			kind: "exact",
			path: MANAGER_API.import,
			handler: async (req, res) => {
				if (!guard(req, res, "POST")) return;
				const body = await readJsonBody(req);
				if (body === void 0) {
					writeJson(res, 400, { error: "invalid JSON body" });
					return;
				}
				const path = stringField(body, "path");
				const result = await deps.manager.importFrom(path === "" ? void 0 : path);
				writeJson(res, result.ok ? 200 : 400, {
					ok: result.ok,
					message: result.message,
					snapshot: result.snapshot ?? null
				});
			}
		},
		{
			kind: "exact",
			path: MANAGER_API.reload,
			handler: async (req, res) => {
				if (!guard(req, res, "POST")) return;
				try {
					writeJson(res, 200, {
						ok: true,
						message: "Re-read the config and reconnected.",
						snapshot: await deps.manager.refresh()
					});
				} catch (error) {
					writeJson(res, 500, { error: describe(error) });
				}
			}
		}
	];
}
//#endregion
//#region src/tools.ts
/** One text content block (the only render shape these tools emit). */
function text(value) {
	return [{
		type: "text",
		text: value
	}];
}
/** Render the tool's `message` field. */
function renderMessage(_args, value) {
	return text(String(value.message ?? ""));
}
/** The output schema shared by every mutating tool. */
const OP_OUTPUT = {
	type: "object",
	additionalProperties: false,
	properties: {
		ok: {
			type: "boolean",
			required: true
		},
		message: {
			type: "string",
			required: true
		},
		servers: {
			type: "array",
			items: {
				type: "object",
				additionalProperties: false,
				properties: {
					name: {
						type: "string",
						required: true
					},
					transport: {
						type: "string",
						required: true
					},
					enabled: {
						type: "boolean",
						required: true
					},
					phase: {
						type: "string",
						required: true
					},
					toolCount: {
						type: "number",
						required: true
					},
					error: { type: "string" }
				}
			}
		}
	}
};
/** One row of the server table, as a JSON-safe record. */
function serverRows(snapshot) {
	const runtime = new Map(snapshot.runtime.map((view) => [view.name, view]));
	return snapshot.servers.map((server) => {
		const view = runtime.get(server.name);
		return {
			name: server.name,
			transport: server.transport,
			enabled: server.enabled,
			phase: view?.phase ?? "stopped",
			toolCount: view?.toolCount ?? 0,
			...view?.error != null ? { error: view.error } : {}
		};
	});
}
/** Render a compact, human-readable server table. */
function renderServerTable(snapshot) {
	if (snapshot.servers.length === 0) return "(No MCP servers configured yet)";
	const runtime = new Map(snapshot.runtime.map((view) => [view.name, view]));
	return snapshot.servers.map((server) => {
		const view = runtime.get(server.name);
		const phase = view?.phase ?? "stopped";
		const mark = phase === "active" ? "●" : phase === "error" ? "✖" : phase === "starting" || phase === "waiting" ? "◌" : "○";
		const short = server.transport === "stdio" ? `${server.command} ${server.args.join(" ")}`.trim() : server.url;
		const detail = view?.error != null ? `  ⚠️ ${view.error}` : "";
		return `${mark} ${server.name}  [${server.transport}]  ${phase}  ${view?.toolCount ?? 0} tools${detail}\n    ${short}`;
	}).join("\n");
}
/** Guard every mutating tool behind the effective enablement. */
function disabled(enabled) {
	if (enabled()) return void 0;
	return {
		ok: false,
		message: "dsh-mcp-manager is disabled (the MCP master switch is off, or the plugin is disabled in the profile); re-enable it from the \"MCP Manager\" card in Settings, or set enabled back to true in the config file."
	};
}
/** Tool: plugin and connection status. */
function statusTool(ctx) {
	return defineTool({
		name: "mcp_manager_status",
		description: "Show the dsh-mcp-manager plugin status: how many MCP servers are configured and connected, how many tools each contributes, whether the plugin is enabled, where the harness MCP bridge is loaded from, and the state file path. Read-only: it neither connects nor changes anything.",
		parameters: {},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					ok: {
						type: "boolean",
						required: true
					},
					message: {
						type: "string",
						required: true
					},
					enabled: { type: "boolean" },
					total: { type: "number" },
					active: { type: "number" },
					idle: { type: "number" },
					toolCount: { type: "number" },
					bridge: { type: "string" },
					bridgeError: { type: "string" },
					file: { type: "string" },
					servers: {
						type: "array",
						items: {
							type: "object",
							additionalProperties: false,
							properties: {
								name: {
									type: "string",
									required: true
								},
								transport: {
									type: "string",
									required: true
								},
								enabled: {
									type: "boolean",
									required: true
								},
								phase: {
									type: "string",
									required: true
								},
								toolCount: {
									type: "number",
									required: true
								},
								error: { type: "string" }
							}
						}
					}
				}
			},
			render: renderMessage
		},
		async execute() {
			const snapshot = ctx.manager.snapshot();
			const active = snapshot.runtime.filter((view) => view.phase === "active").length;
			const idle = snapshot.runtime.filter((view) => view.phase === "waiting" || view.phase === "starting").length;
			const toolCount = snapshot.runtime.reduce((sum, view) => sum + view.toolCount, 0);
			const bridge = snapshot.bridge !== null ? `${snapshot.bridge.source} (${snapshot.bridge.via})` : "";
			const lines = [
				ctx.enabled() ? "MCP master switch: on" : "MCP master switch: off (all servers disconnected)",
				ctx.masterSwitch() ? "" : "(enabled=false in the config file)",
				`${snapshot.servers.length} servers configured: ${active} connected, ${idle} without tools`,
				`${toolCount} MCP tools in total`,
				snapshot.bridge !== null ? `MCP bridge ${bridge}` : "MCP bridge not loaded",
				snapshot.bridgeError !== null ? `Bridge load failed: ${snapshot.bridgeError}` : "",
				`State file ${snapshot.file}`
			].filter((line) => line !== "");
			return {
				ok: snapshot.bridgeError === null,
				message: `dsh-mcp-manager: ${lines.join("; ")}.\n${renderServerTable(snapshot)}`,
				enabled: ctx.enabled(),
				total: snapshot.servers.length,
				active,
				idle,
				toolCount,
				bridge,
				...snapshot.bridgeError !== null ? { bridgeError: snapshot.bridgeError } : {},
				file: snapshot.file,
				servers: serverRows(snapshot)
			};
		}
	});
}
/** Tool: list servers with their live state. */
function listTool(ctx) {
	return defineTool({
		name: "mcp_manager_list",
		description: "List every MCP server configured in dsh-mcp-manager: name, transport, enabled flag, current phase (active = connected / waiting = no tools yet / error = failed / stopped = not loaded), the tool count and full tool names it contributes, and its latest error. Read-only.",
		parameters: {},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					ok: {
						type: "boolean",
						required: true
					},
					message: {
						type: "string",
						required: true
					},
					servers: {
						type: "array",
						items: {
							type: "object",
							additionalProperties: false,
							properties: {
								name: {
									type: "string",
									required: true
								},
								transport: {
									type: "string",
									required: true
								},
								enabled: {
									type: "boolean",
									required: true
								},
								phase: {
									type: "string",
									required: true
								},
								toolCount: {
									type: "number",
									required: true
								},
								error: { type: "string" },
								tools: {
									type: "array",
									items: { type: "string" }
								}
							}
						}
					}
				}
			},
			render: renderMessage
		},
		async execute() {
			const snapshot = ctx.manager.snapshot();
			const detail = snapshot.runtime.filter((view) => view.tools.length > 0).map((view) => `${view.name}: ${view.tools.join(", ")}`).join("\n");
			return {
				ok: true,
				message: `${renderServerTable(snapshot)}\n\n${detail === "" ? "(no MCP tools are currently registered)" : detail}`,
				servers: snapshot.servers.map((server) => {
					const view = snapshot.runtime.find((item) => item.name === server.name);
					return {
						name: server.name,
						transport: server.transport,
						enabled: server.enabled,
						phase: view?.phase ?? "stopped",
						toolCount: view?.toolCount ?? 0,
						...view?.error != null ? { error: view.error } : {},
						tools: view?.tools ?? []
					};
				})
			};
		}
	});
}
/** Tool: add a server. */
function addTool(ctx) {
	return defineTool({
		name: "mcp_manager_add",
		description: "Add an MCP server to dsh-mcp-manager and connect it immediately (no DSH restart needed). For a stdio server pass command/args/env/cwd; for a remote server pass transport=streamable-http with url/headers. name becomes the tool namespace: the server's tools are published as mcp__<name>__<toolName>. Use mcp_manager_test with a draft first to verify the definition.",
		parameters: {
			name: {
				type: "string",
				description: "Server namespace: letters, digits, underscores and hyphens only, 1–32 characters",
				required: true
			},
			transport: {
				type: "string",
				enum: ["stdio", "streamable-http"],
				description: "Transport (default stdio)"
			},
			command: {
				type: "string",
				description: "stdio: command that starts the server (e.g. /opt/homebrew/bin/uvx)"
			},
			args: {
				type: "array",
				items: { type: "string" },
				description: "stdio: command arguments, passed one by one without a shell"
			},
			env: {
				type: "object",
				additionalProperties: true,
				description: "stdio: extra environment variables (string keys and values)"
			},
			cwd: {
				type: "string",
				description: "stdio: working directory (optional)"
			},
			url: {
				type: "string",
				description: "streamable-http: MCP endpoint URL"
			},
			headers: {
				type: "object",
				additionalProperties: true,
				description: "streamable-http: extra request headers"
			},
			description: {
				type: "string",
				description: "Note for display only; not part of the connection config"
			},
			toolCallTimeoutMs: {
				type: "number",
				description: "Per-call timeout in milliseconds (default 60000)"
			},
			enabled: {
				type: "boolean",
				description: "Whether to enable it immediately (default true)"
			}
		},
		output: {
			schema: OP_OUTPUT,
			render: renderMessage
		},
		async execute(args) {
			const blocked = disabled(ctx.enabled);
			if (blocked !== void 0) return {
				ok: blocked.ok,
				message: blocked.message
			};
			const result = await ctx.manager.addServer(args);
			return {
				ok: result.ok,
				message: `${result.message}\n${renderServerTable(result.snapshot ?? ctx.manager.snapshot())}`,
				servers: serverRows(result.snapshot ?? ctx.manager.snapshot())
			};
		}
	});
}
/** Tool: update a server. */
function updateTool(ctx) {
	return defineTool({
		name: "mcp_manager_update",
		description: "Edit an existing MCP server in dsh-mcp-manager: any of transport/command/args/env/cwd/url/headers/description/toolCallTimeoutMs, and enabled to toggle it. Changing name renames it (the old namespace is disconnected and the server reconnects under the new name). Pass only the fields you want to change.",
		parameters: {
			name: {
				type: "string",
				description: "Current name of the server to update",
				required: true
			},
			newName: {
				type: "string",
				description: "New name (omit to keep the current name)"
			},
			transport: {
				type: "string",
				enum: ["stdio", "streamable-http"],
				description: "Transport"
			},
			command: {
				type: "string",
				description: "stdio: command that starts the server"
			},
			args: {
				type: "array",
				items: { type: "string" },
				description: "stdio: command arguments"
			},
			env: {
				type: "object",
				additionalProperties: true,
				description: "stdio: extra environment variables"
			},
			cwd: {
				type: "string",
				description: "stdio: working directory"
			},
			url: {
				type: "string",
				description: "streamable-http: endpoint URL"
			},
			headers: {
				type: "object",
				additionalProperties: true,
				description: "streamable-http: extra request headers"
			},
			description: {
				type: "string",
				description: "Note"
			},
			toolCallTimeoutMs: {
				type: "number",
				description: "Per-call timeout in milliseconds"
			},
			enabled: {
				type: "boolean",
				description: "Enable / disable"
			}
		},
		output: {
			schema: OP_OUTPUT,
			render: renderMessage
		},
		async execute(args) {
			const blocked = disabled(ctx.enabled);
			if (blocked !== void 0) return {
				ok: blocked.ok,
				message: blocked.message
			};
			const patch = { ...args };
			delete patch.name;
			const newName = patch.newName;
			delete patch.newName;
			if (typeof newName === "string" && newName.trim() !== "") patch.name = newName;
			const result = await ctx.manager.updateServer(String(args.name), patch);
			return {
				ok: result.ok,
				message: `${result.message}\n${renderServerTable(result.snapshot ?? ctx.manager.snapshot())}`,
				servers: serverRows(result.snapshot ?? ctx.manager.snapshot())
			};
		}
	});
}
/** Tool: remove a server (two-step). */
function removeTool(ctx) {
	return defineTool({
		name: "mcp_manager_remove",
		description: "Remove an MCP server from dsh-mcp-manager and unregister all of its tools. **Without confirm it only previews and returns exactly what would be removed, writing nothing** — show the preview to the user first, and only pass confirm: true after they agree.",
		parameters: {
			name: {
				type: "string",
				description: "Name of the server to remove",
				required: true
			},
			confirm: {
				type: "boolean",
				description: "Pass true to actually remove (means the user has agreed)"
			}
		},
		output: {
			schema: OP_OUTPUT,
			render: renderMessage
		},
		async execute(args) {
			const name = String(args.name);
			const confirm = args.confirm === true;
			const target = ctx.manager.server(name);
			if (target === void 0) return {
				ok: false,
				message: `No server named "${name}".`,
				servers: serverRows(ctx.manager.snapshot())
			};
			const view = ctx.manager.snapshot().runtime.find((item) => item.name === name);
			if (!confirm) {
				const detail = target.transport === "stdio" ? `${target.command} ${target.args.join(" ")}` : target.url;
				return {
					ok: true,
					message: [
						`Preview: removing server "${name}" and unregistering its current ${view?.toolCount ?? 0} tools:`,
						`  Transport: ${target.transport}`,
						`  Definition: ${detail}`,
						view !== void 0 && view.tools.length > 0 ? `  Tools: ${view.tools.join(", ")}` : "  Tools: (none)",
						"Nothing was written. To delete it, call again with confirm: true."
					].join("\n"),
					servers: serverRows(ctx.manager.snapshot())
				};
			}
			const blocked = disabled(ctx.enabled);
			if (blocked !== void 0) return {
				ok: blocked.ok,
				message: blocked.message
			};
			const result = await ctx.manager.removeServer(name);
			return {
				ok: result.ok,
				message: `${result.message}\n${renderServerTable(result.snapshot ?? ctx.manager.snapshot())}`,
				servers: serverRows(result.snapshot ?? ctx.manager.snapshot())
			};
		}
	});
}
/** Tool: test a saved server or an unsaved draft. */
function testTool(ctx) {
	return defineTool({
		name: "mcp_manager_test",
		description: "Test whether an MCP server can connect, and list the tools it offers. Two modes: pass name to reconnect the saved server (it disconnects first); or pass name plus command/args (or url) as a **draft** — the draft is never saved, and it disconnects and restores the previous state when done. This is the most reliable way to verify a definition before adding it.",
		parameters: {
			name: {
				type: "string",
				description: "Server name (in draft mode, the namespace to use for this test)",
				required: true
			},
			draft: {
				type: "boolean",
				description: "When true, treat the fields of this call as a draft and do not save them"
			},
			transport: {
				type: "string",
				enum: ["stdio", "streamable-http"],
				description: "Draft: transport"
			},
			command: {
				type: "string",
				description: "Draft: stdio command"
			},
			args: {
				type: "array",
				items: { type: "string" },
				description: "Draft: stdio command arguments"
			},
			env: {
				type: "object",
				additionalProperties: true,
				description: "Draft: stdio extra environment variables"
			},
			url: {
				type: "string",
				description: "Draft: streamable-http endpoint URL"
			}
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					ok: {
						type: "boolean",
						required: true
					},
					message: {
						type: "string",
						required: true
					},
					tools: {
						type: "array",
						items: { type: "string" }
					}
				}
			},
			render: renderMessage
		},
		async execute(args) {
			const raw = args;
			const name = String(raw.name);
			const useDraft = raw.draft === true || raw.command !== void 0 || raw.url !== void 0;
			try {
				if (useDraft) {
					const result = await ctx.manager.test(void 0, {
						name,
						transport: raw.transport,
						command: raw.command,
						args: raw.args,
						env: raw.env,
						url: raw.url,
						enabled: true
					});
					return {
						ok: result.ok,
						message: result.message,
						tools: result.tools
					};
				}
				if (!ctx.enabled()) return {
					ok: false,
					message: "dsh-mcp-manager is disabled, so nothing can connect.",
					tools: []
				};
				const result = await ctx.manager.test(name, void 0);
				return {
					ok: result.ok,
					message: result.message,
					tools: result.tools
				};
			} catch (error) {
				return {
					ok: false,
					message: `Test failed: ${describe(error)}`,
					tools: []
				};
			}
		}
	});
}
/** Tool: import definitions from another manager's file. */
function importTool(ctx) {
	return defineTool({
		name: "mcp_manager_import",
		description: "Import server definitions from another MCP manager's config file (existing names are never overwritten; imported entries connect according to their own enabled flag). Without path it tries, in order: $DSH_HOME/@wingsky-1/dsh-mcp-manager/mcp.json (where the package this plugin replaces stores them), $DSH_HOME/mcp-servers.json, $DSH_HOME/mcp-manager-mcp.json, $DSH_HOME/dsh-mcp-manager/servers.json.",
		parameters: { path: {
			type: "string",
			description: "File to import (omit to try the default locations)"
		} },
		output: {
			schema: OP_OUTPUT,
			render: renderMessage
		},
		async execute(args) {
			const blocked = disabled(ctx.enabled);
			if (blocked !== void 0) return {
				ok: blocked.ok,
				message: blocked.message
			};
			const path = args.path;
			const result = await ctx.manager.importFrom(typeof path === "string" ? path : void 0);
			return {
				ok: result.ok,
				message: `${result.message}\n${renderServerTable(result.snapshot ?? ctx.manager.snapshot())}`,
				servers: serverRows(result.snapshot ?? ctx.manager.snapshot())
			};
		}
	});
}
/** Tool: re-read the state file and reconcile. */
function reloadTool(ctx) {
	return defineTool({
		name: "mcp_manager_reload",
		description: "Re-read $DSH_HOME/dsh-mcp-manager.json and reconnect according to its definitions (use it after editing the config file by hand, or to retry a server that failed to connect). It only affects connections, never the config content.",
		parameters: {},
		output: {
			schema: OP_OUTPUT,
			render: renderMessage
		},
		async execute() {
			if (!ctx.enabled()) {
				await ctx.manager.shutdown();
				return {
					ok: true,
					message: "dsh-mcp-manager is disabled; all MCP servers have been disconnected.",
					servers: []
				};
			}
			const snapshot = await ctx.manager.refresh();
			return {
				ok: true,
				message: `Re-read ${snapshot.file} and reconnected.\n${renderServerTable(snapshot)}`,
				servers: serverRows(snapshot)
			};
		}
	});
}
/**
* Build every agent-facing `mcp_manager_*` tool.
* @param ctx - the tool context.
* @returns registry-ready definitions.
*/
function buildTools(ctx) {
	return [
		statusTool(ctx),
		listTool(ctx),
		addTool(ctx),
		updateTool(ctx),
		removeTool(ctx),
		testTool(ctx),
		importTool(ctx),
		reloadTool(ctx)
	];
}
//#endregion
//#region src/index.ts
/** Stable cordis plugin name. */
const name = "mcp-manager";
/** Services required before the surfaces can mount. */
const inject = [
	"tools",
	"systemPrompt",
	"webServer"
];
/** Order of the announcement section within the tool-guidance band. */
const SECTION_ORDER = 164;
/** Model-facing announcement: plugin presence, capabilities, and limits. */
const MCP_MANAGER_GUIDANCE = "This machine has the dsh-mcp-manager plugin installed (MCP server management): add, edit, enable/disable, test and remove MCP servers from the \"MCP Manager\" panel on the Web settings page or directly through tools. It supports stdio (command/args/env/cwd) and streamable-http (url/headers) transports, and both connecting and disconnecting happen at runtime with no DSH restart. The servers' tools appear as mcp__<serverName>__<toolName>. Tools: mcp_manager_status (status), mcp_manager_list (list), mcp_manager_add (add and connect), mcp_manager_update (edit/enable/disable/rename), mcp_manager_remove (remove; always preview first and get user consent), mcp_manager_test (test a saved server or a draft definition), mcp_manager_import (import from the old manager plugin), mcp_manager_reload (re-read the config and reconnect). Server definitions live in $DSH_HOME/dsh-mcp-manager.json (0600). When the user mentions \"MCP / MCP server / manage MCP / install an MCP / mcp tools / garmin\", they mean this plugin — work with them accordingly.";
/**
* Mount the MCP manager tools, routes, panel and announcement.
* @param ctx - host plugin context carrying tools/systemPrompt/webServer.
* @param config - plugin config from the composition row.
*/
function apply(ctx, config) {
	const announceToAgent = config?.announceToAgent !== false;
	const enabled = config?.enabled !== false;
	const home = dshHome();
	const manager = new McpManager({
		ctx,
		enabled: () => enabled,
		home
	});
	let disposeTools;
	let disposeRoutes;
	let disposeSection;
	const sync = () => {
		if (disposeTools !== void 0) {
			disposeTools();
			disposeTools = void 0;
		}
		if (disposeRoutes !== void 0) {
			disposeRoutes();
			disposeRoutes = void 0;
		}
		if (disposeSection !== void 0) {
			disposeSection();
			disposeSection = void 0;
		}
		if (!enabled) return;
		try {
			disposeTools = ctx.effect(() => {
				const disposers = buildTools({
					manager,
					enabled: () => manager.active(),
					masterSwitch: () => manager.masterSwitch(),
					file: () => manager.snapshot().file
				}).map((tool) => ctx.tools.register(tool));
				return () => {
					for (const dispose of disposers) dispose();
				};
			}, "dsh-mcp-manager: tools");
		} catch (error) {
			ctx.logger.warn(`dsh-mcp-manager: tool registration failed: ${describe(error)}`);
		}
		try {
			disposeRoutes = ctx.effect(() => {
				const disposers = makeRoutes({
					manager,
					home,
					enabled: () => enabled
				}).map((route) => ctx.webServer.register(route));
				return () => {
					for (const dispose of disposers) dispose();
				};
			}, "dsh-mcp-manager: routes");
		} catch (error) {
			ctx.logger.warn(`dsh-mcp-manager: route registration failed: ${describe(error)}`);
		}
		if (announceToAgent) try {
			disposeSection = ctx.systemPrompt.section({
				name: "plugin:dsh-mcp-manager",
				order: SECTION_ORDER,
				text: MCP_MANAGER_GUIDANCE
			});
		} catch (error) {
			ctx.logger.warn(`dsh-mcp-manager: prompt section failed: ${describe(error)}`);
		}
	};
	sync();
	(async () => {
		if (!enabled) return;
		try {
			await manager.initialize();
		} catch (error) {
			ctx.logger.warn(`dsh-mcp-manager: initial connection failed: ${describe(error)}`);
		}
	})();
	ctx.effect(() => {
		return () => {
			manager.shutdown();
		};
	}, "dsh-mcp-manager: connections");
}
//#endregion
export { BRIDGE_PACKAGE, MANAGER_API, MCP_MANAGER_GUIDANCE, ManagerRuntime, McpManager, SERVER_NAME_PATTERN, apply, buildTools, dshHome, emptyServer, groupByServer, inject, loadBridge, loadState, makeRoutes, name, normalizeConfig, normalizeServer, normalizeServerList, saveState, serverSignature, toBridgeConfig, toolPrefix, validateServer };
