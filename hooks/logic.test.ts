import { test } from 'claude-code/testing'
import {
  buildPanelData,
  foreignConfigDir,
  foreignStatusText,
  healthArgv,
  pingArgv,
  probeArgv,
  sessionArgv,
  parseCfg,
  parseHealth,
  providerAgentSpecs,
  providerModelForSubagent,
  providerReport,
  routerScript,
  routerUrl,
  setupScript,
  startArgv,
  statusText,
  toggleArgv,
} from './logic'
import { fit } from './panel'

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error('assert failed: ' + msg)
}

const base = { baseUrl: 'https://api.z.ai/api/anthropic', token: 't', model: 'glm-5.3[1m]' }

test('parseCfg validates both legacy and multi-provider formats', () => {
  assert(parseCfg(null) === null, 'null rejected')
  assert(parseCfg({ ...base, token: '' }) === null, 'empty token rejected')
  assert(parseCfg({ ...base, baseUrl: 'ftp://x' }) === null, 'non-http rejected')
  const cfg = parseCfg(base)!
  assert(cfg.port === 8950 && cfg.nodePath === 'node' && cfg.providers.glm === 'glm-5.3[1m]', 'defaults')
  assert(parseCfg({ ...base, port: 80 })!.port === 8950, 'privileged port refused')

  const multi = parseCfg({
    port: 8960,
    failover: { provider: 'deepseek' },
    providers: {
      glm: { token: 't' },
      deepseek: { token: 'env:DS_KEY' },
    },
  })!
  assert(multi.failoverProvider === 'deepseek' && multi.providers.deepseek === 'deepseek-chat' && multi.providers.glm === 'glm-5.3[1m]', 'multi-provider with built-in presets parsed')
})

test('router control commands on Windows and POSIX', () => {
  const cfg = parseCfg({ ...base, port: 9001 })!
  assert(routerUrl(cfg) === 'http://127.0.0.1:9001', 'url')
  assert(healthArgv(cfg, 'a b').at(-1) === 'http://127.0.0.1:9001/__health?sid=a%20b', 'health carries the session')
  const m = sessionArgv(cfg, 's1', 'glm')
  assert(m.includes('{"sid":"s1","on":"glm"}') && m.at(-1) === 'http://127.0.0.1:9001/__session', 'per-session switch')
  assert(pingArgv(cfg, 'glm').at(-1) === 'http://127.0.0.1:9001/__ping', 'ping endpoint')
  assert(probeArgv(cfg).at(-1) === 'http://127.0.0.1:9001/__probe', 'probe endpoint')
  assert(routerScript('C:\\x\\claude-relay') === 'C:/x/claude-relay/router/router.js', 'script from root')
  assert(routerScript('C:/x/claude-relay/.claude-plugin') === 'C:/x/claude-relay/router/router.js', 'script from manifest dir')
  const sWin = startArgv({ ...cfg, nodePath: 'C:/n o/node.exe' }, 'C:/r.js', "C:/it's", true)
  assert(sWin[0] === 'powershell.exe' && (sWin[3] ?? '').includes("'C:/n o/node.exe'") && (sWin[3] ?? '').includes("it''s"), 'quoted start win')
  const sPosix = startArgv({ ...cfg, nodePath: '/usr/local/bin/node' }, '/opt/r.js', '/home/u/.claude', false)
  assert(sPosix[0] === 'sh' && (sPosix[2] ?? '').includes('nohup'), 'posix nohup start')
})

test('health, panel data, and status texts (zh and en)', () => {
  assert(parseHealth('nope') === null && parseHealth('{"ok":false}') === null, 'bad health')
  const h = parseHealth('{"ok":true,"session":"claude","failoverSince":5,"nextClaudeTry":600005,"sessionsOnCustom":3,"stats":{"glm":{"status":200,"ms":1200,"at":10}}}')!
  assert(h.session === 'claude' && h.failoverSince === 5 && h.sessionsOnCustom === 3 && h.stats?.glm?.ms === 1200, 'parsed with stats')
  assert(statusText(h, 'glm', false).includes('額度用完'), 'failover status')
  assert(statusText({ ...h, failoverSince: 0 }, 'glm', false) === '主線：Claude', 'normal')
  assert(statusText({ ...h, session: 'glm', failoverSince: 0 }, 'glm', false).includes('固定'), 'sticky session')
  assert(statusText({ ...h, session: 'glm', failoverSince: 0 }, 'glm', false, null, 'en').includes('pinned'), 'sticky session en')
  assert(parseHealth('{"ok":true,"mode":"glm"}')!.session === 'claude', 'old router answer reads as claude')
  assert(statusText(null, 'glm', true).includes('直連'), 'router down, direct')
  const rep = providerReport(h, 'glm', 5)
  assert(rep.includes('10 分鐘後') && rep.includes('● /provider claude') && rep.includes('○ /provider glm') && rep.includes('200 · 1.2s') && rep.includes('haiku → glm'), 'structured provider report with latency and alias')
  const cfg = parseCfg(base)!
  assert(cfg.aliases.haiku === 'glm', 'default glm alias detected')
  const pd = buildPanelData(h, cfg, false, 'zh', 5)
  assert(pd.online && pd.sessionsOnCustom === 3 && pd.stats.glm?.status === 200 && pd.aliases.haiku === 'glm', 'panel snapshot built')
  assert(fit('1234567890', 6) === '12345…', 'fit truncates long text')
})

