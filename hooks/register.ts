import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'
import type { PanelNote, PanelUi } from '../types'
import {
  CONFIG_NAME,
  OLD_CONFIG_NAME,
  PING_LIMIT_S,
  buildPanelData,
  elsewhereText,
  foreignConfigDir,
  foreignStatusText,
  has,
  healthArgv,
  healthWaitArgv,
  helpText,
  missedRelayText,
  outdatedText,
  parseHealth,
  parseLocal,
  pingArgv,
  pingReport,
  probeArgv,
  providerAgentSpecs,
  providerReport,
  reachedRelay,
  relayAgent,
  routerIsStale,
  routerScript,
  routerUrl,
  sessionArgv,
  setupBrief,
  setupCliArgv,
  setupScript,
  spawnedElsewhere,
  staleStatusText,
  startArgv,
  startFailedText,
  statusText,
  switchedText,
  toggleArgv,
  type Health,
  type LocalCfg,
} from './logic'
import { panelTree, type PanelActions } from './panel'

const panelUi = atom(
  { plugin: 'model-relay', key: 'panelUi' } as const,
  { open: false, confirmingClaude: false, pinging: false } satisfies PanelUi,
)
const panelData = atom({ plugin: 'model-relay', key: 'panelData' } as const, null)

let ticking = false
let shownStatus = ''
let lastStart = 0
let direct = false // this session bypasses a dead router and talks to Anthropic itself
let startFailed = false // the router was started and did not answer; said once until it answers again
let registeredSig: string | null = null
let pluginVersion: string | null = null
let lastStaleTry = 0
let staleBusy = false // the router runs older code but was answering a request when we last tried to replace it
let outdatedTold = false // the toast about an older config, once per session
// The providers our own router last reported; kept through an outage so a model-relay:<name> spawn still gets its model
let knownProviders: Record<string, string> = {}
// model-relay:<name> subagents started and not finished yet, by agentId: checked against the router when their turn ends
const pending = new Map<string, { name: string; model: string; since: number }>()

