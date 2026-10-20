import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'
import type { PanelUi } from '../types'
import {
  buildPanelData,
  healthArgv,
  healthWaitArgv,
  parseCfg,
  foreignConfigDir,
  foreignStatusText,
  parseHealth,
  pingArgv,
  probeArgv,
  providerAgentSpecs,
  providerModelForSubagent,
  providerReport,
  routerIsStale,
  routerScript,
  routerUrl,
  staleStatusText,
  sessionArgv,
  setupCliArgv,
  setupBrief,
  setupScript,
  startArgv,
  statusText,
  toggleArgv,
  type RelayCfg,
  type Health,
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
let registeredAgentsSig = ''
let pluginVersion: string | null = null
let lastStaleTry = 0
let staleBusy = false // the router runs older code but was answering a request when we last tried to replace it

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

async function syncProviderAgents($: EngineInterface, cfg: RelayCfg, h: Health | null = null): Promise<void> {
  const specs = providerAgentSpecs(cfg, h)
  const sig = JSON.stringify(specs)
  if (sig === registeredAgentsSig) return
  for (const spec of specs) {
    await $.agent.register(spec).catch(() => undefined)
  }
  registeredAgentsSig = sig
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

async function readCfg($: EngineInterface): Promise<RelayCfg | null> {
  const base = await configDir($)
  for (const name of ['model-relay.json', 'custom-agent.json']) {
    try {
      const parsed = parseCfg(JSON.parse(await $.fs.read(`${base}/${name}`)))
      if (parsed) return parsed
    } catch {}
  }
  return null
}

async function health($: EngineInterface, cfg: RelayCfg): Promise<Health | null> {
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

async function syncPanelData($: EngineInterface, cfg: RelayCfg, h: Health | null, lang: 'zh' | 'en'): Promise<void> {
  try {
    const ui = await read($, panelUi)
    if (!ui.open) return
    const snap = buildPanelData(h, cfg, direct, lang, Date.now())
    await update($, panelData, () => snap)
  } catch {}
}

async function setPanelNote($: EngineInterface, note: string | undefined): Promise<void> {
  try {
    await update($, panelUi, ({ confirmingClaude: _c, confirmingProxy: _p, note: _n, ...u }) => (note ? { ...u, confirmingClaude: false, note } : { ...u, confirmingClaude: false }))
  } catch {}
}

// Keeps the router alive; when it cannot be brought back, this session talks to
// Anthropic directly until the router answers again.
async function tick($: EngineInterface): Promise<void> {
  if (ticking) return
  ticking = false
  ticking = true
  try {
    const cfg = await readCfg($)
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
    // `plugin update` leaves the old router running, and the hook only starts one when none answers; replace it here,
    // but only while it answers nothing (setup.mjs restart --if-idle), so no other session loses a reply. A router from
    // before 0.6.1 cannot report that, so it is only pointed out: /provider restart is the person's call.
    const stale = routerIsStale(h, await myVersion($))
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
    await syncProviderAgents($, cfg, h)
    if (h) {
      if (direct) {
        direct = false
        await $.env.set('ANTHROPIC_BASE_URL', routerUrl(cfg))
        $.ui.toast(lang === 'en' ? 'Relay recovered; routing through local relay' : '轉發站恢復，主線重新經由轉發站')
      }
      await showStatus($, staleBusy ? `${statusText(h, cfg, false, null, lang)} · ${staleStatusText(lang)}` : statusText(h, cfg, false, null, lang))
      await syncPanelData($, cfg, h, lang)
      return
    }
    if (Date.now() - lastStart > 15000) {
      lastStart = Date.now()
      const win = await isWindows($)
      await $.process.run(startArgv(cfg, routerScript($.plugin.root), await configDir($), win), { timeoutMs: 15000 }).catch(() => undefined)
      const up = await $.process.run(healthWaitArgv(cfg, await $.session.id(), win), { timeoutMs: 20000 }).catch(() => null)
      const h2 = up && up.exitCode === 0 ? parseHealth(up.stdout) : null
      if (h2) {
        await showStatus($, statusText(h2, cfg, false, null, lang))
        await syncPanelData($, cfg, h2, lang)
        return
      }
    }
    if (!direct && (await $.env.get('ANTHROPIC_BASE_URL')) === routerUrl(cfg)) {
      direct = true
      await $.env.set('ANTHROPIC_BASE_URL', undefined)
    }
    await showStatus($, statusText(null, cfg, direct, null, lang))
    await syncPanelData($, cfg, null, lang)
  } finally {
    ticking = false
  }
}

function panelActions($: EngineInterface): PanelActions {
  const run = (work: () => Promise<string | undefined>) => {
    void work()
      .catch((err) => String(err))
      .then(async (note) => {
        const cfg = await readCfg($)
        if (cfg) {
          const lang = await detectLang($)
          const h = await health($, cfg)
          if (h) await showStatus($, statusText(h, cfg, false, null, lang))
          await syncPanelData($, cfg, h, lang)
        }
        await setPanelNote($, note)
      })
  }
  return {
    switchTo: (target) =>
      run(async () => {
        const cfg = await readCfg($)
        const lang = await detectLang($)
        if (!cfg) return lang === 'en' ? 'Config missing.' : '設定檔不存在。'
        const win = await isWindows($)
        const r = await $.process.run(sessionArgv(cfg, await $.session.id(), target, win), { timeoutMs: 8000 }).catch(() => null)
        if (!r || r.exitCode !== 0 || !r.stdout.includes('"ok":true')) {
          return lang === 'en' ? 'Relay did not respond.' : '轉發站沒有回應。'
        }
        const h = await health($, cfg)
        const active = h?.providers ?? cfg.providers
        if (target === 'claude') {
          return lang === 'en'
            ? 'Switched this session back to Claude (next turn rebuilds cache).'
            : '已切回 Claude（下一輪會重建整段快取）。'
        }
        return lang === 'en'
          ? `Pinned this session to ${active[target] ?? target} (other windows unaffected).`
          : `這個對話已固定改用 ${active[target] ?? target}（其他視窗不受影響）。`
      }),
    askClaude: (ask) => {
      void update($, panelUi, ({ note: _n, ...u }) => ({ ...u, confirmingClaude: ask }))
    },
    ping: () =>
      run(async () => {
        const ui = await read($, panelUi)
        if (ui.pinging) return undefined
        const cfg = await readCfg($)
        const lang = await detectLang($)
        if (!cfg) return undefined
        await update($, panelUi, (u) => ({ ...u, pinging: true }))
        try {
          const win = await isWindows($)
          const r = await $.process.run(pingArgv(cfg, '', win), { timeoutMs: 12000 }).catch(() => null)
          if (!r || r.exitCode !== 0) {
            return lang === 'en' ? 'Ping failed: relay unreachable.' : '測速失敗：轉發站未回應。'
          }
          return lang === 'en' ? 'Upstream latency updated.' : '已完成上游連線測速。'
        } finally {
          await update($, panelUi, (u) => ({ ...u, pinging: false }))
        }
      }),
    probe: () =>
      run(async () => {
        const cfg = await readCfg($)
        const lang = await detectLang($)
        if (!cfg) return undefined
        const win = await isWindows($)
        await $.process.run(probeArgv(cfg, win), { timeoutMs: 5000 }).catch(() => null)
        return lang === 'en' ? 'Cooldown reset; next new session will try Claude.' : '已重置冷卻計時，下一個新對話將嘗試使用 Claude。'
      }),
    askProxy: (ask) => {
      void update($, panelUi, ({ note: _n, ...u }) => ({ ...u, confirmingProxy: ask }))
    },
    toggle: (which, on) =>
      run(async () => {
        const cfg = await readCfg($)
        const lang = await detectLang($)
        if (!cfg) return lang === 'en' ? 'Config missing.' : '設定檔不存在。'
        const argv = toggleArgv(cfg, setupScript($.plugin.root), which, on)
        // The proxy switch restarts the router and tests the certificate, which takes a few seconds
        const r = await $.process.run(argv, { timeoutMs: which === 'proxy' ? 60000 : 15000 }).catch(() => null)
        if (!r || r.exitCode !== 0) {
          const why = (r?.stderr || r?.stdout || '').trim().split(/\r?\n/).pop() ?? ''
          return lang === 'en' ? `Not changed: ${why || 'setup command failed'}` : `沒有變更：${why || '設定指令失敗'}`
        }
        if (which === 'proxy') {
          return on
            ? (lang === 'en' ? 'Remote Control enabled. Start a new Claude Code session to use it.' : '已開啟手機遙控；開新的 Claude Code 對話後生效。')
            : (lang === 'en' ? 'Remote Control disabled. Sessions already running in proxy mode lose their connection.' : '已關閉手機遙控；已在代理模式執行的對話會斷線。')
        }
        const name = which === 'failover' ? (lang === 'en' ? '429 failover' : '429 備援') : lang === 'en' ? 'Retry' : '失敗重試'
        return lang === 'en' ? `${name} ${on ? 'on' : 'off'} (applies to the next request).` : `${name}已${on ? '開啟' : '關閉'}（下一個請求起生效）。`
      }),
    close: () => {
      void update($, panelUi, (u) => ({ ...u, open: false, confirmingClaude: false, confirmingProxy: false }))
    },
  }
}

export const register: Register = (on) => {
  on('session.start', async ($, e, next) => {
    const cfg = await readCfg($)
    const keys = cfg ? Object.keys(cfg.providers) : ['glm', 'gemini']
    if (cfg) await syncProviderAgents($, cfg, null)
    await $.command.register({
      name: 'provider',
      description: '切換對話模型、設定 haiku 別名或開關備援面板（/provider [name|claude|panel|ping|setup|init|doctor|restart|alias|failover|retry|rc]）',
      argumentHint: `[${[...keys, 'claude', 'panel', 'ping', 'setup', 'init', 'doctor', 'restart', 'alias', 'failover', 'retry', 'rc'].join('|')}]`,
    })
    await tick($)
    $.clock.every(10000, () => {
      void tick($).catch(() => {})
    })
    return next(e)
  })

  on('agent.spawn', async ($, e, next) => {
    if (e.fork || e.resume) return next(e)
    const cfg = await readCfg($)
    if (!cfg) return next(e)
    const forced = providerModelForSubagent(e.subagentType, cfg, null)
    return forced ? next({ ...e, model: forced }) : next(e)
  }).catch(($, e, next) => (next.called ? next(e) : { deny: 'model-relay agent.spawn failed' }))

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
    const cfg = await readCfg($)
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
    if (!cfg) {
      return {
        text: lang === 'en'
          ? 'model-relay.json (or custom-agent.json) is missing or invalid. Run /provider init to create it, then /provider doctor to check it.'
          : 'model-relay.json（或 custom-agent.json）不存在或格式錯誤。請先執行 /provider init 建立，再用 /provider doctor 檢查。',
      }
    }
    const win = await isWindows($)

    if (arg === 'panel') {
      const nextOpen = !(await read($, panelUi)).open
      const h = await health($, cfg)
      if (nextOpen) {
        await update($, panelData, () => buildPanelData(h, cfg, direct, lang, Date.now()))
      }
      await update($, panelUi, (u) => ({ ...u, open: nextOpen, confirmingClaude: false }))
      return {
        text: nextOpen
          ? (lang === 'en'
              ? 'model-relay panel opened above prompt (click buttons or press ctrl+x tab; run /provider panel again to close).'
              : '已在輸入框上方開啟 model-relay 控制面板：直接點按鈕，或按 ctrl+x tab 用鍵盤操作；再打一次 /provider panel 關閉。')
          : (lang === 'en' ? 'model-relay panel closed.' : '已關閉 model-relay 控制面板。'),
      }
    }

    if (arg === 'ping') {
      await $.process.run(pingArgv(cfg, '', win), { timeoutMs: 12000 }).catch(() => null)
      const h = await health($, cfg)
      await syncPanelData($, cfg, h, lang)
      return { text: providerReport(h, cfg, Date.now(), null, lang) }
    }

    if (arg === 'probe') {
      await $.process.run(probeArgv(cfg, win), { timeoutMs: 5000 }).catch(() => null)
      const h = await health($, cfg)
      await syncPanelData($, cfg, h, lang)
      return {
        text: (lang === 'en' ? 'Reset 429 cooldown timer.\n\n' : '已重置 429 冷卻計時。\n\n') + providerReport(h, cfg, Date.now(), null, lang),
      }
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
      const cfgNext = (await readCfg($)) ?? cfg
      const h = await health($, cfgNext)
      if (h) await showStatus($, statusText(h, cfgNext, false, null, lang))
      await syncPanelData($, cfgNext, h, lang)
      return { text: `${out ? `${out}\n\n` : ''}${providerReport(h, cfgNext, Date.now(), null, lang)}` }
    }

    const h0 = await health($, cfg)
    const activeProviders = h0?.providers && Object.keys(h0.providers).length > 0 ? h0.providers : cfg.providers
    if (arg === 'claude' || activeProviders[arg]) {
      const r = await $.process.run(sessionArgv(cfg, await $.session.id(), arg, win), { timeoutMs: 8000 }).catch(() => null)
      if (!r || r.exitCode !== 0 || !r.stdout.includes('"ok":true')) {
        return { text: lang === 'en' ? 'Relay did not respond; no change.' : '轉發站沒有回應，沒有改變。' }
      }
      const h = await health($, cfg)
      if (h) await showStatus($, statusText(h, cfg, false, null, lang))
      await syncPanelData($, cfg, h, lang)
      const done = arg === 'claude'
        ? (lang === 'en' ? '✓ Switched this session back to Claude (next turn rebuilds cache; other windows unaffected).\n\n' : '✓ 已將這個對話切回 Claude（下一輪會重建快取；其他視窗不受影響）。\n\n')
        : (lang === 'en' ? `✓ Pinned this session to ${arg} (${activeProviders[arg]}; other windows unaffected).\n\n` : `✓ 已將這個對話固定改用 ${arg}（${activeProviders[arg]}；其他視窗不受影響）。\n\n`)
      return { text: `${done}${providerReport(h, cfg, Date.now(), null, lang)}` }
    }
    if (arg !== '' && arg !== 'status') {
      const opts = [...Object.keys(activeProviders), 'claude', 'panel', 'ping'].map((k) => `/provider ${k}`).join('、')
      return { text: lang === 'en' ? `Usage: /provider (status & panel), ${opts}` : `用法：/provider（看狀態並開啟面板）、${opts}` }
    }
    // Bare `/provider` opens the interactive panel above prompt AND returns the status summary
    if (arg === '') {
      await update($, panelData, () => buildPanelData(h0, cfg, direct, lang, Date.now()))
      await update($, panelUi, (u) => ({ ...u, open: true, confirmingClaude: false }))
    }
    return { text: providerReport(h0, cfg, Date.now(), null, lang) }
  }).catch(() => ({ text: '/provider 執行失敗，設定未變更。' }))
}
