<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/assets/banner-dark.zh-TW.svg">
    <img src="docs/assets/banner-light.zh-TW.svg" width="900" alt="model-relay：Claude Code 多供應商模型路由與保護快取的 429 自動備援轉發站">
  </picture>
</p>

<p align="center">
  <b>遇到 Claude 5 小時額度上限時當場無縫接手、把子代理分流給快速模型，<br>還能從輸入框上方的互動面板一鍵切換單一視窗——絕不白白重建 80 萬快取。</b>
</p>

<p align="center">
  <a href="https://github.com/cablate/model-relay/releases"><img src="https://img.shields.io/github/v/release/cablate/model-relay?include_prereleases&display_name=release&label=release&color=38bdf8" alt="最新版本"></a>
  <a href="https://github.com/cablate/model-relay/actions/workflows/ci.yml"><img src="https://github.com/cablate/model-relay/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <img src="https://img.shields.io/badge/Claude_Code-2.1.287%2B-a78bfa" alt="Claude Code 2.1.287 以上">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue" alt="MIT 授權"></a>
</p>

<p align="center">
  <a href="README.md">English</a> · <b>繁體中文</b> · <a href="#安裝">安裝</a> · <a href="#功能">功能</a> · <a href="#設定">設定</a> · <a href="CHANGELOG.zh-TW.md">更新紀錄</a>
</p>

<p align="center">
  <img src="docs/assets/relay-flow.zh-TW.svg" width="900" alt="動畫：620k token 的長對話撞上 429 額度上限；model-relay 當場無縫切換至 GLM 5.3 並固定該對話。10 分鐘後 Claude 恢復時，只有新開的視窗回到 Claude，長對話固定留在 GLM 免重建 620k 快取">
</p>

## 為什麼需要

長時間使用 Claude Code 常撞上四個既中斷心流又浪費額度的路由問題。`model-relay` 在本機端（`127.0.0.1:8950`）直接解決它們，不需要依賴外部雲端代理。

| 當… | 沒裝 `model-relay` | 裝了 `model-relay` |
|---|---|---|
| 寫到一半遇到 Claude 5 小時額度上限（HTTP 429） | 這一輪直接報錯中斷，只能等額度重置或關視窗改環境變數 | 同一個請求當場自動轉給備援供應商完成回覆，工作完全不中斷 |
| 10 分鐘後 Claude 額度恢復了 | 把 620k token 的長對話切回 Claude 會全價重送 620k 快取，瞬間燒光額度 | 已切走的長對話固定留在備援供應商（7 天有效）；只有新開的對話回到 Claude |
| 想把 `haiku` 子代理交給便宜快速的模型 | 改全域環境變數會連主線的 Opus/Sonnet 一起換掉 | 透過 `matchModels` 把 `haiku` 子代理導向 GLM/DeepSeek，主線繼續留在 Claude |
| 只想把眼前這一個視窗切去 Gemini 或 GLM | 改 `settings.json` 會把所有開著的終端機視窗一起換掉 | 輸入 `/provider` 打開輸入框上方的互動面板，只固定當前視窗 |
| 第三方轉發站遇到 `ToolSearch` 或 `cache_control` 報錯 | 工具整批消失或請求直接回 HTTP 400 | 每個供應商可獨立設定 `stripToolSearch` 與 `stripCacheControl` 自動清洗請求 |

## 安裝

需要 Node.js 20+ 與 Claude Code 2.1.287 以上（已於 Node.js 22.23.2 及 Claude Code 2.1.302 實測）。

```sh
claude plugin marketplace add cablate/model-relay
claude plugin install model-relay@model-relay
```

初始化 `~/.claude/model-relay.json`、自動將 `ANTHROPIC_BASE_URL` 寫入 `~/.claude/settings.json`，並用一行指令實測所有上游供應商連線：

```bash
cd ~/.claude/plugins/cache/model-relay/model-relay/<version>   # 外掛的安裝目錄（見下方說明）
node tools/setup.mjs init --fix
export ZAI_API_KEY="your-api-key"
node tools/setup.mjs doctor --ping
```

