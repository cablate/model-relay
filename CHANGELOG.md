# Changelog

[繁體中文](CHANGELOG.zh-TW.md)

All notable changes to `model-relay` are documented in this file. Format follows [Keep a Changelog 1.1](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/) (while in `0.x`, minor versions may include breaking changes). The canonical version is defined in `.claude-plugin/plugin.json`.

## [Unreleased]

## [0.7.4] - 2026-10-22

The router stays up and answers when a config value is wrong or a provider stalls, and `/provider doctor` no longer changes anything unless you ask it to.

### Fixed

- **Each provider gets its own model:** A request for a provider's own `model` now reaches that provider even when another provider's `matchModels` pattern would also match it, so two providers on one gateway (for example `codex/gpt-6-luna` and `codex/gpt-6.1-sol`) no longer catch each other's requests.
- **The router no longer stops on a bad value:** A provider address or `claudeUrl` that is not a valid URL, or a malformed session switch, used to take the router down for every open window. Such a provider is now skipped, `claudeUrl` falls back to Anthropic, and any unexpected error is logged while the router keeps running.
- **No more endless waits:** A provider that stops sending data for `idleTimeoutMs` (5 minutes by default), or drops the connection in the middle of an error, now gets an error back to Claude Code instead of leaving it waiting.
- **Gateways shared by several providers start once:** Providers that use the same `launch` gateway start it once, and a gateway that does not come up is retried after 1, 2, 4… up to 10 minutes instead of every 30 seconds.
- **Your own local gateway is left alone:** `doctor --fix` and `init` no longer re-point an `ANTHROPIC_BASE_URL` on another localhost port (such as LiteLLM on `:4000`) at the relay.
- **`alias` keeps a broken settings file:** If `~/.claude/settings.json` is not valid JSON, `alias` now stops with the parse error instead of rewriting the file from scratch.

### Changed

- **`/provider doctor` only reports:** It changes nothing unless you add `--fix`, and it ends with a hint when a fix is available.

### Added

- **`idleTimeoutMs`:** How long a provider may stay silent before the request counts as failed and follows the usual retry and failover rules.

## [0.7.3] - 2026-10-22

Subagents on another provider (GLM, DeepSeek, Gemini, GPT…) can use `WebFetch` and your MCP tools reliably again; in some setups these tools could go missing.

### Fixed

- **Tools loaded on demand on third-party providers:** Tools that Claude Code loads when needed, such as `WebFetch` and MCP tools, now work on third-party providers in both subagents and the main conversation. Before, they could be unavailable in some setups.

### Removed

- **`providers.<name>.stripToolSearch`:** No longer needed and ignored if still in `model-relay.json`.

## [0.7.2] - 2026-10-22

Each provider's `model-relay:<name>` subagent can now be shaped in `~/.claude/model-relay.json`: write when Claude should pick it, and give it its own prompt, tools and effort.

### Added

- **Per-provider subagent settings (`providers.<name>.agent`):** Each provider's `model-relay:<name>` subagent can now set its own `description` (the line Claude reads when choosing which agent to spawn), `prompt`, `tools`, `effort`, `maxTurns` and the other agent-file fields in `~/.claude/model-relay.json`; `name` and `model` stay the provider's.

## [0.7.1] - 2026-10-22

