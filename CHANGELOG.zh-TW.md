# 版本紀錄

[English](CHANGELOG.md)

本檔案記錄 `model-relay` 的所有重要變更。格式依據 [Keep a Changelog 1.1](https://keepachangelog.com/en/1.1.0/)，版號遵循 [語意化版本](https://semver.org/)（`0.x` 階段的次版號可能包含不相容變更），並以 `.claude-plugin/plugin.json` 的版號為準。

## [未發布]

## [0.7.3] - 2026-10-22

跑在其他供應商上的子代理（GLM、DeepSeek、Gemini、GPT…）又能穩定使用 `WebFetch` 與你的 MCP 工具；過去在某些設定下，這些工具可能會缺少。

### 修正

- **第三方供應商上的按需載入工具：** Claude Code 需要時才載入的工具（如 `WebFetch`、MCP 工具）在第三方供應商上可以正常使用，子代理和主對話都適用。過去在某些設定下可能無法使用。

### 移除

- **`providers.<name>.stripToolSearch`：** 已不需要；`model-relay.json` 裡留著也會被忽略。

## [0.7.2] - 2026-10-22

每個供應商的 `model-relay:<name>` 子代理現在可以在 `~/.claude/model-relay.json` 調整：寫清楚 Claude 什麼時候該派它，並給它自己的提示詞、工具與 effort。

### 新增

- **每個供應商的子代理設定（`providers.<name>.agent`）：** 每個供應商的 `model-relay:<name>` 子代理現在可以在 `~/.claude/model-relay.json` 自訂 `description`（Claude 決定派哪個子代理時讀的那一行）、`prompt`、`tools`、`effort`、`maxTurns` 等 agent 定義檔欄位；`name` 與 `model` 一律是該供應商的。

## [0.7.1] - 2026-10-22

讓自訂狀態列（例如 [coralline](https://github.com/Nanako0129/coralline) 的 `relay` segment）能直接顯示每個 Claude Code 視窗實際連線的模型與分流狀態，並預設收起輸入框上方的外掛黃字狀態列，畫面不再重複佔位。

**⚠️ 還在用 0.6.0 或更早版本（`< 0.7.0`）？請務必立即升級並完成設定轉換：**
- **為什麼 `< 0.7.0` 必須更新：** `0.7.0` 以前的版本在 HTTPS proxy 模式（`proxy enable`）下切到非 Claude 供應商時，第二輪起會遺失歷史對話與工具定義；同時存在瀏覽器網頁可偷連本機盜用 API 額度的安全漏洞。
- **從 `0.7.0` 升級：** 執行 `claude plugin update model-relay@model-relay` 即可，外掛會在轉發站閒置時自動重啟背景程序。
- **從 `0.6.0` 或更早版本升級（必做三步驟——只更新外掛不會生效）：**
  1. 執行 `claude plugin update model-relay@model-relay`。
  2. 將設定檔轉換為 `"format": 2`：在 Claude Code 輸入 `/provider setup upgrade my model-relay config`（或在外掛資料夾執行 `node tools/setup.mjs migrate --go`）。
  3. 趁沒有視窗正在回覆時執行 `/provider restart`。*（完整說明見 [UPGRADING.zh-TW.md](https://github.com/cablate/model-relay/blob/main/UPGRADING.zh-TW.md)。）*

### 新增

- **每個視窗寫出獨立狀態檔，供自訂 statusline 直接讀取（`model-relay-status/<session id>`）：** Claude Code 內建傳給 `statusLine` 的資料永遠顯示轉發前原本的 Claude 模型名稱。現在每個視窗在路由改變（或執行 `/clear`）時，都會把真實轉發狀態寫進 `~/.claude/model-relay-status/<session id>`，格式為單行 `kind<TAB>label`（`claude`、`pinned`、`failover`、`limit`、`offline`、`direct`），讓 [coralline](https://github.com/Nanako0129/coralline) 等狀態列工具用一行 shell `read` 就能直接顯示。超過 7 天未更新的檔案會由背景轉發站自動清理。

### 變更

- **輸入框上方的外掛黃字狀態列改為預設關閉（`statusBar`）：** 為保持輸入區乾淨、避免與自訂 statusline 重複顯示，外掛狀態列（`$.ui.status`）改為選用開啟。需要時可隨時執行 `node tools/setup.mjs set statusBar on`（或在 `model-relay.json` 設定 `"statusBar": true`）恢復顯示；切換模型、升級提醒與轉發站離線仍會正常跳出通知。

## [0.7.0] - 2026-10-21

**⚠️ 強烈建議所有使用者立即升級（修復對話失憶與工具遺失 Bug ＋ 堵住本機額度盜用漏洞）：**
- **修復 HTTPS proxy 模式（`proxy enable`）下聊到一半「失憶」與弄丟工具的重大 Bug：** 切到非 Claude 供應商的視窗現在每一輪都會送出完整對話，不再只送只有 Anthropic 伺服器才接得上的差異片段。
- **修補本機安全漏洞：** 阻擋瀏覽器開啟的網頁偷連 `127.0.0.1` 盜用你的供應商額度或竄改分流設定。
- **日常操作全面精簡：** `/provider` 切換只回一行確認、選完模型面板自動收起，`/provider ping` 會直接告訴你連不上的具體原因（金鑰被拒、模型名稱錯誤、額度用盡、本機服務沒開）。

**升級（必做——只更新外掛不會生效）：**
0.7 版只讀取格式 2（`"format": 2`）設定檔。從 0.6 或更早版本升上來，**必須**完成以下三步，否則新版轉發站不會接手（背景會繼續跑有 Bug 的 0.6 舊轉發站，或全部退回直連 Claude）：
1. **更新外掛：** `claude plugin update model-relay@model-relay`。
2. **轉換設定檔（必做）：** 在 Claude Code 輸入 `/provider setup upgrade my model-relay config`（或在外掛資料夾執行 `node tools/setup.mjs migrate --go`），會自動備份舊檔並保留你原有的所有分流規則。
3. **重啟轉發站（必做）：** 趁沒有對話正在回覆時，執行 `/provider restart`，把背景的 0.6 舊轉發站換成 0.7 新版。
*（完整說明見 [UPGRADING.zh-TW.md](https://github.com/cablate/model-relay/blob/main/UPGRADING.zh-TW.md)。）*

### 新增

- **在 Claude Code 裡直接讓 AI 帶你完成設定與升級（`/provider setup [goal]`）：** 在任何資料夾都能直接執行 `/provider setup`（連設定檔都還沒有時也能用），Claude 會一步步帶你跑完 `setup.mjs`——套用前先預覽差異、改 `~/.claude/settings.json` 前先徵求同意，而且絕不會要你在對話視窗裡貼上 API 金鑰。
- **測試供應商時直接指出哪裡出問題（`/provider ping`）：** `/provider ping`、面板熱鍵 `p` 與 `doctor --ping` 現在會送出 1 token 的串流測試（上限 15 秒），並明確區分結果：正常可用、金鑰被拒、模型名稱錯誤、額度用盡或被限流、本機服務未啟動、無法連線、連線逾時。測試延遲獨立存在 `ping` 欄位，不與真實請求的 `stats` 混算（避免長文回覆讓供應商看起來很慢），且上游錯誤訊息中的 API 金鑰會自動遮罩。
- **在對話視窗內一鍵重啟背景轉發站（`/provider restart`）：** `/provider restart` 與 `setup.mjs restart [--if-stale] [--if-idle]` 可將背景轉發站換成目前外掛的版本。`/__health` 現在會回報 `version`、`inflight`（處理中的請求數）與 `tunnels`（開啟中的 `CONNECT` 通道數），讓外掛之後能在轉發站完全閒置時自動重啟舊版。
- **`model-relay:<name>` 子代理沒走轉發站時主動提醒：** 當 Claude Code 用別的模型啟動 `model-relay:<name>` 子代理，或子代理結束時轉發站根本沒收到該模型的請求（透過 `/__health` 的 `seenModels` 比對），外掛會跳出通知並引導你執行 `/provider doctor` 排查。
- **一行指令更換轉發站連接埠（`setup.mjs set port <n>`）：** 將連接埠改為 `1025`–`65535`、自動留存 `.model-relay-backup` 備份，並同步更新 `settings.json`（`ANTHROPIC_BASE_URL` 或 `HTTPS_PROXY`）。若目標連接埠已被佔用會直接拒絕；舊轉發站的 PID 會印在畫面上讓你自行決定何時關閉。
- **機器可讀的健康檢查輸出（`doctor --json`）：** 與文字版檢查項目相同，每筆結果包含 `id`、對應的 `setup.mjs` 修復參數 `fix`，以及會修改使用者設定時標記的 `needsConsent`。環境變數未設定的金鑰會回報為 `missing-key`（只列變數名、不印機密值），舊版設定檔則回報為 `outdated` 並指向 `migrate --go`。
- **設定格式 2（`"format": 2`）：** 由 `init`、`add` 與 `migrate --go` 寫入，讓所有分流規則都明確寫在檔案裡。若偵測到舊設定檔（`custom-agent.json` 或沒有 `"format": 2` 的 `model-relay.json`），外掛不會動正在跑的 0.6 轉發站（沒在跑則直連 Claude），並在狀態列、面板與 [UPGRADING.zh-TW.md](https://github.com/cablate/model-relay/blob/main/UPGRADING.zh-TW.md) 提醒你升級。
- **`doctor` 會在背景轉發站版本比外掛舊時發出警告。**
- **`/__health` 回報 `configDir`：** 標明轉發站是讀取哪個設定資料夾啟動的（以真實路徑比對，Windows 不分大小寫），讓 `doctor`、`proxy` 與外掛不會誤連其他設定檔啟動的轉發站。
- **真實環境發版前測試腳本（`tools/smoke.mjs`）：** 發版前在臨時連接埠啟動轉發站，透過真實的 `claude` CLI 送出請求驗證（加上 `--provider <name>` 可連同供應商一起實測）。
- **CI 自動跑外掛邏輯測試與中性命名守門：** `hooks/logic.test.ts` 直接在 Node 環境下跑 CI；`tools/neutral.mjs` 會在舊版遷移區塊以外發現寫死的供應商名稱、私人 Gateway 位址或 0.6 舊檔名時攔截失敗。

### 變更

- **`/provider` 回覆精簡為一行，面板專心負責切換模型：** 輸入 `/provider <name>` 或 `/provider claude` 現在只回一行確認，不再每次倒出 20 多行的完整狀態報告與指令表。單獨輸入 `/provider` 只打開面板（選完模型自動收起，只有在轉發站離線或 429 冷卻中才顯示提示）；會影響所有視窗的共用開關（429 備援、失敗重試、Remote Control）與模型別名都收進「設定 `[s]`」。要看文字版狀態改用 `/provider status`，查指令說明改用 `/provider help`。
- **不相容變更（影響 0.6 及更早版本）：舊設定檔需先執行 `migrate --go`。** 0.7 轉發站不再讀取 `custom-agent.json` 或缺少 `"format": 2` 的 `model-relay.json`（`doctor` 會顯示 `outdated`）。執行 `node tools/setup.mjs migrate --go` 會將設定檔轉為格式 2，並把 0.6 以前在背景偷偷幫你補上的所有預設值（preset 預設模型、舊 `zai`／`glm` preset 自動攔截 `haiku`、舊 `gemini`／`magpie` 的 Gateway 位址、從供應商名稱猜測的參數、預設 429 備援名單）全部明確寫進檔案，確保升級前後的分流行為 100% 一致。詳見 [UPGRADING.zh-TW.md](https://github.com/cablate/model-relay/blob/main/UPGRADING.zh-TW.md)。
- **其他 `setup.mjs` 子指令不再自動夾帶格式轉換：** `set`、`add`、`remove`、`alias`、`providers`、`init`、`restart`、`rc` 與 `proxy enable` 遇到舊設定檔時會直接拒絕並請你先跑 `migrate`，不再像以前跑 `set` 時順手改寫設定結構。
- **格式 2 不再有任何隱藏的預設分流：** 內建 preset（`zai`、`deepseek`、`kimi`、`minimax`、`openrouter`）只提供 API 網址與相容開關，`model` 一律由你指定；移除舊的 `glm`、`gemini`、`magpie` preset；沒有設定別名時不會再有 preset 自動攔截 `haiku`；`failover.chain` 為空時遇到 429 直接回傳原錯誤；不再根據供應商名稱猜測任何參數。
- **`setup.mjs add <name> --model <model id> --token <token|env:VAR> (--preset <preset> | --url <address>)` 強制檢查必填參數並保留自訂欄位：** 漏填參數時不再自己亂編 `<name>-default` 或 `api.example.com`；修改既有供應商時只更新網址、金鑰與模型（不會洗掉你的重試等自訂設定），修改前自動留存 `.model-relay-backup` 備份，遇到損毀無法解析的設定檔則拒絕覆寫。新設定檔加入的第一個供應商會自動設為 429 備援對象。
- **`presets` 只列出各服務的 API 網址，** 不再綁定預設模型。
- **`/__ping` 將測試延遲獨立存放在 `ping`，不再覆蓋真實請求的 `stats`：** 還在跑 0.6 外掛的 Claude Code 視窗重啟後即可看到獨立的測試時間。
- **檔名統一為 `model-relay*`：** 設定、狀態、日誌與備份檔統一為 `model-relay.json`、`model-relay-state.json`、`model-relay.log`、`model-relay-requests.log` 與 `*.model-relay-backup`。0.6 的 `custom-agent*` 舊檔名（`custom-agent.json`、`custom-agent-state.json`、`custom-agent-router.log`、`custom-agent-requests.log`）在執行 `migrate --go` 時會自動改名。
- **`init` 改為建立空白的格式 2 設定檔，不再複製範例供應商：** 全新安裝在還沒設定供應商之前，所有請求都會安全直連 Claude，`doctor` 也會清楚引導下一步怎麼加供應商，而不是直接報錯。
- **外掛改為只從執行中的轉發站讀取供應商清單與狀態：** 外掛在磁碟上只讀 `port` 與 `nodePath`，避免面板顯示或切換到轉發站實際上根本沒載入的模型。
- **`model-relay.example.json`、README 與架構圖改用中性範例名稱，不再寫死特定供應商。**
- **轉發站連接埠被佔用時寫明原因：** 遇到 `EADDRINUSE` 時，只有當佔用該埠的轉發站服務的是同一個設定資料夾才安靜退出；若是其他設定資料夾或未知程式佔用，會把衝突連接埠與對方目錄寫進 `model-relay.log` 並以非零狀態碼結束。
- **`doctor` 與 `proxy` 指令會辨識並攔截「別人的轉發站」：** 當連接埠上的轉發站屬於其他設定資料夾時，`doctor` 與 `proxy status` 會發出警告，`proxy enable|renew` 會在修改任何設定前直接拒絕並印出雙方的資料夾路徑。
- **外掛不會把請求送進其他設定資料夾的轉發站：** 若連接埠上的轉發站屬於別的設定資料夾，當前視窗會改為直連 Claude，並在狀態列標示對方的資料夾路徑。
- **補齊 README 常見問題與運作邊界說明：** 寫明 `tools/setup.mjs` 的安裝位置、`env:VAR` 金鑰如何讀取轉發站啟動時的環境變數、為什麼只有 `ANTHROPIC_BASE_URL` 模式有自動直連退路、`HTTPS_PROXY` 對 `git`／`curl`／`gh` 的影響、`proxy.enabled` 實際攔截的範圍、CI 測試涵蓋範圍，以及完整解除安裝步驟。

### 修正

- **HTTPS proxy 模式下非 Claude 供應商聊到一半「失憶」、看不到歷史對話與工具：** 在 HTTPS proxy 模式下，Claude Code 以為自己直連 `api.anthropic.com`，於是開啟 `message-threads` beta——把前文存在 Anthropic 伺服器上，後續每輪只送最新一句話，連系統提示詞與工具定義都省略。第三方供應商沒有這份雲端對話紀錄，只收到沒頭沒尾的一句話，才會回答「這是新對話」或「我無法存取你的本機檔案」。現在轉發站遇到要送往非 Claude 供應商的請求時，會拒絕 `message-threads` beta（請求日誌記為 `<provider>-thread-refused`），讓 Claude Code 當場改送包含完整前文與工具的請求。（`ANTHROPIC_BASE_URL` 模式本來就不會啟用此 beta，不受影響。）
- **剛裝好還沒填金鑰時連 Claude 都不能用：** 以前沒有任何可用供應商時轉發站會回傳 HTTP 500 `"config missing"`，導致新安裝連 Claude 都打不通；現在會把所有請求直接交給 Claude。
- **名稱設為 `zai` 的供應商永遠不會被用到：** 以前轉發站內部把 `glm` 與 `zai` 互相轉寫，導致設為 `zai` 的路由被改寫成 `glm`。現在所有供應商一律使用設定檔裡自己的名稱分流與記錄日誌。
- **API 金鑰不小心帶了換行等非法標頭字元時，執行 `/provider ping` 不再讓轉發站當掉：** 會攔下並回報錯誤訊息，且不會把金鑰印出來。
- **`doctor --fix` 不再覆蓋指向其他服務的 `ANTHROPIC_BASE_URL`：** 若你的 `settings.json` 原本指向別的 Gateway，現在會保留原設定並告知你。
- **轉發站啟動失敗時主動跳出通知：** 以前只會在狀態列默默顯示 `"Relay offline"`（轉發站離線）並退回直連 Claude，現在會跳出通知告訴你去哪個 `model-relay.log` 看失敗原因。
- **`/provider ping` 不再等 10 秒就提早放棄：** 改為等待轉發站完整的測試時限，讓需要轉發站自動喚醒的本機 Gateway 有足夠時間啟動並回應。
- **輸入 `/provider constructor` 等 JavaScript `Object.prototype` 內建屬性名稱時，外掛不再誤判為有效的供應商。**
- **當 `~/.claude/settings.json` 的 `availableModels` 漏列供應商模型時，`doctor` 會主動提醒：** 若沒列進去，Claude Code 派發 `model-relay:<name>` 子代理時會默默改用 `CLAUDE_CODE_SUBAGENT_MODEL` 或主對話模型，只在 debug log 留一行警告，導致子代理根本沒走轉發站。
- **串流中途斷線或按 `Esc` 取消時，前後端連線都能乾淨收尾：** 上游串流中途斷線時，轉發站會立即切斷呼叫端連線，不再讓 Claude Code 卡死乾等（開啟重試時也不會因連線重置而當掉）；在 Claude Code 按 `Esc` 取消回覆時，轉發站也會同步中斷上游請求，不再讓供應商繼續空燒 token。
- **啟動轉發站之後才 `export` 的 `env:VAR` 金鑰變數，現在會明確提示需重啟：** 轉發站讀的是它啟動當下的環境變數，事後在 shell 補設金鑰在重啟轉發站前不會生效，但以前在 shell 跑 `doctor` 卻會顯示 `"Config OK"`。現在 `/__health` 會列出未解析的變數名 `unresolved`（絕不印出金鑰值），當 `doctor` 發現你的 shell 有變數而執行中的轉發站沒有時，會直接提醒你重啟轉發站。
- **首次執行 `proxy enable --go` 不再因 `"unable to get local issuer certificate"` 自測失敗：** 以前轉發站會把「憑證不存在」快取 10 秒，若外掛的健康檢查剛好在建立憑證前觸發快取，自測連線就會被直接穿隧送到 Anthropic 而非使用新憑證回應。現在不再快取「憑證不存在」的狀態。
- **`init --fix` 不再寫死連接埠 `8950`，改為讀取設定檔中實際設定的連接埠。**
- **當設定檔裡所有 `env:` 金鑰變數都還沒設定時，轉發站仍會遵守設定檔的連接埠與 `proxy.enabled` 開關，** 不再退回綁定 `8950` 或對外開放任意 `CONNECT` 連線。
- **`model-relay.log` 現在與 `model-relay-requests.log` 一樣超過 5 MB 自動清空，** 不再無限膨脹。
- **在任何資料夾都能直接跑 `/provider init` 與 `/provider doctor [--ping]`：** 用 `claude plugin install` 安裝外掛後，不必再自己找外掛安裝路徑 `cd` 進去跑 `node tools/setup.mjs …`。
- **`claude plugin update` 更新外掛後不再放任舊轉發站一直跑：** 升上 0.7 之後，未來更新外掛時只要轉發站的 `inflight` 與 `tunnels` 歸零，外掛就會自動重啟轉發站套用新版。（0.6 以前的轉發站無法回報閒置狀態，狀態列會提醒你手動執行 `/provider restart`。）
- **`proxy enable` 與 `proxy renew` 不再蓋掉你原有的 `NODE_EXTRA_CA_CERTS`：** 若你的環境或 `settings.json` 已經設了自訂憑證（例如公司內網憑證），現在會事前攔截並印出原有路徑，不會默默覆蓋導致公司網路斷線。
- **`proxy renew --go` 換發憑證後立即生效：** 轉發站不再沿用舊憑證快取 10 秒，解決了剛換完憑證時自我測試失敗的問題。

### 安全性

- **阻擋瀏覽器網頁偷連本機轉發站消耗你的供應商額度：** 以前轉發站接受任何連往 `127.0.0.1` 的請求，瀏覽器中打開的惡意網頁只要送一個簡單的 `text/plain` POST 到 `/v1/messages`（或透過 DNS rebinding），就能盜用你的供應商額度，甚至呼叫 `/__session`、`/__probe` 與 `/__ping`。現在轉發站遇到帶有瀏覽器標頭（`Origin` 或 `Sec-Fetch-Site`）、`Host` 不是轉發站連接埠上的 `127.0.0.1`／`localhost`，或使用絕對網址的請求，一律回傳 HTTP 403 拒絕。（`api.anthropic.com` 代理通道內的請求不受影響。）
- **防範供應商與對話名稱的原型鏈污染（Prototype Pollution）：** `constructor`、`toString`、`__proto__` 等 JavaScript 物件內建屬性名稱不再被當成已設定的供應商，透過 `/__session` 傳入也不會再讓轉發站當掉。

### 未涵蓋

- **上游伺服器卡住但未斷開 TCP 連線時，轉發站不設獨立的閒置逾時：** 交由 Claude Code 自身的請求逾時機制處理。
- **HTTPS proxy 模式下，呼叫端中途放棄非模型請求時，不會主動切斷上游連線。**
- **子代理的委派提示詞尚未調整，** 待後續基準測試後再評估。
- **`model-relay.json` 尚無 JSON Schema 與獨立欄位參考文件。**
- **尚未支援串接上游（公司內網）Proxy。**

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

[unreleased]: https://github.com/cablate/model-relay/compare/v0.7.2...HEAD
[0.7.2]: https://github.com/cablate/model-relay/compare/v0.7.1...v0.7.2
[0.7.1]: https://github.com/cablate/model-relay/compare/v0.7.0...v0.7.1
[0.7.0]: https://github.com/cablate/model-relay/compare/v0.6.0...v0.7.0
[0.6.0]: https://github.com/cablate/model-relay/compare/v0.5.0...v0.6.0
[0.5.0]: https://github.com/cablate/model-relay/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/cablate/model-relay/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/cablate/model-relay/releases/tag/v0.3.0
