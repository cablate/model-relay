# Changelog

[繁體中文](CHANGELOG.zh-TW.md)

All notable changes to `model-relay` are documented in this file. Format follows [Keep a Changelog 1.1](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/) (while in `0.x`, minor versions may include breaking changes). The canonical version is defined in `.claude-plugin/plugin.json`.

## [Unreleased]

### Added

- **`setup.mjs set port <n>`:** Changes the router port (`1025`–`65535`), keeps a `.relay-backup` copy, and rewires `settings.json` (`ANTHROPIC_BASE_URL`, or `HTTPS_PROXY` in proxy mode) with the usual backup. Refuses a port that already answers. The router already running keeps the old port until you stop it; the command prints its pid and does not kill it.
- **`/__health` reports `configDir`:** The config directory the router was started for, so `doctor`, `proxy` and the plugin hook can tell whose router answers on a port. Paths compare by real path, and case-insensitively on Windows.
- **`/provider setup [goal]`: let Claude set it up with you.** Claude gets the path of the installed setup tool and runs it with you: it never asks for a key in the chat, previews changes before applying them, and asks before touching `~/.claude/settings.json`. Works before a config file exists.
- **`/provider restart` and `setup.mjs restart [--if-stale] [--if-idle]`:** Restart the relay so it runs the installed plugin's code. `/__health` now reports `version`, `inflight` (requests being answered) and `tunnels` (open `CONNECT` tunnels) so a router left over from an older plugin can be told apart, and restarted only while idle.
- **`tools/smoke.mjs`:** Sends one real Claude Code request through this checkout's router on a throwaway port (`--provider <name>` adds one on a provider). Needs a logged-in `claude`, so it is a release step, not part of CI.

### Changed

- **A router that cannot take its port says why:** On `EADDRINUSE` it exits quietly only when the occupant reports the same config directory; otherwise it logs the port and the other config directory (or an unknown process) to `custom-agent-router.log` and exits non-zero. A router that reports no config directory is an older relay and is left running, as before.
- **`doctor`, `proxy status` and `proxy enable|renew` notice a foreign router:** When the router on the port belongs to another config directory, `doctor` and `proxy status` warn and `proxy enable|renew` refuse, naming both directories, before changing anything. A router that reports no directory is an older relay: `doctor` asks you to restart it, and `proxy enable` restarts it as before.
- **The plugin hook does not route through another config directory's router:** If the router on the port reports a different config directory, the session connects directly to Claude and the status line names the other directory. A router that reports none still counts as yours.
- **README:** Says where `tools/setup.mjs` lives and how to run it, that `env:VAR` tokens come from the router's own environment, that the example config sends every `haiku` call to GLM, that the automatic direct fallback only works in `ANTHROPIC_BASE_URL` mode, that `HTTPS_PROXY` also applies to `git` / `curl` / `gh`, what `proxy.enabled` really opens up, what CI really tests, and the full uninstall list.

### Fixed

- `doctor` now warns when `availableModels` in `~/.claude/settings.json` does not list a provider's non-Claude model. Claude Code otherwise runs `model-relay:<name>` subagents on `CLAUDE_CODE_SUBAGENT_MODEL` or the parent's model, with a warning only in its debug log, so they never reach the relay.
- A provider or Anthropic answer that drops mid-stream no longer leaves Claude Code waiting with no reply, and a connection reset mid-stream no longer crashes the router when retries are on: the caller's connection is cut so it sees the failure. A caller that gives up (Esc) now stops the upstream request instead of letting it run to the end.
- **A token variable the router cannot see is now visible:** the router resolves `env:VAR` tokens from the environment it was started with, so a key exported later was ignored until a restart while `doctor` (run from your shell) said "Config OK". `/__health` now lists `unresolved` providers with their variable name (never the value), the "config missing" error names the skipped providers and says to restart the router, and `doctor` warns when the running router lacks a variable your shell has.
- **First `proxy enable --go` no longer fails its self-test with "unable to get local issuer certificate":** the router remembered "no certificate" for 10 seconds, and the plugin's health poll could record that just before `proxy enable` created the certificate, so the self-test connection was tunnelled to Anthropic instead of answered with the relay certificate. A missing certificate is no longer cached.
- **`init --fix` wired port 8950:** It now wires the port from the config file.
- **A config with an unset `env:` token made the router bind 8950, and open `CONNECT` to any host:** The router now binds the config file's own port, and without a usable config it refuses `CONNECT` like proxy mode off.
- **`custom-agent-router.log` grew without limit:** It is now emptied past 5 MB like `custom-agent-requests.log`, as documented.
- **First-run setup no longer needs a path:** the install steps ran `node tools/setup.mjs …`, which only works from the plugin's install folder or a cloned copy, so running them from any other folder after `claude plugin install` failed with `Cannot find module`. `/provider init` and `/provider doctor [--ping]` now do the same work from inside Claude Code, from any folder and before a config file exists, and the README says where `node tools/setup.mjs …` applies.
- **Updating the plugin now updates the relay too:** `claude plugin update` left the old router running, because the plugin only starts one when none answers, so the fixes in this release reached nobody until the router was killed by hand. The plugin now restarts a router left by an older plugin once it answers no request and holds no tunnel. A router from before this release cannot report either, so the plugin never restarts it by itself: the status line asks you to run `/provider restart` when no reply is in progress. A router newer than the plugin is never replaced.
- **`proxy enable` no longer replaces an existing `NODE_EXTRA_CA_CERTS`:** Proxy mode points it at the relay's CA, and `settings.json` env wins over the shell's, so a certificate already set there or in your environment (often a company network's) silently stopped being trusted. `proxy enable` and `proxy renew` now refuse before changing anything and name the existing value.
- **`proxy renew --go` failed its self-test when the router had served in the last 10 seconds:** the router kept the old certificate for up to 10 seconds after `renew` replaced it, so the self-test saw a certificate the new CA does not vouch for and left `settings.json` unchanged. The router now notices the rewritten certificate file at once.

### Security

- **Web pages can no longer use the router:** the router used to answer any request that reached `127.0.0.1`, so a page open in a browser could send a plain `text/plain` POST to `/v1/messages` and spend your provider tokens, or use DNS rebinding to read answers and call `/__session`, `/__probe` and `/__ping`. The router's listener now refuses, with 403, any request that comes from a browser (one that carries an `Origin` or `Sec-Fetch-Site` header, including pages served from another local port), any request whose `Host` is not `127.0.0.1` or `localhost` on the port the router is listening on, and any absolute-form request URL. Requests inside the `api.anthropic.com` proxy tunnel are not affected.
- **Provider names such as `constructor` no longer resolve to a provider in the router:** names that exist on every JavaScript object (`constructor`, `toString`, `__proto__`) were treated as configured providers, so `/__session` could pin a session to one, and the next request from that session crashed the router. The router now treats them as unknown provider names, and a session id of `__proto__` is stored like any other.

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

[unreleased]: https://github.com/cablate/model-relay/compare/v0.6.0...HEAD
[0.6.0]: https://github.com/cablate/model-relay/compare/v0.5.0...v0.6.0
[0.5.0]: https://github.com/cablate/model-relay/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/cablate/model-relay/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/cablate/model-relay/releases/tag/v0.3.0
