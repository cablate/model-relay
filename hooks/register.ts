import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, UiOpenResult } from 'claude-code'
import type { AvatarEntry, AvatarView, PanelNote, PanelUi } from '../types'
import {
  AVATAR_EMPTY,
  AVATAR_START,
  CONFIG_NAME,
  OLD_CONFIG_NAME,
  PING_LIMIT_S,
  accountAnswer,
  accountArgv,
  accountLimitedText,
  accountRefusedText,
  accountServingText,
  selfServingText,
  accountNames,
  agentProviders,
  apiOnlyToastText,
  avatarArgv,
  avatarBytes,
  avatarLabel,
  avatarMade,
  avatarName,
  avatarScratch,
  avatarSource,
  avatarWanted,
  base64ToBytes,
  buildPanelData,
  elsewhereText,
  expandHome,
  foreignConfigDir,
  foreignStatusText,
  has,
  healthArgv,
  healthWaitArgv,
  helpText,
  limitToastText,
  missedRelayText,
  outdatedText,
  parseHealth,
  parseLocal,
  pingArgv,
  pingReport,
  probeArgv,
  providerAgentSpecs,
  providerAgentOptions,
  providerReport,
  rasterCells,
  reachedRelay,
  relayConfigDir,
  relayAgent,
  routerIsStale,
  routerScript,
  routerUrl,
  sessionAnswer,
  sessionArgv,
  sessionRefusedText,
  setupBrief,
  setupCliArgv,
  setupCommandArgs,
  setupScript,
  shownAs,
  spawnedElsewhere,
  staleStatusText,
  startArgv,
  startFailedText,
  statusFields,
  statusFile,
  statusText,
  switchedText,
  switchPlan,
  switchRefusal,
  toggleArgv,
  wantsApiOnlyToast,
  wantsLimitToast,
  type AvatarAim,
  type AvatarWant,
  type Health,
  type LocalCfg,
} from './logic'
import { avatarTree } from './avatar'
import { panelTree, type PanelActions } from './panel'

const panelUi = atom(
  { plugin: 'model-relay', key: 'panelUi' } as const,
  { open: false, confirmingClaude: false, pinging: false } satisfies PanelUi,
)
const panelData = atom({ plugin: 'model-relay', key: 'panelData' } as const, null)
// Change the tag when AvatarView's fields change: a value an earlier version stored outlives a reload
const avatarView = atom({ plugin: 'model-relay', key: 'avatarView' } as const, AVATAR_EMPTY, { shape: 'avatar-2' })
// Asks for a wide dock: the picture has more cells to draw glyphs in the wider it is (the engine keeps it to 45% of the terminal)
const AVATAR_PANE = 'model-relay-avatar'
const AVATAR_OPEN = { id: AVATAR_PANE, title: 'model-relay avatar', columns: 80 }

let ticking = false
let shownStatus: string | undefined = ''
let statusBar = false // the config's "statusBar", read each tick
let writtenStatus = '' // path and line last written, so a new session id writes its own file at once
let statusDir: string | undefined
let writtenStatusAt = 0
let lastStart = 0
let direct = false // this session bypasses a dead router and talks to Anthropic itself
let startFailed = false // the router was started and did not answer; said once until it answers again
let registeredSig: string | null = null
let pluginVersion: string | null = null
let lastStaleTry = 0
let staleBusy = false // the router runs older code but was answering a request when we last tried to replace it
let outdatedTold = false // the toast about an older config, once per session
let limitTold = false // accountFallback "switch": the toast about the main account's limit, once per session
let apiOnlyTold = false // accountFallback "api-only": the toast about a window the wrapper did not start, once per session
// Whether a person is at this session (session.start's isInteractive: false under -p and the SDK); /provider switch
// writes a handoff only then
let interactive = false
// The second account this window belongs to (mode switch, its own config dir is that account's configDir), else null;
// found each tick. Its Claude requests are registered with the router by sid and skip main's failover.
let windowAccount: string | null = null
// This window's own and the relay's config dirs as they resolve, found once (neither changes while the window runs);
// not kept while they cannot be resolved
let ownReal: string | undefined
let relayReal: string | undefined
// When this window first saw each sid it registers as its account (ms), by sid, sent again if the router forgets that sid.
// A sid first registered later (a /resume inside the window changes it) has no time: the router counts it from now.
const accountSince = new Map<string, number>()
let accountRefusedAt = 0 // the router last refused this window's registration: asked again a minute later at most
let accountRefusalTold = false // its hint, once per session
let servingTold: string | null = null // the fallback account the router last reported for this window: one toast per move there
let accountLimitedTold = false // an account window at its usage limit with nobody to go to: told once per limit
// The providers our own router last reported; kept through an outage so a model-relay:<name> spawn still gets its model
let knownProviders: Record<string, string> = {}
let knownAccounts: string[] = [] // second Claude accounts: /provider choices with no subagent
// model-relay:<name> subagents started and not finished yet, by agentId: checked against the router when their turn ends
const pending = new Map<string, { name: string; model: string; since: number }>()
let avatarEntries: Record<string, AvatarEntry> = {} // the config's "avatars", read each tick
let avatarAim: AvatarAim = AVATAR_START // what the avatar pane is asked to show; its view catches up
let avatarBusy = false // a conversion is running: one at a time
let avatarSwitch: boolean | null = null // the config's "avatarPane" (with pictures to show) as last followed; null before the first tick
// The last pictures made, by what they were made from, so switching back to a model draws at once; reopening the pane empties it
const avatarMemo = new Map<string, string>()
const AVATAR_MEMO_SIZE = 8

// Matched before provider names, so a provider can never take one of these words (setup.mjs refuses "switch" as a name)
const COMMAND_WORDS = ['claude', 'status', 'help', 'ping', 'setup', 'doctor', 'restart', 'failover', 'retry', 'rc', 'alias', 'avatar', 'switch']

