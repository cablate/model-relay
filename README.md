<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/assets/banner-dark.svg">
    <img src="docs/assets/banner-light.svg" width="900" alt="model-relay: per-window model switcher, subagent router, and 429 failover for Claude Code">
  </picture>
</p>

<p align="center">
  <b>Switch any Claude Code window to another model from an interactive panel, route subagents to any provider,<br>and automatically fail over when Claude hits a usage limit—all on localhost, with Remote Control and statuslines intact.</b>
</p>

<p align="center">
  <a href="https://github.com/cablate/model-relay/releases"><img src="https://img.shields.io/github/v/release/cablate/model-relay?include_prereleases&display_name=release&label=release&color=38bdf8" alt="Latest release"></a>
  <a href="https://github.com/cablate/model-relay/actions/workflows/ci.yml"><img src="https://github.com/cablate/model-relay/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <img src="https://img.shields.io/badge/Claude_Code-2.1.287%2B-a78bfa" alt="Claude Code 2.1.287 or later">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue" alt="MIT license"></a>
</p>

<p align="center">
  <b>English</b> · <a href="README.zh-TW.md">繁體中文</a> · <a href="#install">Install</a> · <a href="#whats-inside">Features</a> · <a href="#configuration">Configuration</a> · <a href="CHANGELOG.md">Changelog</a>
</p>

<p align="center">
  <img src="docs/assets/panel.svg" width="900" alt="Animation: on the left, main chat uses Claude while subagents route to any provider and local gateways auto-launch; on the right, the interactive AbovePrompt panel lets you test providers and switch only the current window with one click">
</p>

## Why

Claude Code binds model settings globally across every terminal window. `model-relay` runs a lightweight router on localhost (`127.0.0.1:8950`) so each window and subagent can use the model you want—with zero external cloud proxies.

| When… | Without `model-relay` | With `model-relay` |
|---|---|---|
| You want to switch just one window to another model | Editing `settings.json` switches every open terminal at once | Type `/provider` to switch only the current window from the panel above your prompt (and write its active model to `model-relay-status/<session id>` for your statusline) |
| You want `haiku` or a specific subagent on another model | Changing global env vars forces your main Opus/Sonnet chat onto that endpoint too | `/provider alias haiku <name>` offloads `haiku` globally, or `model-relay:<name>` spawns a one-off subagent on that provider with all tools intact |
| Claude hits a 5-hour usage limit (HTTP 429) or a provider hiccups | Your turn fails mid-task until quota resets | Automatic retries and `failover.chain` hand the request to your backup provider and pin only that window while new windows return to Claude after cooldown |
| You use Remote Control (`claude.ai/code`) from your phone or browser | Custom `ANTHROPIC_BASE_URL` blocks Remote Control from connecting | Local HTTPS proxy mode (`/provider rc on`) keeps Remote Control working while routing each window independently |
| Third-party gateways lose history/tools or reject `ToolSearch` / `cache_control` | `message-threads` deltas cause mid-chat amnesia, and `ToolSearch` hides tools or triggers HTTP 400 | Automatically sends full conversations keeps `ToolSearch` working, and cleans `cache_control` per provider on the fly |

## Who this is for

`model-relay` is built for Claude Code users who combine a Claude subscription with backup or specialized endpoints (z.ai, DeepSeek, Kimi, MiniMax, OpenRouter, or a gateway on your own machine). Each provider has to accept Anthropic's `/v1/messages` format; a service that only speaks OpenAI Chat Completions needs a local translator (see [Limitations](#limitations)). If you need a multi-tenant cloud proxy for an entire organization, use LiteLLM instead—`model-relay` is a single-user localhost daemon.

## Install

Requires Node.js 20+ and Claude Code 2.1.287 or later (tested on Node.js 22.23.2 and Claude Code 2.1.306).

