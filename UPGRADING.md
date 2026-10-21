# Upgrading

[繁體中文](UPGRADING.zh-TW.md)

## Upgrading from 0.6 or earlier

Updating the plugin does not edit your files, but this version no longer reads an older config: a file named `custom-agent.json`, or a `model-relay.json` without `"format": 2`. Until you run `migrate --go`, the plugin starts and replaces no router for it. A 0.6 router that is still running keeps routing with the older file; if none answers, the session talks to Claude directly. The plugin says so in a notice, in the panel and, with `statusBar` on, in the status line, and `doctor` lists one finding, `outdated`. The old file names (`custom-agent-state.json`, `custom-agent-router.log`, `custom-agent-requests.log`) are not read either.

`migrate --go` writes the file as format 2 with every value the older version filled in, so the router then routes exactly as before, and a 0.6 router still running reads the new file the same way (it refuses to write anything that would route differently). `migrate` is the only command that understands the older format: `set`, `add`, `remove`, `alias`, `providers`, `init`, `restart`, `rc` and `proxy enable` refuse to work on an older config and tell you to run `migrate` first.

### The short way

Type this in Claude Code:

```text
/provider setup upgrade my model-relay config
```

Claude runs `doctor`, shows you what `migrate` would write, and changes nothing until you agree. It never asks for a key and never prints one.

### What changed

| Older config | Format 2 (`"format": 2`) | What `migrate --go` writes |
|---|---|---|
| Presets came with a model (`zai`: `glm-5.3[1m]`, `deepseek`: `deepseek-chat`, `kimi`: `kimi-k2`, `minimax`: `MiniMax-M1`, `openrouter`: `anthropic/claude-sonnet-4`) | A preset gives only the address and the switches the service needs; you set `model` | The model the preset gave, into that provider |
| The `zai` preset also caught every `haiku` request (`matchModels: ["^glm", "haiku"]`) | No preset catches a Claude tier; `alias haiku <name>` does it on purpose | That `matchModels`, so `haiku` keeps going there |
| `glm` was another name for `zai`, and the `gemini` and `magpie` presets pointed at a gateway on `127.0.0.1:3425` | Those three presets are gone | Their address and switches, into each provider that used them |
| A provider named or modelled like `gemini` got `stripCacheControl` and `authHeader` guessed for it | Nothing is guessed from a name | The guessed values |
| Without `failover.chain`, Claude's 429 went to `glm` or to the first provider | An empty chain passes the 429 back as it is | The chain it used to fall back to |
| Files were named `custom-agent.json`, `custom-agent-state.json`, `custom-agent-router.log` and `custom-agent-requests.log` | `model-relay.json`, `model-relay-state.json`, `model-relay.log` and `model-relay-requests.log` (the old names are no longer read) | Renames each one whose new name is still free |
| Backups were `*.relay-backup` | Backups are `*.model-relay-backup` | Nothing: old copies stay where they are |

Two commands are stricter: `add` needs `--model` and one of `--preset` or `--url` (it used to make up a model and an address), and `presets` lists addresses without models. Nothing else was removed: every `retry` field, `retry.failover`, `alias subagent`, `check` and `rc` work as before.

### By hand

1. Run `node tools/setup.mjs doctor`. It reports the config as outdated (`outdated` in `doctor --json`); that one finding is what `migrate` handles.
2. Run `node tools/setup.mjs migrate`. It only prints what it would write and which files it would rename. A line starting with `!` means a provider's key variable is unset in this shell, so who takes over on a 429 would change; set the key (or name the chain yourself) first.
3. Run `node tools/setup.mjs migrate --go`. The previous config is kept as `<name>.model-relay-backup`, the old files are renamed, and tokens are copied untouched.
4. Run `/provider restart` (or `node tools/setup.mjs restart`) when no reply is in progress in any Claude Code window, so the router runs the current code. Every window shares the one router, and a router from 0.6 cannot say whether it is busy, so the plugin only asks you to do this; until then it keeps routing as before. A reply that is cut off is sent again by Claude Code. Until the restart the 0.6 router logs requests to `custom-agent-requests.log` again; you can delete it afterwards.
5. Decide whether you still want what used to happen without asking. To keep `haiku` on Claude, run `node tools/setup.mjs alias haiku claude`. To choose who takes over on a 429, run `node tools/setup.mjs set failover.chain <a,b>`, or `set failover.enabled off` for nobody.
6. Run `/provider doctor --ping`. Every line should be ✓, and each provider should answer.
