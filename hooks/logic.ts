import type { PanelData, PingStat, ProviderStat } from '../types'

// What the hook takes from the config file: where the router listens and which node runs it. Providers, aliases and the
// failover chain come from the router's /__health only, so the plugin never second-guesses how the router reads a config.
// outdated: the file is from an older version, which this version's router does not read (no "format": 2, or the older
// file name); the hook then starts and replaces no router, so a router that still reads it keeps working until migrate
export interface LocalCfg {
  port: number
  nodePath: string
  outdated: boolean
}

export const CONFIG_NAME = 'model-relay.json'
// legacy:begin the file name of 0.6.0 and earlier, read for its port and node only
export const OLD_CONFIG_NAME = 'custom-agent.json'
// legacy:end

export function parseLocal(raw: unknown, oldName = false): LocalCfg | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null
  const r = raw as Record<string, unknown>
  const port = typeof r.port === 'number' && Number.isInteger(r.port) && r.port > 1024 && r.port < 65536 ? r.port : 8950
  const nodePath = typeof r.nodePath === 'string' && r.nodePath.length > 0 ? r.nodePath : 'node'
  return { port, nodePath, outdated: oldName || r.format !== 2 }
}

export function outdatedText(lang: 'zh' | 'en' = 'zh'): string {
  return lang === 'en'
    ? 'Config from an older version, not read by this one: run /provider setup upgrade my model-relay config'
    : '設定檔是舊版格式，這一版不讀它：執行 /provider setup 升級我的 model-relay 設定'
}

// A name typed by a person is looked up as an own key only: "constructor" is not a provider
export const has = (o: Record<string, unknown>, k: string) => Object.hasOwn(o, k)

const cells = (ch: string) => ((ch.codePointAt(0) ?? 0) >= 0x1100 ? 2 : 1)

// Cuts text to a terminal width in cells (CJK counts two), ending in … when it had to cut
export function fit(s: string, width: number): string {
  const text = s.replace(/\s+/g, ' ').trim()
  let used = 0
  let out = ''
  for (const ch of text) {
    const w = cells(ch)
    if (used + w > width - 1) return `${out}…`
    used += w
    out += ch
  }
  return out
}

// ---- local router ----

export function curlBin(isWin = true): string {
  return isWin ? 'C:/Windows/System32/curl.exe' : 'curl'
}

export const routerUrl = (cfg: LocalCfg) => `http://127.0.0.1:${cfg.port}`

const healthUrl = (cfg: LocalCfg, sid: string) => `${routerUrl(cfg)}/__health?sid=${encodeURIComponent(sid)}`

export function healthArgv(cfg: LocalCfg, sid: string, isWin = true): string[] {
  return [curlBin(isWin), '-s', '-m', '2', healthUrl(cfg, sid)]
}

export function healthWaitArgv(cfg: LocalCfg, sid: string, isWin = true): string[] {
  return [curlBin(isWin), '-s', '-m', '2', '--retry', '6', '--retry-connrefused', '--retry-delay', '1', healthUrl(cfg, sid)]
}

export function sessionArgv(cfg: LocalCfg, sid: string, on: string, isWin = true): string[] {
  return [curlBin(isWin), '-s', '-m', '3', '-X', 'POST', '-H', 'content-type: application/json', '-d', JSON.stringify({ sid, on }), `${routerUrl(cfg)}/__session`]
}

// The router tests each provider for up to 15 s, after waiting up to 10 s for a local one it starts itself
export const PING_LIMIT_S = 30

export function pingArgv(cfg: LocalCfg, provider = '', isWin = true): string[] {
  return [curlBin(isWin), '-s', '-m', String(PING_LIMIT_S), '-X', 'POST', '-H', 'content-type: application/json', '-d', JSON.stringify({ provider }), `${routerUrl(cfg)}/__ping`]
}

export function probeArgv(cfg: LocalCfg, isWin = true): string[] {
  return [curlBin(isWin), '-s', '-m', '3', '-X', 'POST', `${routerUrl(cfg)}/__probe`]
}

const pluginBase = (pluginRoot: string) => pluginRoot.replace(/[\\/]\.claude-plugin[\\/]?$/, '').replace(/\\/g, '/')

