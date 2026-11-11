# dsh-mcp-manager portability verification SOP

> Rule source: `~/.dsh/AGENTS.md` section 10 (always in force). Criteria: `2️⃣ AI/Standards/DSH插件可移植性验证清单.md`.
> Tool source: `DSH /DSH-test/dsh-release-kit/` (`portability.mjs` has been copied into this repo's `scripts/`).
> **Gate: do not publish before it says `✅ Passed`.**

## Why this plugin needs it especially

The plugin's core capability is **starting someone else's MCP server subprocess on someone else's
machine**, so it carries three extra classes of risk that only blow up on other machines:

1. **MCP bridge resolution.** The plugin does not implement MCP itself; it drives the harness's
   bundled `@deepseek-ai/dsh-mcp-client` (see the resolution ladder in `src/core-mcp.ts`). Whether
   that package can still be found after a tarball install is the root cause of "installed, but
   cannot connect to any server".
2. **`DSH_HOME`, not `~/.dsh`.** Server definitions must land in the harness's own home; hardcoding
   `~/.dsh` makes a machine with a relocated home read an empty server list while the real config
   sits elsewhere.
3. **No definition file during verification.** The health route must answer truthfully even with
   **zero config**, otherwise a "fresh machine" is misread as a broken plugin.

## 1. Standard routine (before every release)

```bash
npm run verify:full          # = node scripts/portability.mjs --health /api/dsh-mcp-manager/probe
npm run verify:live          # live instance end to end: config → real MCP server → mcp__* tools
```

Eight steps, fully automatic, exit code is the verdict:

| # | Step | What it guards against |
| --- | --- | --- |
| 1 | Static audit | local absolute paths / bare platform-specific commands / writing `.dsh` while ignoring `DSH_HOME` |
| 2 | `npm pack` + entry check | files missing from the package: `main`, `exports["./client"]`, `dsh.bundle.patch`, `files` |
| 3 | Clean install | empty profile + **tarball** (no `link:`); whether it lands in `dsh.profile.bundles` |
| 4 | Boot | start an instance in an **isolated `DSH_HOME`** and pick up error lines from the boot output |
| 5 | Host half | whether `GET /api/dsh-mcp-manager/probe` really answers |
| 6 | Client half | `dsh.client` declaration, bundle registration id **equal to the package name**, presence in `__DSH_BOOT__.entries` |
| 7 | Real action | this plugin has no restart-style endpoint, so skipped (the real action is covered by `verify:live`) |
| 8 | **Stability watch** | **is it still alive after readiness** (a late crash = a false success) |

> This plugin's "real action" is `npm run verify:live`: it really starts a stdio MCP server in an
> isolated instance, asserts the tools register as `mcp__<name>__*`, then runs add / disable / remove
> over HTTP to prove "no restart needed".

## 2. Notes on this plugin's health route

`/api/dsh-mcp-manager/probe` **also returns 200 while the plugin is disabled** (it only reports
`enabled: false`). This is deliberate: it is the health check of the portability gate, and a
"switched-off plugin" that returned 503 would read as "the install is broken".
It reports both switches so "switched off on purpose" and "failed to boot" can be told apart:

```json
{ "ok": true, "enabled": true, "masterSwitch": true, "serving": true,
  "servers": 0, "toolCount": 0, "managerTools": ["mcp_manager_add", "..."],
  "bridge": "harness", "bridgeError": null }
```

- `bridge`: `harness` / `profile` = the harness's own bridge; `bare` = fell back to the plugin's own dependency tree (the version may have drifted).
- `managerToolCount`: the only observation point that proves the agent-tool half really mounted (those tools live on the tool registry, not behind a route).

## 3. Manual re-check

```bash
npm pack
export DSH_HOME=$(mktemp -d)/dsh-home                      # ① must be isolated
dsh --profile verify-mcp-mgr --from-default-profile web --dump-config
dsh plugin --profile verify-mcp-mgr add "file:$PWD/zhengjunyao-dsh-mcp-manager-0.1.0.tgz"
python3 -c "import json;print(json.load(open('$DSH_HOME/profiles/verify-mcp-mgr/package.json'))['dsh']['profile']['bundles'])"
dsh --profile verify-mcp-mgr --port 3456 --no-open > /tmp/verify.log 2>&1 &
grep -n "Error\|error:" /tmp/verify.log                    # ② port LISTEN ≠ successful boot
curl -s http://127.0.0.1:3456/api/dsh-mcp-manager/probe    # ③ host half
TOKEN=$(grep -o 'token=[A-Za-z0-9_-]*' /tmp/verify.log | head -1 | cut -d= -f2)
curl -s -L -c /tmp/ck -b /tmp/ck "http://127.0.0.1:3456/?token=$TOKEN" -o /tmp/idx.html
grep -c "@zhengjunyao/dsh-mcp-manager/client.js" /tmp/idx.html    # ④ client half
sleep 15 && curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3456/api/dsh-mcp-manager/probe   # ⑤ still alive?
lsof -ti tcp:3456 -sTCP:LISTEN | xargs -r kill; rm -rf "$DSH_HOME" *.tgz
```

## 4. Four traps you must know

1. **`DSH_HOME` must be isolated.** A second instance on the same machine waits for the write lock on
   `~/.dsh/.credentials.yaml` until it times out (`atomic-write: timed out waiting for the writer lock`)
   and fails to boot — without isolation the verification results are all fake. This plugin's
   `verify:live` therefore **never touches the real `~/.dsh`**.
2. **Port LISTEN ≠ successful boot.** `dsh web` binds the port first and loads the plugin tree after;
   failures such as a credential write-lock timeout take ~30 seconds to surface. So check the error
   lines in the boot output *and* keep watching after readiness.
3. **The URL line with the token arrives late and cannot be captured through a pipe.** `dsh web` forks
   the real server process; once the wrapper exits the pipe closes and the token written by the forked
   half is lost — that is why the tooling uses a **file** for stdio.
4. **Verification only proves "it installs and boots on someone else's machine"**, not "it can connect
   to someone else's MCP server" — that depends on the other server. This plugin's contract is:
   **correct config connects, wrong config reports the error truthfully, and neither breaks the
   harness boot**.

## 5. Veto items (any one blocks the release)

1. Local absolute paths in the source.
2. A declared entry / file loaded by path at runtime is missing from the package.
3. After installing the tarball into an empty profile it is not in `dsh.profile.bundles`.
4. Errors in the boot output (even if the port answers).
5. The client bundle registration id differs from the package name.
6. `__DSH_BOOT__.entries` does not contain `@zhengjunyao/dsh-mcp-manager/client.js`.
7. The service did not recover after the real action (this plugin uses `verify:live`'s add/remove/enable instead).
8. **It did not hold up after readiness** (the health route dropped, the process was replaced, or new fatal boot lines appeared inside the observation window).

## 6. After passing

1. `npm run verify:full` prints `✅ Passed`, `npm run verify:live` prints `✅ Live end-to-end verification passed`.
2. Record the conclusion in the project file (pass / fail + failed items).
3. Then follow the version discipline → git tag → npm publish → aggregate platforms.

> Order matters: **portability verification comes before the version discipline**. A wrong version number can be released again; an install that is broken for others is "broken the moment it ships".