async function myVersion($: EngineInterface): Promise<string> {
  if (pluginVersion === null) {
    try {
      pluginVersion = String(JSON.parse(await $.fs.read(`${$.plugin.root}/.claude-plugin/plugin.json`)).version ?? '')
    } catch {
      pluginVersion = ''
    }
  }
  return pluginVersion
}

// One model-relay:<name> agent per provider, and the provider names in /provider's hint; redone when the router's list changes
// A second Claude account (kind "anthropic") gets no agent but is still one of /provider's choices.
async function syncProviders($: EngineInterface, providers: Record<string, string>, kinds: Record<string, string> = {}): Promise<void> {
  const agents = agentProviders(providers, kinds)
  knownProviders = agents
  knownAccounts = accountNames(providers, kinds)
  let options: ReturnType<typeof providerAgentOptions> = {}
  try {
    options = providerAgentOptions(JSON.parse(await $.fs.read(`${await configDir($)}/${CONFIG_NAME}`)))
  } catch {}
  const specs = providerAgentSpecs(agents, options)
  // The picker's names are part of it: a Claude account added alone changes no agent but must reach the hint
  const sig = JSON.stringify([specs, Object.keys(providers)])
  if (sig === registeredSig) return
  const plain = providerAgentSpecs(agents)
  for (const [i, spec] of specs.entries()) {
    const ok = await $.agent.register(spec).then(() => true, () => false)
    // Claude Code refused this provider's "agent" fields: keep the agent with the defaults rather than lose it
    if (!ok && has(options, spec.name)) {
      await $.agent.register(plain[i]!).catch(() => undefined)
      const lang = await detectLang($)
      $.ui.toast(lang === 'en'
        ? `Claude Code refused providers.${spec.name}.agent in model-relay.json; model-relay:${spec.name} uses the defaults`
        : `Claude Code 不接受 model-relay.json 的 providers.${spec.name}.agent，model-relay:${spec.name} 先用預設值`)
    }
  }
  await $.command.register({
    name: 'provider',
    description: '切換這個視窗的模型（不帶參數開面板，/provider help 看全部指令）',
    argumentHint: `[${[...Object.keys(providers), ...COMMAND_WORDS].join('|')}]`,
  })
  registeredSig = sig
}

async function isWindows($: EngineInterface): Promise<boolean> {
  const os = await $.env.get('OS')
  const up = await $.env.get('USERPROFILE')
  return Boolean((os && /windows/i.test(os)) || up)
}

async function detectLang($: EngineInterface): Promise<'zh' | 'en'> {
  try {
    const s = await $.settings.read()
    const lang = String((s as Record<string, unknown>)?.language ?? '')
    if (/zh|繁體|中文|traditional/i.test(lang)) return 'zh'
    if (/en|english/i.test(lang)) return 'en'
  } catch {}
  return 'zh'
}

const homeDir = async ($: EngineInterface) => (await $.env.get('USERPROFILE')) || (await $.env.get('HOME')) || ''
const realPathOf = async ($: EngineInterface, p: string) => (await $.fs.stat(p, { resolve: true }).catch(() => undefined))?.realPath

// This window's own config dir: where Claude Code keeps its login, and where status files go for a statusline to find
async function ownConfigDir($: EngineInterface): Promise<string> {
  const dir = await $.env.get('CLAUDE_CONFIG_DIR')
  return (dir || `${await homeDir($)}/.claude`).replace(/\\/g, '/')
}

// The relay's config dir: the config, the router this window uses and starts, its logs, avatars and the setup CLI's
// target. MODEL_RELAY_CONFIG_DIR (a second account's window, pointed at main's dir) when absolute and resolvable, else
// the window's own dir, as before
async function configDir($: EngineInterface): Promise<string> {
  const given = await $.env.get('MODEL_RELAY_CONFIG_DIR')
  const resolved = Boolean(given) && Boolean(await realPathOf($, given!))
  return relayConfigDir(given, resolved, await ownConfigDir($))
}

// What every setup.mjs run gets: the relay's config dir, whatever this window's own is
const setupEnv = async ($: EngineInterface) => ({ CLAUDE_CONFIG_DIR: await configDir($), MODEL_RELAY_CONFIG_DIR: '' })

// The account whose configDir is this window's own config dir, in mode switch; else null. An account whose configDir
// is the relay's own dir never matches (as tools/launch.mjs isAccountDir): that dir's login is main's
async function findWindowAccount($: EngineInterface, cfg: LocalCfg): Promise<string | null> {
  if (cfg.fallback.mode !== 'switch') return null
  const own = (ownReal ||= await realPathOf($, await ownConfigDir($)))
  if (!own) return null
  const relay = (relayReal ||= await realPathOf($, await configDir($)))
  const home = await homeDir($)
  for (const [name, dir] of Object.entries(cfg.fallback.accounts)) {
    const real = await realPathOf($, expandHome(dir, home))
    if (real === own && real !== relay) return name
  }
  return null
}

// Keeps the router's record of this sid right: registered as this window's account, or not registered at all (a main
// window resuming a sid an account window had). true when the router took a change. A refusal is not retried for a
// minute, and its reason is shown once.
async function syncAccount($: EngineInterface, cfg: LocalCfg, h: Health): Promise<boolean> {
  if (cfg.fallback.mode !== 'switch') return false
  const sid = await $.session.id()
  if (!windowAccount) accountSince.clear()
  else if (h.account === windowAccount && !accountSince.has(sid)) accountSince.set(sid, Date.now())
  if (windowAccount ? h.account === windowAccount : !h.account) return false
  if (Date.now() - accountRefusedAt < 60000) return false
  const asked = Date.now()
  const r = await $.process.run(accountArgv(cfg, sid, windowAccount, await isWindows($), accountSince.get(sid)), { timeoutMs: 5000 }).catch(() => null)
  const answer = accountAnswer(r ? r.exitCode : null, r ? r.stdout : '')
  if (windowAccount && answer.result === 'changed' && !accountSince.has(sid)) accountSince.set(sid, asked)
  if (answer.result === 'refused') {
    accountRefusedAt = Date.now()
    if (!accountRefusalTold && windowAccount) {
      accountRefusalTold = true
      $.ui.toast(accountRefusedText(windowAccount, answer.why, await detectLang($)))
    }
  }
  return answer.result === 'changed'
}