export const routerScript = (pluginRoot: string) => `${pluginBase(pluginRoot)}/router/router.js`

export const setupScript = (pluginRoot: string) => `${pluginBase(pluginRoot)}/tools/setup.mjs`

export type Toggle = 'failover' | 'retry' | 'proxy'

// The panel and `/provider` subcommands change settings through the same CLI a person would use
export function toggleArgv(cfg: LocalCfg, script: string, which: Toggle, on: boolean): string[] {
  if (which === 'proxy') return [cfg.nodePath, script, 'proxy', on ? 'enable' : 'disable', '--go']
  return [cfg.nodePath, script, 'set', which === 'failover' ? 'failover.enabled' : 'retry.enabled', on ? 'on' : 'off']
}

// The turn /provider setup hands to the model: where the CLI is, what the person asked for, and the rules that keep keys and settings safe.
export function setupBrief(script: string, nodePath: string, goal: string, hasCfg: boolean, lang: 'zh' | 'en'): string {
  const cli = `"${nodePath}" "${script}"`
  return [
    lang === 'en'
      ? 'Help me set up the model-relay plugin for Claude Code. Reply in English.'
      : '請幫我設定 Claude Code 的 model-relay 外掛，用繁體中文（台灣）回覆。',
    goal ? `What I want: ${goal}` : 'What I want: a working setup with one provider; ask me which provider if it is not clear.',
    '',
    `The setup CLI is ${cli} (run it by this absolute path; it is not in the current folder). Run it with no arguments for usage, and "presets" for the built-in providers.`,
    hasCfg
      ? `A config already exists. Start with ${cli} doctor --json and ${cli} providers to see the current state; a finding's "fix" is the arguments to run this CLI with, and "needsConsent" means ask me first.`
      : `There is no config yet. Start with ${cli} presets, then create it with "init --fix" and "add <name> --preset <preset> --model <model id> --token env:<VAR>" (or --url for any other Anthropic-compatible address). Ask me which model I want; there is no default.`,
    '',
    'Rules:',
    '- Never ask me to paste an API key into this chat, and never print one. Use "env:VAR_NAME" tokens; tell me which variable to set, how to make it permanent on my OS, and that Claude Code must be restarted to see it.',
    '- Commands that accept --go (migrate, remove, proxy): run without --go first, show me the result, and add --go only after I agree.',
    '- Tell me before anything changes ~/.claude/settings.json (init --fix, doctor --fix, alias, proxy) and wait for my yes.',
    `- If doctor lists the "outdated" finding, my config is from an older version: follow ${script.replace(/tools\/setup\.mjs$/, 'UPGRADING.md')} step by step.`,
    `- Finish with ${cli} doctor --ping and tell me in plain words what works, what does not, and what I still have to do.`,
  ].join('\n')
}

export function setupCliArgv(cfg: LocalCfg, script: string, cliArgs: string[]): string[] {
  return [cfg.nodePath, script, ...cliArgs]
}

