import type { AvatarEntry, AvatarMode, AvatarView, PanelData, PingStat, ProviderStat } from '../types'

// What the hook takes from the config file: where the router listens and which node runs it. Providers, aliases and the
// failover chain come from the router's /__health only, so the plugin never second-guesses how the router reads a config.
// outdated: the file is from an older version, which this version's router does not read (no "format": 2, or the older
// file name); the hook then starts and replaces no router, so a router that still reads it keeps working until migrate
// statusBar: also draw the relay state in Claude Code's plugin status line ("statusBar": true); off by default, since
// the per-session status file (statusFields) lets a statusline tool show it instead
// avatars: the pictures of the avatar pane, by persona (parseAvatars); the router ignores the key
export interface LocalCfg {
  port: number
  nodePath: string
  outdated: boolean
  statusBar: boolean
  avatars: Record<string, AvatarEntry>
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
  return { port, nodePath, outdated: oldName || r.format !== 2, statusBar: r.statusBar === true, avatars: parseAvatars(r.avatars) }
}

// The agent fields a provider's "agent" object in the config may set, with the shape each must have; `name` and `model`
// are not among them: the type is named after the provider and runs on its model. Claude Code validates the rest.
const isStr = (v: unknown) => typeof v === 'string' && v.trim().length > 0
const isStrList = (v: unknown) => Array.isArray(v) && v.every((x) => typeof x === 'string')
const AGENT_FIELDS: Record<string, (v: unknown) => boolean> = {
  description: isStr,
  prompt: isStr,
  tools: isStrList,
  disallowedTools: isStrList,
  skills: isStrList,
  effort: (v) => isStr(v) || (typeof v === 'number' && Number.isInteger(v) && v > 0),
  permissionMode: isStr,
  maxTurns: (v) => typeof v === 'number' && Number.isInteger(v) && v > 0,
  autoCompactWindow: (v) => typeof v === 'number' && Number.isInteger(v) && v > 0,
  initialPrompt: isStr,
  memory: (v) => v === 'user' || v === 'project' || v === 'local',
  isolation: (v) => v === 'worktree' || v === 'remote',
  background: (v) => v === true,
  omitClaudeMd: (v) => v === true,
  mcpServers: (v) => Array.isArray(v) && v.every((x) => typeof x === 'string' || (typeof x === 'object' && x !== null && !Array.isArray(x))),
  hooks: (v) => typeof v === 'object' && v !== null && !Array.isArray(v),
}

export type AgentOptions = Record<string, unknown>