本文所有 `node tools/setup.mjs ...` 指令都要在外掛的安裝目錄下執行，也就是 `~/.claude/plugins/cache/model-relay/model-relay/<version>/`（有設定 `CLAUDE_CONFIG_DIR` 時為 `$CLAUDE_CONFIG_DIR/plugins/cache/model-relay/model-relay/<version>/`；用 `ls` 看該資料夾即可知道版本）。在其他位置則改用該目錄內 `tools/setup.mjs` 的完整路徑。指令操作的是 `$CLAUDE_CONFIG_DIR` 指定的設定目錄，未設定則為 `~/.claude`。

`env:VAR` 的 token 是從轉發站程序自己的環境變數讀取，而它的環境繼承自啟動它的 Claude Code 對話（或 setup 指令）。轉發站啟動之後才匯出的變數，要等轉發站重新啟動才讀得到：請結束轉發站程序（`doctor` 會印出它的 pid）並開新的 Claude Code 對話。`doctor` 讀的是你當下的 shell，所以可能顯示金鑰已設定、轉發站卻看不到。

範例設定會把 `haiku` 導向 GLM（`matchModels: ["^glm", "haiku"]`）。金鑰一設好，Claude Code 所有的 `haiku` 呼叫（子代理、`WebFetch` 摘要、內部輔助呼叫）都會送到 z.ai，而不只是你挑的模型。要關掉，執行 `node tools/setup.mjs alias haiku claude`。

確認成功的輸出：

```text
Config OK (~/.claude/model-relay.json)
  Port: 8950
  Providers: glm -> glm-5.3[1m], gemini -> gemini-4-argon
  Failover: glm (back to Claude after 10 min)    Retry: on
  Claude settings: ✓ settings.json ANTHROPIC_BASE_URL=http://127.0.0.1:8950
  Router health: {"ok":true,"pid":38780,"failoverSince":0,"nextClaudeTry":0,"failoverProvider":"glm"}
  Upstream ping:
    ✓ glm        (glm-5.3[1m]) -> HTTP 200 in 1950ms
    ✓ gemini     (gemini-4-argon) -> HTTP 200 in 1420ms
```

之後更新只需執行 `claude plugin update model-relay@model-relay`。

## 適合誰用

`model-relay` 為同時擁有 Claude 訂閱與備援／專用模型端點（GLM `z.ai`、DeepSeek、Kimi、MiniMax、OpenRouter 或本地 Gemini Gateway）的 Claude Code 使用者設計。如果你需要的是給整個團隊共用的多租戶雲端閘道器，請改用 LiteLLM——`model-relay` 是單機本機端專用的輕巧轉發站。

## 功能

<p align="center">
  <img src="docs/assets/panel.zh-TW.svg" width="900" alt="動畫：左邊展示主線跑 Claude、haiku 子代理自動分流給 GLM 5.3、本地 Gemini Gateway 自動拉起；右邊展示輸入框上方的 model-relay 互動控制面板，可一鍵測速 Ping 與切換模型">
</p>

### 輸入框上方的 `AbovePrompt` 互動面板與即時測速

輸入 `/provider`（或 `/provider panel`）即可在輸入框上方開啟互動控制面板。可直接用滑鼠點擊按鈕，或按 `ctrl+x tab` 用鍵盤熱鍵操作（按 `1`–`9` 切換模型、按 `p` 即時測試所有供應商的回應延遲、按 `r` 重置 429 冷卻計時、按 `f` / `t` / `x` 開關 429 備援、重試與 Remote Control）。當要把已固定的長對話切回 Claude 時，面板設有二次確認防呆，避免誤觸重建巨量快取。面板上有三列開關，不必改 JSON 就能開關 429 備援、重試與 Remote Control：備援與重試從下一個請求起生效；Remote Control 會改寫 `settings.json`，所以先確認再執行，而且只有新對話會生效。

### 保護快取的 429 自動備援與對話黏著

當 Anthropic 回傳 429 額度上限時，轉發站會當場把請求改送往 `failover.chain` 的第一個供應商並將該對話 ID 標記固定 7 天。經過 `failover.cooldownMs`（預設 10 分鐘）後，新對話會重新嘗試使用 Claude，而已經切走的長對話會固定留在備援供應商。`failover.enabled` 可整個關閉。

### 供應商透明自動重試