// The hook itself just started or restarted the router, which knows no registration yet: register now, not a tick later
async function resyncAccount($: EngineInterface, cfg: LocalCfg): Promise<Health | null> {
  windowAccount = await findWindowAccount($, cfg)
  const h = await health($, cfg)
  return h && (await syncAccount($, cfg, h)) ? (await health($, cfg)) ?? h : h
}

// The status of this window: under its account when the router has it registered as that account's window
const accountLabel = (h: Health | null) => (windowAccount && h && h.account === windowAccount ? windowAccount : null)
// selfServing is the relay's own account's, never an account window's (one whose registration did not take)
const ownView = (h: Health | null) => (h && windowAccount ? { ...h, selfServing: undefined } : h)
const sText = (h: Health | null, direct: boolean, lang: 'zh' | 'en') => statusText(ownView(h), direct, lang, accountLabel(h))
const sFields = (h: Health | null, direct: boolean, foreign = false) => statusFields(ownView(h), direct, foreign, accountLabel(h))

async function readLocal($: EngineInterface): Promise<LocalCfg | null> {
  const base = await configDir($)
  const read = async (name: string) => JSON.parse(await $.fs.read(`${base}/${name}`)) as unknown
  let cfg: LocalCfg | null = null
  try {
    cfg = parseLocal(await read(CONFIG_NAME))
  } catch {}
  if (!cfg) {
    try {
      cfg = parseLocal(await read(OLD_CONFIG_NAME), true)
    } catch {}
  }
  if (cfg) {
    statusBar = cfg.statusBar
    avatarEntries = cfg.avatars
  }
  return cfg
}

async function health($: EngineInterface, cfg: LocalCfg): Promise<Health | null> {
  try {
    const win = await isWindows($)
    const r = await $.process.run(healthArgv(cfg, await $.session.id(), win), { timeoutMs: 5000 })
    return r.exitCode === 0 ? parseHealth(r.stdout) : null
  } catch {
    return null
  }
}

// Writes this session's relay state for statusline tools (statusFields), when it changes and at least daily so the
// router's sweep of week-old files never takes a live session's; then draws the plugin status line, only when the
// config asks for it ("statusBar": true).
async function showStatus($: EngineInterface, text: string, fields: [string, string]): Promise<void> {
  // the session id is asked each time: /clear and an in-process resume go on under a new one without session.start
  statusDir ??= await ownConfigDir($)
  const file = statusFile(statusDir, await $.session.id(), fields)
  if (file && (`${file.path}\n${file.line}` !== writtenStatus || Date.now() - writtenStatusAt > 86400000)) {
    try {
      await $.fs.write(file.path, file.line)
      writtenStatus = `${file.path}\n${file.line}`
      writtenStatusAt = Date.now()
    } catch {}
  }
  const shown = statusBar ? text : undefined
  if (shown === shownStatus) return
  shownStatus = shown
  $.ui.status(shown)
}

// One avatar view from what is wanted: the pixels from ffmpeg as cells, or a view that says why there are none
async function makeAvatar($: EngineInterface, want: AvatarWant): Promise<AvatarView> {
  const view: AvatarView = { ...want, cells: null, error: null }
  if (!want.entry) return { ...view, error: 'unset' }
  if (want.cols < 1) return view
  const key = JSON.stringify([want.entry, want.mode, want.cols, want.rows])
  const known = avatarMemo.get(key)
  if (known) return { ...view, cells: known }
  try {
    const dir = await configDir($)
    const out = avatarScratch(dir, await $.session.id())
    await $.fs.write(out, '') // makes the folder ffmpeg writes into
    const run = await $.process.run(avatarArgv(avatarSource(dir, want.entry.image), out, want.mode, want.entry.head, want.cols, want.rows), { timeoutMs: 20000 })
    if (run.exitCode !== 0) return { ...view, error: 'failed' }
    const rgba = base64ToBytes((await $.fs.read(out, { as: 'bytes' })).base64)
    await $.fs.write(out, '').catch(() => undefined) // the pixels are held now; one empty file per window stays
    if (rgba.length !== avatarBytes(want.cols, want.rows)) return { ...view, error: 'failed' }
    const cells = rasterCells(rgba, want.cols, want.rows)
    avatarMemo.set(key, cells)
    if (avatarMemo.size > AVATAR_MEMO_SIZE) avatarMemo.delete(avatarMemo.keys().next().value!)
    return { ...view, cells }
  } catch {
    return { ...view, error: 'failed' }
  }
}

// Brings the avatar view up to what is wanted, one conversion at a time. A result is kept only if the wish did not move
// while ffmpeg ran, and the loop then goes round for the new wish; the pass limit is only a stop for a loop that cannot end.
async function pumpAvatar($: EngineInterface): Promise<void> {
  if (avatarBusy) return
  avatarBusy = true
  try {
    for (let pass = 0; pass < 8; pass++) {
      const have = await read($, avatarView)
      if (avatarMade(have, avatarWanted(avatarAim, avatarEntries))) return
      const view = await makeAvatar($, avatarWanted(avatarAim, avatarEntries))
      if (avatarMade(view, avatarWanted(avatarAim, avatarEntries))) await update($, avatarView, () => view)
    }
  } catch {
  } finally {
    avatarBusy = false
  }
}