// Each provider's "agent" object from the config, by name, keeping only the fields above in the right shape
export function providerAgentOptions(raw: unknown): Record<string, AgentOptions> {
  const out: Record<string, AgentOptions> = {}
  const providers = (raw as { providers?: unknown } | null)?.providers
  if (typeof providers !== 'object' || providers === null || Array.isArray(providers)) return out
  for (const [name, p] of Object.entries(providers as Record<string, unknown>)) {
    const agent = (p as { agent?: unknown } | null)?.agent
    if (typeof agent !== 'object' || agent === null || Array.isArray(agent)) continue
    const kept: AgentOptions = {}
    for (const [k, v] of Object.entries(agent as Record<string, unknown>)) {
      if (has(AGENT_FIELDS, k) && AGENT_FIELDS[k]!(v)) kept[k] = v
    }
    if (Object.keys(kept).length) out[name] = kept
  }
  return out
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

// What /provider init|doctor|presets|restart runs. init is setting up, so it wires settings.json; doctor only looks until the person types --fix
export function setupCommandArgs(first: string, arg: string): string[] {
  const typed = arg.split(/\s+/)
  if (first === 'init') return ['init', '--fix']
  if (first === 'doctor') return ['doctor', ...['--fix', '--ping'].filter((flag) => typed.includes(flag))]
  return [first]
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
  if (pinned) return lang === 'en' ? `Main: ${pinned} (pinned for this window)` : `主線：${pinned}（這個視窗固定用它）`
  if (h.failoverSince) {
    const to = h.failoverProvider ? h.providers[h.failoverProvider] ?? h.failoverProvider : ''
    if (to) return lang === 'en' ? `Claude limit reached: routing to ${to}` : `Claude 額度用完：下一個請求起改用 ${to}`
    return lang === 'en' ? 'Claude limit reached' : 'Claude 額度用完'
  }
  return lang === 'en' ? 'Main: Claude' : '主線：Claude'
}

// The relay state of this session for statusline tools (coralline's relay segment), written by the hook to
// <config dir>/model-relay-status/<session id> as one line "kind<TAB>label":
//   claude   <tab> claude     this session goes to Claude through the relay
//   pinned   <tab> <model>    pinned to a provider (/provider, or a failover that pinned it)
//   failover <tab> <model>    Claude's limit is reached; the next request goes to that model
//   limit    <tab> claude     Claude's limit is reached and the failover chain has nobody to hand over to
//   offline  <tab> offline    no router of ours answers for this window
//   direct   <tab> claude     no router of ours answers, so this window talks to Claude directly
// foreign: the port answers for another config dir's router, which this window never counts as its own
export function statusFields(h: Health | null, direct: boolean, foreign = false): [string, string] {
  if (foreign || !h) return direct ? ['direct', 'claude'] : ['offline', 'offline']
  const pinned = h.session !== 'claude' && has(h.providers, h.session) ? h.providers[h.session] : undefined
  if (pinned) return ['pinned', pinned]
  if (h.failoverSince) {
    const to = h.failoverProvider ? h.providers[h.failoverProvider] ?? h.failoverProvider : ''
    return to ? ['failover', to] : ['limit', 'claude']
  }
  return ['claude', 'claude']
}

// The status file's path and line; null for a session id that is not a plain file name. Tabs and line breaks in a
// model id would split the line, so they become spaces.
export function statusFile(configDir: string, sid: string, fields: [string, string]): { path: string; line: string } | null {
  if (!/^[A-Za-z0-9._-]+$/.test(sid) || sid === '.' || sid === '..') return null
  const clean = (s: string) => s.replace(/[\t\r\n]+/g, ' ')
  return { path: `${configDir}/model-relay-status/${sid}`, line: `${clean(fields[0])}\t${clean(fields[1])}\n` }
}

// ---- avatar pane ----

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

// The head square of an avatar entry, [centre x, centre y, side] in whole source pixels; null for anything else
function parseHead(v: unknown): [number, number, number] | null {
  if (!Array.isArray(v) || v.length !== 3 || !v.every(isNum)) return null
  const [x, y, side] = v.map(Math.round) as [number, number, number]
  return x >= 0 && y >= 0 && side > 0 ? [x, y, side] : null
}

// The config's "avatars": a persona name (claude or a provider, lower case like the router's) to an image path, or to
// { image, head }. An entry without a usable image is dropped; a head that is not three numbers is dropped alone, so the
// picture still shows.
export function parseAvatars(raw: unknown): Record<string, AvatarEntry> {
  if (!isObj(raw)) return {}
  const entries: [string, AvatarEntry][] = []
  for (const [key, v] of Object.entries(raw)) {
    const name = key.trim().toLowerCase()
    const image = typeof v === 'string' ? v : isObj(v) ? v.image : undefined
    if (!name || typeof image !== 'string' || !image.trim()) continue
    entries.push([name, { image: image.trim(), head: isObj(v) ? parseHead(v.head) : null }])
  }
  return Object.fromEntries(entries)
}

// The persona of this window for the avatar pane, by statusFields' rules: the pinned provider, else the one a Claude
// limit handed the window to, else Claude (also with no router answering for it)
export function avatarName(h: Health | null, foreign = false): string {
  if (foreign || !h) return 'claude'
  if (h.session !== 'claude' && has(h.providers, h.session)) return h.session
  if (h.failoverSince && h.failoverProvider) return h.failoverProvider
  return 'claude'
}

export function avatarLabel(name: string, providers: Record<string, string>): string {
  if (name === 'claude') return 'Claude'
  return has(providers, name) ? `${name} · ${providers[name]}` : name
}

// What the avatar pane is asked to show: the persona, the person's mode preference (the head square, which a persona with
// none shows whole), and the pane body the picture goes in (null until the pane has drawn once). The view's own mode is
// what was made.
export type AvatarBody = { placement: 'dock' | 'inline'; columns: number; rows: number }
export type AvatarAim = { name: string; label: string; mode: AvatarMode; body: AvatarBody | null }
export type AvatarWant = Omit<AvatarView, 'cells' | 'error'>

export const AVATAR_START: AvatarAim = { name: 'claude', label: 'Claude', mode: 'head', body: null }
export const AVATAR_EMPTY: AvatarView = { name: '', label: '', entry: null, mode: 'full', cols: 0, rows: 0, cells: null, error: null }

// The picture's box in cells: as wide as the pane's body and as tall as it leaves after the rows under the picture (the
// label, and the mode switch when there is a head square). The picture is fitted inside it at its true shape, a cell being
// taken as 10 x 20 pixels. Inline above the prompt it stays short, to leave the transcript its room. 0 x 0 when nothing fits.
export const AVATAR_MAX_COLS = 160
export const AVATAR_MAX_ROWS = 100
export const AVATAR_INLINE_ROWS = 12

export const avatarLabelRows = (hasHead: boolean): number => (hasHead ? 2 : 1)

export function avatarSize(placement: 'dock' | 'inline', bodyColumns: number, bodyRows: number, labelRows: number): { cols: number; rows: number } {
  const cols = Math.min(Math.floor(bodyColumns), AVATAR_MAX_COLS)
  const rows = Math.min(Math.floor(bodyRows) - labelRows, placement === 'inline' ? AVATAR_INLINE_ROWS : AVATAR_MAX_ROWS)
  return cols >= 1 && rows >= 1 ? { cols, rows } : { cols: 0, rows: 0 }
}

export function avatarWanted(aim: AvatarAim, entries: Record<string, AvatarEntry>): AvatarWant {
  const entry = has(entries, aim.name) ? entries[aim.name]! : null
  const { body } = aim
  const size = body ? avatarSize(body.placement, body.columns, body.rows, avatarLabelRows(Boolean(entry?.head))) : { cols: 0, rows: 0 }
  return { name: aim.name, label: aim.label, entry, mode: aim.mode === 'head' && entry?.head ? 'head' : 'full', ...size }
}

// A view is current when it was made from exactly what is wanted now, config entry included
export const avatarMade = (v: AvatarView, w: AvatarWant): boolean =>
  JSON.stringify([v.name, v.label, v.entry, v.mode, v.cols, v.rows]) === JSON.stringify([w.name, w.label, w.entry, w.mode, w.cols, w.rows])

// Config paths are relative to the config directory unless they start from a root
export function avatarSource(configDir: string, image: string): string {
  const path = image.replace(/\\/g, '/')
  return /^([A-Za-z]:)?\//.test(path) ? path : `${configDir}/${path}`
}

// One scratch file per window, so two windows converting at once never share an output
export const avatarScratch = (configDir: string, sid: string): string => `${configDir}/model-relay-avatars/.cache/${sid.replace(/[^A-Za-z0-9_-]/g, '_') || 'window'}.rgba`

const SAMPLES = 8 // samples across and down one cell: what its glyph and colors are judged on

// The video filter that makes the box's samples: the head square first when asked for, then the image fitted inside the
// box at its true shape, never cropped, with transparent padding (a cell is taken to be 10 x 20 screen pixels), then
// scaled to the 8 x 8 samples each cell is judged on, sharpened a little and given a little more color
export function avatarFilter(mode: AvatarMode, head: [number, number, number] | null, cols: number, rows: number): string {
  const [w, h] = [cols * 10, rows * 20]
  const crop = mode === 'head' && head ? `crop=${head[2]}:${head[2]}:${Math.max(0, Math.round(head[0] - head[2] / 2))}:${Math.max(0, Math.round(head[1] - head[2] / 2))},` : ''
  return `${crop}scale=${w}:${h}:force_original_aspect_ratio=decrease:flags=area,format=rgba,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2:color=0x00000000,scale=${cols * SAMPLES}:${rows * SAMPLES}:flags=area,unsharp=3:3:0.6,eq=saturation=1.12:contrast=1.04`
}

// The bytes of the raw RGBA frame the filter makes
export const avatarBytes = (cols: number, rows: number): number => cols * SAMPLES * rows * SAMPLES * 4

// ffmpeg writes one raw RGBA frame of cols*8 x rows*8 samples to `out`
export function avatarArgv(input: string, out: string, mode: AvatarMode, head: [number, number, number] | null, cols: number, rows: number): string[] {
  return ['ffmpeg', '-v', 'error', '-y', '-i', input, '-vf', avatarFilter(mode, head, cols, rows), '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgba', out]
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

// Standard padded base64, written out because the engine's environment and plain Node do not share a built-in for it
export function bytesToBase64(bytes: Uint8Array): string {
  let out = ''
  for (let i = 0; i < bytes.length; i += 3) {
    const n = (bytes[i]! << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0)
    out += B64[(n >> 18) & 63]! + B64[(n >> 12) & 63]! + (i + 1 < bytes.length ? B64[(n >> 6) & 63]! : '=') + (i + 2 < bytes.length ? B64[n & 63]! : '=')
  }
  return out
}

export function base64ToBytes(text: string): Uint8Array {
  const clean = text.replace(/[^A-Za-z0-9+/]/g, '')
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4))
  let acc = 0
  let bits = 0
  let at = 0
  for (const ch of clean) {
    acc = (acc << 6) | B64.indexOf(ch)
    bits += 6
    if (bits >= 8) {
      bits -= 8
      out[at++] = (acc >> bits) & 255
      acc &= (1 << bits) - 1
    }
  }
  return out
}