供應商回 429 或 5xx 時，轉發站在**同一個供應商**上以指數退避自動重試（`retry.attempts`/`delayMs`/`backoff`），單次等待受 `retry.maxDelayMs` 上限；更長的 `Retry-After` 以此上限持續輪詢。`retry.attempts: 0` 代表無限重試（打到通為止——會監看客戶端連線，呼叫端斷線即停止）。Claude Code 完全看不到中間的失敗。`retry.enabled` 可一次關掉所有重試。開啟 `retry.failover` 後，重試耗盡仍失敗的請求會交給 `failover.chain` 的下一個供應商（或該供應商自己的 `fallback` 清單），不會回頭找已經試過的。

### 內建 6 大供應商 Presets 與本地 Gateway 自動拉起

內建 `zai`、`glm`、`deepseek`、`kimi`、`minimax`、`openrouter`、`gemini`、`magpie` 預設集，設定檔只需填寫 `token`（或 `"env:VAR_NAME"`）即可自動帶入網址與相容參數。針對跑在 `127.0.0.1` 的本地 Gateway，可設定 `launch: { command, args }`，在連接埠未開啟時自動由轉發站於背景啟動。

### 模型別名分流（把 `haiku`／`sonnet`／`opus` 指向指定供應商）

`model-relay` 把三種路由層級完全拆開，互不混用：

1. **單次請求別名分流（`matchModels` + `ANTHROPIC_DEFAULT_*_MODEL`）：** 只攔截符合該模型名稱的請求（例如 `haiku` 子代理、`WebFetch` 摘要），不會把整個主對話綁死。
2. **單一對話固定（`/provider <name>`）：** 只把目前這個對話視窗（`x-claude-code-session-id`）固定 7 天，其他視窗仍走 Claude。
3. **429 額度備援鏈（`failover.chain`）：** 只有 Anthropic 回傳 429 額度上限時才接手。

要把 `haiku` 等別名指向某個供應商（例如 `glm`），背後是兩個設定一起配合：

- `~/.claude/settings.json` → `env.ANTHROPIC_DEFAULT_HAIKU_MODEL = "glm-5.3[1m]"`：讓 Claude Code 本身把 `haiku` 別名解析成 `glm-5.3[1m]`（含 `[1m]` 百萬上下文視窗），送出請求時帶 `"model": "glm-5.3"`。
- `~/.claude/model-relay.json` → `providers.glm.matchModels: ["^glm", "haiku"]`：讓轉發站同時攔截 `"glm-5.3"`（符合 `^glm`）以及 Claude Code 內部寫死 `"claude-haiku-*"` 的請求（符合 `"haiku"`），並在送往上游前自動把 `model` 欄位改寫成 `"glm-5.3"`。這也是範例設定在金鑰設好後會把 Claude Code 所有 `haiku` 呼叫送到 GLM 的原因；`node tools/setup.mjs alias haiku claude` 可還原。

直接用 `setup.mjs alias`（或對話內 `/provider alias`）即可一次查看或同步寫入這兩個檔案：

```bash
node tools/setup.mjs alias                       # 查看 haiku / sonnet / opus 與 subagent 預設層級
node tools/setup.mjs alias haiku glm             # 把 haiku 指向 glm（同步更新 settings.json 與 model-relay.json）
node tools/setup.mjs alias haiku claude          # 把 haiku 還原回 Anthropic Claude
node tools/setup.mjs alias subagent sonnet       # 在 settings.json 設定 CLAUDE_CODE_SUBAGENT_MODEL=sonnet
```

若想在單次派子代理時直接指定走某個供應商，`model-relay` 會在執行期透過 `$.agent.register` 為每個供應商自動註冊一個等同預設 `Agent` 工具（繼承全部父層工具）的 `model-relay:<name>`（如 `model-relay:glm`、`model-relay:gemini`），並在 `on('agent.spawn')` 鎖定該供應商的模型 ID——直接指定 `subagent_type: "model-relay:gemini"` 即可，不必建 `.claude/agents/*.md` 定義檔，也不用重開對話。

### 用指令改設定，不必手改 JSON

`set`、`providers`、`remove` 與 `migrate` 可以不手改 JSON 就修改設定檔。每次修改都會在檔案旁留一份 `.relay-backup` 備份，token 一律不會印出，執行中的轉發站在下一個請求就會讀到新設定。`doctor` 也會提醒舊版格式、備援名單裡不存在的供應商，以及被別的供應商先攔走的模型名稱。

