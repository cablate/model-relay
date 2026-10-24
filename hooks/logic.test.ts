import { test } from 'claude-code/testing'
import {
  AVATAR_EMPTY,
  AVATAR_INLINE_ROWS,
  AVATAR_START,
  avatarArgv,
  avatarFilter,
  avatarLabel,
  avatarMade,
  avatarName,
  avatarScratch,
  avatarSize,
  avatarSource,
  avatarWanted,
  base64ToBytes,
  buildPanelData,
  bytesToBase64,
  compareVersions,
  elsewhereText,
  fit,
  foreignConfigDir,
  foreignStatusText,
  has,
  healthArgv,
  healthHints,
  helpText,
  outdatedText,
  parseAvatars,
  parseHealth,
  parseLocal,
  pingArgv,
  pingReport,
  pingText,
  probeArgv,
  providerAgentSpecs,
  providerAgentOptions,
  providerReport,
  rasterCells,
  reachedRelay,
  relayAgent,
  routerIsStale,
  routerScript,
  routerUrl,
  sessionArgv,
  setupBrief,
  setupCommandArgs,
  setupScript,
  spawnedElsewhere,
  startArgv,
  statusFields,
  statusFile,
  statusText,
  switchedText,
  toggleArgv,
  wireKey,
} from './logic'

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error('assert failed: ' + msg)
}

const health = (j: object) => parseHealth(JSON.stringify({ ok: true, ...j }))!

test('the hook reads only the port, the node path and the status bar switch from the config file', () => {
  assert(parseLocal(null) === null && parseLocal([]) === null, 'not an object')
  const d = parseLocal({ providers: { x: { token: 't' } } })!
  assert(d.port === 8950 && d.nodePath === 'node', 'defaults')
  assert(parseLocal({ port: 80 })!.port === 8950, 'privileged port refused')
  assert(parseLocal({ port: 9001, nodePath: 'C:/n/node.exe' })!.nodePath === 'C:/n/node.exe', 'node path kept')
  assert(parseLocal({})!.statusBar === false && parseLocal({ statusBar: true })!.statusBar === true && parseLocal({ statusBar: 'yes' })!.statusBar === false, 'status bar is opt-in, true only')
  assert(Object.keys(parseLocal({ port: 9001 })!).sort().join() === 'avatars,nodePath,outdated,port,statusBar', 'nothing about providers')
  assert(parseLocal({ format: 2 })!.outdated === false, 'format 2 is read')
  assert(parseLocal({ providers: {} })!.outdated && parseLocal({ format: '2' })!.outdated, 'no "format": 2 is an older config')
  assert(parseLocal({ format: 2, port: 9001 }, true)!.outdated && parseLocal({ format: 2, port: 9001 }, true)!.port === 9001, 'the older file name: its port only')
})

test('an older config is pointed out, never routed by guesswork', () => {
  assert(outdatedText('en').includes('/provider setup upgrade my model-relay config'), 'the prompt UPGRADING.md gives')
  const hints = healthHints(null, 'zh', true)
  assert(hints.length === 1 && hints[0] === outdatedText('zh'), 'shown even with no router answering')
  assert(buildPanelData(null, 8950, true, 'en', 0, true).hints[0] === outdatedText('en'), 'the panel shows it first')
  assert(buildPanelData(null, 8950, true, 'en', 0).hints.length === 0, 'and only for an older config')
})