// Points the avatar pane at the persona this window talks to now. Until the pane has drawn once there is no body to
// convert for, and its first draw starts the conversion.
function followAvatar($: EngineInterface, h: Health | null, foreign = false): void {
  const name = avatarName(h, foreign)
  avatarAim = { ...avatarAim, name, label: avatarLabel(name, h?.providers ?? {}) }
  if (avatarAim.body) void pumpAvatar($)
}

// The pane's draw is what tells the body its picture goes in
function sizeAvatar($: EngineInterface, props: { bodyColumns: number; placement: 'dock' | 'inline'; scroll: { bodyRows: number } }): void {
  avatarAim = { ...avatarAim, body: { placement: props.placement, columns: props.bodyColumns, rows: props.scroll.bodyRows } }
  void pumpAvatar($)
}

// A reopened pane tries again: the image may have changed, or ffmpeg got onto PATH
async function openAvatar($: EngineInterface): Promise<UiOpenResult> {
  avatarMemo.clear()
  await update($, avatarView, () => AVATAR_EMPTY)
  return $.ui.open(AVATAR_OPEN)
}

async function closeAvatar($: EngineInterface): Promise<void> {
  avatarAim = { ...avatarAim, body: null }
  await $.ui.close({ id: AVATAR_PANE }).catch(() => undefined)
}

// The "avatarPane" switch every window shares: turned on (or found on at the start) it opens the pane here, turned off it
// closes it, within a tick of the change. Unchanged, it leaves alone a pane /provider avatar opened or closed.
async function followAvatarSwitch($: EngineInterface, cfg: LocalCfg): Promise<void> {
  const on = cfg.avatarPane && Object.keys(cfg.avatars).length > 0
  if (on === avatarSwitch) return
  const was = avatarSwitch
  avatarSwitch = on
  if (on) await openAvatar($).catch(() => undefined)
  else if (was) await closeAvatar($)
}

// /provider avatar closes the pane when it is drawn and opens it otherwise; a command is the person asking, so it is placed at any width
async function toggleAvatar($: EngineInterface, lang: 'zh' | 'en'): Promise<string> {
  const en = lang === 'en'
  if ((await $.ui.panes()).some((p) => p.id === AVATAR_PANE && p.isPlaced)) {
    await closeAvatar($)
    return en ? 'Avatar pane closed.' : '頭像面板已關閉。'
  }
  const opened = await openAvatar($)
  if (opened.isPlaced) return en ? 'Avatar pane open.' : '頭像面板已開啟。'
  return en ? `Avatar pane is open but not drawn yet: ${opened.reason}` : `頭像面板已開啟，但還沒畫出來：${opened.reason}`
}

async function syncPanelData($: EngineInterface, cfg: LocalCfg, h: Health | null, lang: 'zh' | 'en'): Promise<void> {
  try {
    const ui = await read($, panelUi)
    if (!ui.open) return
    const snap = buildPanelData(ownView(h), cfg.port, direct, lang, Date.now(), cfg.outdated, accountLabel(h), await isWindows($))
    await update($, panelData, () => snap)
  } catch {}
}

async function setPanelNote($: EngineInterface, note: PanelNote | undefined): Promise<void> {
  try {
    await update($, panelUi, ({ confirmingClaude: _c, confirmingProxy: _p, note: _n, ...u }) => (note ? { ...u, confirmingClaude: false, note } : { ...u, confirmingClaude: false }))
  } catch {}
}

// Opened fresh each time: no note or open confirmation from last time, the shared settings folded away
async function openPanel($: EngineInterface, cfg: LocalCfg, h: Health | null, lang: 'zh' | 'en'): Promise<void> {
  const win = await isWindows($)
  await update($, panelData, () => buildPanelData(ownView(h), cfg.port, direct, lang, Date.now(), cfg.outdated, accountLabel(h), win))
  await update($, panelUi, ({ note: _n, ...u }) => ({ ...u, open: true, confirmingClaude: false, confirmingProxy: false, showSettings: false }))
}

// Our router answered: it is the one source of what providers exist
async function ours($: EngineInterface, cfg: LocalCfg, h: Health, lang: 'zh' | 'en'): Promise<void> {
  startFailed = false
  await syncProviders($, h.providers, h.kinds)
  await syncPanelData($, cfg, h, lang)
  followAvatar($, h)
}