const COMMAND_WORDS = ['claude', 'status', 'help', 'ping', 'setup', 'doctor', 'restart', 'failover', 'retry', 'rc', 'alias']

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
async function syncProviders($: EngineInterface, providers: Record<string, string>): Promise<void> {
  knownProviders = providers
  const specs = providerAgentSpecs(providers)
  const sig = JSON.stringify(specs)
  if (sig === registeredSig) return
  for (const spec of specs) {
    await $.agent.register(spec).catch(() => undefined)
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

async function configDir($: EngineInterface): Promise<string> {
  const dir = await $.env.get('CLAUDE_CONFIG_DIR')
  const home = (await $.env.get('USERPROFILE')) || (await $.env.get('HOME')) || ''
  return (dir || `${home}/.claude`).replace(/\\/g, '/')
}

async function readLocal($: EngineInterface): Promise<LocalCfg | null> {
  const base = await configDir($)
  const read = async (name: string) => JSON.parse(await $.fs.read(`${base}/${name}`)) as unknown
  try {
    return parseLocal(await read(CONFIG_NAME))
  } catch {}
  try {
    return parseLocal(await read(OLD_CONFIG_NAME), true)
  } catch {
    return null
  }
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

async function showStatus($: EngineInterface, text: string): Promise<void> {
  if (text === shownStatus) return
  shownStatus = text
  $.ui.status(text)
}

async function syncPanelData($: EngineInterface, cfg: LocalCfg, h: Health | null, lang: 'zh' | 'en'): Promise<void> {
  try {
    const ui = await read($, panelUi)
    if (!ui.open) return
    const snap = buildPanelData(h, cfg.port, direct, lang, Date.now(), cfg.outdated)
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
  await update($, panelData, () => buildPanelData(h, cfg.port, direct, lang, Date.now(), cfg.outdated))
  await update($, panelUi, ({ note: _n, ...u }) => ({ ...u, open: true, confirmingClaude: false, confirmingProxy: false, showSettings: false }))
}

// Our router answered: it is the one source of what providers exist
async function ours($: EngineInterface, cfg: LocalCfg, h: Health, lang: 'zh' | 'en'): Promise<void> {
  startFailed = false
  await syncProviders($, h.providers)
  await syncPanelData($, cfg, h, lang)
}

// Keeps the router alive; when it cannot be brought back, this session talks to
// Anthropic directly until the router answers again.
async function tick($: EngineInterface): Promise<void> {
  if (ticking) return
  ticking = true
  try {
    const cfg = await readLocal($)
    if (!cfg) return
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
      await showStatus($, foreignStatusText(other, lang))
      return
    }
    const h = seen
    if (cfg.outdated && !outdatedTold) {
      outdatedTold = true
      $.ui.toast(outdatedText(lang))
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
      const r = await $.process.run([cfg.nodePath, setupScript($.plugin.root), 'restart', '--if-stale', '--if-idle'], { timeoutMs: 30000 }).catch(() => null)
      staleBusy = r?.exitCode === 3
      if (r?.exitCode === 0) {
        $.ui.toast(lang === 'en' ? 'The relay was restarted to run this plugin version' : '轉發站已重啟，改跑這個外掛版本的程式')
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
      await showStatus($, note ? `${statusText(h, false, lang)} · ${note}` : statusText(h, false, lang))
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
      const h2 = up && up.exitCode === 0 ? parseHealth(up.stdout) : null
      if (h2) {
        await showStatus($, statusText(h2, false, lang))
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
    await showStatus($, cfg.outdated ? `${statusText(null, direct, lang)} · ${outdatedText(lang)}` : statusText(null, direct, lang))
    await syncPanelData($, cfg, null, lang)
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
          if (h) await showStatus($, statusText(h, false, lang))
          await syncPanelData($, cfg, h, lang)
        }
        await setPanelNote($, note)
      })
  }
  const close = () => update($, panelUi, (u) => ({ ...u, open: false, confirmingClaude: false, confirmingProxy: false }))
  return {
    // A switch that took is the panel's job done: it closes, and a toast and the status line say where this window goes now
    switchTo: (target) =>
      run(async () => {
        const cfg = await readLocal($)
        const lang = await detectLang($)
        if (!cfg) return bad(lang === 'en' ? 'Config missing.' : '設定檔不存在。')
        const win = await isWindows($)
        const r = await $.process.run(sessionArgv(cfg, await $.session.id(), target, win), { timeoutMs: 8000 }).catch(() => null)
        if (!r || r.exitCode !== 0 || !r.stdout.includes('"ok":true')) {
          return bad(lang === 'en' ? 'Relay did not respond; nothing changed.' : '轉發站沒有回應，沒有改變。')
        }
        const h = await health($, cfg)
        await close()
        $.ui.toast(switchedText(target, h && has(h.providers, target) ? h.providers[target]! : target, lang))
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
        const r = await $.process.run(argv, { timeoutMs: which === 'proxy' ? 60000 : 15000 }).catch(() => null)
        if (!r || r.exitCode !== 0) {
          const why = (r?.stderr || r?.stdout || '').trim().split(/\r?\n/).pop() ?? ''
          return bad(lang === 'en' ? `Not changed: ${why || 'setup command failed'}` : `沒有變更：${why || '設定指令失敗'}`)
        }
        if (which === 'proxy') {
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

export const register: Register = (on) => {
  on('session.start', async ($, e, next) => {
    await syncProviders($, {}) // /provider exists even before the router answers; tick adds the providers
    await tick($)
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
      const cliArgs = first === 'init' ? ['init', '--fix'] : first === 'doctor' ? ['doctor', '--fix', ...(arg.includes('--ping') ? ['--ping'] : [])] : [first]
      const r = await $.process.run([cfg?.nodePath ?? 'node', setupScript($.plugin.root), ...cliArgs], { timeoutMs: 60000 }).catch(() => null)
      const out = ((r?.stdout || '') + (r?.stderr || '')).trim()
      return { text: out || (lang === 'en' ? 'Setup command did not respond.' : '設定指令沒有回應。') }
    }
    if (arg === 'help') return { text: helpText(Object.keys(knownProviders), lang) }
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
      return { text: `${cfg.outdated ? `${outdatedText(lang)}\n\n` : ''}${providerReport(await health($, cfg), Date.now(), lang)}` }
    }

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
      const r = await $.process.run(setupCliArgv(cfg, script, cliArgs), { timeoutMs: head === 'rc' || head === 'proxy' ? 60000 : 15000 }).catch(() => null)
      const out = ((r?.stdout || '') + (r?.stderr || '')).trim()
      const cfgNext = (await readLocal($)) ?? cfg
      const h = await health($, cfgNext)
      if (h) await showStatus($, statusText(h, false, lang))
      await syncPanelData($, cfgNext, h, lang)
      return { text: out || (lang === 'en' ? 'Setup command did not respond.' : '設定指令沒有回應。') }
    }

    const h0 = await health($, cfg)
    const providers = h0?.providers ?? {}
    if (arg === 'claude' || has(providers, arg)) {
      const r = await $.process.run(sessionArgv(cfg, await $.session.id(), arg, win), { timeoutMs: 8000 }).catch(() => null)
      if (!r || r.exitCode !== 0 || !r.stdout.includes('"ok":true')) {
        return { text: lang === 'en' ? 'Relay did not respond; nothing changed.' : '轉發站沒有回應，沒有改變。' }
      }
      const h = await health($, cfg)
      if (h) await showStatus($, statusText(h, false, lang))
      await syncPanelData($, cfg, h, lang)
      return { text: switchedText(arg, providers[arg] ?? arg, lang) }
    }
    const names = [...Object.keys(providers), 'claude'].join(lang === 'en' ? ', ' : '、')
    return {
      text: lang === 'en'
        ? `No provider or command "${arg}". Switch with /provider <${names}>; all commands: /provider help`
        : `沒有「${arg}」這個供應商或指令。切換用 /provider <${names}>；所有指令：/provider help`,
    }
  }).catch(() => ({ text: '/provider 執行失敗，設定未變更。' }))
}