test('router control commands on Windows and POSIX', () => {
  const cfg = parseLocal({ port: 9001 })!
  assert(routerUrl(cfg) === 'http://127.0.0.1:9001', 'url')
  assert(healthArgv(cfg, 'a b').at(-1) === 'http://127.0.0.1:9001/__health?sid=a%20b', 'health carries the session')
  const m = sessionArgv(cfg, 's1', 'aaa')
  assert(m.includes('{"sid":"s1","on":"aaa"}') && m.at(-1) === 'http://127.0.0.1:9001/__session', 'per-session switch')
  const p = pingArgv(cfg, 'aaa')
  assert(p.at(-1) === 'http://127.0.0.1:9001/__ping' && Number(p[p.indexOf('-m') + 1]) >= 25, 'ping endpoint, waits longer than one 15 s test plus a launch')
  assert(probeArgv(cfg).at(-1) === 'http://127.0.0.1:9001/__probe', 'probe endpoint')
  assert(routerScript('C:\\x\\claude-relay') === 'C:/x/claude-relay/router/router.js', 'script from root')
  assert(routerScript('C:/x/claude-relay/.claude-plugin') === 'C:/x/claude-relay/router/router.js', 'script from manifest dir')
  const sWin = startArgv({ ...cfg, nodePath: 'C:/n o/node.exe' }, 'C:/r.js', "C:/it's", true)
  assert(sWin[0] === 'powershell.exe' && (sWin[3] ?? '').includes("'C:/n o/node.exe'") && (sWin[3] ?? '').includes("it''s"), 'quoted start win')
  const sPosix = startArgv({ ...cfg, nodePath: '/usr/local/bin/node' }, '/opt/r.js', '/home/u/.claude', false)
  assert(sPosix[0] === 'sh' && (sPosix[2] ?? '').includes('nohup'), 'posix nohup start')
})

test('health, panel data, and status texts (zh and en) come from the router alone', () => {
  assert(parseHealth('nope') === null && parseHealth('{"ok":false}') === null, 'bad health')
  const h = health({
    session: 'claude', failoverSince: 5, nextClaudeTry: 600005, sessionsOnCustom: 3,
    providers: { aaa: 'aaa-9' }, aliases: { haiku: 'aaa' }, failoverProvider: 'aaa', failoverChain: ['aaa'],
    stats: { aaa: { status: 200, ms: 1200, at: 10 } },
  })
  assert(h.session === 'claude' && h.failoverSince === 5 && h.sessionsOnCustom === 3 && h.stats?.aaa?.ms === 1200, 'parsed with stats')
  assert(statusText(h, false).includes('額度用完') && statusText(h, false).includes('aaa-9'), 'failover status names the model')
  assert(statusText({ ...h, failoverSince: 0 }, false) === '主線：Claude', 'normal')
  assert(statusText({ ...h, session: 'aaa', failoverSince: 0 }, false).includes('固定'), 'sticky session')
  assert(statusText({ ...h, session: 'aaa', failoverSince: 0 }, false, 'en').includes('pinned'), 'sticky session en')
  assert(parseHealth('{"ok":true,"mode":"glm"}')!.session === 'claude', 'old router answer reads as claude')
  assert(statusText(null, true).includes('直連') && !/GLM/i.test(statusText(null, true)), 'router down, direct, no provider named')
  const fc = (x: [string, string]) => x.join(' ')
  assert(fc(statusFields({ ...h, failoverSince: 0 }, false)) === 'claude claude', 'fields: claude')
  assert(fc(statusFields({ ...h, session: 'aaa', failoverSince: 0 }, false)) === 'pinned aaa-9', 'fields: pinned to the model')
  assert(fc(statusFields(h, false)) === 'failover aaa-9', 'fields: failover names the model')
  assert(fc(statusFields({ ...h, failoverProvider: undefined }, false)) === 'limit claude', 'fields: limit reached with nobody to hand over to')
  assert(fc(statusFields({ ...h, session: 'gone', failoverSince: 0 }, false)) === 'claude claude', 'fields: a pin the router no longer lists')
  assert(fc(statusFields(null, false)) === 'offline offline' && fc(statusFields(null, true)) === 'direct claude', 'fields: router down')
  assert(fc(statusFields(h, true, true)) === 'direct claude' && fc(statusFields(h, false, true)) === 'offline offline', 'fields: another relay on the port is not ours; direct only once this window bypasses it')
  const sf = statusFile('/c', 'ab-12', ['pinned', 'm\tx\ny'])!
  assert(sf.path === '/c/model-relay-status/ab-12' && sf.line === 'pinned\tm x y\n', 'status file path and a line that cannot split')
  assert(statusFile('/c', '../x', ['claude', 'claude']) === null && statusFile('/c', '..', ['claude', 'claude']) === null && statusFile('/c', '', ['claude', 'claude']) === null, 'no path out of the status dir')
  const rep = providerReport(h, 5)
  assert(rep.includes('10 分鐘後') && rep.includes('● /provider claude') && rep.includes('○ /provider aaa') && rep.includes('上次 200 · 1.2s') && rep.includes('haiku → aaa'), 'structured provider report with latency and alias')
  const pd = buildPanelData(h, 8950, false, 'zh', 5)
  assert(pd.online && pd.sessionsOnCustom === 3 && pd.stats.aaa?.status === 200 && pd.aliases.haiku === 'aaa', 'panel snapshot built')
  assert(fit('1234567890', 6) === '12345…' && fit('中文字串', 5) === '中文…', 'fit truncates by terminal cells')
})

