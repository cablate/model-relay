import type { PanelData, ProviderStat } from '../types'

export interface RelayCfg {
  providers: Record<string, string> // provider name -> model id
  aliases: Record<string, string> // haiku | sonnet | opus -> provider name
  failoverProvider: string
  model: string // primary failover model (for backward compatibility)
  gemini: string | null // optional gemini model (for backward compatibility)
  port: number
  nodePath: string
}

export type AgentCfg = RelayCfg

const PRESET_DEFAULTS: Record<string, { baseUrl: string; model: string; matchModels?: string[] }> = {
  zai: { baseUrl: 'https://api.z.ai/api/anthropic', model: 'glm-5.3[1m]', matchModels: ['^glm', 'haiku'] },
  glm: { baseUrl: 'https://api.z.ai/api/anthropic', model: 'glm-5.3[1m]', matchModels: ['^glm', 'haiku'] },
  deepseek: { baseUrl: 'https://api.deepseek.com/anthropic', model: 'deepseek-chat', matchModels: ['^deepseek'] },
  kimi: { baseUrl: 'https://api.moonshot.ai/anthropic', model: 'kimi-k2', matchModels: ['^kimi', '^moonshot'] },
  minimax: { baseUrl: 'https://api.minimax.io/anthropic', model: 'MiniMax-M1', matchModels: ['^minimax'] },
  openrouter: { baseUrl: 'https://openrouter.ai/api', model: 'anthropic/claude-sonnet-4', matchModels: ['^openrouter/'] },
  gemini: { baseUrl: 'http://127.0.0.1:3425', model: 'gemini-4-argon', matchModels: ['^gemini'] },
  magpie: { baseUrl: 'http://127.0.0.1:3425', model: 'gemini-4-argon', matchModels: ['^gemini'] },
}

const ALIAS_SAMPLES: Record<string, string> = {
  haiku: 'claude-haiku-5-5',
  sonnet: 'claude-sonnet-5-5',
  opus: 'claude-opus-5-5',
}

export function parseCfg(raw: unknown): RelayCfg | null {
  if (typeof raw !== 'object' || raw === null) return null
  const r = raw as Record<string, unknown>
  const str = (v: unknown) => (typeof v === 'string' && v.length > 0 ? v : null)

  const providers: Record<string, string> = {}
  const matchers: Record<string, RegExp[]> = {}

  if (typeof r.providers === 'object' && r.providers !== null) {
    for (const [k, v] of Object.entries(r.providers as Record<string, unknown>)) {
      const key = k.trim().toLowerCase()
      if (!key || key === 'claude' || typeof v !== 'object' || v === null) continue
      const pv = v as Record<string, unknown>
      const presetKey = (str(pv.preset) ?? key).toLowerCase()
      const preset = PRESET_DEFAULTS[presetKey]
      const url = str(pv.baseUrl ?? pv.url ?? preset?.baseUrl)
      const token = str(pv.token)
      const model = str(pv.model ?? preset?.model)
      if (url && /^https?:\/\//.test(url) && token && model) {
        providers[key] = model
        const rawPats = Array.isArray(pv.matchModels) && pv.matchModels.length > 0
          ? (pv.matchModels as unknown[]).filter((m): m is string => typeof m === 'string' && m.length > 0)
          : (preset?.matchModels ?? [`^${key}`])
        const res: RegExp[] = []
        for (const pat of rawPats) {
          try { res.push(new RegExp(pat, 'i')) } catch {}
        }
        matchers[key] = res
      }
    }
  }

  // Legacy top-level compatibility
  if (!providers.glm) {
    const baseUrl = str(r.baseUrl)
    const token = str(r.token)
    const model = str(r.model)
    if (baseUrl && /^https?:\/\//.test(baseUrl) && token && model) {
      providers.glm = model
      matchers.glm = [/^glm/i, /haiku/i]
    }
  }
  if (!providers.gemini && typeof r.gemini === 'object' && r.gemini !== null) {
    const gm = str((r.gemini as Record<string, unknown>).model)
    if (gm) {
      providers.gemini = gm
      matchers.gemini = [/^gemini/i]
    }
  }

  const names = Object.keys(providers)
  if (names.length === 0) return null

  const aliases: Record<string, string> = {}
  for (const [slot, sample] of Object.entries(ALIAS_SAMPLES)) {
    for (const k of names) {
      if (matchers[k]?.some((re) => re.test(sample) || re.test(slot))) {
        aliases[slot] = k
        break
      }
    }
  }

  const foObj = typeof r.failover === 'object' && r.failover !== null ? (r.failover as Record<string, unknown>) : null
  // The first usable link of the failover chain leads; older files name a single provider
  const chainFirst = Array.isArray(foObj?.chain)
    ? (foObj.chain as unknown[]).map((n) => (typeof n === 'string' ? n.trim().toLowerCase() : '')).find((n) => n && providers[n])
    : undefined
  const preferredFo = chainFirst ?? str(foObj?.provider ?? r.failoverProvider)?.toLowerCase()
  const failoverProvider = preferredFo && providers[preferredFo] ? preferredFo : (providers.glm ? 'glm' : names[0]!)
  const port = typeof r.port === 'number' && Number.isInteger(r.port) && r.port > 1024 && r.port < 65536 ? r.port : 8950

  return {
    providers,
    aliases,
    failoverProvider,
    model: providers[failoverProvider]!,
    gemini: providers.gemini ?? null,
    port,
    nodePath: str(r.nodePath) ?? 'node',
  }
}