const CELL_DEFAULT = 0x01000000

// A cell's 8 x 8 samples are summed as rows, columns and quarters (ROW + y, COL + x, QUARTER + q, left to right and top to
// bottom): every glyph paints a union of these as its foreground, so what it paints and what it leaves come from a few sums
// rather than from the 64 samples again
const [ROW, COL, QUARTER] = [0, SAMPLES, 2 * SAMPLES]
const GROUPS = 2 * SAMPLES + 4
// Per group: samples, opaque samples (alpha 128 and up), the sums of r, g, b over the opaque ones, the sums of their squares
const [N, SOLID, SUM, SQ, STAT] = [0, 1, 2, 5, 8]

const range = (from: number, to: number): number[] => Array.from({ length: to - from }, (_, i) => from + i)

// A glyph a cell may be drawn with, and the groups it paints as its foreground. `flip` is the glyph that paints the rest
// instead, for a cell whose see-through part has to be the background: the terminal's default foreground is its text color,
// so a glyph never carries it. A shape with no such glyph is left out for such a cell.
type Shape = { cp: number; flip: number | null; parts: number[] }

// Block shapes only: the full block, lower and left eighths, the quadrants. No triangles and no shades: both read as grain.
const SHAPES: Shape[] = [
  { cp: 0x2588, flip: 0x20, parts: range(ROW, ROW + SAMPLES) },
  ...[1, 2, 3, 4, 5, 6, 7].map((k) => ({ cp: 0x2580 + k, flip: k === 4 ? 0x2580 : k === 7 ? 0x2594 : null, parts: range(ROW + SAMPLES - k, ROW + SAMPLES) })),
  ...[1, 2, 3, 4, 5, 6, 7].map((k) => ({ cp: 0x2590 - k, flip: k === 4 ? 0x2590 : k === 7 ? 0x2595 : null, parts: range(COL, COL + k) })),
  { cp: 0x2598, flip: 0x259f, parts: [QUARTER] },
  { cp: 0x259d, flip: 0x2599, parts: [QUARTER + 1] },
  { cp: 0x2596, flip: 0x259c, parts: [QUARTER + 2] },
  { cp: 0x2597, flip: 0x259b, parts: [QUARTER + 3] },
  { cp: 0x259a, flip: 0x259e, parts: [QUARTER, QUARTER + 3] },
  { cp: 0x259e, flip: 0x259a, parts: [QUARTER + 1, QUARTER + 2] },
]