test('a switch answers in one line, and the command list waits for /provider help', () => {
  for (const lang of ['zh', 'en'] as const) {
    const one = switchedText('aaa', 'aaa-9', lang)
    assert(!one.includes('\n') && one.includes('aaa-9'), `a switch is one line naming the model (${lang})`)
    assert(!switchedText('claude', 'claude', lang).includes('\n'), `back to Claude is one line (${lang})`)
  }
  const h = health({ session: 'aaa', providers: { aaa: 'aaa-9', bbb: 'bbb-1' }, aliases: { haiku: 'bbb' }, failoverChain: ['bbb'], config: { failoverEnabled: true, retryEnabled: true, proxyEnabled: false }, ping: { aaa: { verdict: 'ok', status: 200, firstByteMs: 300, at: 1, detail: '' } } })
  const rep = providerReport(h, 0, 'en')
  assert(rep.includes('/provider help') && !rep.includes('/provider failover') && !rep.includes('/provider doctor'), 'the status points at help and lists no commands')
  assert(rep.split('\n').filter((l) => l.startsWith('Shared by every window:')).length === 1 && rep.includes('haiku → bbb'), 'the shared switches and aliases on one line')
  const ping = pingReport(h, 'en')
  assert(ping.includes('test ok 300ms') && !ping.includes('/provider claude') && !ping.includes('Shared by every window'), 'a ping shows only the providers and their tests')
  const help = helpText(['aaa'], 'zh')
  assert(['這個視窗：', '所有視窗共用：', '設定與檢查：'].every((g) => help.includes(g)), 'commands grouped by what they reach')
  assert(['status', 'avatar', 'ping', 'setup', 'doctor', 'restart', 'failover', 'retry', 'rc', 'alias', 'probe', 'init'].every((c) => help.includes(`/provider ${c}`)) && help.includes('model-relay:aaa'), 'every command and the subagent type')
})

test('a router with no usable provider, or no failover chain, is shown as such rather than guessed at', () => {
  const bare = health({ session: 'claude', providers: {}, failoverProvider: null, failoverChain: [] })
  assert(bare.failoverProvider === undefined && bare.failoverChain.length === 0 && Object.keys(bare.providers).length === 0, 'null failover provider')
  const pd = buildPanelData(bare, 8950, false, 'en', 0)
  assert(pd.failoverProvider === null && pd.failoverChain.length === 0 && Object.keys(pd.aliases).length === 0, 'no default alias or chain')
  const rep = providerReport(bare, 0, 'en')
  assert(rep.includes('no provider is usable yet') && rep.includes('nobody to hand over to'), 'said plainly')
  assert(!helpText([], 'en').includes('model-relay:<name>'), 'no subagent line with no provider to run it on')
  assert(statusText({ ...bare, failoverSince: 1 }, false, 'en') === 'Claude limit reached', 'a 429 with nobody to take over')
  assert(Object.keys(buildPanelData(null, 8950, true, 'zh', 0).providers).length === 0, 'offline: nothing invented')
})

test('the failover chain leads the panel, and the router reports its switches', () => {
  const old = health({ session: 'claude' })
  assert(old.switches === undefined && buildPanelData(old, 8950, false, 'zh', 0).switches === null, 'an older router shows no switches')

  const h = health({ session: 'claude', failoverChain: ['Deepseek', 'aaa'], config: { failoverEnabled: true, retryEnabled: false, proxyEnabled: true }, proxy: { enabled: true, certificate: true } })
  const pd = buildPanelData(h, 8950, false, 'zh', 0)
  assert(pd.failoverChain.join() === 'deepseek,aaa', 'chain from the router, lower-cased')
  assert(pd.switches?.failover === true && pd.switches.retry === false && pd.switches.proxy === true && pd.switches.proxyReady === true, 'switches as the router reports them')
  assert(health({ config: { failoverEnabled: true } }).switches === undefined, 'a partial report is ignored')
})