// ---- local router ----

export function curlBin(isWin = true): string {
  return isWin ? 'C:/Windows/System32/curl.exe' : 'curl'
}

export const CURL = 'C:/Windows/System32/curl.exe'

export const routerUrl = (cfg: RelayCfg) => `http://127.0.0.1:${cfg.port}`

const healthUrl = (cfg: RelayCfg, sid: string) => `${routerUrl(cfg)}/__health?sid=${encodeURIComponent(sid)}`

export function healthArgv(cfg: RelayCfg, sid: string, isWin = true): string[] {
  return [curlBin(isWin), '-s', '-m', '2', healthUrl(cfg, sid)]
}

export function healthWaitArgv(cfg: RelayCfg, sid: string, isWin = true): string[] {
  return [curlBin(isWin), '-s', '-m', '2', '--retry', '6', '--retry-connrefused', '--retry-delay', '1', healthUrl(cfg, sid)]
}

export function sessionArgv(cfg: RelayCfg, sid: string, on: string, isWin = true): string[] {
  return [curlBin(isWin), '-s', '-m', '3', '-X', 'POST', '-H', 'content-type: application/json', '-d', JSON.stringify({ sid, on }), `${routerUrl(cfg)}/__session`]
}

export function pingArgv(cfg: RelayCfg, provider = '', isWin = true): string[] {
  return [curlBin(isWin), '-s', '-m', '10', '-X', 'POST', '-H', 'content-type: application/json', '-d', JSON.stringify({ provider }), `${routerUrl(cfg)}/__ping`]
}

export function probeArgv(cfg: RelayCfg, isWin = true): string[] {
  return [curlBin(isWin), '-s', '-m', '3', '-X', 'POST', `${routerUrl(cfg)}/__probe`]
}

export function routerScript(pluginRoot: string): string {
  return pluginRoot.replace(/[\\/]\.claude-plugin[\\/]?$/, '').replace(/\\/g, '/') + '/router/router.js'
}

const pluginBase = (pluginRoot: string) => pluginRoot.replace(/[\\/]\.claude-plugin[\\/]?$/, '').replace(/\\/g, '/')

export const setupScript = (pluginRoot: string) => `${pluginBase(pluginRoot)}/tools/setup.mjs`

export type Toggle = 'failover' | 'retry' | 'proxy'

// The panel and `/provider` subcommands change settings through the same CLI a person would use
export function toggleArgv(cfg: RelayCfg, script: string, which: Toggle, on: boolean): string[] {
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
      ? `A config already exists. Start with ${cli} doctor and ${cli} providers to see the current state.`
      : `There is no config yet. Start with ${cli} presets, then create it with "init --fix" or "add <name> --token env:<VAR>".`,
    '',
    'Rules:',
    '- Never ask me to paste an API key into this chat, and never print one. Use "env:VAR_NAME" tokens; tell me which variable to set, how to make it permanent on my OS, and that Claude Code must be restarted to see it.',
    '- Commands that accept --go (migrate, remove, proxy): run without --go first, show me the result, and add --go only after I agree.',
    '- Tell me before anything changes ~/.claude/settings.json (init --fix, doctor --fix, alias, proxy) and wait for my yes.',
    `- Finish with ${cli} doctor --ping and tell me in plain words what works, what does not, and what I still have to do.`,
  ].join('\n')
}

export function setupCliArgv(cfg: RelayCfg, script: string, cliArgs: string[]): string[] {
  return [cfg.nodePath, script, ...cliArgs]
}