Lets custom statuslines (such as [coralline](https://github.com/Nanako0129/coralline)'s `relay` segment) display the actual model and routing state of each Claude Code window, and hides the plugin's own yellow status line above the prompt by default so the two do not duplicate each other.

**⚠️ Still on 0.6.0 or earlier (`< 0.7.0`)? You must upgrade and migrate now:**
- **Why `< 0.7.0` must be updated:** Versions before `0.7.0` suffer from mid-chat conversation history and tool loss on non-Claude providers in HTTPS proxy mode (`proxy enable`), as well as a localhost security flaw where open browser tabs can spend your provider quota.
- **Upgrading from `0.7.0`:** Run `claude plugin update model-relay@model-relay`. The plugin restarts the background router automatically once no request is in flight.
- **Upgrading from `0.6.0` or earlier (3 required steps—updating the plugin alone is not enough):**
  1. Run `claude plugin update model-relay@model-relay`.
  2. Migrate your config to `"format": 2`: run `/provider setup upgrade my model-relay config` in Claude Code (or `node tools/setup.mjs migrate --go` in the plugin folder).
  3. Run `/provider restart` when no window has a reply in progress. *(Full details: [UPGRADING.md](https://github.com/cablate/model-relay/blob/main/UPGRADING.md).)*

### Added

- **Per-window status file for custom statuslines (`model-relay-status/<session id>`):** Claude Code's built-in `statusLine` payload always reports the Claude model name before `model-relay` rewrites it. Each window now writes its real relay state to `~/.claude/model-relay-status/<session id>` as a single line `kind<TAB>label` (`claude`, `pinned`, `failover`, `limit`, `offline`, `direct`) whenever the route changes (and after `/clear`), so statusline tools like [coralline](https://github.com/Nanako0129/coralline) can read it directly with a single shell `read`. The background router automatically cleans up status files untouched for 7 days.

### Changed

- **Plugin status line above the input is now off by default (`statusBar`):** To keep the prompt area clean and avoid duplicating your statusline, the yellow plugin status line (`$.ui.status`) is now opt-in. Turn it back on anytime with `node tools/setup.mjs set statusBar on` (or `"statusBar": true` in `model-relay.json`); switches, upgrade reminders, and outage alerts still appear as toast notices.

## [0.7.0] - 2026-10-21

**⚠️ Recommended upgrade for all users (fixes conversation & tool loss + local security flaw):**
- **Fixes mid-chat "amnesia" in HTTPS proxy mode (`proxy enable`):** Non-Claude providers no longer lose your conversation history, system prompt, or tools mid-chat—every turn now sends the full conversation instead of a delta only Anthropic's server could resolve.
- **Closes a local quota-theft vulnerability:** Browser web pages can no longer send requests to `127.0.0.1` to spend your provider quota or change your session routing.
- **Streamlined daily controls:** `/provider` switches now reply in one line, the `/provider` panel closes automatically after you pick a model, and `/provider ping` tells you the exact reason a provider failed (key refused, unknown model, quota reached, or local service not running).

**Upgrading (Required—updating the plugin alone is not enough):**
Version 0.7 only reads config format 2 (`"format": 2`). If you are on 0.6 or earlier, you **must** run the 3 steps below, or your new router will not start (leaving your old 0.6 router running with the unpatched bugs, or sending all requests straight to Claude):
1. **Update the plugin:** `claude plugin update model-relay@model-relay`.
2. **Migrate your config file (required):** In Claude Code, run `/provider setup upgrade my model-relay config` (or run `node tools/setup.mjs migrate --go` in the plugin folder)—this backs up your old file and keeps your exact routing rules.
3. **Restart the background router (required):** Run `/provider restart` when no reply is in progress to replace the old 0.6 background router with 0.7.
*(Full details: [UPGRADING.md](https://github.com/cablate/model-relay/blob/main/UPGRADING.md).)*

### Added

- **Guided setup and upgrades inside Claude Code (`/provider setup [goal]`):** Run `/provider setup` from any folder (even before a config file exists) and Claude walks you through `setup.mjs` step by step—previewing changes, asking before touching `~/.claude/settings.json`, and never asking you to paste an API key into chat.
- **Clear failure reasons when testing a provider (`/provider ping`):** `/provider ping`, the panel's `p` key, and `doctor --ping` now run a 1-token streaming test (up to 15 seconds) and report the exact result: works, key refused, unknown model, quota or rate limit, local service not running, unreachable, or timed out. Test latency is stored in `ping` separately from real request `stats` (so a long reply never makes a provider look slow), and API keys are masked in upstream error messages.
- **Restart the background router from Claude Code (`/provider restart`):** `/provider restart` and `setup.mjs restart [--if-stale] [--if-idle]` replace the running router with the installed plugin's version. `/__health` now reports `version`, `inflight` requests, and open `CONNECT` `tunnels` so the plugin can auto-restart an older router only when it is completely idle.
- **Notice when a `model-relay:<name>` subagent did not reach the provider:** If Claude Code launches a `model-relay:<name>` subagent on a different model, or the subagent finishes without the router ever seeing that model (`seenModels` in `/__health`), the plugin pops up a warning pointing you to `/provider doctor`.
- **Change the router port in one command (`setup.mjs set port <n>`):** Updates the port (`1025`–`65535`) with a `.model-relay-backup` copy and rewires `settings.json` (`ANTHROPIC_BASE_URL` or `HTTPS_PROXY`). Refuses ports already in use and prints the old router's PID so you can stop it when ready.
- **Machine-readable diagnostics (`doctor --json`):** Outputs every finding with an `id`, the `setup.mjs` `fix` arguments, and `needsConsent` when a fix modifies user settings. Unset `env:VAR` keys are reported as `missing-key` (naming the variable, never the secret), and pre-format-2 configs are reported as `outdated` with `migrate --go` as the fix.
- **Config format 2 (`"format": 2`):** Written by `init`, `add`, and `migrate --go` so every routing rule is explicit in your file. If an older config (`custom-agent.json`, or `model-relay.json` without `"format": 2`) is present, the plugin leaves any running 0.6 router in place (or sends requests to Claude if none is running) and alerts you in the status line, panel, and [UPGRADING.md](https://github.com/cablate/model-relay/blob/main/UPGRADING.md).
- **`doctor` warns when the running router is older than the installed plugin.**
- **`/__health` reports `configDir`:** Identifies which config directory started the router (compared by real path, case-insensitively on Windows), so `doctor`, `proxy`, and the plugin never confuse another profile's router for yours.
- **Real-client release smoke test (`tools/smoke.mjs`):** Starts this checkout's router on a temporary port and runs a real `claude` request through it (plus `--provider <name>` when given) before a release.
- **CI tests for plugin logic and provider neutrality:** `hooks/logic.test.ts` runs in CI under Node, and `tools/neutral.mjs` blocks hardcoded provider names, private gateways, or 0.6 file names outside legacy migration blocks.

### Changed

- **Cleaner `/provider` output and a focused model-picker panel:** `/provider <name>` and `/provider claude` now reply with a single confirmation line instead of dumping the full status report and command list. Running `/provider` opens a compact panel dedicated to switching this window's model (and closes as soon as you switch); global toggles shared by all windows (429 failover, retry, Remote Control) and aliases are tucked under Settings `[s]`. Full status is now at `/provider status`, and the command reference is at `/provider help`.
- **Breaking (0.6 and earlier): older config files require `migrate --go`.** The 0.7 router ignores `custom-agent.json` and any `model-relay.json` without `"format": 2` (`doctor` reports `outdated`). Running `node tools/setup.mjs migrate --go` converts your file to format 2 and writes in every default 0.6 used to assume behind the scenes (preset models, the `haiku` rule on old `zai` / `glm` presets, old `gemini` / `magpie` gateway settings, name-based guesses, and the default failover chain), guaranteeing your routing behavior does not change. See [UPGRADING.md](https://github.com/cablate/model-relay/blob/main/UPGRADING.md).
- **Other `setup.mjs` commands refuse unmigrated configs:** `set`, `add`, `remove`, `alias`, `providers`, `init`, `restart`, `rc`, and `proxy enable` no longer silently rewrite an older config on the fly; they ask you to run `migrate` first.
- **No hidden routing rules in format 2:** Built-in presets (`zai`, `deepseek`, `kimi`, `minimax`, `openrouter`) only supply the API address and compatibility flags—you always pick the `model`. The old `glm`, `gemini`, and `magpie` presets are removed, no preset hijacks `haiku` unless you set an alias, 429 errors are returned as-is if `failover.chain` is empty, and nothing is guessed from a provider's name.
- **`setup.mjs add <name> --model <model id> --token <token|env:VAR> (--preset <preset> | --url <address>)` validates required flags and preserves extra fields:** Instead of inventing `<name>-default` or `api.example.com` when flags are omitted, `add` now requires a model and an address, updates only the URL, key, and model when editing an existing provider, saves a `.model-relay-backup` copy, and refuses to overwrite an unreadable config. The first provider added to a new config becomes the default 429 failover target.
- **`presets` lists only each service's API address,** since presets no longer bundle a default model.
- **`/__ping` stores test latency in `ping` instead of overwriting `stats`:** Real request timings stay in `stats`. (A Claude Code window still running the 0.6 plugin will show test times again after you restart it.)
- **Consistent `model-relay*` file names:** Config, state, logs, and backups are now `model-relay.json`, `model-relay-state.json`, `model-relay.log`, `model-relay-requests.log`, and `*.model-relay-backup`. The 0.6 `custom-agent*` names (`custom-agent.json`, `custom-agent-state.json`, `custom-agent-router.log`, `custom-agent-requests.log`) are renamed automatically by `migrate --go`.
- **`init` creates an empty format 2 config instead of copying example providers:** New installs route everything to Claude until you add a provider, and `doctor` explains how to add one instead of reporting an error.
- **The plugin reads provider list and state from the running router only:** It reads only `port` and `nodePath` from disk, preventing the UI from showing or selecting a provider the router is not actually serving.
- **`model-relay.example.json`, README, and diagrams use neutral placeholder names instead of real providers.**
- **Clear log message when the router port is already taken:** On `EADDRINUSE`, the router exits silently only if the process on that port is already serving the same config directory; otherwise it logs the port conflict and the other process's config directory to `model-relay.log` and exits non-zero.
- **`doctor` and `proxy` commands detect routers from another config directory:** If the port is held by a router for a different config directory, `doctor` and `proxy status` warn you and `proxy enable|renew` refuse to overwrite settings, printing both directory paths.
- **The plugin bypasses routers belonging to another config directory:** If the router on your port was started for a different config directory, the session connects directly to Claude and displays the other directory in the status line.
- **Expanded README troubleshooting and architecture notes:** Documented where `tools/setup.mjs` lives, how `env:VAR` tokens are read from the router process's environment, why automatic direct-to-Claude fallback only applies to `ANTHROPIC_BASE_URL` mode, how `HTTPS_PROXY` affects `git` / `curl` / `gh`, what `proxy.enabled` intercepts, what CI covers, and how to completely uninstall.

### Fixed

- **Non-Claude providers losing conversation history and tools in HTTPS proxy mode:** In HTTPS proxy mode, Claude Code sees `api.anthropic.com` and enables the `message-threads` beta—storing history on Anthropic's servers and sending only the newest turn without system prompt or tools. Because third-party providers do not have that server-side thread, they saw only your latest sentence and replied as if it were a brand-new chat without local file access. The router now rejects the `message-threads` beta for non-Claude routes (logged as `<provider>-thread-refused`), prompting Claude Code to send the complete conversation and tool definitions on every turn. (`ANTHROPIC_BASE_URL` mode was never affected.)
- **Fresh installs with no usable provider could not even use Claude:** Instead of returning HTTP 500 `"config missing"` when no provider key is ready yet, the router now passes all requests through to Claude.
- **A provider named `zai` was unreachable:** The router previously aliased `glm` and `zai` to each other internally, so routes for `zai` were rewritten to `glm`. Every provider is now routed and logged under its own configured name.
- **Newlines or invalid header characters in an API key no longer crash the router during `/provider ping`:** The router catches the invalid header, reports a clean error, and never echoes the secret.
- **`doctor --fix` no longer overwrites a custom `ANTHROPIC_BASE_URL`:** If your `settings.json` points `ANTHROPIC_BASE_URL` to another gateway, `doctor --fix` leaves it untouched and tells you.
- **Visible warning when the router fails to start:** Instead of silently falling back to Claude with only `"Relay offline"` in the status bar, the plugin now pops up a notice pointing you to `model-relay.log`.
- **`/provider ping` no longer cuts off at 10 seconds:** It now waits for the router's full timeout, giving local gateways launched on demand enough time to boot and answer.
- **Typing `/provider constructor` (or other JavaScript `Object.prototype` names) no longer triggers a false provider lookup.**
- **`doctor` warns when a provider's model is missing from `availableModels` in `~/.claude/settings.json`:** Without that entry, Claude Code silently falls back to `CLAUDE_CODE_SUBAGENT_MODEL` or the parent model when spawning a `model-relay:<name>` subagent, so the request never reaches the provider.
- **Dropped streams and `Esc` cancellations now close cleanly on both ends:** If an upstream connection drops mid-stream, the router immediately closes the client stream instead of leaving Claude Code hanging (and without crashing when retries are enabled). Pressing `Esc` in Claude Code now aborts the in-flight upstream request so it stops generating tokens.
- **Warn when an `env:VAR` API key was set with `export` after the router started:** Because the background router inherits the environment from when it launched, exporting a key later in your shell left the provider skipped even while `doctor` said `"Config OK"`. `/__health` now lists `unresolved` env var names (never values), and `doctor` tells you to restart the router when your shell has a key the running router lacks.
- **First-time `proxy enable --go` no longer fails its self-test with `"unable to get local issuer certificate"`:** The router previously cached a missing-certificate result for 10 seconds, so a health check right before certificate generation caused the self-test to tunnel straight to Anthropic instead of using the new relay certificate.
- **`init --fix` now writes the port from your config file instead of hardcoding `8950`.**
- **When all provider `env:` tokens are unset, the router still respects your configured port and `proxy.enabled` setting** instead of falling back to port `8950` or allowing open `CONNECT` requests.
- **`model-relay.log` now rotates at 5 MB** just like `model-relay-requests.log`, preventing unbounded disk growth.
- **Run `/provider init` and `/provider doctor [--ping]` from any folder:** You no longer have to `cd` into the plugin directory to run `node tools/setup.mjs …` after running `claude plugin install`.
- **`claude plugin update` no longer leaves an outdated router running forever:** Once a 0.7+ router is running, future plugin updates will automatically restart it as soon as `inflight` and `tunnels` hit zero. (For a 0.6 router, which cannot report whether it is busy, the status bar prompts you to run `/provider restart`.)
- **`proxy enable` and `proxy renew` no longer overwrite an existing `NODE_EXTRA_CA_CERTS`:** If you already have a custom CA configured (for example, a corporate root certificate), `proxy enable` and `proxy renew` stop and show you the existing path instead of replacing it.
- **`proxy renew --go` reloads the renewed certificate immediately:** The router no longer serves the old cached certificate for up to 10 seconds after renewal, which previously caused the post-renew self-test to fail.

### Security

- **Browser web pages can no longer call the local router or spend your provider quota:** Previously, any page open in your browser could send a simple `text/plain` POST to `127.0.0.1` (or use DNS rebinding) to call `/v1/messages`, `/__session`, `/__probe`, or `/__ping`. The router now returns HTTP 403 for any request carrying browser headers (`Origin` or `Sec-Fetch-Site`), any `Host` header other than `127.0.0.1` or `localhost` on the router's port, and any absolute-form URL. (Traffic inside the `api.anthropic.com` proxy tunnel is unaffected.)
- **Prototype-pollution guard on provider and session names:** Built-in JavaScript object keys (`constructor`, `toString`, `__proto__`) can no longer be passed to `/__session` to crash the router or corrupt session state.

### Not covered

- **Upstreams that stop sending bytes without closing the TCP connection:** Still governed by Claude Code's own request timeout.
- **Cancelling a non-model request inside the HTTPS proxy tunnel does not abort the upstream connection.**
- **Subagent delegation prompt wording is unchanged,** pending benchmark measurement.
- **No JSON Schema or standalone reference doc for `model-relay.json` yet.**
- **Chaining through an upstream corporate proxy is not supported.**

## [0.6.0] - 2026-10-20

Use Remote Control without losing the relay (`proxy.enabled` with a local CA constrained to `api.anthropic.com`), point `haiku` / `sonnet` / `opus` aliases at any provider in one command (`setup.mjs alias` & `/provider alias`), and spawn provider subagents on the fly (`subagent_type: "model-relay:<name>"`) without `.claude/agents/*.md` files or restarting your session. The `/provider` panel also adds live toggles for 429 failover (`failover.chain`), retries (`retry.enabled`), and Remote Control (`f` / `t` / `x`).

**Upgrading:** Pull the latest version or run `claude plugin update model-relay@model-relay`. Run `node tools/setup.mjs migrate --go` if you want to clean up legacy config keys.

### Added

- **Remote Control with the relay still in the path (HTTPS proxy mode):** Claude Code keeps `api.anthropic.com` as its address, which Remote Control requires, and uses the relay as its `HTTPS_PROXY`. The relay answers for `api.anthropic.com` with its own certificate and routes model calls exactly as before (providers, sticky 429 failover, retries); token refresh, Remote Control traffic and WebSocket upgrades pass to Anthropic unchanged, and every other host is a plain byte tunnel. Opt-in: off by default, so the router never acts as an open proxy for anyone who does not use Remote Control. Setting: `proxy.enabled`.
- **Name-constrained local certificate authority:** The CA can only vouch for `api.anthropic.com`, its private key is discarded after it signs the one leaf certificate, and only processes that carry `NODE_EXTRA_CA_CERTS` trust it. Without a usable certificate the relay tunnels `api.anthropic.com` untouched, so Claude Code keeps working.
- **`setup.mjs proxy` and `setup.mjs rc`:** `proxy status|enable|disable|renew` (add `--go` to apply) switches `settings.json` between API-address mode and proxy mode, keeps a `settings.json.relay-backup` copy and refuses settings it does not own; `rc` starts the router when needed and then runs `claude remote-control`.
- **Failover chain:** `failover.chain` lists the providers that take over, in order. When Claude hits its limit the first one answers, and with `retry.failover` a provider that keeps failing hands the request to the next one, never back to one it already tried. A provider can override this with `providers.<name>.fallback` (`false` for nobody, or its own list).
- **Retry master switch:** `retry.enabled` set to `false` turns retrying off everywhere and keeps the other retry settings for later.
- **Switches in the `/provider` panel:** three rows turn 429 failover, retry and Remote Control on or off (hotkeys `f`, `t`, `x`). Remote Control asks for confirmation first because it rewrites `settings.json`; the panel changes the file through the same `set` and `proxy` commands of `setup.mjs`.
- **Config commands in `setup.mjs`:** `set` changes one switch or list after validating it, `providers` shows routes, failover and retry per provider, `remove` deletes a provider from the file and from every failover list, and `migrate` moves an old file to the current layout. Edits keep a `.relay-backup` copy, tokens are never printed, and the router reads the result on its next request.
- **First-class model alias management (`setup.mjs alias` & `/provider alias`):** Inspect or point `haiku`, `sonnet`, `opus`, or `subagent` (`CLAUDE_CODE_SUBAGENT_MODEL`) at any provider or back to Claude in one command, keeping `~/.claude/settings.json` (`ANTHROPIC_DEFAULT_*_MODEL`) and `~/.claude/model-relay.json` (`matchModels`) in sync. `/provider` and the panel now display model aliases separately from 429 failover and support `/provider alias|failover|retry|rc` directly from the prompt.
- **Dynamic `model-relay:<provider>` subagent types (`$.agent.register` & `agent.spawn`):** Because Claude Code's `Agent` tool validates `model` against `"sonnet"|"opus"|"haiku"|"fable"`, the plugin dynamically registers `model-relay:<name>` (such as `model-relay:glm` and `model-relay:gemini`) with full parent tools and the provider's model ID, and locks that model in `on('agent.spawn')`—no static `.claude/agents/*.md` file or session restart needed.

### Changed

- **`doctor` understands proxy mode:** `doctor --fix` no longer puts `ANTHROPIC_BASE_URL` back when proxy mode is on, and `/__health` reports proxy state and connection counts.
- **Cleaner config layout:** `failover` holds `enabled`, `chain` and `cooldownMs`, and providers live only under `providers`. The old top-level `baseUrl`, `token`, `model`, `gemini`, `failoverEnabled`, `probeEveryMin` and `failoverProvider` still work and are read as if migrated; `migrate --go` rewrites the file with the same behaviour.
- **`doctor` checks the config:** it warns about an old layout, failover names that match no provider, and a model name that another provider's `matchModels` claims first, and its failover line shows the chain and the cooldown.
- **`/__health` reports the switches:** `failoverChain` and `config` show what the router is really doing, so the panel never guesses.

### Fixed

- **`failover.cooldownMs` was ignored:** the documented setting had no effect because the router read `probeEveryMin`. `failover.cooldownMs` now sets how long new sessions stay off Claude, with a one-minute minimum.
- **A half-saved config no longer fails requests:** the router keeps the last good config when the file cannot be read for a moment, and the `setup.mjs` commands write files in one step.
- **Claude model names matched via `matchModels` are now rewritten on the wire:** when a request carrying a `claude-*` model (such as a hardcoded `claude-haiku-4-5-20251001`) matches a provider's `matchModels`, the router now rewrites the body's `model` field to that provider's target model instead of forwarding the `claude-*` name unchanged.

## [0.5.0] - 2026-10-18

A provider that answers 429 or 5xx no longer kills your turn: the relay retries the SAME provider with exponential backoff, polling at `retry.maxDelayMs` when `Retry-After` asks for longer, so Claude Code never sees the intermediate failures. Cross-provider failover after exhausted retries is available as an opt-in.

**Upgrading:** Pull the latest version; same-provider retrying is on by default and needs no configuration. Tune it with the new `retry` settings.

### Added

- **Transparent same-provider retries with backoff:** Failing provider answers (429, 500, 502, 503, 504, 529) are retried on the same provider up to `retry.attempts` times with `retry.delayMs` × `retry.backoff` waits, capped by `retry.maxDelayMs`. `retry.attempts: 0` retries forever (until success or the client disconnects). Settings: `retry`.
- **`Retry-After` awareness:** A provider asking to wait longer than `retry.maxDelayMs` keeps being polled at that cap instead of giving up early. Setting: `retry.maxDelayMs`.
- **Opt-in cross-provider failover:** With `retry.failover: true`, the original (un-rewritten) request is forwarded to `failover.provider` once retries run out, so the turn completes on the backup model rather than returning the error. Setting: `retry.failover`.
- **Per-provider retry switch:** `providers.<name>.retry` turns retrying off for one provider (`false`), follows the global settings (`true`, the default), or passes a partial object (e.g. `{ "attempts": 5 }`) to override individual fields. Setting: `providers.<name>.retry`.

## [0.4.0] - 2026-10-17

Type `/provider` to open an interactive `AbovePrompt` control panel right above your prompt input box: switch the current window's model with one click (or hotkeys `1`–`9`), test live latency across every provider (`[Ping]`), and protect long prompt caches with a two-click confirmation before switching back to Claude. Both English and Traditional Chinese READMEs now have their own animated banners and story diagrams.

**Upgrading:** Pull the latest version or run `claude plugin update model-relay@model-relay`. No configuration changes are required.

### Added

- **Interactive `AbovePrompt` control panel:** Running `/provider` or `/provider panel` opens an interactive panel above the prompt where you can switch providers by clicking buttons or pressing `ctrl+x tab` + `1`–`9`, with a two-step confirmation before switching a pinned session back to Claude.
- **Live upstream latency ping (`/__ping` and `/provider ping`):** Test live HTTP status and response time for all configured providers directly from the panel (`[Ping]`) or via `/provider ping`, and reset 429 cooldown timers via `[Retry Claude]` or `/provider probe`.
- **Separate English and Traditional Chinese animated SVGs:** Added dedicated English and Traditional Chinese dark/light banners (`banner-dark.svg`, `banner-light.svg`, `banner-dark.zh-TW.svg`, `banner-light.zh-TW.svg`) and story animations (`relay-flow.svg` / `.zh-TW.svg`, `panel.svg` / `.zh-TW.svg`).

## [0.3.0] - 2026-10-17

`model-relay` is now open-source as a flexible, multi-provider localhost router and failover toolkit for Claude Code. You can route individual conversations or `haiku` subagents across Claude, GLM (`z.ai`), Gemini (via local gateway), DeepSeek, Kimi, MiniMax, or OpenRouter without losing prompt cache efficiency when Claude hits a 429 usage limit.

**Upgrading:** Existing `~/.claude/custom-agent.json` files continue to work without changes. Run `node tools/setup.mjs init --fix` and `node tools/setup.mjs doctor --ping` to verify your setup or migrate to `~/.claude/model-relay.json`.

### Added

- **Flexible multi-provider routing and built-in presets:** Configure any number of providers under `providers.<name>` using built-in presets (`zai`, `glm`, `deepseek`, `kimi`, `minimax`, `openrouter`, `gemini`, `magpie`) so `baseUrl`, `model`, `matchModels`, `stripToolSearch`, `stripCacheControl`, and `authHeader` work out of the box with just a `token`. Setting: `providers`.
- **Cache-safe sticky 429 failover:** When Anthropic returns a 429 usage-limit response, the router automatically forwards to `failover.provider` and pins that session for 7 days so recovering Claude quota never triggers an expensive 800k-token prompt cache rebuild on existing long chats. Setting: `failover`.
- **Structured `/provider` command and live provider sync:** `/provider` now displays an aligned route list (`●` active vs `○` available) synced directly with the router's live `/__health` endpoint, hiding providers whose `env:VAR_NAME` token is unset.
- **One-command `doctor` and upstream `--ping` CLI:** Run `node tools/setup.mjs doctor --fix --ping` to validate config syntax, detect unset `env:VAR` variables, wire `ANTHROPIC_BASE_URL` into `~/.claude/settings.json`, check localhost router health, and send a 1-token live probe to every configured provider.
- **Local gateway supervision (`launch`):** Providers pointing at `127.0.0.1` or `localhost` can declare `launch: { command, args }` so the router automatically spawns the local gateway whenever its TCP port is closed. Setting: `providers.<name>.launch`.
- **Cross-platform and bilingual UI support:** Supports both Windows (`powershell.exe` + `curl.exe`) and macOS/Linux (`sh` + `curl`), with English and Traditional Chinese status/command output plus SVG architecture diagrams.

### Removed

- **Legacy child-process `custom_agent` tool:** Removed the deprecated `claude.exe -p` child-process wrapper so the plugin focuses purely on fast, zero-overhead HTTP relay and session routing.

[unreleased]: https://github.com/cablate/model-relay/compare/v0.7.2...HEAD
[0.7.2]: https://github.com/cablate/model-relay/compare/v0.7.1...v0.7.2
[0.7.1]: https://github.com/cablate/model-relay/compare/v0.7.0...v0.7.1
[0.7.0]: https://github.com/cablate/model-relay/compare/v0.6.0...v0.7.0
[0.6.0]: https://github.com/cablate/model-relay/compare/v0.5.0...v0.6.0
[0.5.0]: https://github.com/cablate/model-relay/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/cablate/model-relay/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/cablate/model-relay/releases/tag/v0.3.0