test('a test result is kept apart from the last request, and what the person should fix is listed', () => {
  const h = health({
    providers: { aaa: 'aaa-9', bbb: 'bbb-1' },
    stats: { aaa: { status: 200, ms: 45000, at: 9 } },
    ping: { aaa: { verdict: 'ok', status: 200, firstByteMs: 320, at: 10, detail: '' }, bbb: { verdict: 'key', status: 401, firstByteMs: 80, at: 10, detail: 'invalid key' } },
    unresolved: [{ provider: 'ccc', env: 'CCC_KEY' }],
  })
  assert(pingText(h.ping?.aaa, 'en')?.text === 'test ok 320ms' && pingText(h.ping?.bbb, 'zh')?.text === '測試: 金鑰被拒', 'verdict in words')
  assert(pingText({ verdict: 'error', status: 500, firstByteMs: 1, at: 1, detail: '' }, 'en')?.text === 'test: HTTP 500', 'unknown verdict shows the status')
  const rep = providerReport(h, 0, 'en')
  assert(rep.includes('last 200 · 45.0s · test ok 320ms'), 'a 45 s reply and a 320 ms first byte, side by side')
  const hints = healthHints(h, 'en')
  assert(hints.length === 1 && hints[0]!.includes('CCC_KEY'), 'skipped provider')
  assert(buildPanelData(h, 8950, false, 'zh', 0).hints.length === 1, 'the panel gets it too')
})

test('/provider setup hands Claude the CLI path and the safety rules', () => {
  const b = setupBrief('C:/p/tools/setup.mjs', 'node', 'add deepseek', false, 'zh')
  assert(b.includes('"node" "C:/p/tools/setup.mjs"') && b.includes('add deepseek') && b.includes('繁體中文'), 'path, goal and language')
  assert(b.includes('presets') && b.includes('--model') && b.includes('there is no default') && !b.includes('already exists'), 'no config yet: presets, and the model is asked for')
  assert(b.includes('Never ask me to paste an API key') && b.includes('without --go first') && b.includes('settings.json'), 'safety rules')
  assert(b.includes('"outdated"') && b.includes('C:/p/UPGRADING.md'), 'an older config is upgraded by the guide next to the CLI')
  const en = setupBrief('/p/tools/setup.mjs', '/usr/bin/node', '', true, 'en')
  assert(en.includes('already exists') && en.includes('doctor --json') && en.includes('ask me which provider') && en.includes('Reply in English'), 'existing config, no goal, english')
})

