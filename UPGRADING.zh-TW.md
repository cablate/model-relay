# 升級

[English](UPGRADING.md)

## 從 0.6 或更早的版本升級

更新外掛不會改你的檔案，但這一版不再讀取舊設定：檔名為 `custom-agent.json` 的檔案，或沒有 `"format": 2` 的 `model-relay.json`。在你執行 `migrate --go` 之前，外掛不會為它啟動或替換轉發站。還在執行的 0.6 轉發站會照舊用舊檔案路由；沒有轉發站回應時，這個對話直接連 Claude。外掛會用提示、狀態列和面板告訴你這件事，`doctor` 會列出一項 `outdated`。舊檔名（`custom-agent-state.json`、`custom-agent-router.log`、`custom-agent-requests.log`）同樣不會被讀取。

`migrate --go` 會把設定檔寫成格式 2，並把舊版本當初替你補上的每一個值都寫進去，所以之後轉發站的路由跟原本完全一樣，還在執行的 0.6 轉發站讀到新檔案也一樣（會讓路由改變的寫入，它一律拒絕）。`migrate` 是唯一看得懂舊格式的指令：`set`、`add`、`remove`、`alias`、`providers`、`init`、`restart`、`rc` 與 `proxy enable` 遇到舊設定都會拒絕，並請你先執行 `migrate`。

### 最省事的做法

在 Claude Code 裡輸入：

```text
/provider setup upgrade my model-relay config
```

Claude 會先跑 `doctor`，給你看 `migrate` 會寫入什麼，你同意之前什麼都不改。它不會要你提供金鑰，也不會印出金鑰。

### 改了什麼

| 舊設定 | 格式 2（`"format": 2`） | `migrate --go` 會寫入什麼 |
|---|---|---|
| preset 自帶模型（`zai`：`glm-5.3[1m]`、`deepseek`：`deepseek-chat`、`kimi`：`kimi-k2`、`minimax`：`MiniMax-M1`、`openrouter`：`anthropic/claude-sonnet-4`） | preset 只帶網址與該服務需要的相容參數；`model` 由你設定 | preset 原本給的模型，寫進那個供應商 |
| `zai` preset 也會攔下所有 `haiku` 請求（`matchModels: ["^glm", "haiku"]`） | 沒有 preset 會攔 Claude 的模型層級；要的話用 `alias haiku <name>` 明確設定 | 那組 `matchModels`，讓 `haiku` 照舊送過去 |
| `glm` 是 `zai` 的別名，`gemini` 與 `magpie` preset 指向 `127.0.0.1:3425` 上的 Gateway | 這三個 preset 已移除 | 它們的網址與參數，寫進用到它們的供應商 |
| 名稱或模型像 `gemini` 的供應商，會被猜一組 `stripCacheControl` 與 `authHeader` | 不再從名稱猜任何設定 | 原本猜出來的值 |
| 沒設 `failover.chain` 時，Claude 的 429 會交給 `glm` 或第一個供應商 | 空的名單代表 429 原樣回傳 | 原本會接手的名單 |
| 檔名是 `custom-agent.json`、`custom-agent-state.json`、`custom-agent-router.log` 與 `custom-agent-requests.log` | `model-relay.json`、`model-relay-state.json`、`model-relay.log` 與 `model-relay-requests.log`（舊檔名不再讀取） | 新檔名還沒被占用的，逐一改名 |
| 備份檔是 `*.relay-backup` | 備份檔是 `*.model-relay-backup` | 不動：舊備份留在原處 |

有兩個指令變嚴格了：`add` 一定要給 `--model`，以及 `--preset` 或 `--url` 其中一個（原本缺少時會自己編一個模型和網址）；`presets` 只列網址、不列模型。其他都沒有移除：所有 `retry` 欄位、`retry.failover`、`alias subagent`、`check` 與 `rc` 都照舊可用。

### 手動做

1. 執行 `node tools/setup.mjs doctor`。它會回報這份設定是過時的（`doctor --json` 裡的 `outdated`）；這一項正是 `migrate` 要處理的。
2. 執行 `node tools/setup.mjs migrate`。它只會印出會寫入什麼、會改名哪些檔案。如果有一行以 `!` 開頭，表示某個供應商的金鑰變數在這個 shell 裡沒設，遷移後 429 時由誰接手會改變；請先設好金鑰（或自己指定 chain）。
3. 執行 `node tools/setup.mjs migrate --go`。原本的設定檔會保留為 `<name>.model-relay-backup`，舊檔案會改名，token 原封不動複製過去。
4. 沒有回覆進行中時，執行 `/provider restart`（或 `node tools/setup.mjs restart`），讓轉發站改跑目前的程式。0.6 的轉發站無法回報自己忙不忙，所以外掛只會提醒你做這一步；在那之前它照舊路由。
5. 決定以前那些「沒問你就做」的行為還要不要。要讓 `haiku` 留在 Claude，執行 `node tools/setup.mjs alias haiku claude`。要指定 429 時由誰接手，執行 `node tools/setup.mjs set failover.chain <a,b>`；不要任何人接手就用 `set failover.enabled off`。
6. 執行 `/provider doctor --ping`。每一行都應該是 ✓，每個供應商都應該有回應。