// Keeps the router alive; when it cannot be brought back, this session talks to
// Anthropic directly until the router answers again.
async function tick($: EngineInterface): Promise<void> {
  if (ticking) return
  ticking = true
  try {
    const cfg = await readLocal($)
    if (!cfg) return
    await followAvatarSwitch($, cfg)
    const lang = await detectLang($)
    const seen = await health($, cfg)
    // Another config dir's router on our port is not ours: never route through it, same as a router that is down
    const other = foreignConfigDir(seen, await configDir($), await isWindows($))
    if (other) {
      if (!direct && (await $.env.get('ANTHROPIC_BASE_URL')) === routerUrl(cfg)) {
        direct = true
        await $.env.set('ANTHROPIC_BASE_URL', undefined)
        $.ui.toast(lang === 'en' ? `Port ${cfg.port} belongs to another relay (${other}); connected directly to Claude` : `連接埠 ${cfg.port} 屬於另一個轉發站（${other}），主線直連 Claude`)
      }
      await showStatus($, foreignStatusText(other, lang), sFields(null, direct, true))
      followAvatar($, null, true)
      return
    }
    windowAccount = await findWindowAccount($, cfg)
    const h = seen && (await syncAccount($, cfg, seen)) ? (await health($, cfg)) ?? seen : seen
    if (cfg.outdated && !outdatedTold) {
      outdatedTold = true
      $.ui.toast(outdatedText(lang))
    }
    if (!apiOnlyTold && !windowAccount && cfg.fallback.mode === 'api-only' && wantsApiOnlyToast(cfg.fallback.mode, await $.env.get('MODEL_RELAY_WRAPPER_ID'))) {
      apiOnlyTold = true
      $.ui.toast(apiOnlyToastText(lang))
    }
    if (h) {
      // an account window's fallback account, or, in a main window, the relay's own account's
      const own = !windowAccount && !h.account ? h.selfServing ?? null : null
      const serving = accountLabel(h) ? h.accountServing ?? null : own
      if (serving && serving !== servingTold) $.ui.toast(own ? selfServingText(own, lang) : accountServingText(windowAccount!, serving, lang))
      servingTold = serving
    }
    // an account window at its own usage limit with nobody to go to: Claude Code's limit text says nothing of what to do
    if (h && accountLabel(h) && h.accountLimited && !h.accountServing) {
      if (!accountLimitedTold) {
        accountLimitedTold = true
        $.ui.toast(accountLimitedText(windowAccount!, lang))
      }
    } else accountLimitedTold = false
    if (!limitTold && !windowAccount && wantsLimitToast(cfg.fallback.mode, h, Date.now())) {
      limitTold = true
      $.ui.toast(limitToastText(lang))
    }
    // `plugin update` leaves the old router running, and the hook only starts one when none answers; replace it here,
    // but only while it answers nothing (setup.mjs restart --if-idle), so no other session loses a reply. A router from
    // 0.6.0 or earlier cannot report that, so it is only pointed out: /provider restart is the person's call. With an
    // older config nothing is replaced: the router that answers may be the last one that still reads it.
    const stale = !cfg.outdated && routerIsStale(h, await myVersion($))
    if (!stale) staleBusy = false
    else if (h && typeof h.inflight !== 'number') {
      if (!staleBusy) $.ui.toast(staleStatusText(lang))
      staleBusy = true
    } else if (Date.now() - lastStaleTry > 60000) {
      lastStaleTry = Date.now()
      const r = await $.process.run([cfg.nodePath, setupScript($.plugin.root), 'restart', '--if-stale', '--if-idle'], { env: await setupEnv($), timeoutMs: 30000 }).catch(() => null)
      staleBusy = r?.exitCode === 3
      if (r?.exitCode === 0) {
        $.ui.toast(lang === 'en' ? 'The relay was restarted to run this plugin version' : '轉發站已重啟，改跑這個外掛版本的程式')
        await resyncAccount($, cfg)
        return // the next tick reads the new router
      }
    }
    if (h) {
      if (direct) {
        direct = false
        await $.env.set('ANTHROPIC_BASE_URL', routerUrl(cfg))
        $.ui.toast(lang === 'en' ? 'Relay recovered; routing through local relay' : '轉發站恢復，主線重新經由轉發站')
      }
      const note = cfg.outdated ? outdatedText(lang) : staleBusy ? staleStatusText(lang) : ''
      await showStatus($, note ? `${sText(h, false, lang)} · ${note}` : sText(h, false, lang), sFields(h, false))
      await ours($, cfg, h, lang)
      return
    }
    // This version's router does not read an older config, so none is started for one
    if (!cfg.outdated && Date.now() - lastStart > 15000) {
      lastStart = Date.now()
      const win = await isWindows($)
      const dir = await configDir($)
      await $.process.run(startArgv(cfg, routerScript($.plugin.root), dir, win), { timeoutMs: 15000 }).catch(() => undefined)
      const up = await $.process.run(healthWaitArgv(cfg, await $.session.id(), win), { timeoutMs: 20000 }).catch(() => null)
      const started = up && up.exitCode === 0 ? parseHealth(up.stdout) : null
      const h2 = started && (await syncAccount($, cfg, started)) ? (await health($, cfg)) ?? started : started
      if (h2) {
        await showStatus($, sText(h2, false, lang), sFields(h2, false))
        await ours($, cfg, h2, lang)
        return
      }
      if (!startFailed) {
        startFailed = true
        $.ui.toast(startFailedText(dir, lang))
      }
    }
    if (!direct && (await $.env.get('ANTHROPIC_BASE_URL')) === routerUrl(cfg)) {
      direct = true
      await $.env.set('ANTHROPIC_BASE_URL', undefined)
    }
    await showStatus($, cfg.outdated ? `${sText(null, direct, lang)} · ${outdatedText(lang)}` : sText(null, direct, lang), sFields(null, direct))
    await syncPanelData($, cfg, null, lang)
    followAvatar($, null)
  } finally {
    ticking = false
  }
}

// After a model-relay:<name> subagent's turn: a router that reports what reached it says whether its model did
async function checkReached($: EngineInterface, p: { name: string; model: string; since: number }): Promise<void> {
  const cfg = await readLocal($)
  if (!cfg) return
  if (reachedRelay(await health($, cfg), p.model, p.since) === false) $.ui.toast(missedRelayText(p.name, p.model, await detectLang($)))
}