test('switches are changed through the setup CLI, and each provider gets a model-relay agent', () => {
  const cfg = parseLocal({ nodePath: 'node' })!
  assert(setupScript('C:/mods/x/.claude-plugin') === 'C:/mods/x/tools/setup.mjs', 'manifest dir with forward slashes')
  const script = setupScript('C:\\mods\\x\\.claude-plugin')
  assert(script === 'C:/mods/x/tools/setup.mjs', 'script path from the plugin root')
  assert(toggleArgv(cfg, script, 'failover', false).join(' ') === `node ${script} set failover.enabled off`, 'failover')
  assert(toggleArgv(cfg, script, 'retry', true).join(' ') === `node ${script} set retry.enabled on`, 'retry')
  assert(toggleArgv(cfg, script, 'proxy', true).join(' ') === `node ${script} proxy enable --go`, 'proxy on')
  assert(toggleArgv(cfg, script, 'proxy', false).join(' ') === `node ${script} proxy disable --go`, 'proxy off')

  const providers = { aaa: 'aaa-9[1m]', bbb: 'bbb-1' }
  const specs = providerAgentSpecs(providers)
  assert(specs.length === 2 && specs[0]?.name === 'aaa' && specs[0]?.model === 'aaa-9[1m]' && specs[1]?.model === 'bbb-1', 'one spec per provider')
  const opts = providerAgentOptions({ providers: {
    aaa: { agent: { description: 'Hard reviews.', effort: 'high', tools: ['Read', 'Grep'], name: 'evil', model: 'other', maxTurns: -1, memory: 'cloud' } },
    bbb: { agent: 'yes' },
    ccc: { token: 't' },
  } })
  assert(JSON.stringify(opts) === '{"aaa":{"description":"Hard reviews.","effort":"high","tools":["Read","Grep"]}}', 'agent fields in the right shape only; no name or model')
  assert(JSON.stringify(providerAgentOptions(null)) === '{}' && JSON.stringify(providerAgentOptions({ providers: [] })) === '{}', 'no providers object')
  const custom = providerAgentSpecs(providers, opts)
  assert(custom[0]!.description === 'Hard reviews.' && custom[0]!.effort === 'high' && (custom[0]!.tools as string[]).length === 2, 'the config sets the description and fields as written')
  assert(custom[0]!.name === 'aaa' && custom[0]!.model === 'aaa-9[1m]' && custom[0]!.prompt === specs[0]!.prompt, "name and model stay the provider's; unset fields keep defaults")
  assert(JSON.stringify(custom[1]) === JSON.stringify(specs[1]), 'a provider without an agent object is unchanged')
  assert(relayAgent('model-relay:BBB', providers)?.model === 'bbb-1', 'locks model-relay:<name> to its model')
  assert(relayAgent('Explore', providers) === null && relayAgent('model-relay:ghost', providers) === null, 'other types and unknown names untouched')
  assert(relayAgent('model-relay:constructor', providers) === null && !has(providers, 'toString'), 'no prototype names')
})

test('/provider doctor only looks until the user types --fix; init still wires settings.json', () => {
  const args = (first: string, arg = first) => setupCommandArgs(first, arg).join(' ')
  assert(args('doctor') === 'doctor', 'a bare doctor is read-only')
  assert(args('doctor', 'doctor --ping') === 'doctor --ping', '--ping passes through and still changes nothing')
  assert(args('doctor', 'doctor --fix') === 'doctor --fix', '--fix is the user asking for the change')
  assert(args('doctor', 'doctor --fix --ping') === 'doctor --fix --ping' && args('doctor', 'doctor --ping --fix') === 'doctor --fix --ping', 'both flags, in either order')
  assert(args('doctor', 'doctor --prefix') === 'doctor', 'only the flag itself counts')
  assert(args('init') === 'init --fix', 'setting up is what init is for')
  assert(args('presets') === 'presets' && args('restart') === 'restart', 'the others pass their name only')
  assert(helpText([], 'en').includes('/provider doctor [--ping] [--fix]') && helpText([], 'zh').includes('/provider doctor [--ping] [--fix]'), 'help says doctor takes --fix')
})