// Detaches the router process on both Windows and POSIX platforms.
export function startArgv(cfg: LocalCfg, script: string, configDir: string, isWin = true): string[] {
  if (isWin) {
    const q = (s: string) => `'${s.replace(/'/g, "''")}'`
    return [
      'powershell.exe',
      '-NoProfile',
      '-Command',
      `Start-Process -WindowStyle Hidden -FilePath ${q(cfg.nodePath)} -ArgumentList @(${q(`"${script}"`)}, ${q(`"${configDir}"`)})`,
    ]
  }
  const shQuote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`
  return ['sh', '-c', `nohup ${shQuote(cfg.nodePath)} ${shQuote(script)} ${shQuote(configDir)} >/dev/null 2>&1 &`]
}

export interface Health {
  session: string // 'claude' or a configured provider key
  failoverSince: number
  nextClaudeTry: number
  sessionsOnCustom?: number
  providers: Record<string, string> // provider name -> model id; empty when none is usable
  aliases: Record<string, string>
  failoverProvider?: string // absent when failover has nobody to hand over to
  failoverChain: string[]
  configDirs?: string[] // the directory this router serves, as it resolves it and as it was given; absent on older routers
  version?: string // the plugin version the router's code came from; absent on 0.6.0 and earlier
  inflight?: number // model and passthrough requests being answered right now; absent on 0.6.0 and earlier
  tunnels?: number
  stats?: Record<string, ProviderStat> // the last real request per provider
  ping?: Record<string, PingStat> // the last test per provider; absent on older routers
  seenModels?: Record<string, number> // when each model id last reached the router; absent on older routers
  unresolved: { provider: string; env: string }[] // providers skipped because their env:VAR is unset for the router
  // What the router is doing right now; absent when it predates the switches
  switches?: { failover: boolean; retry: boolean; proxy: boolean; proxyReady: boolean }
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

export function parseHealth(stdout: string): Health | null {
  try {
    const j = JSON.parse(stdout) as Record<string, unknown>
    if (!isObj(j) || j.ok !== true) return null
    const num = (v: unknown) => (typeof v === 'number' ? v : 0)
    const str = (v: unknown) => (typeof v === 'string' && v.length > 0 ? v : '')
    const lowerMap = (v: unknown, lowerValues: boolean) => {
      const out: Record<string, string> = {}
      if (isObj(v)) for (const [k, x] of Object.entries(v)) if (str(x)) out[k.toLowerCase()] = lowerValues ? str(x).toLowerCase() : str(x)
      return out
    }
    const stats: Record<string, ProviderStat> = {}
    if (isObj(j.stats)) {
      for (const [k, v] of Object.entries(j.stats)) if (isObj(v)) stats[k.toLowerCase()] = { status: num(v.status), ms: num(v.ms), at: num(v.at) }
    }
    let ping: Record<string, PingStat> | undefined
    if (isObj(j.ping)) {
      ping = {}
      for (const [k, v] of Object.entries(j.ping)) {
        if (isObj(v) && str(v.verdict)) ping[k.toLowerCase()] = { verdict: str(v.verdict), status: num(v.status), firstByteMs: num(v.firstByteMs), at: num(v.at), detail: str(v.detail) }
      }
    }
    let seenModels: Record<string, number> | undefined
    if (isObj(j.seenModels)) {
      seenModels = {}
      for (const [k, v] of Object.entries(j.seenModels)) if (typeof v === 'number') seenModels[k.toLowerCase()] = v
    }
    const failoverProvider = str(j.failoverProvider).toLowerCase()
    const failoverChain = Array.isArray(j.failoverChain) ? j.failoverChain.map(str).filter(Boolean).map((n) => n.toLowerCase()) : []
    const configDirs = [j.configDir, j.configDirArg].map(str).filter(Boolean)
    const conf = isObj(j.config) ? j.config : null
    const px = isObj(j.proxy) ? j.proxy : null
    const switches = conf && typeof conf.failoverEnabled === 'boolean' && typeof conf.retryEnabled === 'boolean' && typeof conf.proxyEnabled === 'boolean'
      ? { failover: conf.failoverEnabled, retry: conf.retryEnabled, proxy: conf.proxyEnabled, proxyReady: px?.certificate === true }
      : undefined
    const unresolved = Array.isArray(j.unresolved)
      ? j.unresolved.filter(isObj).map((u) => ({ provider: str(u.provider), env: str(u.env) })).filter((u) => u.provider)
      : []
    return {
      session: str(j.session).toLowerCase() || 'claude',
      failoverSince: num(j.failoverSince),
      nextClaudeTry: num(j.nextClaudeTry),
      sessionsOnCustom: num(j.sessionsOnCustom),
      providers: lowerMap(j.providers, false),
      aliases: lowerMap(j.aliases, true),
      ...(failoverProvider ? { failoverProvider } : {}),
      failoverChain,
      ...(configDirs.length > 0 ? { configDirs } : {}),
      ...(str(j.version) ? { version: str(j.version) } : {}),
      ...(typeof j.inflight === 'number' ? { inflight: j.inflight } : {}),
      ...(typeof j.tunnels === 'number' ? { tunnels: j.tunnels } : {}),
      stats,
      ...(ping ? { ping } : {}),
      ...(seenModels ? { seenModels } : {}),
      unresolved,
      ...(switches ? { switches } : {}),
    }
  } catch {
    return null
  }
}

// One line per thing the person should act on: an older config, a provider the router skips
export function healthHints(h: Health | null, lang: 'zh' | 'en', outdated = false): string[] {
  const en = lang === 'en'
  const out = outdated ? [outdatedText(lang)] : []
  for (const u of h ? h.unresolved : []) {
    out.push(en
      ? `${u.provider} is skipped: ${u.env ? `the relay was started without ${u.env}` : 'its token "env:" names no variable'}`
      : `${u.provider} 被略過：${u.env ? `轉發站啟動時沒有 ${u.env}` : '它的 token「env:」沒寫變數名稱'}`)
  }
  return out
}

export function buildPanelData(h: Health | null, port: number, direct: boolean, lang: 'zh' | 'en', now: number, outdated = false): PanelData {
  return {
    online: Boolean(h),
    direct,
    port,
    session: h?.session ?? 'claude',
    failoverProvider: h?.failoverProvider ?? null,
    failoverSince: h?.failoverSince ?? 0,
    nextClaudeTry: h?.nextClaudeTry ?? 0,
    sessionsOnCustom: h?.sessionsOnCustom ?? 0,
    providers: h?.providers ?? {},
    aliases: h?.aliases ?? {},
    failoverChain: h?.failoverChain ?? [],
    switches: h?.switches ?? null,
    stats: h?.stats ?? {},
    ping: h?.ping ?? {},
    hints: healthHints(h, lang, outdated),
    lang,
    now,
  }
}

// The directory of a router that answers on our port but serves a different config dir; null when it is ours.
// A router that reports no directory is an older relay and still counts as ours.
export function foreignConfigDir(h: Health | null, myDir: string, isWin = true): string | null {
  if (!h || !h.configDirs || h.configDirs.length === 0) return null
  const key = (d: string) => {
    const s = d.replace(/\\/g, '/').replace(/\/+$/, '')
    return isWin ? s.toLowerCase() : s
  }
  return h.configDirs.some((d) => key(d) === key(myDir)) ? null : h.configDirs[0]!
}

// -1, 0 or 1 for dotted numeric versions; a missing part counts as 0
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map((n) => parseInt(n, 10) || 0)
  const pb = b.split('.').map((n) => parseInt(n, 10) || 0)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (d !== 0) return d < 0 ? -1 : 1
  }
  return 0
}

// The router runs older code than this plugin: one from 0.6.0 or earlier (no configDir) or a lower version. A newer router is
// left alone, so two sessions on different plugin versions never take turns restarting it.
export function routerIsStale(h: Health | null, pluginVersion: string): boolean {
  if (!h) return false
  if (!h.configDirs || h.configDirs.length === 0) return true
  if (!h.version || !pluginVersion) return false
  return compareVersions(h.version, pluginVersion) < 0
}

export function staleStatusText(lang: 'zh' | 'en' = 'zh'): string {
  return lang === 'en'
    ? 'The relay runs older code; run /provider restart when no reply is in progress'
    : '轉發站還在跑舊版程式；沒有回覆進行中時執行 /provider restart 更新'
}

export function foreignStatusText(dir: string, lang: 'zh' | 'en' = 'zh'): string {
  return lang === 'en'
    ? `Port is held by another relay (config dir ${dir}): connected directly to Claude`
    : `連接埠被另一個轉發站（設定目錄 ${dir}）佔用：主線暫時直連 Claude`
}

// The router was started and did not answer: say where its own log explains why, once per outage
export function startFailedText(configDir: string, lang: 'zh' | 'en' = 'zh'): string {
  return lang === 'en'
    ? `The relay did not start, so this session talks to Claude directly; the reason is in ${configDir}/model-relay.log (or run /provider doctor)`
    : `轉發站沒有啟動，這個對話暫時直連 Claude；原因記在 ${configDir}/model-relay.log（或執行 /provider doctor）`
}

export function statusText(h: Health | null, direct: boolean, lang: 'zh' | 'en' = 'zh'): string {
  if (!h) {
    if (lang === 'en') return direct ? 'Relay offline: connected directly to Claude' : 'Relay offline, restarting…'
    return direct ? '轉發站離線：主線暫時直連 Claude，model-relay 子代理無法使用' : '轉發站離線，正在重啟…'
  }
  const pinned = h.session !== 'claude' && has(h.providers, h.session) ? h.providers[h.session] : undefined
  if (pinned) return lang === 'en' ? `Main: ${pinned} (pinned for this session)` : `主線：${pinned}（這個對話固定用它）`
  if (h.failoverSince) {
    const to = h.failoverProvider ? h.providers[h.failoverProvider] ?? h.failoverProvider : ''
    if (to) return lang === 'en' ? `Claude limit reached: routing to ${to}` : `Claude 額度用完：下一個請求起改用 ${to}`
    return lang === 'en' ? 'Claude limit reached' : 'Claude 額度用完'
  }
  return lang === 'en' ? 'Main: Claude' : '主線：Claude'
}

export function fmtLatency(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`
}