// A Raster paints 1024 distinct color pairs exactly and the rest as their nearest, so the palette is the largest of these
// whose cells use at most that many (31 colors and the default make 32 x 32, which never goes over)
const PALETTE_SIZES = [192, 160, 128, 96, 72, 56, 44, 31]
const MAX_PAIRS = 1024
// A box with more cells than this starts the search at 160 colors, to bound the work
const BIG_BOX_CELLS = 2200
const WEIGHTS = [0.3, 0.59, 0.11]
// A sample that is painted over, or left without a color, counts as this much error (half of 255 squared)
const HALF_ERR = 65025 * 0.5
// A shape has to beat the best so far by this much: a flat cell fits every shape equally, up to rounding, and stays the
// full block (one color pair) instead of one of the others at random
const TIE_ERR = 1e-3

// Median cut over the opaque samples (every fourth pixel): the palette after each of `sizes` splits, as flat r, g, b
// lists. The splits run once, since a smaller palette is the same cut stopped earlier.
function medianCut(rgba: Uint8Array, sizes: number[]): Map<number, number[]> {
  const rgb: number[] = []
  for (let i = 0; i < rgba.length; i += 16) if ((rgba[i + 3] ?? 0) >= 128) rgb.push(rgba[i]!, rgba[i + 1]!, rgba[i + 2]!)
  type Box = { items: number[]; span: number; channel: number }
  const measure = (items: number[]): Box => {
    let span = -1
    let channel = 0
    if (items.length >= 2) {
      for (let c = 0; c < 3; c++) {
        let [lo, hi] = [255, 0]
        for (const i of items) {
          const v = rgb[i * 3 + c]!
          if (v < lo) lo = v
          if (v > hi) hi = v
        }
        if (hi - lo > span) [span, channel] = [hi - lo, c]
      }
    }
    return { items, span, channel }
  }
  const mean = (boxes: Box[]): number[] =>
    boxes.filter((b) => b.items.length).flatMap((b) => [0, 1, 2].map((c) => b.items.reduce((s, i) => s + rgb[i * 3 + c]!, 0) / b.items.length))
  const out = new Map<number, number[]>()
  const boxes = [measure(Array.from({ length: rgb.length / 3 }, (_, i) => i))]
  for (const n of [...sizes].sort((a, b) => a - b)) {
    while (boxes.length < n) {
      let pick = -1
      boxes.forEach((b, i) => {
        if (b.span >= 0 && (pick < 0 || b.span > boxes[pick]!.span)) pick = i
      })
      if (pick < 0) break
      const { items, channel } = boxes[pick]!
      const sorted = [...items].sort((p, q) => rgb[p * 3 + channel]! - rgb[q * 3 + channel]!)
      boxes.splice(pick, 1, measure(sorted.slice(0, sorted.length >> 1)), measure(sorted.slice(sorted.length >> 1)))
    }
    out.set(n, mean(boxes))
  }
  return out
}