// Detaches the router process on both Windows and POSIX platforms.
export function startArgv(cfg: RelayCfg, script: string, configDir: string, isWin = true): string[] {
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
  providers?: Record<string, string>
  aliases?: Record<string, string>
  failoverProvider?: string
  failoverChain?: string[]
  configDirs?: string[] // the directory this router serves, as it resolves it and as it was given; absent on older routers
  stats?: Record<string, ProviderStat>
  // What the router is doing right now; absent when it predates the switches
  switches?: { failover: boolean; retry: boolean; proxy: boolean; proxyReady: boolean }
}

export function parseHealth(stdout: string): Health | null {
  try {
    const j = JSON.parse(stdout) as Record<string, unknown>
    if (j.ok !== true) return null
    const num = (v: unknown) => (typeof v === 'number' ? v : 0)
    const session = typeof j.session === 'string' && j.session.length > 0 ? j.session.toLowerCase() : 'claude'
    let providers: Record<string, string> | undefined
    if (typeof j.providers === 'object' && j.providers !== null) {
      const pMap: Record<string, string> = {}
      for (const [k, v] of Object.entries(j.providers as Record<string, unknown>)) {
        if (typeof v === 'string' && v.length > 0) pMap[k.toLowerCase()] = v
      }
      if (Object.keys(pMap).length > 0) providers = pMap
    }
    let aliases: Record<string, string> | undefined
    if (typeof j.aliases === 'object' && j.aliases !== null) {
      const aMap: Record<string, string> = {}
      for (const [k, v] of Object.entries(j.aliases as Record<string, unknown>)) {
        if (typeof v === 'string' && v.length > 0) aMap[k.toLowerCase()] = v.toLowerCase()
      }
      aliases = aMap
    }
    let stats: Record<string, ProviderStat> | undefined
    if (typeof j.stats === 'object' && j.stats !== null) {
      const sMap: Record<string, ProviderStat> = {}
      for (const [k, v] of Object.entries(j.stats as Record<string, unknown>)) {
        if (typeof v === 'object' && v !== null) {
          const sv = v as Record<string, unknown>
          sMap[k.toLowerCase()] = { status: num(sv.status), ms: num(sv.ms), at: num(sv.at) }
        }
      }
      stats = sMap
    }
    const failoverProvider = typeof j.failoverProvider === 'string' && j.failoverProvider.length > 0
      ? j.failoverProvider.toLowerCase()
      : undefined
    const failoverChain = Array.isArray(j.failoverChain)
      ? (j.failoverChain as unknown[]).filter((n): n is string => typeof n === 'string' && n.length > 0).map((n) => n.toLowerCase())
      : undefined
    const configDirs = [j.configDir, j.configDirArg].filter((d): d is string => typeof d === 'string' && d.length > 0)
    const conf = typeof j.config === 'object' && j.config !== null ? (j.config as Record<string, unknown>) : null
    const px = typeof j.proxy === 'object' && j.proxy !== null ? (j.proxy as Record<string, unknown>) : null
    const switches = conf && typeof conf.failoverEnabled === 'boolean' && typeof conf.retryEnabled === 'boolean' && typeof conf.proxyEnabled === 'boolean'
      ? { failover: conf.failoverEnabled, retry: conf.retryEnabled, proxy: conf.proxyEnabled, proxyReady: px?.certificate === true }
      : undefined
    return {
      session,
      failoverSince: num(j.failoverSince),
      nextClaudeTry: num(j.nextClaudeTry),
      sessionsOnCustom: num(j.sessionsOnCustom ?? j.sessionsOnGlm),
      ...(providers ? { providers } : {}),
      ...(aliases ? { aliases } : {}),
      ...(failoverProvider ? { failoverProvider } : {}),
      ...(failoverChain && failoverChain.length > 0 ? { failoverChain } : {}),
      ...(configDirs.length > 0 ? { configDirs } : {}),
      ...(stats ? { stats } : {}),
      ...(switches ? { switches } : {}),
    }
  } catch {
    return null
  }
}

export function resolveModelsMap(
  modelOrCfg: string | RelayCfg,
  gemini: string | null = null,
  h: Health | null = null,
): { providers: Record<string, string>; failoverProvider: string; failoverModel: string } {
  if (typeof modelOrCfg === 'string') {
    const providers: Record<string, string> = { glm: modelOrCfg }
    if (gemini) providers.gemini = gemini
    return { providers, failoverProvider: 'glm', failoverModel: modelOrCfg }
  }
  const activeProviders = h?.providers && Object.keys(h.providers).length > 0 ? h.providers : modelOrCfg.providers
  const foKey = h?.failoverProvider && activeProviders[h.failoverProvider]
    ? h.failoverProvider
    : modelOrCfg.failoverProvider
  const failoverModel = activeProviders[foKey] ?? modelOrCfg.model
  return { providers: activeProviders, failoverProvider: foKey, failoverModel }
}