> **⚠️ Upgrading from 0.6 or earlier? Updating the plugin alone is not enough.** Version 0.7+ reads only `"format": 2` in `~/.claude/model-relay.json`. Until you migrate your config and restart the router, an old 0.6 router still running in the background keeps running 0.6 code (without 0.7's conversation/tool loss fix or localhost security check), and once that process stops, the plugin will not start a new router until you migrate. Run `/provider setup upgrade my model-relay config` and Claude does it with you, or follow [UPGRADING.md](UPGRADING.md) by hand (`node tools/setup.mjs migrate`, then `migrate --go`, then `/provider restart`).

```sh
claude plugin marketplace add cablate/model-relay
claude plugin install model-relay@model-relay
```

1. **Set your provider's API key before starting Claude Code.** The relay reads it from the environment of Claude Code, so a variable set in a shell that is already running Claude Code is not seen. Make it permanent, for example `export BACKUP_API_KEY="your-api-key"` in `~/.zshrc` (macOS/Linux) or `setx BACKUP_API_KEY "your-api-key"` (Windows), then open a new terminal.
2. **Open Claude Code and let it set things up with you.** Run `/reload-plugins` first if Claude Code was already open.

   ```text
   /provider setup
   ```

   Claude runs the setup tool for you, never asks you to paste a key into the chat, and asks before it changes `~/.claude/settings.json`. Add what you want, such as `/provider setup use deepseek for haiku`.
3. **Check that it works.**

   ```text
   /provider doctor --ping
   ```

   You should see `Config OK`, your provider under `Providers`, and a `✓` for it under `Upstream ping`:

   ```text
   Config OK (~/.claude/model-relay.json)
     Port: 8950
     Providers: backup -> your-model-id
     Failover: backup (back to Claude after 10 min)    Retry: on
     Aliases:  none (run "node tools/setup.mjs alias haiku <provider>" to route haiku)
     Claude settings: ✓ settings.json ANTHROPIC_BASE_URL=http://127.0.0.1:8950
     Router health: ✓ up on 127.0.0.1:8950 (pid 38780, <version>, pinned sessions: 0, 429 failover: idle, proxy off (0 routed / 0 tunnelled))
     Upstream ping:
       ✓ backup     (your-model-id) -> answers, first byte after 640 ms
   ```

   Anything `doctor` finds is listed with a `⚠` and what fixes it; `/provider setup` can run those fixes with you. `doctor` only reports and changes nothing; add `--fix` (`/provider doctor --fix`) to let it apply the repairs it can make itself, such as pointing `ANTHROPIC_BASE_URL` in `~/.claude/settings.json` at the relay. `doctor --json` prints the same findings for an assistant or a script, each with the `setup.mjs` arguments that fix it (`fix`) and whether that command changes something you should agree to first (`needsConsent`).

**Nothing goes to a provider unless you say so.** A new config keeps `haiku` and every other request on Claude; the first provider you `add` becomes the one that takes over on a 429 (`failover.chain`). To send Claude Code's `haiku` calls (subagents, `WebFetch` summaries, internal helpers) to a provider, run `node tools/setup.mjs alias haiku <name>`.

**Setting it up by hand:** run `/provider init` (creates `~/.claude/model-relay.json` with no provider yet, so every request still goes to Claude, and points `ANTHROPIC_BASE_URL` in `~/.claude/settings.json` at the relay). Add a provider with `node tools/setup.mjs add <name> --preset <preset> --model <model id> --token env:<VAR>` (`presets` lists the built-in ones; `--url` takes any other Anthropic-compatible address), restart Claude Code, then run `/provider doctor --ping`.

**Where `node tools/setup.mjs` runs:** the `node tools/setup.mjs ...` commands later in this README are the same tool. They run from the plugin's install directory, which is `~/.claude/plugins/cache/model-relay/model-relay/<version>/` (`$CLAUDE_CONFIG_DIR/plugins/cache/model-relay/model-relay/<version>/` when you set `CLAUDE_CONFIG_DIR`; `ls` that folder for your version). Elsewhere, use the full path to `tools/setup.mjs` inside it. The command acts on the config directory in `$MODEL_RELAY_CONFIG_DIR` when that is an absolute path that exists (a second account's window sets it, see [Using more than one Claude account](#using-more-than-one-claude-account)), else in `$CLAUDE_CONFIG_DIR`, or `~/.claude` if unset. `/provider setup` runs them for you from anywhere.

**A key exported later is not seen:** `env:VAR` tokens are read from the router process's own environment, which it inherits from whichever Claude Code session (or setup command) started it. A variable exported after the router started is not seen until the router restarts: stop the router process (`doctor` prints its pid) and start a new Claude Code session. `doctor` reads your shell, so it can report the key as set while the router cannot see it.

**Updating:** run `claude plugin update model-relay@model-relay`. The plugin then restarts the relay by itself once no request is in flight through it; a relay from 0.6 or earlier cannot report that, so a notice asks you to run `/provider restart` when no Claude Code window has a reply in progress.

## What's inside

### Interactive `AbovePrompt` control panel and provider test

Type `/provider` to open a panel right above your prompt input box. It does one thing: pick which model this window uses, one button per row. Once a switch takes, the panel closes and a notice names the model now in use. Click a button, or press `ctrl+x tab` and then the key shown on it (`1`–`9` to switch, `p` to test every provider, and `r` to try Claude again while a 429 cooldown runs). Switching a pinned window back to Claude takes a second press to confirm. The switches every window shares stay folded under Settings [s]: press it to show 429 failover, retry and Remote Control (`f` / `t` / `x`) and the model aliases. They turn on or off without editing JSON: failover and retry apply from the next request, while Remote Control asks first because it rewrites `settings.json`: turning it on reaches new sessions only, and turning it off disconnects sessions already running in proxy mode until they are restarted.

Each provider row shows two things apart: the last real request (`last 200 · 45.0s`) and the last test (`test ok 640ms`). The test sends one 1-token request and stops at the first byte (15 seconds at most), so a long reply never reads as a slow provider, and a failure says what is wrong in words: the key was refused, the model name is wrong, the quota is used up, the local gateway is not running, or there was no answer in time. The router keeps the provider's key out of anything it shows. When the router skips a provider (its `env:` variable is unset for the router), the panel says so.

### Automatic 429 failover and per-window session pinning

<p align="center">
  <img src="docs/assets/relay-flow.svg" width="900" alt="Animation: a Claude Code session hits a 429 usage limit; model-relay seamlessly fails over to a backup provider and pins that window while new windows return to Claude after cooldown">
</p>

When Anthropic returns a 429 usage-limit response, the router immediately forwards the request to the first provider in `failover.chain` and pins that session ID for 7 days. After `failover.cooldownMs` (default 10 minutes), new sessions probe Claude again while existing pinned sessions stay on their backup provider. A second Claude account (`kind` `"anthropic"`) is the exception: failover pins no session to it, so the windows it took over return to Claude with the first trial that succeeds. `failover.enabled` switches the whole thing off.

### Transparent provider retries

A provider answering 429 or 5xx is retried on the SAME provider with exponential backoff (`retry.attempts`/`delayMs`/`backoff`), capped by `retry.maxDelayMs`; a longer `Retry-After` keeps polling at that cap. Set `retry.attempts: 0` to retry forever (keep hammering until it succeeds — the client connection is watched, so retries stop once the caller disconnects). Claude Code never sees the intermediate failures. `retry.enabled` turns retrying off everywhere in one go. Turn on `retry.failover` and a request that still fails once its retries run out is handed to the next provider in `failover.chain` (or to that provider's own `fallback` list), never back to one it already tried.

### Built-in provider presets and local gateway auto-launch

Built-in presets (`zai`, `deepseek`, `kimi`, `minimax`, `openrouter`) fill in a service's address and the compatibility switches it needs. You always choose the `model`, because model IDs go out of date, and give the `token` (or `"env:VAR_NAME"`). `node tools/setup.mjs presets` lists them. For local gateways on `127.0.0.1`, set `launch: { command, args }` and the router will automatically spawn the gateway process whenever its port is closed.

### Model alias routing (pointing `haiku` / `sonnet` / `opus` at a provider)

`model-relay` separates three routing layers so they never get mixed up:

1. **Per-request model alias (`matchModels` + `ANTHROPIC_DEFAULT_*_MODEL`):** Routes only requests whose `model` matches (such as `haiku` subagents or `WebFetch` summaries) without pinning the main conversation.
2. **Per-conversation pin (`/provider <name>`):** Pins only the current conversation ID (`x-claude-code-session-id`) for 7 days; other windows stay on Claude.
3. **429 failover chain (`failover.chain`):** Takes over only when Anthropic returns a 429 usage-limit error.

Pointing a Claude tier like `haiku` at a provider (for example `backup`, with model `your-model-id[1m]`) coordinates two places at once:

- `~/.claude/settings.json` → `env.ANTHROPIC_DEFAULT_HAIKU_MODEL = "your-model-id[1m]"` so Claude Code itself resolves the `haiku` alias to that model (including the `[1m]` context window) and sends `"model": "your-model-id"`.
- `~/.claude/model-relay.json` → `providers.backup.matchModels` gains `"haiku"`, so the router also catches internal Claude Code calls that hardcode `"claude-haiku-*"`, rewriting the wire `model` field to `"your-model-id"`. A request for a provider's own model always reaches that provider. `node tools/setup.mjs alias haiku claude` undoes both.

**How a request finds its provider:** a request whose `model` is some provider's own `model` goes to that provider first, whatever the order in the config. Only then are the `matchModels` patterns tried, in config order, and the first match wins. A request caught by a pattern keeps the model name it came with, except a Claude name (`claude-*`, `haiku`, `sonnet`, `opus`), which is replaced by the provider's `model`. So a pattern should match the real model ID the upstream knows, not the provider's name in this file: `^backup` would catch requests named after the provider and pass on a name the upstream has never heard of.

Use `setup.mjs alias` (or `/provider alias`) to inspect or set both files in one step:

```bash
node tools/setup.mjs alias                       # inspect haiku / sonnet / opus / subagent default
node tools/setup.mjs alias haiku backup          # point haiku at backup in both settings.json and model-relay.json
node tools/setup.mjs alias haiku claude          # reset haiku back to Anthropic Claude
node tools/setup.mjs alias subagent sonnet       # set CLAUDE_CODE_SUBAGENT_MODEL=sonnet in settings.json
```

For per-call subagent routing, `model-relay` also dynamically registers a full-capability `Agent` type `model-relay:<name>` for each provider the router serves (such as `model-relay:backup`) via `$.agent.register` with all parent tools and `model` set to that provider's model ID, and locks that model in `on('agent.spawn')`—so you can spawn `subagent_type: "model-relay:backup"` on the fly without creating `.claude/agents/*.md` files or restarting the session.

Each provider can shape its agent with an `agent` object in `~/.claude/model-relay.json`. The fields are the ones an agent file's frontmatter takes, used as written; `name` and `model` always stay the provider's. `description` is the line Claude reads in its list of agent types when it decides which one to spawn, so say when to pick this agent:

```json
"providers": {
  "backup": {
    "model": "your-model-id",
    "agent": {
      "description": "Use for routine, well-scoped tasks: code search, summaries, small edits.",
      "effort": "medium",
      "maxTurns": 40
    }
  }
}
```

A change to `agent` applies from your next message, without restarting Claude Code. Tested on Claude Code 2.1.308: `permissionMode` cannot loosen or tighten a parent running in `bypassPermissions`; `initialPrompt` is not applied to subagents started by the Agent tool (it is for `claude --agent`); `memory` had no effect, the same as in an ordinary `.claude/agents/*.md` file.

Claude Code can still run such a subagent on another model without saying so (a model missing from `availableModels` is swapped, with a line only in its debug log). The plugin checks twice: when the subagent starts, against the model Claude Code reports it started on, and when it finishes, against the models the router actually received. Either mismatch shows a notice that points to `/provider doctor`.

### Edit the config from the command line

`add`, `set`, `providers`, `remove`, `account-add`, `account-sync`, `account-fallback`, `account-token` and `migrate` change the file without hand-editing JSON, and `launcher` writes the one file that starts the launcher wrapper. Every edit keeps a `.model-relay-backup` copy next to the file, tokens are never printed, and the running router picks the change up on its next request. The account commands are described in [Using more than one Claude account](#using-more-than-one-claude-account); in short:

- **`account-add <name>`** makes a login directory for another Claude account (`~/.claude-<name>`, or `--dir <path>`) that only you can open, links into it whichever of `settings.json`, `CLAUDE.md`, `agents`, `commands`, `skills`, `hooks`, `plugins`, `projects` and `output-styles` your config directory has (plus each `--link <entry>`), writes `accounts.<name>.configDir`, and prints the steps only you can do, with the exact commands for your mode and OS: `set accountFallback.mode switch` first, then `/login`, `claude setup-token`, the keychain item, `account-sync` and `account-token`. It refuses a name or directory already in use, a directory that is a symlink or not empty, one inside or around your config directory or another account's, and links to a login file, `ide`, `history.jsonl`, `shell-snapshots`, `session-env`, `backups` or the relay's own files; it never touches the keychain or a shell profile, and warns when your `settings.json` sets a key that would send with something other than the account's login, and for each of `projects`, `settings.json` and `plugins` that your config directory does not have (so it linked nothing) with what the window then lacks.
- **`account-sync <name>`** copies a second account's `accountUuid`, `deviceId` and `email` from the `.claude.json` in `accounts.<name>.configDir` into `providers.<name>`: it reads nothing else there, prints field names but never their values, and refuses this router's own config directory or a login to your own account. A login is found by its directory, never by `CLAUDE_CONFIG_DIR`: `~/.claude` keeps it in `~/.claude.json`, any other directory in its own `.claude.json`.
- **`account-fallback <name> <target>[,<target>...] [--allow-cross-org <target>[,...]]`** writes `accounts.<name>.fallback`: a string for one plain target, a list otherwise, `{ "account": "<target>", "allowCrossOrg": true }` for each target named after `--allow-cross-org`. `account-fallback <name> none` removes it. It refuses an unknown account, itself, the relay's own account as a target and a target named twice. A target that has no usable entry yet, or a mode other than `"switch"`, is a warning that names the next command, not a refusal, so the commands can come in any order; `--allow-cross-org` warns that the conversation crosses an organization boundary.
- **`account-token <name> keychain:<service>/<account>`** or **`account-token <name> env:<VAR>`** writes `providers.<name>.token` as that reference on a `kind` `"anthropic"` entry (made when there is none). It accepts only these two forms and never the token itself: anything else is refused with a fixed text that does not repeat what you typed, since a word typed there may be a pasted secret (if you did paste one, revoke it and make a new one). `keychain:` is refused off macOS, and `env:` cannot name `CLAUDE_CODE_OAUTH_TOKEN`, `ANTHROPIC_API_KEY` or `ANTHROPIC_AUTH_TOKEN`, which are the window's own credentials. It never runs `security` and never checks that the item exists; `doctor` does.
- **`set accountFallback.mode <off|switch|rc-keep|api-only>`** and **`set accountFallback.account <name|none>`** write the two keys of the account settings; the account must be an `accounts` entry with a `configDir`, and not the relay's own account. Turning on `"rc-keep"` or `"api-only"` prints a line on Anthropic's terms.
- **`launcher`** writes `model-relay-launch.mjs` into your config directory and prints the alias or function that starts Claude Code through the wrapper with it.

On an older config (see `format` under Configuration), `add`, `set`, `providers`, `remove`, `alias`, `init`, `restart`, `rc` and `proxy enable` refuse and tell you to run `migrate` first; `migrate` is the only command that understands it. `doctor` also warns about an older config, a failover name that matches no provider, two providers that name the same model (the first one in the file gets it), an `availableModels` list in `~/.claude/settings.json` that leaves a provider's model out, an `accounts.<name>.fallback` that the mode does not read, and a running router older than the plugin.

```bash
node tools/setup.mjs providers
node tools/setup.mjs add local --url http://127.0.0.1:4000 --model your-local-model-id --token env:LOCAL_GATEWAY_TOKEN
node tools/setup.mjs set failover.chain backup,local
node tools/setup.mjs set providers.local.fallback none
node tools/setup.mjs migrate --go
node tools/setup.mjs account-add team-3
node tools/setup.mjs account-sync team-3
node tools/setup.mjs account-token team-3 keychain:model-relay-team-3/team-3
node tools/setup.mjs account-fallback team-1 team-2,team-3
node tools/setup.mjs set accountFallback.mode switch
node tools/setup.mjs launcher
```

`remove <name>` takes the provider out of `failover.chain` and out of other providers' `fallback` lists, but it does not touch the `ANTHROPIC_DEFAULT_*_MODEL` aliases in `~/.claude/settings.json`. If `haiku`, `sonnet` or `opus` pointed at the removed provider's model, Claude Code keeps sending that model name and, with no provider left to claim it, the request goes to Claude. Reset each of those aliases yourself with `node tools/setup.mjs alias haiku claude` (or `alias haiku <name>` to give it to another provider; likewise for `sonnet` and `opus`). `doctor` warns about an alias that no provider matches.

### Remote Control without giving up the relay

Remote Control only starts when Claude Code talks to `api.anthropic.com`, which a base URL pointing at the relay breaks. HTTPS proxy mode keeps that address and makes the relay the proxy instead: Claude Code connects through `HTTPS_PROXY`, the relay answers for `api.anthropic.com` with a certificate that Claude Code trusts through `NODE_EXTRA_CA_CERTS`, and model calls are routed exactly as before (providers, sticky failover, retries). Everything else, token refresh and Remote Control traffic included, passes to Anthropic unchanged.

```bash
node tools/setup.mjs proxy enable --go
node tools/setup.mjs rc
```

- **Contained trust:** The CA the relay creates can only vouch for `api.anthropic.com` (a critical name constraint), its private key is discarded right after signing, and only Claude Code processes that carry `NODE_EXTRA_CA_CERTS` load it. The system certificate store is never touched.
- **Safe fallback:** Without a usable certificate the relay tunnels `api.anthropic.com` untouched, so Claude Code keeps working, just unrouted. A stopped router is different: the plugin's automatic direct fallback only works in `ANTHROPIC_BASE_URL` mode, so in proxy mode Claude Code cannot connect until the router is restarted (`node tools/setup.mjs rc`).
- **Reversible:** `proxy disable --go` restores `ANTHROPIC_BASE_URL`, and the previous `settings.json` is kept as `settings.json.model-relay-backup`. Sessions already running in proxy mode lose their connection until you restart them.

`HTTPS_PROXY` lives in `settings.json` `env`, so it also applies to commands Claude Code runs (`git`, `curl`, `gh`): they go through the relay as blind tunnels, and fail while the router is down.

## Using more than one Claude account

If you have more than one Claude account, for example two Team seats, `model-relay` can open a window on the other account, move a conversation to it when yours reaches its usage limit, or go on with it by itself. The ways differ in what they send and with whose credential, so read [Terms of use and risk](#terms-of-use-and-risk) before you turn one on. Everything is off until you set `accountFallback.mode`.

### Terms used here

- **Your account:** the Claude login of your own config directory, `~/.claude` or `$CLAUDE_CONFIG_DIR`. "Your" in this README means this one.
- **Relay dir:** the config directory whose `model-relay.json` the router reads, normally `~/.claude`. A second account's window names it in `MODEL_RELAY_CONFIG_DIR`.
- **Account:** an entry of `accounts` in `model-relay.json`: a name and the `configDir` of that account's own Claude Code login. `account-add` makes it.
- **Account window:** a Claude Code window whose config directory is an account's, started with `MODEL_RELAY_CONFIG_DIR` pointing at the relay dir, so that it uses your config and your router.
- **Registration:** the plugin in an account window telling the router, by session id, that this session belongs to that account (`POST /__account`), so that its Claude requests skip your failover.
- **Setup-token:** the long-lived token that `claude setup-token` makes for an account. It is what `providers.<name>.token` points at, and it lets the relay send a request as that account.
- **Fallback account:** an account that goes on with a conversation when another one is at its usage limit, through `failover.chain` (`"rc-keep"`, `"api-only"`) or an `accounts.<name>.fallback` list (`"switch"`).
- **The email sentence:** the sentence "The user's email address is …" that Claude Code puts in a `<system-reminder>` of the first message of a conversation.
- **Seat:** one person's place on a Team or Enterprise plan. Two seats are two accounts.
- **Usage limit:** Anthropic's 429 answer when an account has used its allowance.
- **Trial:** the request the router sends to Claude again once the cooldown (`failover.cooldownMs`) is over.

### Terms of use and risk

Anthropic's terms, not this project, decide what you may do with several accounts, and part of what `model-relay` can do sits close to what they restrict. The page [Legal and compliance](https://code.claude.com/docs/en/legal-and-compliance) says this in its "Authentication and credential use" section (fetched 2026-11-10, quoted word for word):

> OAuth authentication is intended exclusively for purchasers of Claude Free, Pro, Max, Ultra, Team, and Enterprise subscription plans and is designed to support ordinary use of Claude Code and other native Anthropic applications.
>
> Anthropic does not permit third-party developers to offer Claude.ai login into their own applications, or to route requests through Free, Pro, Max, or Ultra plan credentials on behalf of their users. Moreover, developers may not collect, store, or intermediate Claude.ai credentials or session tokens — sign-in to a Claude account must complete through Anthropic's own flow.
>
> Anthropic reserves the right to take measures to enforce these restrictions and may do so without prior notice.

The same page puts Team and Enterprise plans under Anthropic's Commercial Terms, and Free, Pro, Max and Ultra plans under its Consumer Terms. Nothing else here is cited as legal text, and nothing here is legal advice; read the page and decide for yourself. What each part does:

- **Each account on its own login:** `/provider switch` with the launcher wrapper, and account windows. Claude Code runs on that account's own `/login`, and the relay changes nothing in what the window sends. This is not risk-free either: moving one person's work between accounts whenever a limit is reached may not be what the terms mean by ordinary use, and enforcement can reach either account.
- **A setup-token in place of the window's login:** `"rc-keep"`, `"api-only"`, every `accounts.<name>.fallback` list and the relay's own account. The relay sends your request with another account's setup-token and replaces `account_uuid`, `device_id` and the email sentence in it with that account's; in every one of these modes each window also gets a session id of its own on that account, in `metadata.user_id` and in `x-claude-code-session-id`. The rest of the request is what Claude Code wrote. This is the use closest to the quoted sentences, since the relay, not Claude Code's own sign-in, sends with the credential. Anthropic may enforce without notice, against either account.
- **Across an organization boundary:** a fallback entry marked `allowCrossOrg` (`account-fallback ... --allow-cross-org`) lets a conversation go on under an account of another organization. The conversation text then moves from one organization's account to the other's. Without that mark, an account of another organization is skipped.
- **A request the relay will not send with an account's token:** the relay replaces your address only in the one email sentence Claude Code puts in a `<system-reminder>` of the first message, and it refuses a body in which that sentence is anywhere else or is there more than once (for example when a file or a git log shown in the conversation quotes it too). The next link in the chain takes the request, or it fails with an error that says why, and nothing is sent with that account. This is a known limitation and stays strict on purpose: loosening it would let your address, or the conversation, reach the wrong account. A conversation the rule refuses cannot go on through a token account. Continue it in that account's own login instead, with `CLAUDE_CONFIG_DIR=<that account's folder> claude --continue`, or, in mode `"switch"` and for the account `accountFallback.account` names, with the launcher wrapper's `/provider switch`, then `/exit`.
- **Where a token is kept:** with `env:<VAR>` the token is in the environment of the shell that starts Claude Code, so it reaches every process of that shell, the Bash tool and MCP servers included. With `keychain:<service>/<account>` (macOS) it stays out of files and the environment, but any process that runs as you can read the item. `claude setup-token` prints the token once; clear the terminal scrollback afterwards. `account-token` refuses a pasted token.

### Which mode do I want?

| I want… | `accountFallback.mode` | What sends, with whose login or token | Remote Control |
|---|---|---|---|
| To move a conversation to my other account myself, each account on its own login | `"switch"` and `accountFallback.account` | Each window with its own account's login; the relay sends with no token | Stays on the account of the window |
| My windows to go on with a second account by themselves when mine is at its limit | `"rc-keep"` and the account in `failover.chain` | Your login, then the second account's setup-token from your limit on | Stays on your account |
| The same, with every window the wrapper starts having Remote Control off | `"api-only"` and the account in `failover.chain` | The same as `"rc-keep"` | Off |
| An account's windows to go on with another account when that one is at its limit | `"switch"` and `accounts.<name>.fallback` (or the relay's own account for your windows) | The window's own login, then the fallback account's setup-token from the limit on | Stays on the window's account |

Leave `"off"`, the default, to use none of this.

### Before you start

1. Claude Code is logged in with your own account and the relay is installed (`/provider doctor` runs). The recipes check only doctor's account lines and a `⚠` that names an account: a `⚠` about a provider's key or chain concerns the relay, and accounts alone need no provider.
2. Run the `node tools/setup.mjs` commands in a shell of your own account, not inside an account window: `account-sync` refuses while `MODEL_RELAY_CONFIG_DIR` is set. They run from the plugin's install directory ([Install](#install) says where; the commands `account-add` and `account-sync` print use the full path).
3. Each account gets a folder of its own from `account-add <name>` and one `/login` there, as another Claude account than yours (`account-sync` refuses your own, and `doctor` warns); recipe 1 walks through both, so do not run `account-add` twice for one name. `doctor` also warns when the login is missing.
4. That folder has to share `projects/` with yours: without it `/provider switch` refuses, prints the `ln -s` command and `doctor` warns. It also needs your `settings.json` and plugins, so that the plugin runs in its window and registers it; without them the plugin does not run there. `account-add` links these from your config directory, whichever of them exists, and warns about each that does not; a folder made by hand needs the same links.
5. Only where the relay sends with a token (`"rc-keep"`, `"api-only"`, fallback lists): a setup-token of that account, made in your own terminal with `claude setup-token`, kept in the macOS keychain or in an environment variable.

### Recipe 1: a window on a second account

1. Make the account's folder, here `team-2`: `node tools/setup.mjs account-add team-2`. It also prints a checklist of commands with your real paths, numbered in its own way: follow the steps here, and use that list to copy the commands. Its `Terms:` line is a note, not something to fix.
2. Turn on mode `"switch"` first, because the plugin registers a window only in this mode and the login window of the next step should be registered: `node tools/setup.mjs set accountFallback.mode switch`.
3. Log in as that account: run `CLAUDE_CONFIG_DIR=$HOME/.claude-team-2 MODEL_RELAY_CONFIG_DIR=$HOME/.claude claude`, type `/login`, finish the login, then `/exit`. `MODEL_RELAY_CONFIG_DIR` is the relay dir (`$HOME/.claude`, or your `$CLAUDE_CONFIG_DIR` when you set one): with it the plugin registers this window with your router, so a window that reaches its limit is never mistaken for your own account. Where you gave `--dir`, or your own account uses `CLAUDE_CONFIG_DIR`, copy the command that `account-add` printed, which has the real paths. On Windows, see the PowerShell form below.
4. Name the account that `/provider switch` moves a window to: `node tools/setup.mjs set accountFallback.account team-2`.
5. Write the launcher file and print the alias with `node tools/setup.mjs launcher`. Put the `alias claude=…` line it prints in `~/.zshrc` or `~/.bashrc` (a PowerShell function in `$PROFILE`), then open a new terminal.
6. From your project folder, use `claude` as before. When your account reaches its limit a notice says `/provider switch`, then `/exit`: type them, and the wrapper resumes the conversation on `team-2`. To open a window on `team-2` directly, run the command of step 3 again.
7. Check with `node tools/setup.mjs doctor`: an `Accounts: mode "switch"; /provider switch moves a window to team-2` line, `Login of team-2: … (an accountUuid found)`, and no `⚠` about `team-2` (it warns when `team-2` is not logged in yet or is logged in as your own account, or when its `projects/` is not yours). For a missing login, log in again as in step 3.

### Recipe 2: two Team seats, the second takes over by itself

Your account is seat 1 and `team-2` is seat 2. This sends with `team-2`'s setup-token, so read the terms above first.

1. Do steps 1 and 3 of recipe 1: `account-add team-2`, then log in there. Skip what you did already: `account-add` refuses a name that exists.
2. In your own terminal run `CLAUDE_CONFIG_DIR=$HOME/.claude-team-2 claude setup-token` and finish the sign-in it asks for. It prints the token once: copy it, then clear the terminal scrollback.
3. Keep the token. On macOS: `security add-generic-password -s model-relay-team-2 -a team-2 -w`, which asks for the token instead of taking it on the command line (`account-add` also prints the check that the item goes into the login keychain, the one the router reads). Elsewhere, or on macOS too if you prefer a variable: set `MODEL_RELAY_TOKEN_TEAM_2` permanently for your OS, then restart Claude Code.
4. Copy the account's ids and point the entry at the token:

   ```bash
   node tools/setup.mjs account-sync team-2
   node tools/setup.mjs account-token team-2 keychain:model-relay-team-2/team-2
   ```

   Use `env:MODEL_RELAY_TOKEN_TEAM_2` in place of the keychain reference where there is no keychain, or when you keep the token in the variable (on macOS `account-sync` prints both forms).
5. Turn the mode on and put the account in the chain. `set failover.chain` replaces the whole chain, and the chain is tried in order, so write all of it, with `team-2` where you want it: first, as here, to take over before your other providers. `doctor` shows your chain on its `Failover:` line, and the commands `account-add` and `account-sync` print have it filled in.

   ```bash
   node tools/setup.mjs set accountFallback.mode rc-keep
   node tools/setup.mjs set failover.chain team-2
   ```

   With a chain already, put the rest after `team-2`: for `backup` that is `team-2,backup`. `backup,team-2` would send to `team-2` only after `backup` failed too.
6. Run `node tools/setup.mjs doctor`: it must show no `⚠` about `team-2` and an `Accounts: mode "rc-keep"; … ✓ team-2 …` line (in this mode that line is the check; there is no `Login` line). When your account then answers its usage limit, the same request goes on with `team-2`, and `/provider status` starts with "Claude limit reached: routing to Claude (team-2)". Each window goes back to your account with the first trial that succeeds.

If the windows that run out are windows of an account of their own, say `team-1`, make that account (`account-add team-1`, then log in there as in recipe 1; only `team-2` needs a setup-token and `account-sync`, `team-1` needs neither) and use mode `"switch"` in place of step 5:

```bash
node tools/setup.mjs set accountFallback.mode switch
node tools/setup.mjs account-fallback team-1 team-2
node tools/setup.mjs set failover.chain <the entries of your chain except team-2>
```

The last line is only for a chain that names `team-2` from step 5: `doctor` warns while a Claude account stays in it (if `team-2` was the only entry, the warning is harmless, since `"switch"` skips it). This helps only windows started as `team-1` account windows (`CLAUDE_CONFIG_DIR=$HOME/.claude-team-1 MODEL_RELAY_CONFIG_DIR=$HOME/.claude claude`), not your normal `claude`; `doctor` then shows `Fallback of team-1: ✓ team-2 (same organization)`. For your own windows in mode `"switch"`, see the relay's own account below.

### Recipe 3: adding a third account

Here `team-3` joins `team-2` from recipe 2.

1. `node tools/setup.mjs account-add team-3`, then log in there as in recipe 1 (`account-add` refuses a name that exists, so skip this step if `team-3` is already made).
2. Make its setup-token and keep it as in steps 2 and 3 of recipe 2, with `team-3` and `MODEL_RELAY_TOKEN_TEAM_3`.
3. `node tools/setup.mjs account-sync team-3`, then `node tools/setup.mjs account-token team-3 keychain:model-relay-team-3/team-3`.
4. Give it its place.
   - In mode `"rc-keep"` or `"api-only"`: `set failover.chain` replaces the whole chain and tries it in order, so write all of it: `node tools/setup.mjs set failover.chain team-2,team-3`, or `team-2,team-3,backup` with a provider of your own after them. `team-3` then takes over when `team-2` answers its own usage limit, and `team-2` is not asked again until `failover.cooldownMs` has passed. The commands `account-add` and `account-sync` print have your chain filled in.
   - In mode `"switch"`: a fallback list belongs to an account that has a folder and a login of its own, `<account>` below: `team-1` from the variant of recipe 2, or the relay's own account (below). Coming from recipe 2 you are in `"rc-keep"`, so run `node tools/setup.mjs set accountFallback.mode switch` first; then `node tools/setup.mjs account-fallback team-1 team-2,team-3`, and take `team-2` and `team-3` out of `failover.chain` as in the variant of recipe 2.
   - If you only want `team-3` as the account `/provider switch` moves a window to: `node tools/setup.mjs set accountFallback.account team-3` is all. One account is the target: `team-2` stays usable for windows you open on it directly, and `/provider switch` now goes to `team-3`.
5. Run `node tools/setup.mjs doctor`. In mode `"switch"` it lists each entry of a fallback list with `✓` or `✗` and why (`Fallback of team-1: ✓ team-2 (same organization), …`). In `"rc-keep"` and `"api-only"` there is no such list: the `Accounts:` line names the accounts of `failover.chain` that can send (`✓ team-2, ✓ team-3`), the `Failover:` line shows their order, and a `⚠` names what is skipped and why. `doctor` also warns when `team-3` is not logged in yet (log in again as in recipe 1).

### Platform notes

- **macOS:** `keychain:<service>/<account>` tokens work and the steps `account-add` prints use them.
- **Linux and Windows:** there is no login keychain for the router to read; `account-token` refuses `keychain:`. Use `env:<VAR>`, set where Claude Code starts. The router reads it from the environment of the session that started it, so restart Claude Code after setting it.
- **Windows:** the wrapper starts `claude.exe` from a folder on `PATH` (a drive or share path), where the native installer puts it. An npm install's `claude.cmd` cannot be started without a shell: install Claude Code with the native installer, or name the file, `-- C:\path\to\claude.exe`.
- **An alias or a function, never a file named `claude` on `PATH`:** the wrapper starts `claude` from `PATH` and would start itself. `setup.mjs launcher` prints the alias for zsh and bash and a function for PowerShell.
- **The alias keeps working across plugin updates:** it runs `model-relay-launch.mjs` in the relay dir, which `setup.mjs launcher` writes and which every session start refreshes in the modes `"switch"`, `"rc-keep"` and `"api-only"` so that it names the plugin version running. Run `launcher` yourself the first time, before any session has refreshed it.
- **PowerShell forms of the commands in this section:** the variable stays set in the window that sets it, so use a new PowerShell window for each.

  ```powershell
  $env:CLAUDE_CONFIG_DIR="$HOME\.claude-team-2"; $env:MODEL_RELAY_CONFIG_DIR="$HOME\.claude"; claude
  ```

  It logs in (recipe 1, step 3) and opens a window on `team-2` (recipe 1, step 6). The command that resumes a conversation by hand is under `/provider switch` in Commands.

### The launcher wrapper: moving a window to another account

With `accountFallback.mode` `"switch"`, the window moves: Claude Code starts on the other account's own login. The router sends with another account's token only for an `accounts.<name>.fallback` list (below), never through `failover.chain`. Start Claude Code through the wrapper, which reads the `model-relay.json` of the config directory the window will use (`CLAUDE_CONFIG_DIR`, else `~/.claude`). A window with a config directory of its own must have `CLAUDE_CONFIG_DIR` set in the environment before the wrapper starts, since that is all the wrapper looks at. Run it from your project folder, in place of `claude`, through the file that `setup.mjs launcher` writes (it runs the `tools/launch.mjs` of the installed plugin, whatever its version):

```bash
node ~/.claude/model-relay-launch.mjs [your usual arguments]
node ~/.claude/model-relay-launch.mjs -- <launcher> [arguments]
```

Without a leading `--`, every word is an argument and the launcher is `claude`; after `--`, the next word is the launcher. The file is in your relay dir (`~/.claude` unless `CLAUDE_CONFIG_DIR` says otherwise); `launcher` prints its path and the alias. On Windows, a launcher that is a `.cmd` or `.bat` script is not supported (the wrapper starts it without a shell), and that includes the `claude.cmd` of an npm install.

- **Pass-through:** with no `model-relay.json` there, or a mode other than `"switch"`, `"rc-keep"` or `"api-only"`, it runs the launcher with exactly your arguments and environment. So does a window whose config directory is one of the `accounts` in the config `MODEL_RELAY_CONFIG_DIR` names, in every mode. A second account's own window is therefore untouched, its own `--settings` included.
- **First launch:** your arguments as they are, plus `MODEL_RELAY_WRAPPER_ID` (a fresh id) in the environment. In `"api-only"` it also adds `--settings '{"disableRemoteControl":true}'`, and refuses a `--settings` of yours rather than merging the two.
- **Switching:** after `/provider switch` and `/exit` (exit code 0), it starts the launcher once more with `CLAUDE_CONFIG_DIR` set to `accounts.<accountFallback.account>.configDir`. That relaunch gets only `--model`, `--permission-mode` and `--effort` from your arguments, plus `--resume=<session id>` and a `--settings` that keeps the memory folder of this project. Any other option of the original command (`--add-dir`, `--mcp-config` and the like) is not carried over, and the wrapper prints the names of those options, never their values. The window keeps the relay: `MODEL_RELAY_CONFIG_DIR` points it at your config directory, `HTTPS_PROXY` and `https_proxy` stay, the relay wiring of your `settings.json` (`ANTHROPIC_BASE_URL`, `HTTPS_PROXY`, `NO_PROXY`, `NODE_EXTRA_CA_CERTS`, whichever it sets) goes into that `--settings` so the window reaches the relay even with a `settings.json` of its own, and the router learns the session before the window starts. It removes `CLAUDE_CODE_OAUTH_TOKEN`, `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_BASE_URL`, `HTTP_PROXY` and `http_proxy` from that window's environment and names the ones it removed. Only when your `claudeUrl` is not `https://api.anthropic.com`, your `settings.json` sets none of those four, or your `model-relay.json` is gone by then, does the window bypass the relay instead: no `MODEL_RELAY_CONFIG_DIR`, the proxy variables removed too, and a `--settings` that sets `ANTHROPIC_BASE_URL` to `https://api.anthropic.com` and blanks `HTTPS_PROXY` and `https_proxy`. It refuses when the account's config directory is this window's own, and unless both config directories' `projects/` folders are the same folder, since `--resume` needs the transcript; the refusal prints the `ln -s` command (`New-Item -ItemType SymbolicLink` on Windows) that links the account's `projects/` to yours, and `/provider switch` makes the same check before `/exit`. It switches at most once, and never after it passed a `SIGTERM` or `SIGHUP` on to the window.
- **Signals:** Ctrl-C reaches Claude Code, not the wrapper; `SIGTERM` and `SIGHUP` are passed on; a window killed by a signal makes the wrapper exit with 128 plus the signal's number.

### The second account's window keeps the relay

A window whose own config directory is one of `accounts`' (the wrapper's relaunch, or one you start yourself with `CLAUDE_CONFIG_DIR=<that dir> MODEL_RELAY_CONFIG_DIR=$HOME/.claude claude`) uses your config and your router, through `MODEL_RELAY_CONFIG_DIR`. That variable counts only when it is an absolute path that exists; its status files stay in its own config directory, where a statusline looks.

- **Its session is registered:** in mode `"switch"` the plugin tells the router, by session id, that this is that account's window (`POST /__account`), at the start, right after the plugin itself restarts the router, and whenever the router no longer knows it. A registration the router refuses is shown once with the reason and asked again no sooner than a minute later; the router also drops one the config no longer allows (another mode, another `claudeUrl`, the account removed). A window of your own account that resumes such a session ends the registration.
- **Its Claude requests are its own:** they go to Anthropic with the window's own login, never through your failover chain. A 429 there is that account's own limit, and it comes back to the window, unless that account has a fallback account (next item). Your failover state is left exactly as it was. A provider's model (`model-relay:<name>` subagents, aliases) still goes to that provider, and a `/provider <name>` pin made in that window holds until the router restarts (then make it again). An automatic pin from before the registration does not.
- **Its fallback account:** with `accounts.<name>.fallback` set to another account, say team-2 for team-1, a usage-limit 429 from team-1 is not passed back. The same request goes to Anthropic again with team-2's token, account_uuid, device_id and email sentence, and so does every later request of team-1's windows until `failover.cooldownMs` ends; then team-1 is tried again (also after a router restart). The session id is not team-1's either: each window gets a random one of its own for team-2, in `metadata.user_id` and in `x-claude-code-session-id`, kept until the router restarts. The conversation text is the same on both accounts, and Remote Control stays on team-1. This happens only when the request carries team-1's own account_uuid (from the `.claude.json` in team-1's `configDir`); a request team-2 cannot take exactly (a refused body, see `providers.<name>.accountUuid` below) goes on with the next account of the list, and when none is left the window gets an error that says why and that its own account is at its limit (continue in that account's own login), and team-2's own failure (its usage limit included) comes back to the window. Nothing goes to your failover chain or to your own account on the way, and your windows never reach team-2: not through `failover.chain`, a provider's `fallback`, `/provider team-2` or `/provider` lists. In a team-1 window, `/provider team-2` pins it there by hand. With a list, say `["team-2", "team-3"]`, team-3 takes over in turn when team-2 answers its own usage limit, each account sits out its own cooldown, and when every one is at its limit team-1's 429 comes back. An account is used only while both logins are in one organization and its directory is still logged in to the account its entry names, unless its entry says `allowCrossOrg` (see Configuration).
- **Its status:** for a window of team-1, the status line shows "Main: Claude (team-1)", or "Main: Claude (team-2) (team-1 is at its usage limit)" while its fallback account team-2 serves it (a notice says so once each time it starts), or its own pin, and the status file shows `claude/team-1`, `claude/team-2` or the pin; neither shows your failover. The panel and `/provider status` show the same: the Claude row says `Claude (team-1)` and your failover chain and its switch are left out. The limit notice for your own account and the `api-only` notice do not appear there; an account at its limit with no fallback account to move to gets one notice that says what to do. `/provider switch` is refused there.
- A request from that window to a provider carries that account's metadata and email address to the provider, as any provider request carries the window's; its token is never sent there.
- The router accepts a registration only in mode `"switch"` and only while `claudeUrl` is `https://api.anthropic.com`. Any local program can register a session; that only makes its Claude requests skip your failover, or, for an account with a fallback account, lets them reach that account, the same boundary as `"rc-keep"`. After a router restart, requests sent before the window's next check (up to 10 seconds) are treated as those of a window that never registered, the next bullet: with your relay dir's login readable and a different account in the request they go to Claude as sent; when either cannot be read, they take your normal path and a usage limit there can start your failover. The window's registration then comes back with the time it first saw that session registered, so a `/provider` pin made by hand in that window still counts; a session the window starts later (a `/resume` inside it) is counted from its own first registration, and an automatic pin made on it before does not hold it.
- A window of another login that never registered (opened on an account's folder without `MODEL_RELAY_CONFIG_DIR`) is told apart by the account in its requests: in modes `"switch"`, `"rc-keep"` and `"api-only"` (not `"off"`), while your relay dir's own login is readable and differs, its Claude requests go to Claude as sent, and its usage-limit answer never reaches your failover.
- Requests to a provider from an account window, a pinned one included, still fall back along that provider's and your failover chain; what an account window never touches is your failover state.

#### The relay's own account

Mode `"switch"` only: give the login of your config directory itself an `accounts` entry, such as `"own": { "configDir": "~/.claude" }` (at most one; no command makes it, so write it into `model-relay.json` by hand), and a `fallback` list (`account-fallback own team-2,team-3` writes it), and your own windows walk that list at your usage limit before `failover.chain` takes over. A usage-limit 429 for a request that carries that login's account_uuid goes to the first usable account of the list with that account's token and ids, and so does every later request of your windows until `failover.cooldownMs` ends; any other request takes your normal path. When the list runs out, your failover runs exactly as without it. Your windows are never registered, `/provider` and `/__health` still leave those accounts out, and the status line shows "Main: Claude (team-2) (your account is at its usage limit)" (the status file `claude/team-2`) with a notice once each time it moves. Without a list your windows route as before. `doctor` errors when two entries point at your config directory.

## Configuration

Configuration lives in `~/.claude/model-relay.json`. The directory defaults to `$CLAUDE_CONFIG_DIR` when set, falling back to `$USERPROFILE/.claude` or `$HOME/.claude`; `$MODEL_RELAY_CONFIG_DIR`, when it is an absolute path that exists, comes before both (a second account's window, see above). [`model-relay.example.json`](model-relay.example.json) shows a provider from a preset and a local gateway.

| Field | Default | Meaning |
|---|---|---|
| `format` | (none) | `2` for a config in the current format (`init`, `add` and `migrate --go` set it), the only format the router reads. A file without it, or one named `custom-agent.json`, is an older config: until `migrate --go` rewrites it, the plugin starts and replaces no router for it, so a 0.6 router still running keeps using it, and with none answering the session talks to Claude directly. The plugin says so in a notice, the panel and, with `statusBar` on, the status line; see [UPGRADING.md](UPGRADING.md) |
| `port` | `8950` | Localhost port for the relay HTTP server (`1025`–`65535`). Change it with `node tools/setup.mjs set port <n>`, which also updates `settings.json`; the router already running keeps the old port until you stop it (the command prints its pid), and it refuses a port that already answers |
| `statusBar` | `false` | Also show the relay state in Claude Code's plugin status line, the yellow line above the input. Off by default: each window's state is written to a status file for your own statusline instead (see below). Notices about upgrades and outages still appear as toasts |
| `claudeUrl` | `"https://api.anthropic.com"` | Upstream Anthropic API base URL |
| `idleTimeoutMs` | `300000` | How long an upstream may send nothing before the request counts as failed and follows the retry and failover rules (`1000`–`3600000`); a streaming answer that keeps sending data is never cut |
| `proxy.enabled` | `false` | Accept HTTPS-proxy connections for Remote Control. Off by default. When on, a `CONNECT` to any host other than `api.anthropic.com` is a blind tunnel that any local process can use; `node tools/setup.mjs proxy enable --go` turns it on and `proxy disable --go` off |
| `failover.enabled` | `true` | Automatically switch to the failover chain on Claude 429 usage limits |
| `failover.chain` | `[]` | Ordered providers that take over when Claude is out of quota or a provider keeps failing; unknown names are skipped. Empty means a 429 from Claude is passed back as it is (`add` puts the first provider of a new config here) |
| `failover.cooldownMs` | `600000` | Milliseconds before probing Claude again for new sessions (10 minutes). Kept between `60000` (1 minute) and `7200000` (2 hours): a value outside that range is moved to the nearest limit |
| `accountFallback.mode` | `"off"` | Whether a second Claude account (`providers.<name>.kind` `"anthropic"`) is used. `"off"` uses none, exactly as 0.7.5. `"rc-keep"` lets the router send a request to that account with its own token, while Remote Control stays on your account. `"api-only"` routes exactly as `"rc-keep"` in the router; it differs only in the launcher wrapper, which starts the window with Remote Control off. `"switch"` leaves the router as in `"off"`, except for an `accounts.<name>.fallback` (see there): it is for a launcher that moves the whole window to that account's own login (`/provider switch`); a window in this mode gets a notice, once, when the router has seen your account's usage-limit answer within `failover.cooldownMs`, whatever `failover.chain` holds: `/provider switch`, then `/exit`. In `"api-only"`, a window the launcher wrapper did not start gets a notice, once, that Remote Control is not disabled there. Only `"rc-keep"` and `"api-only"` read the account's token or use its entry, and `"switch"` for a fallback account, for its accounts' windows only; any other value counts as `"off"`, and `doctor` warns about one it does not know. Sending your windows' requests with another account's token can conflict with Anthropic's terms of use; that risk is yours |
| `accountFallback.account` | (none) | The account (a key of `accounts`) that `"switch"` moves a window to |
| `accounts.<name>.configDir` | (none) | The config directory that account's own Claude Code login uses, such as `~/.claude-second` (`~` is your home directory). `node tools/setup.mjs account-sync <name>` reads the `.claude.json` there for `providers.<name>`. The login is read from `~/.claude.json` for `~/.claude` and from `<dir>/.claude.json` for any other directory, whatever `CLAUDE_CONFIG_DIR` says, and `doctor` names the file it read, and warns about an account that is not logged in yet or is logged in as your own. An entry whose `configDir` is your own config directory is the relay's own account (see above); `doctor` errors on two |
| `accounts.<name>.fallback` | (none) | Mode `"switch"` only: another name in `accounts`, or a list of them in order such as `["team-2", "team-3"]` (an entry can also be `{ "account": "team-3", "allowCrossOrg": true }`), whose kind `"anthropic"` entries in `providers` this account's windows go on with at its usage limit, the next one when that one answers its own, each until its own `failover.cooldownMs` ends. Only this account's list counts: a listed account's own `fallback` does not. An account is skipped while the two logins' `.claude.json` do not name one `organizationUuid` (or one cannot be read), unless its entry has `allowCrossOrg`, and while its directory is logged in to another account than its entry names (run `account-sync` again). Such entries are reserved for those windows: your failover chain, a provider's own `fallback`, `/provider` from any other window and `/__health` leave them out, and `doctor` says so when `failover.chain` names one. Their token, account_uuid, device_id and email sentence are sent in place of the window's, and a session id of their own replaces the window's; the conversation text is shared, and Remote Control stays on the window's account. `doctor` lists each entry with ✓ or ✗ and why, and warns when one names no account, the account itself, the relay's own account, an account twice, or an account without a usable entry. The more of your seats take turns at their limits, the more visible it is that one person uses several seats' limits; that risk is yours |
| `accounts.<name>.fallback[].allowCrossOrg` | `false` | `true` lets that entry's account serve this account's windows although the two logins are not in one organization, or one of them cannot be read. Only the boolean `true` counts |
| `retry.enabled` | `true` | Master switch for retrying a failing provider; `false` keeps the other retry settings for later |
| `retry.attempts` | `3` | Times the SAME provider is retried with backoff when it answers 429/5xx; `0` means retry forever. Any other value is capped at `30` |
| `retry.delayMs` | `2000` | First retry delay; multiplied by `retry.backoff` each attempt. Capped at `60000` (60 seconds), or `300000` (300 seconds) when set in a provider's own `retry` |
| `retry.backoff` | `2` | Multiplier between retries (2s → 4s → …), capped by `retry.maxDelayMs`. Kept between `1` and `4` |
| `retry.maxDelayMs` | `10000` | Longest single wait; a longer `Retry-After` keeps polling at this interval. Capped at `300000` (300 seconds) |
| `retry.failover` | `false` | Opt-in: after retries are exhausted, forward the original request to the next provider in the chain instead of returning the error |
| `providers.<name>.retry` | `true` | Per-provider switch: `false` never retries this provider (failure returns at once); `true` follows the global `retry`; or a partial object like `{ "attempts": 5 }` overrides just those fields, within the limits listed above |
| `providers.<name>.fallback` | the chain | Who takes over from this provider: `false` for nobody, or a list like `["backup"]` |
| `providers.<name>.preset` | `<name>` | Optional preset (`zai`, `deepseek`, `kimi`, `minimax`, `openrouter`): the address and compatibility switches, never a model |
| `providers.<name>.baseUrl` | (from preset) | Anthropic-compatible upstream URL for this provider |
| `providers.<name>.token` | (required) | Literal token, `"env:ENV_VAR_NAME"` or `"keychain:<service>/<account>"`. The variable is read from the router process's environment (inherited from the Claude Code session or setup command that started it), so one exported later is not seen until the router restarts. A `keychain:` token is a generic password in the macOS login keychain, macOS only (elsewhere use `env:<VAR>`); add one with `security add-generic-password -s <service> -a <account> -w`, which asks for the value instead of taking it on the command line; the router reads it in the background when the config first names it, and reads an item it could not read again only when `model-relay.json` changes or the router restarts (never on a timer, so a locked keychain does not raise an unlock dialog every few minutes): after you fix an item, save a change to the config (`account-token` rewrites it) or run `/provider restart`; a changed token that still reads needs a restart; the setup CLI only checks that the item exists. An `env:` token is in the environment of every process of the shell that sets it, and any process that runs as you can read a keychain item (see Terms of use and risk); `account-token` writes either reference for a Claude account |
| `providers.<name>.kind` | (none) | Used only when `accountFallback.mode` is `"rc-keep"` or `"api-only"`, or in `"switch"` when an `accounts.<name>.fallback` names it (for those windows only, see there); otherwise the entry is ignored and its token never read. `"anthropic"` makes this entry a second Claude account (another Claude subscription) rather than an Anthropic-compatible service. Its requests go to `claudeUrl` as Claude Code wrote them, with this entry's `token` (from `claude setup-token` on that account, best kept as `keychain:`) in place of yours, its `accountUuid`, `deviceId` and `email` in place of your account's, and `oauth-2025-04-20` added to `anthropic-beta` when the request lacks it. Put it in `failover.chain` and it takes over by itself when your account answers its usage-limit 429, and keeps new requests through the cooldown. Failover never pins a window to it: every window it took over goes back to your account with the first Claude trial that succeeds (`/provider probe` starts one sooner), and only `/provider <name>` pins a window there, by hand. It takes no `baseUrl`, `preset`, `model` or `matchModels`, so a model name never reaches it, and another provider hands it Claude-model requests only. A usage-limit 429 from it goes straight to the next link in the chain, without retrying it. It gets no `model-relay:<name>` subagent, is never pinged, and is skipped unless `claudeUrl` is `https://api.anthropic.com` |
| `providers.<name>.accountUuid` | (required with `kind`) | That account's UUID, the `account_uuid` its own Claude Code login sends in `metadata.user_id`. Exactly three things are replaced: the ids in `metadata.user_id` (`account_uuid`, and `device_id` when the request has one), the window's `session_id` there, which becomes one random id per window and account (also in `x-claude-code-session-id`; kept until the router restarts, and left alone for a request with no session header), and the address in the email sentence Claude Code puts in a `<system-reminder>` of the first message. Every other byte of the body stays as it was, so your address or account id written anywhere else in the conversation (a system prompt, `CLAUDE.md`, a git log) is not scrubbed. A body in which those two cannot be replaced exactly (a value written twice, the email sentence anywhere but that reminder) never goes out with this account's token: the next link in the chain takes it, or the request fails with an error that says why. It is never resent on your own account |
| `providers.<name>.deviceId` | (required with `kind`) | That account's device id: the `userID` in its `.claude.json`, 64 lower-case hex digits. It replaces the `device_id` in `metadata.user_id` when the request has one; none is ever added |
| `providers.<name>.email` | (required with `kind`) | That account's email address, without quotes, backslashes, angle brackets or spaces. When a `<system-reminder>` of the first message holds the sentence with your address, the address is replaced, whether or not the request has a `metadata.user_id`; a request without that sentence (a title or side call) goes on without one. Since the first message changes, the first request after a window moves there reads its whole prompt again |
| `providers.<name>.model` | (required) | Target model ID when rewriting requests (suffixes like `[1m]` are stripped on wire) |
| `providers.<name>.matchModels` | (from preset, else the model's first word) | Regex patterns matched against the incoming request `model`, in config order; the first match wins. A request for a provider's own `model` goes to that provider before any pattern is tried. A pattern match sends the model name on unchanged (a Claude name is replaced by the provider's `model`), so match the real model ID the upstream knows (see Model alias routing) |
| `providers.<name>.stripCacheControl` | `false` | Recursively remove `cache_control` fields before forwarding |
| `providers.<name>.authHeader` | (from preset, else `"bearer"`) | How to send credentials: `"bearer"`, `"x-api-key"`, or `"both"`. Of the built-in presets only `zai` uses `"both"`; the others use `"bearer"` |
| `providers.<name>.launch` | `null` | `{ "command": "...", "args": [...] }` to auto-spawn if localhost port is closed |
| `providers.<name>.agent` | `null` | Fields for this provider's `model-relay:<name>` subagent, as in an agent file: `description`, `prompt`, `tools`, `disallowedTools`, `skills`, `effort`, `permissionMode`, `maxTurns`, `autoCompactWindow`, `initialPrompt`, `memory`, `isolation`, `background`, `omitClaudeMd`, `mcpServers`, `hooks`. A field of the wrong shape is ignored; if Claude Code refuses the whole set, the subagent keeps the defaults and a notice says so |

### Show the relay in your statusline

Each window writes its relay state to `~/.claude/model-relay-status/<session id>` (the same config directory as above) whenever it changes, as one line `kind<TAB>label`. The session id is the `session_id` Claude Code passes to a `statusLine` command, so a statusline reads its own window's file directly. The router deletes files untouched for a week.

| `kind` | `label` | Meaning |
|---|---|---|
| `claude` | `claude` | This window goes to Claude through the relay |
| `claude` | `claude/<account>` | A second account's window, or a window that a usage limit moved to a fallback account (the label names the account that serves it), see Using more than one Claude account |
| `pinned` | the provider's model, or `claude/<account>` | Pinned with `/provider`, or by a failover |
| `failover` | the provider's model | Claude's limit is reached; the next request goes there |
| `limit` | `claude` | Claude's limit is reached and the failover chain has nobody to hand over to |
| `offline` | `offline` | No relay of this config directory answers (it is restarted when it can be; an older config is not, see `format`) |
| `direct` | `claude` | No relay answers, so this window talks to Claude directly |

[coralline](https://github.com/Nanako0129/coralline)'s `relay` segment reads this file.

### Experimental: show the model's picture in a pane

This feature is experimental: it may change or go away, and it is left out of `/provider help` and the tables above. Add `avatars` and the plugin draws the picture of the model this window is talking to in a side pane, swapping it when you switch with `/provider <name>`, when a Claude limit hands the window to a provider, and when it goes back to Claude. It is drawn with colored block characters (eighths and quarters of a cell), picked per cell to follow the picture's shapes, so it also works in terminals without an image protocol, such as Windows Terminal. It needs `ffmpeg` on `PATH`.

```json
"avatars": {
  "claude": { "image": "model-relay-avatars/claude.webp", "head": [471, 200, 340] },
  "backup": "model-relay-avatars/backup.webp"
}
```

- A key is `claude` or a provider's name. A value is an image path, relative to the config directory unless it starts from a root, or `{ "image", "head" }`. `head` is the square that holds the head: `[centerX, centerY, size]` in the image's own pixels.
- With `head` set, the pane shows the head, cropped to the pane's own shape around that square (narrowing to no less than three quarters of its side) so it fills the pane; without it the whole picture is fitted into the pane. Switching back to a model this window showed lately draws its picture at once. A persona with no entry shows its name and the key to add.
- The pane is off by default. `/provider avatar on` turns it on for every window (the `avatarPane` key): it then opens at the start of a session when the terminal is wide enough, and `/provider avatar off` closes it everywhere. `/provider avatar` alone opens or closes it in this window only, at any width, and changes no setting. It asks for a dock 80 columns wide, which Claude Code keeps to 45% of the terminal; the wider it is, the finer the picture. Close and reopen it after you change an image file.
- Each conversion writes its pixels to `model-relay-avatars/.cache/<session id>.rgba` in the config directory and empties the file when it is done; the folder is safe to delete.
- The repository ships no pictures; use only images you may use.

## Commands

| Command | Description |
|---|---|
| `/provider` | Open the panel above the prompt to pick this window's model |
| `/provider <name>` · `/provider claude` | Switch this window without the panel, answered in one line (e.g. `/provider backup`); back to Claude, the next turn rebuilds the prompt cache |
| `/provider switch [<account>]` | Mode `"switch"` only (`accountFallback.mode`): in a window the launcher wrapper started (it sets `MODEL_RELAY_WRAPPER_ID`) with a person at it, leaves the wrapper this session's id in `model-relay-handoff/<wrapper id>.json` in the config directory, and you then type `/exit`: the wrapper resumes the conversation under `accountFallback.account`. The account named, if any, must be that one. Before it writes anything it refuses, with the fix, when that account's folder is missing, is this window's own, or has a `projects/` folder other than this one's (the `ln -s` command, or `New-Item -ItemType SymbolicLink` on Windows, is printed). Anywhere else (no wrapper, a `-p` run, a command no person typed) nothing is written; it says which, and prints the command to resume by hand, as `env -u CLAUDE_CODE_OAUTH_TOKEN -u ANTHROPIC_API_KEY -u ANTHROPIC_AUTH_TOKEN -u ANTHROPIC_BASE_URL -u HTTP_PROXY -u http_proxy -u MODEL_RELAY_WRAPPER_ID CLAUDE_CONFIG_DIR=<that account's configDir> MODEL_RELAY_CONFIG_DIR=<relay dir> claude --resume <session id>`, or on Windows, in a new PowerShell window, `Remove-Item Env:CLAUDE_CODE_OAUTH_TOKEN,Env:ANTHROPIC_API_KEY,Env:ANTHROPIC_AUTH_TOKEN,Env:ANTHROPIC_BASE_URL,Env:HTTP_PROXY,Env:http_proxy,Env:MODEL_RELAY_WRAPPER_ID -ErrorAction SilentlyContinue; $env:CLAUDE_CONFIG_DIR='<configDir>'; $env:MODEL_RELAY_CONFIG_DIR='<relay dir>'; claude --resume <session id>`. The variables it removes are the ones the wrapper removes, so a token exported in your shell cannot take over the second account's window. When your `claudeUrl` is not `https://api.anthropic.com`, no command is printed, because a window started by hand would use your relay without being registered; it points to the launcher wrapper instead (`/provider switch` in a window the wrapper started). Run it from the same working directory; it finds the conversation only if that config directory shares this one's transcripts (`projects/`, for example through a symlink); in another mode it says that it needs `"switch"` |
| `/provider status` | The status as text: where this window goes, the switches every window shares, and anything to fix |
| `/provider help` | Every command, grouped by what it reaches: this window, every window, setup and checks |
| `/provider setup [goal]` | Let Claude walk you through setup with the setup tool; keys stay out of the chat |
| `/provider init` · `/provider doctor [--ping] [--fix]` | First-run setup and health check; `doctor` only reports unless you add `--fix`, which applies the repairs it can make itself. Work from any folder, with or without a config file |
| `/provider restart` | Restart the relay so it runs the installed plugin's code. After `claude plugin update` the plugin does this by itself once the relay answers no request; a relay left by an older plugin cannot report that, so a notice asks you to run it when no window has a reply in progress |
| `/provider ping` | Test every provider: does it answer, how soon does the answer start, and what is wrong if it does not |
| `/provider probe` | Reset the 429 cooldown timer so the next new session tries Claude immediately |
| `/provider alias [haiku\|sonnet\|opus] [<name>\|claude]` | Inspect or point a Claude model alias at a provider (updates both `settings.json` and `matchModels`) |
| `/provider failover [on\|off\|<a,b>]` | Turn 429 failover on/off or update `failover.chain` |
| `/provider retry [on\|off]` | Turn automatic provider retries on or off |
| `/provider rc [on\|off]` | Turn Remote Control HTTPS proxy mode on or off. On reaches new sessions only; off disconnects sessions already running in proxy mode until you restart them |

## Cost, privacy, and permissions

- **Network and data flow:** The router listens only on `127.0.0.1:<port>`. Requests go strictly to `claudeUrl` (`https://api.anthropic.com`) or the `baseUrl` endpoints you configure. `/provider ping` sends a `max_tokens: 1` request to each configured provider when you trigger it. No telemetry or analytics exist.
- **Other accounts' logins and keychain items:** for the organization rule the router reads `oauthAccount.accountUuid` and `oauthAccount.organizationUuid` from the `.claude.json` of each account in `accounts` and never logs them; `setup.mjs account-sync` takes `oauthAccount.accountUuid`, `oauthAccount.emailAddress` and `userID` from it and prints only field names. Nothing else in that file is used. To read a `keychain:` token the router runs `/usr/bin/security` (macOS only), in the background; the setup CLI only checks that the item exists. A setup-token is sent only to `claudeUrl`, never to a provider.
- **Local files:** Reads `~/.claude/model-relay.json` and writes session sticky state to `~/.claude/model-relay-state.json` plus local logs (`model-relay.log` and `model-relay-requests.log`, each emptied once it passes 5 MB). The old file names (`custom-agent.json`, `custom-agent-state.json`, `custom-agent-router.log`, `custom-agent-requests.log`) are no longer read; `migrate --go` renames them. With accounts it also writes `model-relay-launch.mjs` (the launcher file), `model-relay-handoff/<wrapper id>.json` (a `/provider switch` hand-over, in a folder only you can open, deleted by the wrapper when the window ends) and, for `account-add`, a folder `~/.claude-<name>` (or the `--dir` you gave) with symlinks back into your config directory.
- **Local certificate (proxy mode only):** `~/.claude/model-relay-pki/` holds a public CA file and one leaf certificate with its key (restricted to your user). The CA is limited to `api.anthropic.com` and trusted only through `NODE_EXTRA_CA_CERTS`; delete the folder or run `proxy disable --go` to stop using it.
- **Plugin permissions:** Inspect all hooks, state keys, and env access at any time by running `claude plugin validate /path/to/model-relay`.

## Supported environments

| Environment | Status |
|---|---|
| Windows 11 + Node.js 22 + Git Bash / PowerShell | Tested |
| Windows with an npm-installed Claude Code (`claude.cmd`) | The launcher wrapper cannot start it: use the native installer, or name the file with `-- <full path to claude.exe>` |
| Linux and Windows, for account tokens | `keychain:` tokens are macOS only; use `env:<VAR>` |
| macOS / Linux + Node.js 20+ (`sh` + `curl`) | Per official Node.js & POSIX specs. CI runs only `node tools/check.mjs` on Node.js 22 (Ubuntu, Windows, macOS); Node.js 20, the plugin hooks and the Claude Code integration are not tested there |

## Limitations

- **Requires an Anthropic-compatible `/v1/messages` endpoint:** Providers that only speak OpenAI Chat Completions require a local translation proxy (and can be supervised via `providers.<name>.launch`).
- **Switching back to Claude mid-session rebuilds cache:** Because prompt caches do not transfer across providers, `/provider claude` on a long conversation will resend the full conversation history to Anthropic.
- **No upstream proxy:** The relay connects to Anthropic and your providers directly, so a network that only lets traffic out through a (company) proxy is not supported yet.

## Troubleshooting

Start with `/provider doctor --ping`: it lists each problem with a `⚠` and the command that fixes it, and `/provider setup` can run those fixes with you.

| Symptom | What to check |
|---|---|
| `/provider` says config is missing or invalid | Run `/provider doctor` (or `node tools/setup.mjs doctor` from the install directory) to verify JSON syntax and check if any `env:VAR` variables are unset in your shell |
| The status line (with `statusBar` on) shows `Relay offline: connected directly to Claude`, or the status file says `direct` | In `ANTHROPIC_BASE_URL` mode the plugin bypassed a stopped router so your chat keeps working. In proxy mode there is no such bypass: Claude Code cannot connect until the router is restarted. Run `/provider doctor` or check `~/.claude/model-relay.log` (a router that finds its port taken by another process or another config directory logs that there and exits) |
| Remote Control says it is only available via `api.anthropic.com` | Claude Code still uses the relay as its API address; run `node tools/setup.mjs proxy enable --go` and start a new session |
| `proxy enable` refuses because `NODE_EXTRA_CA_CERTS` is already set | Something you use (often a company network that inspects TLS) already relies on that certificate, and Claude Code accepts only one file there, so proxy mode would make it stop trusting yours. Remote Control through the relay cannot be combined with it yet; nothing was changed |
| Claude Code cannot connect after enabling proxy mode | The router is probably down: run `node tools/setup.mjs proxy status`, start it with `node tools/setup.mjs rc`, or go back with `node tools/setup.mjs proxy disable --go` |
| Tools are missing on a third-party provider | The router now renames `ToolSearch` before it reaches the provider and keeps tools it has loaded callable. Run `node tools/setup.mjs restart` so a running router picks up the change |
| A `model-relay:<name>` subagent runs on Claude instead of the provider | The plugin shows a notice when this happens. Usually an `availableModels` list does not include the provider's model, so Claude Code runs the subagent on `CLAUDE_CODE_SUBAGENT_MODEL` or the parent's model; add the model ID exactly as configured. `node tools/setup.mjs doctor` checks the list in `~/.claude/settings.json` only |
| A notice says the config is from an older version, and `doctor` says it is outdated | The file is named `custom-agent.json` or has no `"format": 2`, so this version's router does not read it. `node tools/setup.mjs migrate` shows what it would write, and `migrate --go` writes it, with the router then routing as the older version did (it refuses if the result would route differently); then run `/provider restart` when no Claude Code window has a reply in progress. See [UPGRADING.md](UPGRADING.md) |

## Uninstall

1. Run `/provider doctor` and note the router's `pid` (on the `Router health` line; `Router status: offline` means nothing is running, so skip stopping it). Do this before uninstalling, because the tool that prints it lives in the plugin's folder.
2. Run `claude plugin uninstall model-relay@model-relay` and remove `ANTHROPIC_BASE_URL` from `~/.claude/settings.json` (in proxy mode remove `HTTPS_PROXY`, `NODE_EXTRA_CA_CERTS` and `NO_PROXY` instead; running `node tools/setup.mjs proxy disable --go` first does that and puts `ANTHROPIC_BASE_URL` back, which you then remove).
3. Close the Claude Code windows that still have the plugin loaded (an open one starts the router again), then stop the router with `kill <pid>` (macOS/Linux) or `taskkill /PID <pid> /F` (Windows). It keeps running after the plugin is removed. A gateway the router started from a provider's `launch` also keeps running on its own, so stop it after the router, which restarts a closed one within about 30 seconds. Find its process by the port in that provider's `baseUrl` (`lsof -i :<port>` on macOS/Linux, `netstat -ano | findstr :<port>` on Windows) and stop it the same way.
4. Delete optional state files (`~/.claude/model-relay.json`, `~/.claude/model-relay-state.json`, `~/.claude/model-relay-status/`, `~/.claude/model-relay-pki/`, `~/.claude/model-relay-handoff/`, `~/.claude/model-relay-launch.mjs`, `~/.claude/model-relay.log`, `~/.claude/model-relay-requests.log`, and any `*.model-relay-backup` copies).
5. If you used more than one account: remove the `alias claude=…` line or the `claude` function you put in your shell profile (it runs the launcher file you just deleted), delete each `~/.claude-<name>` folder `account-add` made (it holds that account's Claude Code login; most of its entries are symlinks into `~/.claude`, so delete the folder and not what the links point to), remove the keychain item of each `keychain:model-relay-<name>/<name>` token (`security delete-generic-password -s model-relay-<name> -a <name>`) or the `MODEL_RELAY_TOKEN_<NAME>` variables. Deleting your copy of a setup-token does not revoke it with Anthropic.

## Run from source

```bash
node tools/check.mjs
claude plugin validate .
claude plugin test .
node tools/smoke.mjs   # one real Claude Code request through this checkout's router; add --provider <name> for a provider
```

`tools/smoke.mjs` needs a logged-in `claude`, so CI does not run it. Run it before a release and after a Claude Code update. `node tools/check.mjs` also runs the TypeScript hook tests, which need Node.js 22.6 or later; only running the plugin gets by on 20+.

See [CONTRIBUTING.md](CONTRIBUTING.md) for architecture and release steps.

## More

- [Changelog](CHANGELOG.md)
- [Contributing](CONTRIBUTING.md)
- [Security Policy](SECURITY.md)
- [License (MIT)](LICENSE)