// The last test of a provider, in a few words, kept apart from the last real request
export function pingText(p: PingStat | undefined, lang: 'zh' | 'en'): { text: string; color: string } | null {
  if (!p) return null
  const en = lang === 'en'
  if (p.verdict === 'ok') return { text: `${en ? 'test ok' : '測試正常'} ${fmtLatency(p.firstByteMs)}`, color: 'green' }
  const words: Record<string, [string, string]> = {
    key: ['key refused', '金鑰被拒'],
    model: ['unknown model', '模型名稱不對'],
    quota: ['quota or rate limit', '額度用完或被限流'],
    'not-running': ['local service not running', '本機服務沒開'],
    unreachable: ['unreachable', '連不到'],
    timeout: ['timed out', '逾時'],
  }
  const w = has(words, p.verdict) ? words[p.verdict]! : [`HTTP ${p.status}`, `HTTP ${p.status}`]
  return { text: `${en ? 'test' : '測試'}: ${en ? w[0] : w[1]}`, color: 'red' }
}

export function statText(st: ProviderStat | undefined, lang: 'zh' | 'en'): { text: string; color: string } | null {
  if (!st || !st.at) return null
  const head = lang === 'en' ? 'last' : '上次'
  if (st.status >= 200 && st.status < 300) return { text: `${head} ${st.status} · ${fmtLatency(st.ms)}`, color: 'green' }
  if (st.status === 0) return { text: `${head} ${lang === 'en' ? 'no connection' : '未連線'}`, color: 'red' }
  return { text: `${head} HTTP ${st.status}`, color: 'red' }
}