type Snap = (r: number, g: number, b: number) => number[]

// The cells as u32 triplets [code point, foreground, background], and how many distinct color pairs they use
type Painted = { words: Uint32Array; pairs: number }

// What one side of a glyph costs, from the sums of its samples: the error it leaves, and the color to paint it in
// `colors[at]`. A side mostly see-through is the terminal's default color; the rest take the palette's color nearest their
// mean. Without a `snap` the color is the mean itself, and the error the least any color leaves: a floor under the real one.
function judge(v: Float64Array, snap: Snap | null, colors: number[], at: number): number {
  const total = v[N]!
  const solid = v[SOLID]!
  if (solid * 2 < total || total === 0) {
    colors[at] = CELL_DEFAULT
    return solid * HALF_ERR
  }
  let r = v[SUM]! / solid
  let g = v[SUM + 1]! / solid
  let b = v[SUM + 2]! / solid
  if (snap) {
    const near = snap(r, g, b)
    r = near[0]!
    g = near[1]!
    b = near[2]!
  }
  colors[at] = (Math.round(r) << 16) | (Math.round(g) << 8) | Math.round(b)
  let err = (total - solid) * HALF_ERR
  err += WEIGHTS[0]! * (v[SQ]! - 2 * r * v[SUM]! + solid * r * r)
  err += WEIGHTS[1]! * (v[SQ + 1]! - 2 * g * v[SUM + 1]! + solid * g * g)
  err += WEIGHTS[2]! * (v[SQ + 2]! - 2 * b * v[SUM + 2]! + solid * b * b)
  return err
}

const [whole, painted, rest] = [new Float64Array(STAT), new Float64Array(STAT), new Float64Array(STAT)]
const picked = [0, 0]

// The glyph and the two colors with the least error for one cell, from its groups' sums: [code point, foreground, background]
function bestCell(groups: Float64Array, snap: Snap): [number, number, number] {
  whole.fill(0)
  for (let g = ROW; g < ROW + SAMPLES; g++) for (let j = 0; j < STAT; j++) whole[j]! += groups[g * STAT + j]!
  let best = Infinity
  let cell: [number, number, number] = [0x20, CELL_DEFAULT, CELL_DEFAULT]
  for (const { cp, flip, parts } of SHAPES) {
    painted.fill(0)
    for (const g of parts) for (let j = 0; j < STAT; j++) painted[j]! += groups[g * STAT + j]!
    for (let j = 0; j < STAT; j++) rest[j] = whole[j]! - painted[j]!
    // A shape that cannot beat the best even with the exact mean for colors is not worth finding its palette colors
    if (judge(rest, null, picked, 0) + judge(painted, null, picked, 1) >= best - TIE_ERR) continue
    const err = judge(rest, snap, picked, 0) + judge(painted, snap, picked, 1)
    if (err >= best - TIE_ERR) continue
    const bg = picked[0]!
    const fg = picked[1]!
    if (fg !== CELL_DEFAULT) [best, cell] = [err, [cp, fg, bg]]
    else if (bg === CELL_DEFAULT) [best, cell] = [err, [0x20, CELL_DEFAULT, CELL_DEFAULT]]
    else if (flip !== null) [best, cell] = [err, [flip, bg, CELL_DEFAULT]]
  }
  return cell
}