export function buildPanelData(h: Health | null, cfg: RelayCfg, direct: boolean, lang: 'zh' | 'en', now: number): PanelData {
  const { providers, failoverProvider } = resolveModelsMap(cfg, null, h)
  return {
    online: Boolean(h),
    direct,
    port: cfg.port,
    session: h?.session ?? 'claude',
    failoverProvider,
    failoverSince: h?.failoverSince ?? 0,
    nextClaudeTry: h?.nextClaudeTry ?? 0,
    sessionsOnCustom: h?.sessionsOnCustom ?? 0,
    providers,
    aliases: h?.aliases ?? cfg.aliases,
    failoverChain: h?.failoverChain && h.failoverChain.length > 0 ? h.failoverChain : [failoverProvider],
    switches: h?.switches ?? null,
    stats: h?.stats ?? {},
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

export function foreignStatusText(dir: string, lang: 'zh' | 'en' = 'zh'): string {
  return lang === 'en'
    ? `Port is held by another relay (config dir ${dir}): connected directly to Claude`
    : `連接埠被另一個轉發站（設定目錄 ${dir}）佔用：主線暫時直連 Claude`
}

export function statusText(h: Health | null, modelOrCfg: string | RelayCfg, direct: boolean, gemini: string | null = null, lang: 'zh' | 'en' = 'zh'): string {
  const { providers, failoverModel } = resolveModelsMap(modelOrCfg, gemini, h)
  if (!h) {
    if (lang === 'en') return direct ? 'Relay offline: connected directly to Claude' : 'Relay offline, restarting…'
    return direct ? '轉發站離線：主線暫時直連 Claude，subagent 的 GLM 無法使用' : '轉發站離線，正在重啟…'
  }
  if (h.session !== 'claude' && providers[h.session]) {
    const m = providers[h.session]!
    return lang === 'en' ? `Main: ${m} (pinned for this session)` : `主線：${m}（這個對話固定用它）`
  }
  if (h.failoverSince) {
    return lang === 'en' ? `Claude limit reached: routing to ${failoverModel}` : `Claude 額度用完：下一個請求起改用 ${failoverModel}`
  }
  return lang === 'en' ? 'Main: Claude' : '主線：Claude'
}

function fmtLatency(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`
}

export function providerReport(h: Health | null, modelOrCfg: string | RelayCfg, now: number, gemini: string | null = null, lang: 'zh' | 'en' = 'zh'): string {
  const { providers, failoverProvider } = resolveModelsMap(modelOrCfg, gemini, h)
  const en = lang === 'en'
  if (!h) {
    return en
      ? 'Relay is not responding; auto-restarting every 10s.'
      : '轉發站沒有回應；每 10 秒會自動重啟，稍後再試。'
  }

  let head = statusText(h, modelOrCfg, false, gemini, lang)
  if (h.failoverSince) {
    const mins = Math.max(0, Math.round((h.nextClaudeTry - now) / 60000))
    head += en
      ? ` (retrying Claude in ~${mins}m; only new sessions switch back)`
      : `（約 ${mins} 分鐘後再試 Claude，恢復後只有新對話回到 Claude）`
  }

  const aliases = h.aliases ?? (typeof modelOrCfg === 'object' ? modelOrCfg.aliases : { haiku: 'glm' })
  const aliasPairs = Object.entries(aliases)
    .filter(([, p]) => providers[p])
    .map(([slot, p]) => `${slot} → ${p} (${providers[p]})`)
  const aliasLine = en
    ? `Model aliases: ${aliasPairs.length > 0 ? aliasPairs.join(', ') : 'none (all Claude tiers use main route)'}`
    : `別名自動分流：${aliasPairs.length > 0 ? aliasPairs.join('、') : '無（子代理全走主線）'}`

  const chain = h.failoverChain && h.failoverChain.length > 0 ? h.failoverChain : [failoverProvider]
  const sw = h.switches
  const foOn = sw ? sw.failover : true
  const foSummary = foOn ? `● ${en ? 'on' : '開啟'} (${chain.join(' → ')})` : `○ ${en ? 'off' : '關閉'}`
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
    '',
    en ? 'Switch this session:' : '切換這個對話的模型：',
    `  ${claudeMark} /provider ${'claude'.padEnd(8)} ${claudeDesc}`,
  ]

  for (const [k, m] of Object.entries(providers)) {
    const isCurrent = activeSession === k
    const mark = isCurrent ? '●' : '○'
    const badges: string[] = []
    for (const [slot, target] of Object.entries(aliases)) {
      if (target === k) badges.push(en ? `${slot} alias` : `${slot} 別名`)
    }
    if (foOn) {
      const idx = chain.indexOf(k)
      if (idx === 0 && chain.length === 1) badges.push(en ? '429 failover' : '429 備援')
      else if (idx >= 0) badges.push(en ? `429 failover #${idx + 1}` : `429 備援 #${idx + 1}`)
    }
    const badgeText = badges.length > 0 ? ` [${badges.join(' · ')}]` : ''
    const st = h.stats?.[k]
    const stText = st && st.status > 0 ? ` (${st.status} · ${fmtLatency(st.ms)})` : ''
    const activeSuffix = isCurrent ? (en ? '  ← pinned' : '  ← 目前固定') : ''
    lines.push(`  ${mark} /provider ${k.padEnd(8)} ${m}${badgeText}${stText}${activeSuffix}`)
  }

  lines.push(
    '',
    en ? 'Controls & settings:' : '面板與快速設定：',
    en
      ? '  · /provider panel                      Toggle interactive panel above prompt (hotkeys 1-9 / p / f / t / x)'
      : '  · /provider panel                      開關上方互動面板（熱鍵 1-9 切換 · p 測速 · f 備援 · t 重試 · x 遙控）',
    en
      ? '  · /provider ping                       Test live latency across all providers'
      : '  · /provider ping                       即時測試所有供應商的回應延遲',
    en
      ? '  · /provider setup [goal]               Let Claude walk you through setup (e.g. /provider setup add deepseek)'
      : '  · /provider setup [想要的設定]         讓 Claude 帶你設定（例：/provider setup 加上 deepseek）',
    en
      ? '  · /provider alias [haiku <name|claude>] View or point a Claude model alias (e.g. /provider alias haiku glm)'
      : '  · /provider alias [haiku <name|claude>] 查看或設定別名分流（例：/provider alias haiku glm）',
    en
      ? '  · /provider failover <on|off|a,b>      Toggle 429 failover or set the failover chain'
      : '  · /provider failover <on|off|a,b>      開關 429 備援或設定接手順序（例：/provider failover gemini,glm）',
    en
      ? '  · /provider retry <on|off>             Toggle automatic provider retries'
      : '  · /provider retry <on|off>             開關供應商失敗自動重試',
    en
      ? '  · /provider rc <on|off>                Toggle Remote Control HTTPS proxy mode (applies to new sessions)'
      : '  · /provider rc <on|off>                開關手機 Remote Control 代理模式（新對話生效）',
    en
      ? `  · subagent_type: "model-relay:<name>"  Spawn a full Agent on a provider (${Object.keys(providers).map((k) => `model-relay:${k}`).join(', ')})`
      : `  · subagent_type: "model-relay:<name>"  派出等同預設 Agent 的子代理並走該供應商（${Object.keys(providers).map((k) => `model-relay:${k}`).join('、')}）`,
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

// Builds one `$.agent.register` spec per configured provider. `tools` is omitted so the subagent inherits every tool
// the parent has (identical to the built-in general-purpose Agent), while `model` is set to the provider's model ID.
export function providerAgentSpecs(cfg: RelayCfg, h: Health | null = null): ProviderAgentSpec[] {
  const active = h?.providers && Object.keys(h.providers).length > 0 ? h.providers : cfg.providers
  return Object.entries(active).map(([name, model]) => ({
    name,
    description: `General-purpose agent routed to ${name} (${model}) via model-relay. Same full toolset as the default Agent tool.`,
    prompt: DEFAULT_AGENT_PROMPT,
    model,
  }))
}

// When the parent calls `Agent({ subagent_type: "model-relay:gemini", model: "sonnet" })`, the explicit `model`
// argument on `Agent` would otherwise override the agent definition's `model: "gemini-4-argon"`. `on('agent.spawn')`
// uses this to lock `model-relay:<name>` back to its provider model.
export function providerModelForSubagent(subagentType: string, cfg: RelayCfg, h: Health | null = null): string | null {
  const m = /^model-relay:([a-z0-9_-]+)$/i.exec((subagentType || '').trim())
  if (!m) return null
  const key = m[1]!.toLowerCase()
  const active = h?.providers && Object.keys(h.providers).length > 0 ? h.providers : cfg.providers
  return active[key] ?? null
}