export function providerReport(h: Health | null, now: number, lang: 'zh' | 'en' = 'zh'): string {
  const en = lang === 'en'
  if (!h) {
    return en
      ? 'Relay is not responding; auto-restarting every 10s.'
      : '轉發站沒有回應；每 10 秒會自動重啟，稍後再試。'
  }
  const providers = h.providers

  let head = statusText(h, false, lang)
  if (h.failoverSince) {
    const mins = Math.max(0, Math.round((h.nextClaudeTry - now) / 60000))
    head += en
      ? ` (retrying Claude in ~${mins}m; only new sessions switch back)`
      : `（約 ${mins} 分鐘後再試 Claude，恢復後只有新對話回到 Claude）`
  }

  const aliasPairs = Object.entries(h.aliases)
    .filter(([, p]) => has(providers, p))
    .map(([slot, p]) => `${slot} → ${p} (${providers[p]})`)
  const aliasLine = en
    ? `Model aliases: ${aliasPairs.length > 0 ? aliasPairs.join(', ') : 'none (all Claude tiers use main route)'}`
    : `別名自動分流：${aliasPairs.length > 0 ? aliasPairs.join('、') : '無（子代理全走主線）'}`

  const chain = h.failoverChain
  const sw = h.switches
  const foOn = sw ? sw.failover : true
  const chainText = chain.length ? chain.join(' → ') : en ? 'nobody to hand over to' : '沒有接手者'
  const foSummary = foOn ? `● ${en ? 'on' : '開啟'} (${chainText})` : `○ ${en ? 'off' : '關閉'}`
  const retrySummary = !sw || sw.retry ? `● ${en ? 'on' : '開啟'}` : `○ ${en ? 'off' : '關閉'}`
  const rcSummary = sw?.proxy ? `● ${en ? 'on' : '開啟'}` : `○ ${en ? 'off' : '關閉'}`
  const switchLine = en
    ? `Global switches: 429 failover ${foSummary} · Retry ${retrySummary} · Remote Control ${rcSummary}`
    : `全域開關狀態：429 備援 ${foSummary} · 失敗重試 ${retrySummary} · 手機遙控 ${rcSummary}`

  const activeSession = h.session || 'claude'
  const claudeMark = activeSession === 'claude' ? '●' : '○'
  const claudeDesc = activeSession === 'claude'
    ? (en ? 'Anthropic Claude  ← active' : 'Anthropic Claude（預設主線） ← 目前使用中')
    : (en ? 'Anthropic Claude (switching back rebuilds prompt cache)' : '切回 Anthropic Claude（長對話會重建一次快取）')

  const lines: string[] = [
    head,
    aliasLine,
    switchLine,
    ...healthHints(h, lang).map((x) => `⚠ ${x}`),
    '',
    en ? 'Switch this session:' : '切換這個對話的模型：',
    `  ${claudeMark} /provider ${'claude'.padEnd(8)} ${claudeDesc}`,
  ]

  for (const [k, m] of Object.entries(providers)) {
    const isCurrent = activeSession === k
    const mark = isCurrent ? '●' : '○'
    const badges: string[] = []
    for (const [slot, target] of Object.entries(h.aliases)) {
      if (target === k) badges.push(en ? `${slot} alias` : `${slot} 別名`)
    }
    if (foOn) {
      const idx = chain.indexOf(k)
      if (idx === 0 && chain.length === 1) badges.push(en ? '429 failover' : '429 備援')
      else if (idx >= 0) badges.push(en ? `429 failover #${idx + 1}` : `429 備援 #${idx + 1}`)
    }
    const badgeText = badges.length > 0 ? ` [${badges.join(' · ')}]` : ''
    const notes = [statText(h.stats?.[k], lang), pingText(h.ping?.[k], lang)].filter((x) => x !== null).map((x) => x.text)
    const stText = notes.length ? ` (${notes.join(' · ')})` : ''
    const activeSuffix = isCurrent ? (en ? '  ← pinned' : '  ← 目前固定') : ''
    lines.push(`  ${mark} /provider ${k.padEnd(8)} ${m}${badgeText}${stText}${activeSuffix}`)
  }
  if (Object.keys(providers).length === 0) {
    lines.push(en
      ? '  (no provider is usable yet: every request goes to Claude; /provider setup adds one)'
      : '  （還沒有可用的供應商：所有請求都走 Claude；/provider setup 可以新增）')
  }

  const agentNames = Object.keys(providers).map((k) => `model-relay:${k}`)
  lines.push(
    '',
    en ? 'Controls & settings:' : '面板與快速設定：',
    en
      ? '  · /provider panel                      Toggle interactive panel above prompt (hotkeys 1-9 / p / f / t / x)'
      : '  · /provider panel                      開關上方互動面板（熱鍵 1-9 切換 · p 測速 · f 備援 · t 重試 · x 遙控）',
    en
      ? '  · /provider ping                       Test every provider: does it answer, and how soon does the answer start'
      : '  · /provider ping                       測試每個供應商：能不能回應、多快開始回應',
    en
      ? '  · /provider setup [goal]               Let Claude walk you through setup (e.g. /provider setup add deepseek)'
      : '  · /provider setup [想要的設定]         讓 Claude 帶你設定（例：/provider setup 加上 deepseek）',
    en
      ? '  · /provider doctor [--ping]            Check the config, Claude Code settings and the relay, with fixes'
      : '  · /provider doctor [--ping]            檢查設定檔、Claude Code 設定與轉發站，並列出修法',
    en
      ? '  · /provider restart                    Restart the relay so it runs this plugin version'
      : '  · /provider restart                    重啟轉發站，讓它跑這個外掛版本的程式',
    en
      ? '  · /provider alias [haiku <name|claude>] View or point a Claude model alias (e.g. /provider alias haiku <name>)'
      : '  · /provider alias [haiku <name|claude>] 查看或設定別名分流（例：/provider alias haiku <名稱>）',
    en
      ? '  · /provider failover <on|off|a,b>      Toggle 429 failover or set the failover chain'
      : '  · /provider failover <on|off|a,b>      開關 429 備援或設定接手順序（例：/provider failover a,b）',
    en
      ? '  · /provider retry <on|off>             Toggle automatic provider retries'
      : '  · /provider retry <on|off>             開關供應商失敗自動重試',
    en
      ? '  · /provider rc <on|off>                Toggle Remote Control HTTPS proxy mode (applies to new sessions)'
      : '  · /provider rc <on|off>                開關手機 Remote Control 代理模式（新對話生效）',
    ...(agentNames.length
      ? [en
          ? `  · subagent_type: "model-relay:<name>"  Spawn a full Agent on a provider (${agentNames.join(', ')})`
          : `  · subagent_type: "model-relay:<name>"  派出等同預設 Agent 的子代理並走該供應商（${agentNames.join('、')}）`]
      : []),
  )
  return lines.join('\n')
}