function panelActions($: EngineInterface): PanelActions {
  const good = (text: string): PanelNote => ({ text, ok: true })
  const bad = (text: string): PanelNote => ({ text, ok: false })
  const run = (work: () => Promise<PanelNote | undefined>) => {
    void work()
      .catch((err) => bad(String(err)))
      .then(async (note) => {
        const cfg = await readLocal($)
        if (cfg) {
          const lang = await detectLang($)
          const h = await health($, cfg)
          if (h) {
            await showStatus($, sText(h, false, lang), sFields(h, false))
            followAvatar($, h)
          }
          await syncPanelData($, cfg, h, lang)
        }
        await setPanelNote($, note)
      })
  }
  const close = () => update($, panelUi, (u) => ({ ...u, open: false, confirmingClaude: false, confirmingProxy: false }))
  return {
    // A switch that took is the panel's job done: it closes, and a toast (and the status line, when on) says where this window goes now
    switchTo: (target) =>
      run(async () => {
        const cfg = await readLocal($)
        const lang = await detectLang($)
        if (!cfg) return bad(lang === 'en' ? 'Config missing.' : '設定檔不存在。')
        const win = await isWindows($)
        const r = await $.process.run(sessionArgv(cfg, await $.session.id(), target, win), { timeoutMs: 8000 }).catch(() => null)
        const answer = sessionAnswer(r ? r.exitCode : null, r ? r.stdout : '')
        if (answer.result === 'refused') return bad(sessionRefusedText(answer.why, lang))
        if (answer.result === 'failed') return bad(lang === 'en' ? 'Relay did not respond; nothing changed.' : '轉發站沒有回應，沒有改變。')
        const h = await health($, cfg)
        await close()
        $.ui.toast(switchedText(target, (h && shownAs(h, target, lang)) ?? target, lang, accountLabel(h)))
        return undefined
      }),
    askClaude: (ask) => {
      void update($, panelUi, ({ note: _n, ...u }) => ({ ...u, confirmingClaude: ask }))
    },
    // The rows show what each test came to, so a test that ran needs no note of its own
    ping: () =>
      run(async () => {
        const ui = await read($, panelUi)
        if (ui.pinging) return undefined
        const cfg = await readLocal($)
        const lang = await detectLang($)
        if (!cfg) return undefined
        await update($, panelUi, ({ note: _n, ...u }) => ({ ...u, pinging: true }))
        try {
          const win = await isWindows($)
          const r = await $.process.run(pingArgv(cfg, '', win), { timeoutMs: (PING_LIMIT_S + 5) * 1000 }).catch(() => null)
          if (!r || r.exitCode !== 0) return bad(lang === 'en' ? 'Test failed: relay unreachable.' : '測試失敗：轉發站未回應。')
          return undefined
        } finally {
          await update($, panelUi, (u) => ({ ...u, pinging: false }))
        }
      }),
    probe: () =>
      run(async () => {
        const cfg = await readLocal($)
        const lang = await detectLang($)
        if (!cfg) return undefined
        const win = await isWindows($)
        await $.process.run(probeArgv(cfg, win), { timeoutMs: 5000 }).catch(() => null)
        return good(lang === 'en' ? '✓ Cooldown reset; the next new session tries Claude.' : '✓ 已重置冷卻，下一個新對話會先試 Claude。')
      }),
    settings: (show) => {
      void update($, panelUi, ({ note: _n, ...u }) => ({ ...u, showSettings: show, confirmingProxy: false }))
    },
    askProxy: (ask) => {
      void update($, panelUi, ({ note: _n, ...u }) => ({ ...u, confirmingProxy: ask }))
    },
    toggle: (which, on) =>
      run(async () => {
        const cfg = await readLocal($)
        const lang = await detectLang($)
        if (!cfg) return bad(lang === 'en' ? 'Config missing.' : '設定檔不存在。')
        const argv = toggleArgv(cfg, setupScript($.plugin.root), which, on)
        // The proxy switch restarts the router and tests the certificate, which takes a few seconds
        const r = await $.process.run(argv, { env: await setupEnv($), timeoutMs: which === 'proxy' ? 60000 : 15000 }).catch(() => null)
        if (!r || r.exitCode !== 0) {
          const why = (r?.stderr || r?.stdout || '').trim().split(/\r?\n/).pop() ?? ''
          return bad(lang === 'en' ? `Not changed: ${why || 'setup command failed'}` : `沒有變更：${why || '設定指令失敗'}`)
        }
        if (which === 'proxy') {
          if (cfg) await resyncAccount($, cfg) // the switch restarted the router
          return good(on
            ? (lang === 'en' ? '✓ Remote Control on; new Claude Code sessions use it.' : '✓ 已開啟手機遙控；開新的 Claude Code 對話後生效。')
            : (lang === 'en' ? '✓ Remote Control off; sessions already in proxy mode lose their connection.' : '✓ 已關閉手機遙控；已在代理模式執行的對話會斷線。'))
        }
        const name = which === 'failover' ? (lang === 'en' ? '429 failover' : '429 備援') : lang === 'en' ? 'Retry' : '失敗重試'
        return good(lang === 'en' ? `✓ ${name} ${on ? 'on' : 'off'} from the next request.` : `✓ ${name}已${on ? '開啟' : '關閉'}，下一個請求起生效。`)
      }),
    close: () => {
      void close()
    },
  }
}

// <relay dir>/model-relay-launch.mjs, the file an alias in place of claude runs, is kept pointing at this plugin version
// by "setup.mjs launcher" (the one place it is written: only when its text differs, never through a symlink). Nothing
// is done without a relay config, or in mode off: someone who uses no second account gets no file written.
async function refreshLauncher($: EngineInterface): Promise<void> {
  const cfg = await readLocal($)
  if (!cfg || cfg.fallback.mode === 'off') return
  await $.process.run(setupCliArgv(cfg, setupScript($.plugin.root), ['launcher']), { env: await setupEnv($), timeoutMs: 15000 }).catch(() => null)
}