function paintCells(rgba: Uint8Array, cols: number, rows: number, palette: number[]): Painted {
  const snap: Snap = (r, g, b) => {
    let best = Infinity
    let near = -1
    for (let i = 0; i < palette.length; i += 3) {
      let d = palette[i]! - r
      d = WEIGHTS[0]! * (d * d)
      if (d >= best) continue
      let e = palette[i + 1]! - g
      d += WEIGHTS[1]! * (e * e)
      if (d >= best) continue
      e = palette[i + 2]! - b
      d += WEIGHTS[2]! * (e * e)
      if (d < best) {
        best = d
        near = i
      }
    }
    return near < 0 ? [r, g, b] : [palette[near]!, palette[near + 1]!, palette[near + 2]!]
  }
  const words = new Uint32Array(cols * rows * 3)
  const pairs = new Set<number>()
  const groups = new Float64Array(GROUPS * STAT)
  // The sample at byte `i` of the frame, opaque or not, counted into a group
  const add = (group: number, i: number, solid: number): void => {
    const at = group * STAT
    const r = solid * rgba[i]!
    const g = solid * rgba[i + 1]!
    const b = solid * rgba[i + 2]!
    groups[at + N]!++
    groups[at + SOLID]! += solid
    groups[at + SUM]! += r
    groups[at + SUM + 1]! += g
    groups[at + SUM + 2]! += b
    groups[at + SQ]! += r * r
    groups[at + SQ + 1]! += g * g
    groups[at + SQ + 2]! += b * b
  }
  const width = cols * SAMPLES
  for (let cy = 0; cy < rows; cy++) {
    for (let cx = 0; cx < cols; cx++) {
      groups.fill(0)
      for (let y = 0; y < SAMPLES; y++) {
        for (let x = 0; x < SAMPLES; x++) {
          const i = ((cy * SAMPLES + y) * width + cx * SAMPLES + x) * 4
          const solid = (rgba[i + 3] ?? 0) >= 128 ? 1 : 0
          const quarter = (y >= SAMPLES / 2 ? 2 : 0) + (x >= SAMPLES / 2 ? 1 : 0)
          add(ROW + y, i, solid)
          add(COL + x, i, solid)
          add(QUARTER + quarter, i, solid)
        }
      }
      const [cp, fg, bg] = bestCell(groups, snap)
      words.set([cp, fg, bg], (cy * cols + cx) * 3)
      pairs.add(fg * 0x2000000 + bg)
    }
  }
  return { words, pairs: pairs.size }
}

// RGBA samples (cols*8 wide, rows*8 tall) as cells: per cell the block glyph and two colors that match its 8 x 8 samples
// best, every color snapped to a median-cut palette of the largest size whose cells use at most 1024 distinct color pairs
export function glyphCells(rgba: Uint8Array, cols: number, rows: number): Painted {
  const sizes = cols * rows > BIG_BOX_CELLS ? PALETTE_SIZES.filter((n) => n <= 160) : PALETTE_SIZES
  const palettes = medianCut(rgba, sizes)
  let made: Painted = { words: new Uint32Array(0), pairs: 0 }
  let tried = -1
  for (const n of sizes) {
    const palette = palettes.get(n)!
    if (palette.length === tried) continue // the cut ran out of colors: this is the palette just tried
    tried = palette.length
    made = paintCells(rgba, cols, rows, palette)
    if (made.pairs <= MAX_PAIRS) break
  }
  return made
}