export interface ProviderAgentSpec {
  name: string
  description: string
  prompt: string
  model: string
}

const DEFAULT_AGENT_PROMPT =
  "You are an agent for Claude Code, Anthropic's official CLI for Claude. Given the user's message, use the available tools to complete the task fully and report your findings and changes clearly and concisely."

// Builds one `$.agent.register` spec per provider the router serves. `tools` is omitted so the subagent inherits every
// tool the parent has (identical to the built-in general-purpose Agent), while `model` is set to the provider's model ID.
export function providerAgentSpecs(providers: Record<string, string>): ProviderAgentSpec[] {
  return Object.entries(providers).map(([name, model]) => ({
    name,
    description: `General-purpose agent routed to ${name} (${model}) via model-relay. Same full toolset as the default Agent tool.`,
    prompt: DEFAULT_AGENT_PROMPT,
    model,
  }))
}

// The provider a `model-relay:<name>` subagent type names, with its model; null for any other type. When the parent calls
// `Agent({ subagent_type: "model-relay:<name>", model: "sonnet" })`, the explicit `model` would otherwise override the
// agent definition's, so `on('agent.spawn')` locks it back to the provider's model.
export function relayAgent(subagentType: string, providers: Record<string, string>): { name: string; model: string } | null {
  const m = /^model-relay:([a-z0-9_-]+)$/i.exec((subagentType || '').trim())
  if (!m) return null
  const name = m[1]!.toLowerCase()
  return has(providers, name) ? { name, model: providers[name]! } : null
}

