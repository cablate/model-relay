# 版本紀錄

[English](CHANGELOG.md)

本檔案記錄 `model-relay` 的所有重要變更。格式依據 [Keep a Changelog 1.1](https://keepachangelog.com/en/1.1.0/)，版號遵循 [語意化版本](https://semver.org/)（`0.x` 階段的次版號可能包含不相容變更），並以 `.claude-plugin/plugin.json` 的版號為準。

## [未發布]

### 新增

- **`setup.mjs set port <n>`：** 修改轉發站連接埠（`1025`–`65535`），保留 `.relay-backup` 備份，並同步改寫 `settings.json`（`ANTHROPIC_BASE_URL`，代理模式則是 `HTTPS_PROXY`，照例備份）。會拒絕已有程式在回應的埠。已在執行的轉發站會一直用舊埠直到你把它停掉；指令會印出它的 pid，但不會替你結束它。
- **`/__health` 回報 `configDir`：** 轉發站是為哪個設定目錄啟動的，讓 `doctor`、`proxy` 與外掛 hook 能分辨連接埠上回應的是誰的轉發站。路徑以實際路徑比對，Windows 上不分大小寫。

### 變更

- **轉發站拿不到連接埠時會說明原因：** 遇到 `EADDRINUSE`，只有佔用者回報相同設定目錄時才靜默結束；否則把連接埠與另一個設定目錄（或未知程序）寫進 `custom-agent-router.log`，並以非零狀態結束。不回報設定目錄的是舊版轉發站，照舊不去動它。
- **`doctor`、`proxy status` 與 `proxy enable|renew` 會察覺別人的轉發站：** 連接埠上的轉發站屬於其他設定目錄時，`doctor` 與 `proxy status` 會警告、`proxy enable|renew` 會拒絕並指出兩個目錄，且在變更任何東西之前。不回報目錄的是舊版轉發站：`doctor` 會請你重新啟動它，`proxy enable` 照舊替你重啟。
- **外掛 hook 不會經由其他設定目錄的轉發站轉送：** 連接埠上的轉發站回報了不同的設定目錄時，這個對話改為直連 Claude，狀態列會指出另一個目錄。沒有回報目錄的仍視為你自己的。
- **README：** 說明 `tools/setup.mjs` 的位置與執行方式、`env:VAR` token 讀的是轉發站自己的環境、範例設定會把所有 `haiku` 呼叫送到 GLM、自動直連退路只在 `ANTHROPIC_BASE_URL` 模式有效、`HTTPS_PROXY` 也會套用到 `git`／`curl`／`gh`、`proxy.enabled` 實際開放了什麼、CI 實際測了什麼，以及完整的移除清單。

### 修正

- `~/.claude/settings.json` 的 `availableModels` 沒有列出某個供應商的非 Claude 模型時，`doctor` 現在會發出警告。否則 Claude Code 會把 `model-relay:<name>` 子代理改跑在 `CLAUDE_CODE_SUBAGENT_MODEL` 或主線模型上，只在 debug log 留一行警告，請求永遠不會經過轉發站。
- 供應商或 Anthropic 的回應在串流途中斷線時，不再讓 Claude Code 一直等不到回覆；開啟重試時，串流途中連線被重置也不再讓轉發站當掉：現在會直接中斷呼叫端的連線，讓它知道請求失敗。呼叫端放棄時（按 Esc），現在也會中斷送往上游的請求，不再讓它跑到結束。
- **路由器看不到的 token 變數現在看得到了：** 路由器從「啟動當下」的環境解析 `env:VAR` token，所以之後才 export 的金鑰在重啟前都不會生效，而從你的 shell 執行的 `doctor` 卻顯示「Config OK」。現在 `/__health` 會以 `unresolved` 列出未解析的供應商與變數名稱（絕不顯示值）、「config missing」錯誤會指出被略過的供應商並說明需重啟路由器，`doctor` 也會在執行中的路由器缺少你 shell 裡已有的變數時提出警告。
- **第一次 `proxy enable --go` 不再因「unable to get local issuer certificate」自我測試失敗：** 路由器會把「沒有憑證」記住 10 秒，而外掛的健康檢查輪詢可能恰好在 `proxy enable` 建立憑證之前記下這個結果，導致自我測試的連線被直接轉送到 Anthropic，而不是由轉發站的憑證回應。現在不再快取「憑證不存在」。
- **`init --fix` 寫死連接埠 8950：** 改為寫入設定檔中的連接埠。
- **設定檔的 `env:` token 未設定時，轉發站會綁到 8950、並對任何主機開放 `CONNECT`：** 現在轉發站會綁設定檔自己的連接埠，沒有可用設定時對 `CONNECT` 的處理和代理模式關閉時相同（拒絕）。
- **`custom-agent-router.log` 無限成長：** 現在和 `custom-agent-requests.log` 一樣超過 5 MB 就清空，與文件一致。

### 安全性

- **網頁不能再使用轉發站：** 轉發站以前會回應任何連到 `127.0.0.1` 的請求，瀏覽器裡開著的網頁可以送一個單純的 `text/plain` POST 到 `/v1/messages`，花掉你的供應商額度，或利用 DNS rebinding 讀取回應、呼叫 `/__session`、`/__probe` 與 `/__ping`。現在轉發站的監聽埠會以 403 拒絕三種請求：來自瀏覽器的請求（帶有 `Origin` 或 `Sec-Fetch-Site` 標頭，本機其他連接埠上的網頁也算）、`Host` 不是 `127.0.0.1` 或 `localhost` 加上轉發站正在監聽的連接埠的請求，以及絕對形式的請求網址。`api.anthropic.com` 代理通道裡的請求不受影響。
- **轉發站不再把 `constructor` 這類名稱當成供應商：** 每個 JavaScript 物件都有的名稱（`constructor`、`toString`、`__proto__`）以前會被當成已設定的供應商，`/__session` 可以把對話固定到這些名稱上，該對話的下一個請求就會讓轉發站當掉。現在轉發站一律視為不存在的供應商，對話 ID 為 `__proto__` 時也會和其他 ID 一樣正常記錄。

## [0.6.0] - 2026-10-20

支援保留轉發站的手機 Remote Control（`proxy.enabled` 搭配只限 `api.anthropic.com` 的本機 CA）、一行指令設定 `haiku`／`sonnet`／`opus` 模型別名分流（`setup.mjs alias` 與 `/provider alias`），並動態註冊可直接派工的供應商子代理（`subagent_type: "model-relay:<name>"`），免建 `.claude/agents/*.md` 也免重開對話。`/provider` 互動面板同步新增 429 備援（`failover.chain`）、失敗重試（`retry.enabled`）與手機遙控三列開關（熱鍵 `f`／`t`／`x`）。

**升級：** 拉取最新版本或執行 `claude plugin update model-relay@model-relay`。若想整理舊版設定鍵，可執行 `node tools/setup.mjs migrate --go`。

### 新增

- **轉發站留在路徑上也能用 Remote Control（HTTPS 代理模式）：** Claude Code 維持 `api.anthropic.com` 當位址（Remote Control 的要求），改把轉發站當成它的 `HTTPS_PROXY`。轉發站以自己的憑證代答 `api.anthropic.com`，模型請求照舊分流（供應商、429 黏著備援、重試）；token 更新、Remote Control 流量與 WebSocket 升級原封不動交給 Anthropic，其他網站則是單純的位元組通道。選用功能：預設關閉，沒用 Remote Control 的人，轉發站不會變成開放代理。設定：`proxy.enabled`。
- **限定網域的本機憑證授權單位：** 這個 CA 只能為 `api.anthropic.com` 背書，簽完唯一的那張葉憑證後私鑰立即丟棄，而且只有帶 `NODE_EXTRA_CA_CERTS` 的程序才會信任它。沒有可用憑證時，轉發站會把 `api.anthropic.com` 原封不動轉送，Claude Code 照常運作。
- **`setup.mjs proxy` 與 `setup.mjs rc`：** `proxy status|enable|disable|renew`（加 `--go` 才會套用）在 API 位址模式與代理模式之間切換 `settings.json`，保留 `settings.json.relay-backup` 備份，且不會碰不屬於轉發站的設定；`rc` 會在需要時先啟動轉發站，再執行 `claude remote-control`。
- **備援名單：** `failover.chain` 依序列出接手的供應商。Claude 額度用完時由第一個回答；開啟 `retry.failover` 後，持續失敗的供應商會把請求交給下一個，不會回頭找已經試過的。供應商可以用 `providers.<name>.fallback` 覆寫（`false` 代表不交給任何人，或自己的清單）。
- **重試總開關：** `retry.enabled` 設為 `false` 即全面停止重試，其他重試設定會保留，之後再開即可。
- **`/provider` 面板上的開關：** 三列開關可開關 429 備援、重試與 Remote Control（熱鍵 `f`、`t`、`x`）。Remote Control 會改寫 `settings.json`，所以先確認再執行；面板是透過 `setup.mjs` 同一組 `set` 與 `proxy` 指令修改檔案。
- **`setup.mjs` 的設定指令：** `set` 驗證後修改單一開關或清單，`providers` 逐一列出路由、備援與重試，`remove` 把供應商從檔案與所有備援名單中移除，`migrate` 把舊格式檔案整理成目前的格式。每次修改都會留一份 `.relay-backup` 備份、token 一律不會印出，轉發站在下一個請求就會讀到結果。
- **一鍵模型別名管理（`setup.mjs alias` 與 `/provider alias`）：** 可在單一指令查看或將 `haiku`、`sonnet`、`opus` 與 `subagent`（`CLAUDE_CODE_SUBAGENT_MODEL`）指向指定供應商或還原回 Claude，自動同步更新 `~/.claude/settings.json`（`ANTHROPIC_DEFAULT_*_MODEL`）與 `~/.claude/model-relay.json`（`matchModels`）。`/provider` 與互動面板現在將「別名分流」與「429 備援」分開揭露，並支援直接在對話框輸入 `/provider alias|failover|retry|rc`。
- **動態註冊 `model-relay:<provider>` 子代理類型（`$.agent.register` 與 `agent.spawn`）：** 針對 Claude Code `Agent` 工具 `model` 欄位只接受 `"sonnet"|"opus"|"haiku"|"fable"` 的限制，外掛現在會自動為每個供應商動態註冊具備完整父層工具的 `model-relay:<name>`（如 `model-relay:glm`、`model-relay:gemini`），並在 `on('agent.spawn')` 鎖定該供應商的模型 ID——無須建立 `.claude/agents/*.md` 或重開對話。

### 變更

- **`doctor` 認得代理模式：** 代理模式開啟時，`doctor --fix` 不會再把 `ANTHROPIC_BASE_URL` 加回去，`/__health` 也會回報代理狀態與連線數。
- **設定檔格式更乾淨：** `failover` 底下放 `enabled`、`chain` 與 `cooldownMs`，供應商只放在 `providers`。舊的頂層 `baseUrl`、`token`、`model`、`gemini`、`failoverEnabled`、`probeEveryMin` 與 `failoverProvider` 仍可使用，讀取時等同已整理過；`migrate --go` 會在行為不變的前提下改寫檔案。
- **`doctor` 會檢查設定：** 提醒舊版格式、備援名單裡不存在的供應商，以及被別的供應商的 `matchModels` 先攔走的模型名稱，備援那一行也會顯示名單與冷卻時間。
- **`/__health` 回報開關狀態：** `failoverChain` 與 `config` 讓面板顯示轉發站實際的狀態，而不是猜測。

### 修正

- **`failover.cooldownMs` 沒有作用：** 文件寫的設定沒有生效，因為轉發站讀的是 `probeEveryMin`。現在 `failover.cooldownMs` 會決定新對話離開 Claude 多久，最小一分鐘。
- **存到一半的設定檔不再讓請求失敗：** 檔案暫時讀不到時，轉發站會沿用上一份正常的設定；`setup.mjs` 的指令也改成一次寫完整個檔案。
- **經由 `matchModels` 攔截的 `claude-*` 請求會正確改寫模型名稱：** 當帶有 `claude-*`（例如 Claude Code 內部寫死的 `claude-haiku-4-5-20251001`）的請求符合某個供應商的 `matchModels` 時，轉發站現在會把送往上游的 `model` 欄位改寫為該供應商的目標模型，不再原樣送出 `claude-*`。

## [0.5.0] - 2026-10-18

供應商回 429 或 5xx 不再讓你的回合中斷：轉發站在**同一個供應商**上以指數退避自動重試，`Retry-After` 要求更久時以 `retry.maxDelayMs` 為間隔持續輪詢——Claude Code 完全看不到中間的失敗。跨供應商備援改為選配開關。

**升級：** 拉取最新版本即可；同供應商重試預設開啟、免設定。需要調整時用新的 `retry` 設定。

### 新增

- **同一供應商透明重試與退避：** 供應商失敗回應（429、500、502、503、504、529）在原供應商上以 `retry.attempts` 次數、`retry.delayMs` × `retry.backoff` 的間隔退避重試，單次等待受 `retry.maxDelayMs` 上限。`retry.attempts: 0` 為無限重試（打到通或客戶端斷線為止）。設定：`retry`。
- **`Retry-After` 感知：** 供應商要求等待超過 `retry.maxDelayMs` 時，改以該上限為間隔持續輪詢，不提前放棄。設定：`retry.maxDelayMs`。
- **選配跨供應商備援：** 開啟 `retry.failover: true` 後，重試用盡時把原始（未改寫的）請求轉送 `failover.provider`，讓該輪在備援模型上完成，而不是回傳錯誤。設定：`retry.failover`。
- **每供應商重試開關：** `providers.<name>.retry` 可對單一供應商關閉重試（`false`）、跟隨全域設定（`true`，預設），或傳部分物件（如 `{ "attempts": 5 }`）只覆寫個別欄位。設定：`providers.<name>.retry`。

## [0.4.0] - 2026-10-17

輸入 `/provider` 即可在輸入框上方開啟 `AbovePrompt` 互動控制面板：一鍵（或按熱鍵 `1`–`9`）切換單一視窗的模型、即時測試各供應商的回應延遲（`[Ping]`），並在切回 Claude 前提供二次確認以保護長對話快取。英文與繁體中文 README 現在各自擁有獨立的深淺色動態 Banner 與情境動畫圖。

**升級：** 拉取最新版本或執行 `claude plugin update model-relay@model-relay` 即可，無須修改現有設定檔。

### 新增

- **輸入框上方的 `AbovePrompt` 互動控制面板：** 執行 `/provider` 或 `/provider panel` 會在輸入框上方打開互動面板，可直接點選按鈕或按 `ctrl+x tab` 加數字鍵 `1`–`9` 切換模型，並在將已固定的長對話切回 Claude 前提供二次確認防呆。
- **上游供應商即時連線測速（`/__ping` 與 `/provider ping`）：** 可直接從面板點選 `[Ping]` 或輸入 `/provider ping` 即時測試所有供應商的 HTTP 狀態碼與回應時間，並支援透過 `[Retry Claude]` 或 `/provider probe` 重置 429 冷卻計時。
- **中英雙語獨立動態 SVG：** 為英文與繁體中文分別設計專屬的深淺色動態 Banner（`banner-dark.svg`、`banner-light.svg`、`banner-dark.zh-TW.svg`、`banner-light.zh-TW.svg`）以及兩組情境動畫（`relay-flow.svg` / `.zh-TW.svg`、`panel.svg` / `.zh-TW.svg`）。

## [0.3.0] - 2026-10-17

`model-relay` 正式開源為 Claude Code 專用的多供應商本機模型轉發站與 429 自動備援工具。你可以在不中斷工作、不浪費長對話快取的前提下，將單一對話或 `haiku` 子代理靈活分流至 Claude、GLM（`z.ai`）、Gemini（透過本地端 Gateway）、DeepSeek、Kimi、MiniMax 或 OpenRouter。

**升級：** 既有的 `~/.claude/custom-agent.json` 無須修改即可繼續使用。可執行 `node tools/setup.mjs init --fix` 與 `node tools/setup.mjs doctor --ping` 進行全鏈路體檢或遷移至 `~/.claude/model-relay.json`。

### 新增

- **彈性多供應商路由與內建 Presets：** 在 `providers.<name>` 下自由新增任意數量的供應商，內建 `zai`、`glm`、`deepseek`、`kimi`、`minimax`、`openrouter`、`gemini`、`magpie` 預設集，只需填寫 `token` 即可自動帶入最佳的 `baseUrl`、`model`、`matchModels`、`stripToolSearch`、`stripCacheControl` 與 `authHeader`。設定：`providers`。
- **保護快取的 429 自動備援與對話黏著：** 當 Anthropic 回傳 429 額度上限時，自動切換至 `failover.provider` 並將該對話固定 7 天；Claude 額度恢復後只有新對話回到 Claude，避免長對話切回時重建 80 萬+ token 快取而瞬間燒光額度。設定：`failover`。
- **結構化 `/provider` 清單與即時狀態同步：** `/provider` 改為對齊顯示目前所在路由（`●`）與可切換路由（`○`），並直接與轉發站 `/__health` 同步，自動隱藏尚未匯出 `env:VAR_NAME` 金鑰的供應商。
- **一鍵 `doctor` 全鏈路體檢與上游 `--ping` 實測：** 執行 `node tools/setup.mjs doctor --fix --ping` 即可一次檢查設定檔語法、未設定的 `env:VAR` 環境變數、自動將 `ANTHROPIC_BASE_URL` 寫入 `~/.claude/settings.json`、確認本機轉發站健康度，並對每個供應商發送 1-token 真實請求測試連線延遲。
- **本地端 Gateway 自動拉起（`launch`）：** 指向 `127.0.0.1` 或 `localhost` 的供應商可設定 `launch: { command, args }`，當本機連接埠未開啟時由轉發站在背景自動啟動程序。設定：`providers.<name>.launch`。
- **跨平台與中英雙語介面：** 同時支援 Windows（`powershell.exe` + `curl.exe`）與 macOS/Linux（`sh` + `curl`），依 Claude Code 語系設定自動切換繁體中文／英文介面，並附深淺色 Banner 與架構流程 SVG。

### 移除

- **舊版 `custom_agent` 子程序工具：** 移除已棄用的 `claude.exe -p` 子程序包裝程式碼，讓外掛專注於純粹、零額外負擔的 HTTP 模型轉發與對話路由。

[unreleased]: https://github.com/cablate/model-relay/compare/v0.6.0...HEAD
[0.6.0]: https://github.com/cablate/model-relay/compare/v0.5.0...v0.6.0
[0.5.0]: https://github.com/cablate/model-relay/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/cablate/model-relay/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/cablate/model-relay/releases/tag/v0.3.0