test('a model-relay subagent that Claude Code ran on another model, or that never reached the relay, is noticed', () => {
  assert(wireKey('GLM-5.3[1m]') === 'glm-5.3', 'the key the router uses')
  assert(!spawnedElsewhere('aaa-9[1m]', 'aaa-9') && !spawnedElsewhere('aaa-9', undefined), 'the same model, or no answer')
  assert(spawnedElsewhere('aaa-9[1m]', 'claude-sonnet-5-5'), 'swapped for another model')
  assert(elsewhereText('aaa', 'aaa-9', 'claude-sonnet-5-5', 'en').includes('availableModels'), 'says the usual cause')
  const h = (seen?: object) => health(seen ? { seenModels: seen } : {})
  assert(reachedRelay(h({ 'aaa-9': 5000 }), 'aaa-9[1m]', 4000) === true, 'reached after the spawn')
  assert(reachedRelay(h({ 'aaa-9': 1000 }), 'aaa-9', 4000) === false, 'only before the spawn')
  assert(reachedRelay(h({}), 'aaa-9', 4000) === false, 'never')
  assert(reachedRelay(h(), 'aaa-9', 4000) === null && reachedRelay(null, 'aaa-9', 4000) === null, 'an older or absent router cannot tell')
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

test('a router left running by an older plugin is stale; a current or newer one is not', () => {
  assert(compareVersions('0.6.0', '0.6.1') === -1 && compareVersions('0.10.0', '0.9.9') === 1 && compareVersions('0.6', '0.6.0') === 0, 'numeric, part by part')
  assert(routerIsStale(health({}), '0.6.1'), 'no configDir: 0.6.0 or earlier')
  assert(routerIsStale(health({ configDir: '/d', version: '0.6.1' }), '0.6.2'), 'a lower version')
  assert(!routerIsStale(health({ configDir: '/d', version: '0.6.1' }), '0.6.1'), 'the same version')
  assert(!routerIsStale(health({ configDir: '/d', version: '0.7.0' }), '0.6.1'), 'a newer router is left alone')
  assert(!routerIsStale(health({ configDir: '/d' }), '0.6.1'), 'a configDir without a version is not guessed at')
  assert(!routerIsStale(null, '0.6.1'), 'no router is not stale')
  const p = health({ configDir: '/d', version: '0.6.1', inflight: 2 })
  assert(p.version === '0.6.1' && p.inflight === 2, 'version and inflight are parsed')
})

test('the avatars in the config are parsed at the boundary: a path or { image, head }, and nothing malformed gets through', () => {
  const a = parseAvatars({
    Claude: { image: ' pics/c.webp ', head: [471.4, 200, 340] },
    aaa: 'pics/a.webp',
    bbb: { image: 'pics/b.webp', head: [1, 2] },
    ccc: { image: 'pics/c.webp', head: [10, 20, 0] },
    ddd: { head: [1, 2, 3] },
    eee: 5,
    fff: '',
    ggg: '  ',
    hhh: null,
    iii: { image: 7 },
    jjj: { image: 'pics/j.webp', head: [1, '2', 3] },
    '': 'pics/none.webp',
  })
  assert(Object.keys(a).sort().join() === 'aaa,bbb,ccc,claude,jjj', 'only entries with a usable image, names lower-cased')
  assert(a.claude!.image === 'pics/c.webp' && a.claude!.head!.join() === '471,200,340', 'image trimmed, head rounded to whole pixels')
  assert(a.aaa!.image === 'pics/a.webp' && a.aaa!.head === null, 'a bare path has no head')
  assert(a.bbb!.head === null && a.ccc!.head === null && a.jjj!.head === null && a.bbb!.image === 'pics/b.webp', 'a bad head is dropped alone, the picture stays')
  assert(Object.keys(parseAvatars(null)).length + Object.keys(parseAvatars([])).length + Object.keys(parseAvatars('x')).length === 0, 'not an object')
  const proto = parseAvatars(JSON.parse('{"__proto__":"pics/p.webp"}'))
  assert(has(proto, '__proto__') && Object.getPrototypeOf(proto) === Object.prototype, 'a name like __proto__ is just a name')
  assert(Object.keys(parseLocal({})!.avatars).length === 0 && parseLocal({ avatars: { aaa: 'p.png' } })!.avatars.aaa!.image === 'p.png', 'the local config carries them')
})

test('the avatar follows the persona the status file names, and is Claude whenever no router answers for this window', () => {
  const h = health({ session: 'claude', providers: { aaa: 'aaa-9', bbb: 'bbb-1' }, failoverProvider: 'bbb', failoverChain: ['bbb'] })
  assert(avatarName(h) === 'claude', 'a window on Claude')
  assert(avatarName({ ...h, session: 'aaa' }) === 'aaa', 'pinned to a provider')
  assert(avatarName({ ...h, failoverSince: 5 }) === 'bbb', 'a Claude limit handed the window to a provider')
  assert(avatarName({ ...h, session: 'aaa', failoverSince: 5 }) === 'aaa', 'a pin outranks the failover')
  assert(avatarName({ ...h, failoverSince: 5, failoverProvider: undefined }) === 'claude', 'a limit with nobody to hand over to')
  assert(avatarName({ ...h, session: 'gone' }) === 'claude', 'a pin the router no longer lists')
  assert(avatarName(null) === 'claude' && avatarName(h, true) === 'claude' && avatarName({ ...h, session: 'aaa' }, true) === 'claude', 'offline, direct, or another relay on the port')
  assert(avatarLabel('claude', h.providers) === 'Claude' && avatarLabel('aaa', h.providers) === 'aaa · aaa-9', 'name and model id')
  assert(avatarLabel('zzz', h.providers) === 'zzz' && avatarLabel('constructor', {}) === 'constructor', 'a name the router does not list is shown as it is')
})

test('ffmpeg is asked for exactly the box: the whole image fitted inside it, or the head square first', () => {
  const tail = ',format=rgba,pad=60:60:(ow-iw)/2:(oh-ih)/2:color=0x00000000'
  assert(avatarFilter('full', null, 60, 30) === `scale=60:60:force_original_aspect_ratio=decrease${tail}`, 'cols wide, twice the rows tall, aspect kept, transparent padding')
  assert(avatarFilter('head', [471, 200, 340], 60, 30) === `crop=340:340:301:30,scale=60:60:force_original_aspect_ratio=decrease${tail}`, 'the head square, centred on x and y')
  assert(avatarFilter('head', [100, 50, 340], 60, 30).startsWith('crop=340:340:0:0,'), 'a square that sticks out on the left or top starts at 0')
  assert(avatarFilter('head', null, 60, 30) === avatarFilter('full', null, 60, 30) && avatarFilter('full', [471, 200, 340], 60, 30) === avatarFilter('full', null, 60, 30), 'no head square, or the whole picture asked for: the full filter')
  const argv = avatarArgv('/c/pics/a.webp', '/c/out.rgba', 'full', null, 6, 3)
  assert(argv[0] === 'ffmpeg' && argv[argv.indexOf('-i') + 1] === '/c/pics/a.webp' && argv[argv.indexOf('-vf') + 1] === avatarFilter('full', null, 6, 3), 'input and filter')
  assert(argv.slice(argv.indexOf('-frames:v')).join(' ') === '-frames:v 1 -f rawvideo -pix_fmt rgba /c/out.rgba', 'one raw RGBA frame, even from an animated image, into the output file')
})

test('the picture box fills the pane body less the rows under it, within the caps; inline above the prompt stays short', () => {
  assert(JSON.stringify(avatarSize('dock', 40, 30, 2)) === '{"cols":40,"rows":28}', 'body less the label and the switch')
  assert(JSON.stringify(avatarSize('dock', 300, 300, 1)) === '{"cols":160,"rows":100}', 'the caps')
  assert(JSON.stringify(avatarSize('inline', 40, 30, 1)) === `{"cols":40,"rows":${AVATAR_INLINE_ROWS}}`, 'inline')
  assert(JSON.stringify(avatarSize('dock', 40.9, 30.9, 1)) === '{"cols":40,"rows":29}', 'whole cells')
  const none = '{"cols":0,"rows":0}'
  assert(JSON.stringify(avatarSize('dock', 40, 2, 2)) === none && JSON.stringify(avatarSize('inline', 0, 30, 1)) === none && JSON.stringify(avatarSize('dock', Number.NaN, 30, 1)) === none, 'nothing fits: no box, never a negative one')
})

test('image paths resolve against the config dir, and each window converts into a file of its own', () => {
  assert(avatarSource('/c', 'pics/a.webp') === '/c/pics/a.webp' && avatarSource('/c', 'C:\\pics\\a.webp') === 'C:/pics/a.webp' && avatarSource('/c', '/pics/a.webp') === '/pics/a.webp', 'relative, drive path, root path')
  assert(avatarScratch('/c', 'ab-12') === '/c/model-relay-avatars/.cache/ab-12.rgba', 'one file per session id')
  assert(!avatarScratch('/c', '../x').includes('..') && avatarScratch('/c', '').endsWith('/window.rgba'), 'a session id cannot name a path')
})

test('a view counts as made only from exactly what is wanted now, down to the config entry', () => {
  const entries = parseAvatars({ aaa: { image: 'a.png', head: [5, 5, 4] } })
  const body = { placement: 'dock' as const, columns: 10, rows: 6 }
  const aim = { ...AVATAR_START, name: 'aaa', label: 'aaa · m', mode: 'head' as const, body }
  const want = avatarWanted(aim, entries)
  assert(want.mode === 'head' && want.entry?.image === 'a.png', 'a persona with a head square can show it')
  assert(want.cols === 10 && want.rows === 4, 'the label and the mode switch take two of the six rows')
  assert(avatarWanted({ ...aim, name: 'bbb' }, entries).rows === 5 && avatarWanted(AVATAR_START, entries).cols === 0, 'one row for the label alone; no box before the pane has drawn')
  const made = { ...want, cells: 'AAAA', error: null }
  assert(avatarMade(made, want) && !avatarMade(AVATAR_EMPTY, want), 'made from this, not from nothing')
  assert(!avatarMade(made, avatarWanted({ ...aim, body: { ...body, columns: 11 } }, entries)) && !avatarMade(made, avatarWanted({ ...aim, mode: 'full' }, entries)) && !avatarMade(made, avatarWanted({ ...aim, label: 'aaa · n' }, entries)), 'another size, mode or label')
  assert(!avatarMade(made, avatarWanted(aim, parseAvatars({ aaa: { image: 'b.png', head: [5, 5, 4] } }))), 'an edited config entry')
  assert(avatarWanted({ ...aim, name: 'bbb' }, entries).entry === null && avatarWanted(aim, parseAvatars({ aaa: 'a.png' })).mode === 'full', 'no entry, or an entry without a head square: the whole picture, whatever the preference')
})

test('two pixels make one half-block cell, and a see-through pixel is the terminal default, never a painted half', () => {
  const words = (rgba: number[], cols: number, rows: number) => {
    const bytes = base64ToBytes(rasterCells(Uint8Array.from(rgba), cols, rows))
    const view = new DataView(bytes.buffer)
    return Array.from({ length: bytes.length / 4 }, (_, i) => view.getUint32(i * 4, true))
  }
  const red = [255, 0, 0, 255]
  const blue = [0, 0, 255, 255]
  const hex = (w: number[]) => w.map((x) => x.toString(16)).join(' ')
  assert(hex(words([...red, ...blue], 1, 1)) === '2580 ff0000 ff', 'upper pixel is the foreground of the upper half block, lower the background')
  assert(Array.from(base64ToBytes(rasterCells(Uint8Array.from([...red, ...blue]), 1, 1))).join() === '128,37,0,0,0,0,255,0,255,0,0,0', 'little-endian u32 triplets')
  assert(hex(words([...red, 9, 9, 9, 0], 1, 1)) === '2580 ff0000 1000000', 'a clear lower pixel is the default background')
  assert(hex(words([9, 9, 9, 127, ...blue], 1, 1)) === '2584 ff 1000000', 'a clear upper pixel makes a lower half block: an upper one would paint the text color there')
  assert(hex(words([9, 9, 9, 128, ...blue], 1, 1)) === '2580 90909 ff', 'half opaque counts as a pixel')
  assert(hex(words([1, 2, 3, 0, 4, 5, 6, 0], 1, 1)) === '20 1000000 1000000', 'nothing in either half: a blank')
  assert(hex(words([...red, 0, 255, 0, 255, ...blue, 255, 255, 255, 255], 2, 1)) === '2580 ff0000 ff 2580 ff00 ffffff', 'rows of pixels pair up per column, cells run left to right')
  assert(words(Array.from({ length: 4 * 4 }, (_, i) => (i % 4 === 3 ? 255 : i)), 1, 2).length === 6, 'a cell per two pixel rows')
})

test('base64 matches the standard encoding both ways, padding included', () => {
  const text = (s: string) => Uint8Array.from(Array.from(s, (c) => c.charCodeAt(0)))
  assert(bytesToBase64(text('Many hands make light work.')) === 'TWFueSBoYW5kcyBtYWtlIGxpZ2h0IHdvcmsu', 'no padding')
  assert(bytesToBase64(text('Ma')) === 'TWE=' && bytesToBase64(text('M')) === 'TQ==' && bytesToBase64(new Uint8Array(0)) === '', 'padding')
  for (const n of [0, 1, 2, 3, 4, 5, 255, 256]) {
    const bytes = Uint8Array.from({ length: n }, (_, i) => (i * 37 + 11) & 255)
    assert(base64ToBytes(bytesToBase64(bytes)).join() === bytes.join(), `${n} bytes survive the round trip`)
  }
  assert(base64ToBytes('TWE=').join() === '77,97' && base64ToBytes('TQ').join() === '77', 'padded or not')
})