// The cells of glyphCells as a Raster takes them: little-endian u32 triplets [code point, foreground, background], base64
export function rasterCells(rgba: Uint8Array, cols: number, rows: number): string {
  const { words } = glyphCells(rgba, cols, rows)
  const view = new DataView(new ArrayBuffer(words.length * 4))
  words.forEach((word, i) => view.setUint32(i * 4, word, true))
  return bytesToBase64(new Uint8Array(view.buffer))
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

// What one switch came to, in one line: the status line and the panel already show the rest
export function switchedText(target: string, model: string, lang: 'zh' | 'en' = 'zh'): string {
  if (target === 'claude') {
    return lang === 'en'
      ? '✓ This window is back on Claude (the next turn rebuilds the prompt cache)'
      : '✓ 這個視窗切回 Claude（下一輪會重建一次快取）'
  }
  return lang === 'en' ? `✓ This window now uses ${target} (${model})` : `✓ 這個視窗改用 ${target}（${model}）`
}

// One row per route, each written as the command that picks it
function routeRows(h: Health, lang: 'zh' | 'en', withClaude: boolean): string[] {
  const en = lang === 'en'
  const active = h.session || 'claude'
  const rows: string[] = []
  if (withClaude) {
    const desc = active === 'claude'
      ? (en ? 'Anthropic Claude  ← in use' : 'Anthropic Claude  ← 使用中')
      : (en ? 'Anthropic Claude (switching back rebuilds the prompt cache)' : 'Anthropic Claude（切回時長對話會重建一次快取）')
    rows.push(`  ${active === 'claude' ? '●' : '○'} /provider ${'claude'.padEnd(8)} ${desc}`)
  }
  for (const [k, m] of Object.entries(h.providers)) {
    const notes = [statText(h.stats?.[k], lang), pingText(h.ping?.[k], lang)].filter((x) => x !== null).map((x) => x.text)
    const noteText = notes.length ? (en ? ` (${notes.join(' · ')})` : `（${notes.join(' · ')}）`) : ''
    const mine = active === k ? (en ? '  ← in use' : '  ← 使用中') : ''
    rows.push(`  ${active === k ? '●' : '○'} /provider ${k.padEnd(8)} ${m}${noteText}${mine}`)
  }
  if (Object.keys(h.providers).length === 0) {
    rows.push(en
      ? '  (no provider is usable yet: every request goes to Claude; /provider setup adds one)'
      : '  （還沒有可用的供應商：所有請求都走 Claude；/provider setup 可以新增）')
  }
  return rows
}

// The switches every window shares, and where each Claude alias goes, on one line
function sharedLine(h: Health, lang: 'zh' | 'en'): string {
  const en = lang === 'en'
  const sw = h.switches
  const onOff = (on: boolean) => (on ? `● ${en ? 'on' : '開啟'}` : `○ ${en ? 'off' : '關閉'}`)
  const foOn = sw ? sw.failover : true
  const chain = h.failoverChain.length ? h.failoverChain.join(' → ') : en ? 'nobody to hand over to' : '沒有接手者'
  const parts = [
    `${en ? '429 failover' : '429 備援'} ${onOff(foOn)}${foOn ? (en ? ` (${chain})` : `（${chain}）`) : ''}`,
    `${en ? 'Retry' : '失敗重試'} ${onOff(!sw || sw.retry)}`,
    `${en ? 'Remote Control' : '手機遙控'} ${onOff(!!sw?.proxy)}`,
  ]
  const aliases = Object.entries(h.aliases).filter(([, p]) => has(h.providers, p)).map(([slot, p]) => `${slot} → ${p}`)
  if (aliases.length) parts.push(`${en ? 'Aliases' : '別名'} ${aliases.join(en ? ', ' : '、')}`)
  return `${en ? 'Shared by every window: ' : '所有視窗共用：'}${parts.join(en ? ' · ' : '・')}`
}

// /provider status: where this window goes, what every window shares, and what to fix; the commands are in /provider help
export function providerReport(h: Health | null, now: number, lang: 'zh' | 'en' = 'zh'): string {
  const en = lang === 'en'
  if (!h) {
    return en
      ? 'Relay is not responding; auto-restarting every 10s.'
      : '轉發站沒有回應；每 10 秒會自動重啟，稍後再試。'
  }
  let head = statusText(h, false, lang)
  if (h.failoverSince) {
    const mins = Math.max(0, Math.round((h.nextClaudeTry - now) / 60000))
    head += en
      ? ` (retrying Claude in ~${mins}m; only new sessions switch back)`
      : `（約 ${mins} 分鐘後再試 Claude，恢復後只有新對話回到 Claude）`
  }
  return [
    head,
    sharedLine(h, lang),
    ...healthHints(h, lang).map((x) => `⚠ ${x}`),
    '',
    en ? 'Switch this window:' : '切換這個視窗：',
    ...routeRows(h, lang, true),
    '',
    en ? 'All commands: /provider help' : '所有指令：/provider help',
  ].join('\n')
}

// /provider ping: each provider with what its test came to
export function pingReport(h: Health | null, lang: 'zh' | 'en' = 'zh'): string {
  if (!h) return providerReport(null, 0, lang)
  return [lang === 'en' ? 'Test results:' : '測試結果：', ...routeRows(h, lang, false)].join('\n')
}

// /provider help: every command, grouped by what it reaches
export function helpText(providers: string[], lang: 'zh' | 'en' = 'zh'): string {
  const en = lang === 'en'
  const groups: [string, [string, string][]][] = [
    [en ? 'This window:' : '這個視窗：', [
      ['/provider', en ? "Open the panel to switch this window's model" : '開啟面板，切換這個視窗的模型'],
      ['/provider <name> | claude', en ? 'Switch this window directly (e.g. /provider claude)' : '直接切換這個視窗（例：/provider claude）'],
      ['/provider status', en ? 'The same status as text' : '文字版狀態'],
      ['/provider avatar', en ? "Show or hide the picture of this window's model (config key avatars)" : '開關這個視窗模型的頭像面板（設定檔的 avatars）'],
    ]],
    [en ? 'Shared by every window:' : '所有視窗共用：', [
      ['/provider failover <on|off|a,b>', en ? 'Turn 429 failover on or off, or set who takes over' : '開關 429 備援或設定接手順序'],
      ['/provider retry <on|off>', en ? 'Turn automatic provider retries on or off' : '開關供應商失敗自動重試'],
      ['/provider rc <on|off>', en ? 'Turn Remote Control proxy mode on or off (new sessions)' : '開關手機遙控代理模式（新對話生效）'],
      ['/provider alias [haiku <name|claude>]', en ? 'View or point a Claude model alias' : '查看或設定別名分流'],
      ['/provider probe', en ? 'Reset the 429 cooldown so the next new session tries Claude' : '重置 429 冷卻，下一個新對話先試 Claude'],
    ]],
    [en ? 'Setup and checks:' : '設定與檢查：', [
      ['/provider ping', en ? 'Test every provider: does it answer, and how soon' : '測試每個供應商：能不能回應、多快開始回應'],
      ['/provider setup [goal]', en ? 'Let Claude walk you through setup (e.g. /provider setup add deepseek)' : '讓 Claude 帶你設定（例：/provider setup 加上 deepseek）'],
      ['/provider doctor [--ping] [--fix]', en ? 'Check the config, Claude Code settings and the relay; changes nothing unless --fix (wires settings.json)' : '檢查設定檔、Claude Code 設定與轉發站；不加 --fix 不會改任何東西（--fix 會設定 settings.json）'],
      ['/provider restart', en ? 'Restart the relay so it runs this plugin version' : '重啟轉發站，讓它跑這個外掛版本的程式'],
      ['/provider init', en ? 'Create an empty config' : '建立空的設定檔'],
    ]],
  ]
  const width = Math.max(...groups.flatMap(([, rows]) => rows.map(([cmd]) => cmd.length)))
  const lines = groups.flatMap(([title, rows]) => [title, ...rows.map(([cmd, desc]) => `  ${cmd.padEnd(width)}  ${desc}`)])
  if (providers.length) {
    const names = providers.map((k) => `model-relay:${k}`).join(en ? ', ' : '、')
    lines.push(en
      ? `Subagents: subagent_type "model-relay:<name>" runs a full Agent on that provider (${names})`
      : `子代理：subagent_type "model-relay:<名稱>" 派出等同預設 Agent 的子代理並走該供應商（${names}）`)
  }
  return lines.join('\n')
}

export interface ProviderAgentSpec extends AgentOptions {
  name: string
  description: string
  prompt: string
  model: string
}

const DEFAULT_AGENT_PROMPT =
  "You are an agent for Claude Code, Anthropic's official CLI for Claude. Given the user's message, use the available tools to complete the task fully and report your findings and changes clearly and concisely."

// Builds one `$.agent.register` spec per provider the router serves. `tools` is omitted so the subagent inherits every
// tool the parent has (identical to the built-in general-purpose Agent), while `model` is set to the provider's model ID.
// `options` holds each provider's "agent" object from the config: what it sets replaces these defaults as written.
export function providerAgentSpecs(providers: Record<string, string>, options: Record<string, AgentOptions> = {}): ProviderAgentSpec[] {
  return Object.entries(providers).map(([name, model]) => ({
    description: `General-purpose agent routed to ${name} (${model}) via model-relay. Same full toolset as the default Agent tool.`,
    prompt: DEFAULT_AGENT_PROMPT,
    ...(has(options, name) ? options[name] : {}),
    name,
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