// A model id as it travels: without a "[1m]"-style suffix, lower case (the router's seenModels uses the same key)
export const wireKey = (model: string) => model.replace(/\[[^\]]*\]$/, '').toLowerCase()

// Claude Code can run a model-relay:<name> subagent on another model (one missing from availableModels is swapped with
// only a debug-log line); the spawn result names the model it really got
export const spawnedElsewhere = (wanted: string, got: string | undefined) => Boolean(got) && wireKey(got!) !== wireKey(wanted)

// After the subagent's turn: did a request for its model reach the relay since it started? null when the router cannot
// say (down, or an older router without seenModels), so nobody is warned on a guess. Two seconds of slack for the two clocks' reads.
export function reachedRelay(h: Health | null, wanted: string, since: number): boolean | null {
  if (!h || !h.seenModels) return null
  const at = h.seenModels[wireKey(wanted)]
  return typeof at === 'number' && at >= since - 2000
}

export function elsewhereText(name: string, wanted: string, got: string, lang: 'zh' | 'en'): string {
  return lang === 'en'
    ? `The model-relay:${name} subagent runs on ${got}, not ${wanted}. Usually availableModels in a settings file does not list ${wanted}; run /provider doctor`
    : `model-relay:${name} 子代理實際跑在 ${got}，不是 ${wanted}。常見原因是設定檔的 availableModels 沒列出 ${wanted}；執行 /provider doctor 檢查`
}

export function missedRelayText(name: string, wanted: string, lang: 'zh' | 'en'): string {
  return lang === 'en'
    ? `The model-relay:${name} subagent finished, but no request for ${wanted} reached the relay, so it did not run on ${name}. Run /provider doctor (a Bedrock/Vertex setting or another ANTHROPIC_BASE_URL can cause this)`
    : `model-relay:${name} 子代理跑完了，但轉發站沒收到 ${wanted} 的請求，所以它沒有走 ${name}。執行 /provider doctor 檢查（Bedrock／Vertex 設定或別的 ANTHROPIC_BASE_URL 都可能造成）`
}