```bash
node tools/setup.mjs providers
node tools/setup.mjs set failover.chain gemini,glm
node tools/setup.mjs set providers.gemini.fallback none
node tools/setup.mjs migrate --go
```

### 保留轉發站的同時支援 Remote Control

Remote Control 只在 Claude Code 連的是 `api.anthropic.com` 時才會啟動，而把位址指向轉發站會讓它拒絕啟動。HTTPS 代理模式改成不動這個位址、讓轉發站當代理：Claude Code 透過 `HTTPS_PROXY` 連線，轉發站以 Claude Code 透過 `NODE_EXTRA_CA_CERTS` 信任的憑證代答 `api.anthropic.com`，模型請求照舊分流（供應商、黏著備援、重試）。其餘流量（含 token 更新與 Remote Control 本身）原封不動交給 Anthropic。

```bash
node tools/setup.mjs proxy enable --go
node tools/setup.mjs rc
```

- **信任範圍受限：** 轉發站建立的 CA 只能為 `api.anthropic.com` 背書（關鍵的網域限制），私鑰在簽完憑證後立即丟棄，且只有帶 `NODE_EXTRA_CA_CERTS` 的 Claude Code 程序才會載入。系統憑證庫完全不會被動到。
- **安全退路：** 沒有可用憑證時，轉發站會把 `api.anthropic.com` 原封不動轉送，Claude Code 照常運作，只是不再分流。轉發站停掉則不一樣：外掛自動退回直連只在 `ANTHROPIC_BASE_URL` 模式有效，代理模式下轉發站沒重新啟動（`node tools/setup.mjs rc`）前 Claude Code 連不上。
- **可還原：** `proxy disable --go` 會恢復 `ANTHROPIC_BASE_URL`，原本的 `settings.json` 會保留為 `settings.json.relay-backup`。

`HTTPS_PROXY` 寫在 `settings.json` 的 `env`，所以 Claude Code 執行的指令（`git`、`curl`、`gh`）也會套用：它們經由轉發站以盲轉送（blind tunnel）連線，轉發站停掉時就會失敗。

## 設定

設定檔位於 `~/.claude/model-relay.json`（亦向下相容舊檔名 `~/.claude/custom-agent.json`）。設定目錄預設優先讀取 `$CLAUDE_CONFIG_DIR`，若未設定則使用 `$USERPROFILE/.claude` 或 `$HOME/.claude`。