export const register: Register = (on) => {
  on('session.start', async ($, e, next) => {
    interactive = e.isInteractive === true
    await syncProviders($, {}) // /provider exists even before the router answers; tick adds the providers
    await tick($)
    void refreshLauncher($).catch(() => {}) // the file is for the next alias use, not this session: nothing waits for it
    $.clock.every(10000, () => {
      void tick($).catch(() => {})
    })
    return next(e)
  })

  on('agent.spawn', async ($, e, next) => {
    if (e.fork || e.resume) return next(e)
    const relay = relayAgent(e.subagentType, knownProviders)
    if (!relay) return next(e)
    const since = Date.now()
    const r = await next({ ...e, model: relay.model })
    try {
      if (spawnedElsewhere(relay.model, r.model)) $.ui.toast(elsewhereText(relay.name, relay.model, r.model ?? '', await detectLang($)))
      else if (r.agentId) {
        pending.set(r.agentId, { ...relay, since })
        if (pending.size > 50) pending.delete(pending.keys().next().value!)
      }
    } catch {}
    return r
  }).catch(($, e, next) => (next.called ? next(e) : { deny: 'model-relay agent.spawn failed' }))

  on('turn.complete', ($, e, next) => {
    const p = e.agentId ? pending.get(e.agentId) : undefined
    if (p && e.agentId) {
      pending.delete(e.agentId)
      if (!e.isAborted) void checkReached($, p).catch(() => {})
    }
    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    try {
      const ui = await read($, panelUi)
      const data = ui.open && !e.props.hasSurvey ? await read($, panelData) : null
      return data
        ? panelTree($.ui.resolve(e), { ...data, ...ui, columns: e.props.bodyColumns }, panelActions($))
        : next(e)
    } catch {
      return next(e)
    }
  })

  on('ui.render', { component: 'Pane', requestId: AVATAR_PANE }, async ($, e, next) => {
    try {
      sizeAvatar($, e.props)
      return avatarTree($.ui.resolve(e), await read($, avatarView), e.props.bodyColumns, await detectLang($))
    } catch {
      return next(e)
    }
  })

  on('command.run', { command: 'provider' }, async ($, e) => {
    const cfg = await readLocal($)
    const lang = await detectLang($)
    const arg = e.args.trim().toLowerCase()
    // First-run setup works without a config, and without knowing where the plugin was installed
    const first = arg.split(/\s+/)[0] ?? ''
    if (first === 'setup') {
      const goal = e.args.trim().slice('setup'.length).trim()
      void $.prompt.submit({ text: setupBrief(setupScript($.plugin.root), cfg?.nodePath ?? 'node', goal, !!cfg, lang) })
      return { text: lang === 'en' ? 'Handing setup to Claude…' : '已交給 Claude 協助設定…' }
    }
    if (first === 'init' || first === 'doctor' || first === 'presets' || first === 'restart') {
      const r = await $.process.run([cfg?.nodePath ?? 'node', setupScript($.plugin.root), ...setupCommandArgs(first, arg)], { env: await setupEnv($), timeoutMs: 60000 }).catch(() => null)
      if (first === 'restart' && cfg) await resyncAccount($, cfg)
      const out = ((r?.stdout || '') + (r?.stderr || '')).trim()
      return { text: out || (lang === 'en' ? 'Setup command did not respond.' : '設定指令沒有回應。') }
    }
    if (arg === 'help') {
      // /provider switch is for a window of your own account in mode switch; an account's window is refused it
      const showSwitch = cfg?.fallback.mode === 'switch' && !(cfg && (await findWindowAccount($, cfg)))
      return { text: helpText(Object.keys(knownProviders), lang, knownAccounts, showSwitch) }
    }
    if (!cfg) {
      return {
        text: lang === 'en'
          ? 'There is no model-relay.json yet. Run /provider setup to let Claude walk you through it, or /provider init to create an empty one.'
          : '還沒有 model-relay.json。執行 /provider setup 讓 Claude 帶你設定，或 /provider init 建立一個空的設定檔。',
      }
    }
    const win = await isWindows($)

    // Bare `/provider` opens the panel and says only that; `panel` toggles it
    if (arg === '' || arg === 'panel') {
      if (arg === 'panel' && (await read($, panelUi)).open) {
        await update($, panelUi, (u) => ({ ...u, open: false, confirmingClaude: false, confirmingProxy: false }))
        return { text: lang === 'en' ? 'Panel closed.' : '面板已關閉。' }
      }
      await openPanel($, cfg, await health($, cfg), lang)
      const opened = lang === 'en' ? 'Panel open above the prompt (all commands: /provider help)' : '面板已開在輸入框上方（所有指令：/provider help）'
      return { text: cfg.outdated ? `${outdatedText(lang)}\n${opened}` : opened }
    }

    if (arg === 'status') {
      const h = await health($, cfg)
      return { text: `${cfg.outdated ? `${outdatedText(lang)}\n\n` : ''}${providerReport(ownView(h), Date.now(), lang, accountLabel(h), win)}` }
    }

    if (arg === 'avatar') return { text: await toggleAvatar($, lang) }

    if (arg === 'ping') {
      await $.process.run(pingArgv(cfg, '', win), { timeoutMs: (PING_LIMIT_S + 5) * 1000 }).catch(() => null)
      const h = await health($, cfg)
      await syncPanelData($, cfg, h, lang)
      return { text: pingReport(h, lang) }
    }

    if (arg === 'probe') {
      const r = await $.process.run(probeArgv(cfg, win), { timeoutMs: 5000 }).catch(() => null)
      await syncPanelData($, cfg, await health($, cfg), lang)
      if (!r || r.exitCode !== 0) return { text: lang === 'en' ? 'Relay did not respond; nothing changed.' : '轉發站沒有回應，沒有改變。' }
      return { text: lang === 'en' ? '✓ 429 cooldown reset; the next new session tries Claude.' : '✓ 已重置 429 冷卻，下一個新對話會先試 Claude。' }
    }

    const parts = arg.split(/\s+/).filter(Boolean)
    const head = parts[0] ?? ''
    // /provider switch [<account>]: a handoff for the launcher wrapper, or the command to resume by hand. Two separate
    // facts: a person is at this session (interactive; a -p run never is), and a person sent this command (typed at the
    // prompt, composer, or from Remote Control, bridge)
    if (head === 'switch') {
      if (await findWindowAccount($, cfg)) {
        return { text: lang === 'en' ? 'This window already runs on the second account; /provider switch is for windows of your own account. Nothing was changed.' : '這個視窗已經在第二個帳號上；/provider switch 是給你自己帳號的視窗用的。沒有做任何變更。' }
      }
      const typed = e.origin.kind === 'composer' || e.origin.kind === 'bridge'
      const home = await homeDir($) // ~ is the home configDir() uses
      const plan = switchPlan({ fallback: cfg.fallback, arg: parts.slice(1).join(' '), wrapperId: await $.env.get('MODEL_RELAY_WRAPPER_ID'), interactive, typed, sid: await $.session.id(), home, relayDir: await configDir($), isWin: win, setup: setupScript($.plugin.root) }, lang)
      if (plan.action === 'say') return { text: plan.text }
      // what the wrapper would refuse after /exit is refused now, before anything is written
      const ownDir = await ownConfigDir($)
      const acctDir = expandHome(cfg.fallback.accountDir, home).replace(/\\/g, '/')
      const refusal = switchRefusal({ account: cfg.fallback.account, ownDir, accountDir: acctDir, isWin: win, setup: setupScript($.plugin.root), real: { own: await realPathOf($, ownDir), account: await realPathOf($, acctDir), ownProjects: await realPathOf($, `${ownDir}/projects`), accountProjects: await realPathOf($, `${acctDir}/projects`) } }, lang)
      if (refusal) return { text: refusal }
      const r = await $.process.run(setupCliArgv(cfg, setupScript($.plugin.root), ['handoff', plan.wrapperId, plan.sid]), { env: { CLAUDE_CONFIG_DIR: await ownConfigDir($), MODEL_RELAY_CONFIG_DIR: '' }, timeoutMs: 15000 }).catch(() => null)
      if (!r || r.exitCode !== 0) {
        const why = ((r?.stderr || r?.stdout || '').trim().split(/\r?\n/).pop() ?? '') || (lang === 'en' ? 'the setup command did not run' : '設定指令沒有執行')
        return { text: lang === 'en' ? `The handoff was not written: ${why}` : `沒有寫入交接檔：${why}` }
      }
      return { text: plan.text }
    }
    // /provider avatar on|off: the switch every window shares, written to the config and followed here at once
    if (head === 'avatar') {
      const r = await $.process.run(setupCliArgv(cfg, setupScript($.plugin.root), ['set', 'avatarPane', parts[1] ?? '']), { env: await setupEnv($), timeoutMs: 15000 }).catch(() => null)
      const out = ((r?.stdout || '') + (r?.stderr || '')).trim()
      const cfgNext = (await readLocal($)) ?? cfg
      await followAvatarSwitch($, cfgNext)
      const none = cfgNext.avatarPane && Object.keys(cfgNext.avatars).length === 0
      const hint = none ? (lang === 'en' ? '\nThere is no picture to show yet: add "avatars" to model-relay.json (see the README).' : '\n還沒有可顯示的頭像：在 model-relay.json 加上 "avatars"（見 README）。') : ''
      return { text: (out || (lang === 'en' ? 'Setup command did not respond.' : '設定指令沒有回應。')) + hint }
    }
    if (head === 'alias' || head === 'failover' || head === 'retry' || head === 'rc' || head === 'proxy') {
      const script = setupScript($.plugin.root)
      let cliArgs: string[]
      if (head === 'alias') {
        cliArgs = ['alias', ...parts.slice(1)]
      } else if (head === 'failover') {
        const val = parts[1] ?? ''
        const isBool = ['on', 'off', 'true', 'false', '1', '0'].includes(val)
        cliArgs = val ? ['set', isBool ? 'failover.enabled' : 'failover.chain', val] : ['providers']
      } else if (head === 'retry') {
        cliArgs = parts[1] ? ['set', 'retry.enabled', parts[1]] : ['providers']
      } else {
        const val = parts[1] ?? 'status'
        const sub = ['on', 'enable', 'true', '1'].includes(val)
          ? 'enable'
          : ['off', 'disable', 'false', '0'].includes(val)
            ? 'disable'
            : val
        cliArgs = sub === 'enable' || sub === 'disable' ? ['proxy', sub, '--go'] : ['proxy', sub]
      }
      const r = await $.process.run(setupCliArgv(cfg, script, cliArgs), { env: await setupEnv($), timeoutMs: head === 'rc' || head === 'proxy' ? 60000 : 15000 }).catch(() => null)
      const out = ((r?.stdout || '') + (r?.stderr || '')).trim()
      const cfgNext = (await readLocal($)) ?? cfg
      // rc and proxy restart the router
      const h = head === 'rc' || head === 'proxy' ? await resyncAccount($, cfgNext) : await health($, cfgNext)
      if (h) {
        await showStatus($, sText(h, false, lang), sFields(h, false))
        followAvatar($, h)
      }
      await syncPanelData($, cfgNext, h, lang)
      return { text: out || (lang === 'en' ? 'Setup command did not respond.' : '設定指令沒有回應。') }
    }

    const h0 = await health($, cfg)
    const providers = h0?.providers ?? {}
    // In an account's window its own name means its own login, as 'claude' does
    const target = windowAccount && arg === windowAccount ? 'claude' : arg
    if (target === 'claude' || has(providers, target)) {
      const r = await $.process.run(sessionArgv(cfg, await $.session.id(), target, win), { timeoutMs: 8000 }).catch(() => null)
      const answer = sessionAnswer(r ? r.exitCode : null, r ? r.stdout : '')
      if (answer.result === 'refused') return { text: sessionRefusedText(answer.why, lang) }
      if (answer.result === 'failed') return { text: lang === 'en' ? 'Relay did not respond; nothing changed.' : '轉發站沒有回應，沒有改變。' }
      const h = await health($, cfg)
      if (h) {
        await showStatus($, sText(h, false, lang), sFields(h, false))
        followAvatar($, h)
      }
      await syncPanelData($, cfg, h, lang)
      return { text: switchedText(target, (h0 && shownAs(h0, target, lang)) ?? target, lang, windowAccount) }
    }
    const names = [...Object.keys(providers), windowAccount ?? 'claude'].join(lang === 'en' ? ', ' : '、')
    return {
      text: lang === 'en'
        ? `No provider or command "${arg}". Switch with /provider <${names}>; all commands: /provider help`
        : `沒有「${arg}」這個供應商或指令。切換用 /provider <${names}>；所有指令：/provider help`,
    }
  }).catch(() => ({ text: '/provider 執行失敗，設定未變更。' }))
}