test('the failover chain leads the panel, and the router reports its switches', () => {
  const cfg = parseCfg({
    providers: { glm: { token: 't' }, deepseek: { token: 't' } },
    failover: { chain: ['ghost', 'deepseek', 'glm'] },
  })!
  assert(cfg.failoverProvider === 'deepseek', 'first usable link of the chain leads')

  const old = parseHealth('{"ok":true,"session":"claude"}')!
  assert(old.switches === undefined && buildPanelData(old, cfg, false, 'zh', 0).switches === null, 'an older router shows no switches')

  const h = parseHealth('{"ok":true,"session":"claude","failoverChain":["Deepseek","glm"],"config":{"failoverEnabled":true,"retryEnabled":false,"proxyEnabled":true},"proxy":{"enabled":true,"certificate":true}}')!
  const pd = buildPanelData(h, cfg, false, 'zh', 0)
  assert(pd.failoverChain.join() === 'deepseek,glm', 'chain from the router, lower-cased')
  assert(pd.switches?.failover === true && pd.switches.retry === false && pd.switches.proxy === true && pd.switches.proxyReady === true, 'switches as the router reports them')
  assert(parseHealth('{"ok":true,"config":{"failoverEnabled":true}}')!.switches === undefined, 'a partial report is ignored')
})

test('switches are changed through the setup CLI', () => {
  const cfg = parseCfg({ ...base, nodePath: 'node' })!
  assert(setupScript('C:/mods/custom-agent/.claude-plugin') === 'C:/mods/custom-agent/tools/setup.mjs', 'manifest dir with forward slashes')
  const script = setupScript('C:\\mods\\custom-agent\\.claude-plugin')
  assert(script === 'C:/mods/custom-agent/tools/setup.mjs', 'script path from the plugin root')
  assert(toggleArgv(cfg, script, 'failover', false).join(' ') === `node ${script} set failover.enabled off`, 'failover')
  assert(toggleArgv(cfg, script, 'retry', true).join(' ') === `node ${script} set retry.enabled on`, 'retry')
  assert(toggleArgv(cfg, script, 'proxy', true).join(' ') === `node ${script} proxy enable --go`, 'proxy on')
  assert(toggleArgv(cfg, script, 'proxy', false).join(' ') === `node ${script} proxy disable --go`, 'proxy off')

  const multi = parseCfg({
    providers: { glm: { token: 't' }, gemini: { token: 'g' } },
  })!
  const specs = providerAgentSpecs(multi)
  assert(specs.length === 2 && specs[0]?.name === 'glm' && specs[0]?.model === 'glm-5.3[1m]' && specs[1]?.name === 'gemini' && specs[1]?.model === 'gemini-4-argon', 'providerAgentSpecs builds one spec per provider')
  assert(providerModelForSubagent('model-relay:gemini', multi) === 'gemini-4-argon', 'locks model-relay:gemini to gemini-4-argon')
  assert(providerModelForSubagent('Explore', multi) === null, 'leaves other subagent types untouched')
})

test('a router serving another config dir is not ours; one that reports no dir is an older relay and is', () => {
  const mine = parseHealth('{"ok":true,"configDir":"/real/.claude","configDirArg":"/link/.claude"}')!
  assert(foreignConfigDir(mine, '/real/.claude', false) === null, 'resolved spelling matches')
  assert(foreignConfigDir(mine, '/link/.claude/', false) === null, 'given spelling matches, trailing slash ignored')
  assert(foreignConfigDir(mine, '/other/.claude', false) === '/real/.claude', 'a different dir is foreign and named')
  assert(foreignConfigDir(parseHealth('{"ok":true,"configDir":"C:/Users/x/.claude"}'), 'c:/users/x/.claude', true) === null, 'Windows ignores case')
  assert(foreignConfigDir(parseHealth('{"ok":true}'), '/any', false) === null, 'older relay without configDir stays ours')
  assert(foreignConfigDir(null, '/any', false) === null, 'no answer is not foreign')
  assert(foreignStatusText('/other/.claude', 'en').includes('/other/.claude'), 'the status names the other dir')
})