| 欄位 | 預設值 | 說明 |
|---|---|---|
| `port` | `8950` | 本機轉發站監聽的連接埠（`1025`–`65535`）。用 `node tools/setup.mjs set port <n>` 修改，會一併更新 `settings.json`；已在執行的轉發站會一直用舊埠直到你把它停掉（指令會印出它的 pid），且會拒絕已有程式在回應的埠 |
| `claudeUrl` | `"https://api.anthropic.com"` | 上游 Anthropic API 網址 |
| `proxy.enabled` | `false` | 接受為 Remote Control 而來的 HTTPS 代理連線。預設關閉。開啟後，對 `api.anthropic.com` 以外任何主機的 `CONNECT` 都是盲轉送（blind tunnel），本機任何程序都能使用；`node tools/setup.mjs proxy enable --go` 開啟、`proxy disable --go` 關閉 |
| `failover.enabled` | `true` | 遇到 Claude 429 額度用完時是否自動切換至備援名單 |
| `failover.chain` | 第一個供應商 | 依序接手的供應商：Claude 額度用完，或某個供應商持續失敗時使用；不存在的名稱會被略過（舊的單一 `failover.provider` 仍可讀） |
| `failover.cooldownMs` | `600000` | 幾毫秒後讓新對話重新測試 Claude 是否恢復（預設 10 分鐘，最小 `60000`） |
| `retry.enabled` | `true` | 供應商失敗時是否重試的總開關；設為 `false` 時其他重試設定會保留，之後再開即可 |
| `retry.attempts` | `3` | 同一個供應商回 429/5xx 時的退避重試次數；`0` 代表無限重試 |
| `retry.delayMs` | `2000` | 第一次重試的等待毫秒數，之後每次乘上 `retry.backoff` |
| `retry.backoff` | `2` | 重試間隔倍數（2s → 4s → …），上限受 `retry.maxDelayMs` 限制 |
| `retry.maxDelayMs` | `10000` | 單次等待上限；更長的 `Retry-After` 以此間隔持續輪詢 |
| `retry.failover` | `false` | 選配：重試耗盡後把原始請求改送備援名單的下一個供應商，而不是回傳錯誤 |
| `providers.<name>.retry` | `true` | 每供應商獨立開關：`false` 完全不重試（失敗立刻回報）；`true` 跟隨全域 `retry`；或傳部分物件如 `{ "attempts": 5 }` 只覆寫那些欄位 |
| `providers.<name>.fallback` | 備援名單 | 這個供應商失敗時由誰接手：`false` 代表不交給任何人，或像 `["glm"]` 的清單 |
| `providers.<name>.preset` | `<name>` | 可選預設集（`zai`、`glm`、`deepseek`、`kimi`、`minimax`、`openrouter`、`gemini`、`magpie`） |
| `providers.<name>.baseUrl` | （由 preset 帶入） | 該供應商相容 Anthropic 格式的上游網址 |
| `providers.<name>.token` | （必填） | API 金鑰字串，或 `"env:ENV_VAR_NAME"` 從環境變數讀取。變數是從轉發站程序的環境讀取（繼承自啟動它的 Claude Code 對話或 setup 指令），所以之後才匯出的變數要等轉發站重新啟動才讀得到 |
| `providers.<name>.model` | （由 preset 帶入） | 轉發時改寫的目標模型 ID（如 `[1m]` 等尾綴會在送出時自動剝除） |
| `providers.<name>.matchModels` | `["^<name>"]` | 比對請求 `model` 欄位的正規表示式陣列 |
| `providers.<name>.stripToolSearch` | `true` | 是否在送出前移除 `ToolSearch` 與 `defer_loading: true` 工具 |
| `providers.<name>.stripCacheControl` | `false` | 是否在送出前遞迴移除所有 `cache_control` 欄位 |
| `providers.<name>.authHeader` | `"both"` | 金鑰標頭傳遞方式：`"bearer"`、`"x-api-key"` 或 `"both"` |
| `providers.<name>.launch` | `null` | `{ "command": "...", "args": [...] }`，當本機連接埠未開時自動拉起程序 |

## 指令

| 指令 | 說明 |
|---|---|
| `/provider` | 在輸入框上方開啟互動控制面板，並顯示目前對話的路由狀態 |
| `/provider panel` | 開關輸入框上方的 `AbovePrompt` 互動控制面板 |
| `/provider <name>` | 將目前這個對話固定改用 `<name>` 供應商（例如 `/provider glm`、`/provider gemini`） |
| `/provider claude` | 將目前這個對話切回 Claude（下一輪會重建整段對話快取） |
| `/provider ping` | 即時測試所有已設定供應商的連線狀態與回應延遲 |
| `/provider probe` | 重置 429 冷卻計時，讓下一個新對話立即嘗試使用 Claude |
| `/provider alias [haiku\|sonnet\|opus] [<name>\|claude]` | 查看或設定 Claude 模型別名要走哪個供應商（同步更新 `settings.json` 與 `matchModels`） |
| `/provider failover [on\|off\|<a,b>]` | 開關 429 備援或修改 `failover.chain` 接手順序 |
| `/provider retry [on\|off]` | 開關供應商失敗自動重試 |
| `/provider rc [on\|off]` | 開關手機 Remote Control HTTPS 代理模式（新對話生效） |

## 花費、隱私與權限

- **網路與資料流向：** 轉發站只綁定本機 `127.0.0.1:<port>`，請求只會送往 `claudeUrl`（`https://api.anthropic.com`）或你在設定檔中指定的 `baseUrl`。當你主動觸發 `/provider ping` 時，會對各供應商發送一個 `max_tokens: 1` 的測試請求。不包含任何遙測或第三方統計。
- **本機讀寫檔案：** 讀取 `~/.claude/model-relay.json`（或 `custom-agent.json`），並將對話黏著狀態寫入 `~/.claude/model-relay-state.json`，日誌寫入 `custom-agent-router.log` 與 `custom-agent-requests.log`（兩者超過 5 MB 都會自動清空）。
- **本機憑證（僅代理模式）：** `~/.claude/model-relay-pki/` 內有一份公開的 CA 檔與一張葉憑證及其私鑰（權限限定你的使用者）。這個 CA 只限 `api.anthropic.com`，且只透過 `NODE_EXTRA_CA_CERTS` 被信任；刪掉該資料夾或執行 `proxy disable --go` 即可停用。
- **外掛權限檢查：** 你可以隨時執行 `claude plugin validate /path/to/model-relay` 檢視外掛宣告的所有 hooks、狀態鍵與環境變數存取範圍。

## 支援的環境

| 環境 | 狀態 |
|---|---|
| Windows 11 + Node.js 22 + Git Bash / PowerShell | 實測通過 |
| macOS / Linux + Node.js 20+（`sh` + `curl`） | 依官方 Node.js 與 POSIX 規格。CI 只在 Node.js 22（Ubuntu、Windows、macOS）執行 `node tools/check.mjs`；Node.js 20、外掛 hooks 與 Claude Code 整合並未在 CI 測試 |

## 限制

- **上游需支援 Anthropic `/v1/messages` 格式：** 若供應商只支援 OpenAI Chat Completions 格式，需搭配本地轉換 Gateway（可透過 `providers.<name>.launch` 由轉發站自動拉起）。
- **長對話中途切回 Claude 會重建快取：** 不同供應商之間的 Prompt Cache 無法互通，在長對話執行 `/provider claude` 會在下一輪將完整歷史重新送給 Anthropic。

## 疑難排解

| 症狀 | 檢查項目 |
|---|---|
| `/provider` 顯示設定檔不存在或格式錯誤 | 執行 `node tools/setup.mjs doctor` 檢查 JSON 語法，並確認 `env:VAR` 環境變數是否已在當前 shell 匯出 |
| 狀態列顯示轉發站離線（`Relay offline: connected directly to Claude`） | `ANTHROPIC_BASE_URL` 模式下，外掛偵測到轉發站未回應時會自動退回直連確保對話不中斷；代理模式沒有這個退路，轉發站重新啟動前 Claude Code 連不上。可執行 `node tools/setup.mjs doctor` 或查看 `~/.claude/custom-agent-router.log`（連接埠被其他程序或其他設定目錄的轉發站佔用時，轉發站會把原因寫在這個日誌並結束） |
| Remote Control 說只能經由 `api.anthropic.com` 使用 | Claude Code 還把轉發站當成 API 位址；執行 `node tools/setup.mjs proxy enable --go` 後開新的對話 |
| 開啟代理模式後 Claude Code 連不上 | 多半是轉發站沒在跑：執行 `node tools/setup.mjs proxy status` 查看，用 `node tools/setup.mjs rc` 啟動，或用 `node tools/setup.mjs proxy disable --go` 退回 |
| 切到第三方供應商後工具消失或無法呼叫工具 | 確認該供應商在 `model-relay.json` 中設有 `"stripToolSearch": true` |
| `model-relay:<name>` 子代理實際跑在 Claude 而不是該供應商 | 某一層設定（使用者、專案、local 或 managed）的 `availableModels` 沒有列出該供應商的模型，Claude Code 會改用 `CLAUDE_CODE_SUBAGENT_MODEL` 或主線模型；把模型 ID 依設定原樣加進去。`node tools/setup.mjs doctor` 會檢查 `~/.claude/settings.json` |

## 移除

1. 執行 `claude plugin uninstall model-relay@model-relay`，並將 `~/.claude/settings.json` 中的 `ANTHROPIC_BASE_URL` 移除（代理模式則改為移除 `HTTPS_PROXY`、`NODE_EXTRA_CA_CERTS` 與 `NO_PROXY`；先執行 `node tools/setup.mjs proxy disable --go` 就會處理好，並把 `ANTHROPIC_BASE_URL` 放回去，再把它移除即可）。
2. 刪除選用的本機狀態檔（`~/.claude/model-relay.json`、`~/.claude/model-relay-state.json`、`~/.claude/model-relay-pki/`、`~/.claude/custom-agent-router.log`、`~/.claude/custom-agent-requests.log`）。

## 從原始碼執行

```bash
node tools/check.mjs
claude plugin validate .
claude plugin test .
```

架構說明與發版流程請見 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 更多

- [版本紀錄](CHANGELOG.zh-TW.md)
- [貢獻指南](CONTRIBUTING.md)
- [安全政策](SECURITY.md)
- [授權條款 (MIT)](LICENSE)
