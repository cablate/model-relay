import { test } from 'claude-code/testing'
import {
  RESUME_UNSET,
  accountLimitedText,
  accountNames,
  accountRefusedText,
  claudeAs,
  routeLabel,
  sessionAnswer,
  sessionRefusedText,
  switchRefusal,
  accountServingText,
  selfServingText,
  agentProviders,
  AVATAR_EMPTY,
  AVATAR_INLINE_ROWS,
  AVATAR_START,
  avatarArgv,
  AVATAR_MIN_SIDE,
  avatarBytes,
  avatarCrop,
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
  glyphCells,
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
  apiOnlyToastText,
  accountAnswer,
  accountArgv,
  isUuid,
  limitToastText,
  manualSwitchText,
  parseFallback,
  switchPlan,
  wantsApiOnlyToast,
  wantsLimitToast,
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
  assert(Object.keys(parseLocal({ port: 9001 })!).sort().join() === 'avatarPane,avatars,fallback,nodePath,outdated,port,statusBar', 'nothing about providers')
  assert(parseLocal({})!.avatarPane === false && parseLocal({ avatarPane: true })!.avatarPane === true && parseLocal({ avatarPane: 'on' })!.avatarPane === false, 'the avatar pane is opt-in, true only')
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
    assert(switchedText('claude', 'claude', lang, 'team-1').includes('Claude (team-1)'), `an account window names its own login (${lang})`)
  }
  const h = health({ session: 'aaa', providers: { aaa: 'aaa-9', bbb: 'bbb-1' }, aliases: { haiku: 'bbb' }, failoverChain: ['bbb'], config: { failoverEnabled: true, retryEnabled: true, proxyEnabled: false }, ping: { aaa: { verdict: 'ok', status: 200, firstByteMs: 300, at: 1, detail: '' } } })
  const rep = providerReport(h, 0, 'en')
  assert(rep.includes('/provider help') && !rep.includes('/provider failover') && !rep.includes('/provider doctor'), 'the status points at help and lists no commands')
  assert(rep.split('\n').filter((l) => l.startsWith('Shared by every window:')).length === 1 && rep.includes('haiku → bbb'), 'the shared switches and aliases on one line')
  const ping = pingReport(h, 'en')
  assert(ping.includes('test ok 300ms') && !ping.includes('/provider claude') && !ping.includes('Shared by every window'), 'a ping shows only the providers and their tests')
  const help = helpText(['aaa'], 'zh')
  assert(['這個視窗：', '所有視窗共用：', '設定與檢查：'].every((g) => help.includes(g)), 'commands grouped by what they reach')
  assert(['status', 'ping', 'setup', 'doctor', 'restart', 'failover', 'retry', 'rc', 'alias', 'probe', 'init'].every((c) => help.includes(`/provider ${c}`)) && help.includes('model-relay:aaa'), 'every command and the subagent type')
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

test('A12: a second Claude account is a /provider choice but gets no model-relay subagent', () => {
  const h = health({
    providers: { aaa: 'aaa-9', spare: 'anthropic-account' },
    kinds: { SPARE: 'Anthropic' },
    unresolved: [{ provider: 'late', keychain: 'svc/acct' }],
  })
  assert(JSON.stringify(h.kinds) === '{"spare":"anthropic"}', 'kinds read, lower case')
  assert(h.providers.spare === 'anthropic-account', 'the account stays in the picker list')
  const agents = agentProviders(h.providers, h.kinds)
  assert(JSON.stringify(Object.keys(agents)) === '["aaa"]', 'only real models get an agent')
  assert(providerAgentSpecs(agents).every((s) => s.name !== 'spare'), 'no model-relay:spare agent')
  assert(relayAgent('model-relay:spare', agents) === null, 'a spawn naming it is left alone')
  assert(JSON.stringify(agentProviders(h.providers)) === JSON.stringify(h.providers), 'an older router without kinds: everything as before')
  assert(providerReport(h, 0, 'en').includes('○ /provider spare    Claude (spare)'), 'the account is a row to switch to, as Claude under its name (B5)')
  assert(!helpText(Object.keys(agents), 'en').includes('model-relay:spare'), 'help lists no subagent for it')
  const help = helpText(Object.keys(agents), 'en', accountNames(h.providers, h.kinds))
  assert(help.includes('/provider spare') && help.includes('Claude accounts') && !help.includes('model-relay:spare'), 'help names the account as a /provider choice')
  assert(helpText(Object.keys(agents), 'zh', ['spare']).includes('Claude 帳號'), 'and in Chinese')
  assert(!helpText(Object.keys(agents), 'en').includes('Claude accounts'), 'no line without one')
  assert(JSON.stringify(accountNames(h.providers, h.kinds)) === '["spare"]', 'the account is named in /provider help')
  const odd = health({ providers: { aaa: 'aaa-9', spare: 'anthropic-account', fut: 'x' }, kinds: { spare: 'anthropic', fut: 'future-kind' } })
  assert(JSON.stringify(accountNames(odd.providers, odd.kinds)) === '["spare"]', 'a kind this hook does not know is not called an account')
  assert(accountNames(h.providers).length === 0 && accountNames({ constructor: 'x' }, {}).length === 0, 'no kinds: no accounts')
  const hints = healthHints(h, 'en')
  assert(hints.length === 1 && hints[0]!.includes('keychain item svc/acct') && hints[0]!.includes('/provider restart') && hints[0]!.includes('any change to model-relay.json'), 'an unreadable keychain item is named, and the retry')
  assert(healthHints(h, 'zh')[0]!.includes('鑰匙圈項目 svc/acct') && healthHints(h, 'zh')[0]!.includes('改動 model-relay.json'), 'and in Chinese')
  const bare = healthHints(health({ unresolved: [{ provider: 'odd', keychain: '' }] }), 'en')
  assert(bare.length === 1 && bare[0]!.includes('"keychain:" names no item') && !bare[0]!.includes('env:'), 'a bare keychain: token is a keychain hint, not an env one')
  assert(healthHints(health({ unresolved: [{ provider: 'odd', keychain: '' }] }), 'zh')[0]!.includes('「keychain:」'), 'and in Chinese')
  const mal = health({ unresolved: [{ provider: 'odd', keychain: 'nope', malformed: true }] })
  assert(mal.unresolved[0]!.malformed === true, 'malformed is read')
  const malHint = healthHints(mal, 'en')
  assert(malHint.length === 1 && malHint[0]!.includes('reference is malformed') && !malHint[0]!.includes('model-relay.json'), 'a malformed reference gets its own hint, with no retry promise')
  assert(healthHints(mal, 'zh')[0]!.includes('格式不對') && !healthHints(mal, 'zh')[0]!.includes('model-relay.json'), 'and in Chinese')
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
  assert(!helpText([], 'en').includes('avatar') && !helpText([], 'zh').includes('avatar'), 'the experimental avatar pane stays out of help')
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

test('ffmpeg is asked for exactly the box: the whole image fitted inside it at its true shape, or the head square first, as 8 x 8 samples a cell', () => {
  const fit = 'scale=600:600:force_original_aspect_ratio=decrease:flags=area,format=rgba,pad=600:600:(ow-iw)/2:(oh-ih)/2:color=0x00000000'
  const samples = 'scale=480:240:flags=area,unsharp=3:3:0.6,eq=saturation=1.12:contrast=1.04'
  assert(avatarFilter('full', null, 60, 30) === `${fit},${samples}`, 'a cell is 10 x 20 pixels, aspect kept, transparent padding, then 8 x 8 samples a cell, sharpened and a little more colorful')
  assert(avatarFilter('head', [471, 200, 340], 60, 30) === `crop=w='min(340,iw)':h='min(340,ih)':x='max(0,min(471-ow/2,iw-ow))':y='max(0,min(200-oh/2,ih-oh))',${fit},${samples}`, 'a square box: the head square, centred on x and y and held inside the picture')
  assert(avatarBytes(60, 30) === 480 * 240 * 4 && avatarBytes(2, 1) === 512, 'the frame it writes: 8 x 8 RGBA samples a cell')
  assert(avatarFilter('head', null, 60, 30) === avatarFilter('full', null, 60, 30) && avatarFilter('full', [471, 200, 340], 60, 30) === avatarFilter('full', null, 60, 30), 'no head square, or the whole picture asked for: the full filter')
  const argv = avatarArgv('/c/pics/a.webp', '/c/out.rgba', 'full', null, 6, 3)
  assert(argv[0] === 'ffmpeg' && argv[argv.indexOf('-i') + 1] === '/c/pics/a.webp' && argv[argv.indexOf('-vf') + 1] === avatarFilter('full', null, 6, 3), 'input and filter')
  assert(argv.slice(argv.indexOf('-frames:v')).join(' ') === '-frames:v 1 -f rawvideo -pix_fmt rgba /c/out.rgba', 'one raw RGBA frame, even from an animated image, into the output file')
})

test('the head crop takes the box shape, narrowing no further than three quarters of its square', () => {
  // 47 x 37 cells is 470 x 740 pixels: narrower than 0.75 of the square, so 0.75 wide and as tall as the box's shape
  assert(JSON.stringify(avatarCrop([468, 149, 246], 47, 37)) === `[${Math.round(246 * AVATAR_MIN_SIDE)},${Math.round(Math.round(246 * AVATAR_MIN_SIDE) / (470 / 740))},468,149]`, 'a tall dock: narrowed to the floor, then grown down and up')
  const [w, h] = avatarCrop([400, 300, 200], 40, 25) // 400 x 500: within the floor, so the box's own shape at the square's height
  assert(w === 160 && h === 200, 'a slightly tall box keeps the square height')
  const [ww, wh] = avatarCrop([400, 300, 200], 60, 10) // 600 x 200: flattened to the floor, then grown sideways
  assert(wh === 150 && ww === 450, 'a wide box flattens no further than the floor either')
  assert(JSON.stringify(avatarCrop([400, 300, 200], 60, 30)) === '[200,200,400,300]', 'a square box is the square')
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
  const aim = { ...AVATAR_START, name: 'aaa', label: 'aaa · m', body }
  const want = avatarWanted(aim, entries)
  assert(want.mode === 'head' && want.entry?.image === 'a.png', 'a persona with a head square shows it')
  assert(want.cols === 10 && want.rows === 5 && avatarWanted({ ...aim, name: 'bbb' }, entries).rows === 5, 'the label takes one of the six rows, head square or not')
  assert(avatarWanted(AVATAR_START, entries).cols === 0, 'no box before the pane has drawn')
  const made = { ...want, cells: 'AAAA', error: null }
  assert(avatarMade(made, want) && !avatarMade(AVATAR_EMPTY, want), 'made from this, not from nothing')
  assert(!avatarMade(made, avatarWanted({ ...aim, body: { ...body, columns: 11 } }, entries)) && !avatarMade(made, avatarWanted({ ...aim, label: 'aaa · n' }, entries)), 'another size or label')
  assert(!avatarMade(made, avatarWanted(aim, parseAvatars({ aaa: { image: 'b.png', head: [5, 5, 4] } }))), 'an edited config entry')
  assert(avatarWanted({ ...aim, name: 'bbb' }, entries).entry === null && avatarWanted(aim, parseAvatars({ aaa: 'a.png' })).mode === 'full', 'no entry, or an entry without a head square: the whole picture')
})

// An image of cols x rows cells, 8 x 8 RGBA samples each, from a function of the sample's place
const samples = (cols: number, rows: number, pixel: (x: number, y: number) => number[]): Uint8Array => {
  const out = new Uint8Array(cols * rows * 64 * 4)
  for (let y = 0; y < rows * 8; y++) for (let x = 0; x < cols * 8; x++) out.set(pixel(x, y), (y * cols * 8 + x) * 4)
  return out
}
const cellsOf = (rgba: Uint8Array, cols: number, rows: number): string[] => {
  const { words } = glyphCells(rgba, cols, rows)
  return Array.from({ length: words.length / 3 }, (_, i) => Array.from(words.slice(i * 3, i * 3 + 3), (w) => w.toString(16)).join(' '))
}
const RED = [255, 0, 0, 255]
const BLUE = [0, 0, 255, 255]
const CLEAR = [9, 9, 9, 0]

test('a cell takes the block glyph that fits its 8 x 8 samples best, the part the glyph paints as its foreground', () => {
  const one = (pixel: (x: number, y: number) => number[]) => cellsOf(samples(1, 1, pixel), 1, 1).join()
  assert(one((x) => (x < 4 ? RED : BLUE)) === '258c ff0000 ff', 'left half red, right half blue: the left half block, red on blue')
  assert(one((_x, y) => (y < 4 ? RED : BLUE)) === '2584 ff ff0000', 'top red, bottom blue: the lower half block, blue on red')
  assert(one((_x, y) => (y < 3 ? RED : BLUE)) === '2585 ff ff0000', 'the top three rows red: the lower five eighths')
  assert(one((x) => (x < 3 ? RED : BLUE)) === '258d ff0000 ff', 'the left three columns red: the left three eighths')
  assert(one((x, y) => (x < 4 && y < 4 ? RED : BLUE)) === '2598 ff0000 ff', 'one quadrant: the quadrant block')
  assert(one((x, y) => ((x < 4) === (y < 4) ? RED : BLUE)) === '259a ff0000 ff', 'a checker: the diagonal quadrants')
  assert(one(() => [10, 200, 30, 255]) === '2588 ac81e 1000000', 'one color: the full block, and no color for the background that is never seen')
})

test('a see-through sample is the terminal default, painted with a glyph whose foreground is a real color', () => {
  const one = (pixel: (x: number, y: number) => number[]) => cellsOf(samples(1, 1, pixel), 1, 1).join()
  assert(one(() => CLEAR) === '20 1000000 1000000', 'nothing opaque: a blank in the default colors')
  assert(one((_x, y) => (y < 4 ? RED : CLEAR)) === '2580 ff0000 1000000', 'the lower half clear: the upper half block, the default background below')
  assert(one((_x, y) => (y < 4 ? CLEAR : BLUE)) === '2584 ff 1000000', 'the upper half clear: the lower half block')
  assert(one((x) => (x < 4 ? CLEAR : BLUE)) === '2590 ff 1000000', 'the left half clear: the right half block, never a left half block in the default foreground (the text color)')
  assert(one((x) => (x < 4 ? RED : CLEAR)) === '258c ff0000 1000000', 'the right half clear')
  assert(one((x, y) => (x < 4 && y < 4 ? CLEAR : BLUE)) === '259f ff 1000000', 'the upper left quadrant clear: the other three quadrants')
  assert(one((x) => (x < 7 ? CLEAR : BLUE)) === '2595 ff 1000000', 'a clear left seven eighths: the right eighth block')
  assert(one((_x, y) => (y < 4 ? RED : [9, 9, 9, 127])) === '2580 ff0000 1000000', 'alpha 127 is clear')
  assert(one((_x, y) => (y < 4 ? RED : [0, 0, 255, 128])) === '2584 ff ff0000', 'alpha 128 is a color')
  assert(one((x, y) => (y < 4 ? RED : x === 0 && y === 7 ? BLUE : CLEAR)) === '2580 ff0000 1000000', 'a side that is mostly clear is clear: one stray sample is dropped')
})

test('a cell is judged on its own 8 x 8 samples and cells run left to right, then down, as little-endian u32 triplets', () => {
  const two = samples(2, 1, (x) => (x < 8 ? RED : BLUE))
  assert(cellsOf(two, 2, 1).join(' | ') === '2588 ff0000 1000000 | 2588 ff 1000000', 'each cell its own color')
  const down = samples(1, 2, (_x, y) => (y < 8 ? RED : BLUE))
  assert(cellsOf(down, 1, 2).join(' | ') === '2588 ff0000 1000000 | 2588 ff 1000000', 'then the next row')
  const bytes = base64ToBytes(rasterCells(samples(1, 1, () => [10, 200, 30, 255]), 1, 1))
  assert(bytes.join() === '136,37,0,0,30,200,10,0,0,0,0,1', 'code point, foreground, background, each little-endian')
  assert(rasterCells(two, 2, 1).length === 32 && base64ToBytes(rasterCells(two, 2, 1)).length === 24, 'twelve bytes a cell')
})

test('the cells use at most 1024 distinct color pairs, and only block glyphs, whatever the picture', () => {
  let seed = 7
  const random = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32)
  const color = () => [Math.floor(random() * 256), Math.floor(random() * 256), Math.floor(random() * 256), 255]
  // Every cell a left half of one color and a right half of another: more pairs asked for than a Raster paints
  const [cols, rows] = [50, 45]
  const halves = Array.from({ length: cols * rows }, () => [color(), color()])
  const asked = new Set(halves.map(([a, b]) => `${a}|${b}`)).size
  assert(asked > 2000, `the picture asks for ${asked} pairs`)
  const noisy = samples(cols, rows, (x, y) => halves[Math.floor(y / 8) * cols + Math.floor(x / 8)]![x % 8 < 4 ? 0 : 1]!)
  const made = glyphCells(noisy, cols, rows)
  assert(made.words.length === cols * rows * 3, 'a cell each')
  assert(made.pairs <= 1024, `${made.pairs} color pairs`)
  const pairs = new Set<string>()
  const colors = new Set<number>()
  for (let i = 0; i < made.words.length; i += 3) {
    pairs.add(`${made.words[i + 1]}|${made.words[i + 2]}`)
    colors.add(made.words[i + 1]!)
    colors.add(made.words[i + 2]!)
  }
  assert(pairs.size === made.pairs, 'the count is the pairs the cells use')
  assert(colors.size <= 160, `${colors.size} colors: every one snapped to the palette (160 at most for a picture this big)`)
  assert(rasterCells(noisy, cols, rows).length === cols * rows * 16, 'and it packs to a Raster all the same')

  // See-through blobs and fine noise: no foreground is the default but a blank's, and only the block glyphs show up
  const blocks = new Set([0x20, 0x2580, 0x2588, 0x2590, 0x2594, 0x2595, ...Array.from({ length: 7 }, (_, i) => 0x2581 + i), ...Array.from({ length: 7 }, (_, i) => 0x2589 + i), ...Array.from({ length: 10 }, (_, i) => 0x2596 + i)])
  const blobs = samples(30, 20, (x, y) => (((x >> 2) * 7 + (y >> 2) * 13) % 5 < 2 ? CLEAR : color()))
  const words = glyphCells(blobs, 30, 20).words
  let clear = 0
  for (let i = 0; i < words.length; i += 3) {
    assert(blocks.has(words[i]!), `U+${words[i]!.toString(16)} is a block glyph`)
    assert(words[i] === 0x20 || words[i + 1] !== 0x01000000, `U+${words[i]!.toString(16)} at ${i / 3} has a real foreground color`)
    if (words[i + 2] === 0x01000000) clear++
  }
  assert(clear > 20, 'the see-through parts stay the terminal default')
  assert(glyphCells(blobs, 30, 20).pairs <= 1024, 'with see-through parts too')
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

// ---------- accountFallback: /provider switch and the account toasts ----------

const WRAPPER = '0f1e2d3c-4b5a-4968-8776-5a4b3c2d1e0f'
const SID = '11111111-2222-4333-8444-555555555555'
const fb = (mode: string, extra: object = {}) => parseFallback({ accountFallback: { mode, account: 'Second' }, accounts: { ' second ': { configDir: '~/.claude-second' } }, ...extra })

test('accountFallback is read for the mode, the account and its config dir; an unknown mode is off', () => {
  const f = fb('switch')
  assert(f.mode === 'switch' && f.account === 'second' && f.accountDir === '~/.claude-second', 'found as providers.<name> is: trimmed, any case')
  assert(fb('rc_keep').mode === 'off' && parseFallback({}).mode === 'off' && parseFallback({ accountFallback: { mode: 3 } }).mode === 'off', 'off unless one of the four')
  for (const m of ['off', 'switch', 'rc-keep', 'api-only']) assert(fb(m).mode === m, m)
  assert(parseFallback(JSON.parse('{"accountFallback":{"mode":"switch","account":"constructor"},"accounts":{}}')).accountDir === '', 'an inherited name is no account')
  assert(parseLocal({ format: 2, accountFallback: { mode: 'switch' } })!.fallback.mode === 'switch', 'parseLocal carries it')
})

test('the registration carries the time the window first saw it, only when there is one', () => {
  const cfg = parseLocal({ format: 2, port: 5 })!
  const body = (since?: number) => JSON.parse(accountArgv(cfg, SID, 'second', false, since)[accountArgv(cfg, SID, 'second', false, since).indexOf('-d') + 1])
  assert(JSON.stringify(body()) === JSON.stringify({ sid: SID, account: 'second' }), 'no time: the body as it was')
  assert(JSON.stringify(body(1700000000000)) === JSON.stringify({ sid: SID, account: 'second', since: 1700000000000 }), 'with the time')
})

test('A3: /provider switch writes a handoff only in mode switch, in a window the wrapper started, from a person at it', () => {
  const base = { fallback: fb('switch'), arg: '', wrapperId: WRAPPER, interactive: true, typed: true, sid: SID, home: '/Users/me', relayDir: '/Users/me/.claude' }
  const w = switchPlan(base, 'en')
  assert(w.action === 'write' && w.wrapperId === WRAPPER && w.sid === SID, 'the handoff: the wrapper id names the file, the sid is its content')
  assert(w.text.includes('/exit') && w.text.includes('second'), w.text)
  assert(switchPlan({ ...base, arg: 'SECOND' }).action === 'write', 'the configured account, in any case')
  const manual = `CLAUDE_CONFIG_DIR=/Users/me/.claude-second MODEL_RELAY_CONFIG_DIR=/Users/me/.claude claude --resume ${SID}`
  for (const [why, o, reason] of [
    ['no wrapper', { wrapperId: undefined }, 'not started by the launcher wrapper'],
    ['a wrapper id that is no UUID', { wrapperId: '../../x' }, 'not started by the launcher wrapper'],
    ['an empty wrapper id', { wrapperId: '' }, 'not started by the launcher wrapper'],
    ['a -p run', { interactive: false, typed: false }, 'no person is at this session'],
    ['a -p run, origin claimed typed', { interactive: false }, 'no person is at this session'],
    ['an interactive window, a command no person sent', { typed: false }, 'it must be typed at the prompt'],
  ] as const) {
    const p = switchPlan({ ...base, ...o }, 'en')
    assert(p.action === 'say' && p.text.includes(manual) && p.text.startsWith('Nothing was written') && p.text.includes(reason), `${why}: ${p.text}`)
  }
  assert(!switchPlan({ ...base, typed: false }, 'en').text.includes('no person'), 'an interactive window is not called empty')
  for (const mode of ['off', 'rc-keep', 'api-only']) {
    const p = switchPlan({ ...base, fallback: fb(mode) }, 'en')
    assert(p.action === 'say' && p.text.includes(`needs accountFallback.mode "switch" (now "${mode}")`), mode)
  }
  assert(switchPlan({ ...base, arg: 'other' }).action === 'say', 'only the configured account')
  assert(switchPlan({ ...base, fallback: { mode: 'switch', account: 'second', accountDir: '' } }).action === 'say', 'no config dir: nothing to switch to')
  // a plugin path with a space is quoted, so the printed command pastes as it is
  const spaced = switchPlan({ ...base, setup: '/p a/tools/setup.mjs', fallback: fb('off') }, 'en').text
  assert(spaced.includes(`node '/p a/tools/setup.mjs' set accountFallback.mode switch`), 'sh-quoted path')
  const spacedWin = switchPlan({ ...base, isWin: true, setup: 'C:\\Users\\J D\\setup.mjs', fallback: fb('off') }, 'en').text
  assert(spacedWin.includes(`node 'C:\\Users\\J D\\setup.mjs' set`), 'PowerShell-quoted path')
  // verifier: both refusals name the exact commands, with this plugin's setup.mjs
  const setup = '/p/tools/setup.mjs'
  for (const lang of ['en', 'zh'] as const) {
    const wrongMode = switchPlan({ ...base, setup, fallback: fb('off') }, lang)
    assert(wrongMode.action === 'say' && wrongMode.text.includes(`node ${setup} set accountFallback.mode switch`) && !wrongMode.text.includes('model-relay.json'), `${lang}: ${wrongMode.text}`)
    const noAccount = switchPlan({ ...base, setup, fallback: { mode: 'switch', account: '', accountDir: '' } }, lang)
    assert(noAccount.action === 'say' && noAccount.text.includes(`node ${setup} account-add <name>`) && noAccount.text.includes(`node ${setup} set accountFallback.account <name>`) && !noAccount.text.includes('model-relay.json'), `${lang}: ${noAccount.text}`)
    const noDir = switchPlan({ ...base, setup, fallback: { mode: 'switch', account: 'second', accountDir: '' } }, lang)
    assert(noDir.action === 'say' && noDir.text.includes(`node ${setup} account-add second`) && !noDir.text.includes('model-relay.json'), `${lang}: ${noDir.text}`)
  }
  assert(switchPlan({ ...base, sid: '--dangerously-skip-permissions' }).action === 'say', 'a session id that is no UUID is never handed over')
  assert(switchPlan({ ...base, sid: '--dangerously-skip-permissions', wrapperId: undefined }, 'en').text.includes('no id to resume'), 'nor printed')
  assert(switchPlan(base, 'zh').text.includes('/exit'), 'zh')
})

test('the manual command: same working directory, shared transcripts, quoted for the shell of this platform, ~ only at the start', () => {
  const via = { dir: '/h/.claude', anthropic: true }
  const en = manualSwitchText('a', "/x/it's dir", SID, '/h', 'no-wrapper', false, 'en', via)
  assert(en.includes(`CLAUDE_CONFIG_DIR='/x/it'\\''s dir' MODEL_RELAY_CONFIG_DIR=/h/.claude claude --resume ${SID}`), 'quoted')
  assert(en.includes('from this same working directory') && en.includes('shares this one\'s transcripts (projects/'), 'says what it needs, no more')
  assert(manualSwitchText('a', '~/d', SID, '/h', 'no-wrapper', false, 'en', via).includes('CLAUDE_CONFIG_DIR=/h/d '), 'home')
  assert(manualSwitchText('a', '/a~/d', SID, '/h', 'no-wrapper', false, 'en', via).includes("CLAUDE_CONFIG_DIR='/a~/d' "), 'a ~ elsewhere is not expanded (and quoted)')
  const win = manualSwitchText('a', "~/it's", SID, 'C:\\Users\\me', 'no-wrapper', true, 'en', { dir: 'C:/Users/me/.claude', anthropic: true })
  assert(win.includes(`$env:CLAUDE_CONFIG_DIR='C:/Users/me/it''s'; $env:MODEL_RELAY_CONFIG_DIR='C:/Users/me/.claude'; claude --resume ${SID}`), `PowerShell on Windows: ${win}`)
  const zh = manualSwitchText('a', '~/d', SID, '/h', 'not-typed', false, 'zh', via)
  assert(zh.includes('同一個工作資料夾') && zh.includes('projects/') && zh.includes('親自輸入'), zh)
  assert(isUuid(WRAPPER) && !isUuid(`${WRAPPER}x`) && !isUuid(undefined), 'uuid')
})

test('A3: the limit toast fires in mode switch when the router saw Claude\'s usage limit within the cooldown; the api-only toast in windows the wrapper did not start', () => {
  const now = 10_000_000
  const at = (claudeLimitedAt: number, cooldownMs?: number) => health({ claudeLimitedAt, ...(cooldownMs ? { config: { failoverEnabled: true, retryEnabled: true, proxyEnabled: false, cooldownMs } } : {}) })
  assert(at(now - 1000).claudeLimitedAt === now - 1000 && at(now, 60000).cooldownMs === 60000 && health({}).claudeLimitedAt === undefined, 'read from /__health')
  assert(wantsLimitToast('switch', at(now - 1000), now), 'a limit just now')
  assert(wantsLimitToast('switch', health({ claudeLimitedAt: now - 1000, failoverSince: 0, failoverChain: [] }), now), 'with an empty chain: no failover state at all')
  assert(!wantsLimitToast('switch', at(now - 600_000), now) && wantsLimitToast('switch', at(now - 599_999), now), 'within the default cooldown')
  assert(!wantsLimitToast('switch', at(now - 70_000, 60_000), now) && wantsLimitToast('switch', at(now - 50_000, 60_000), now), 'within the router\'s cooldown')
  assert(!wantsLimitToast('switch', health({ failoverSince: now - 1000, nextClaudeTry: now + 1000 }), now), 'failover state alone is not it')
  assert(!wantsLimitToast('switch', null, now) && !wantsLimitToast('switch', health({}), now), 'no router, or no limit seen')
  for (const m of ['off', 'rc-keep', 'api-only'] as const) assert(!wantsLimitToast(m, at(now - 1000), now), m)
  assert(limitToastText('en') === 'Your account reached its usage limit — /provider switch, then /exit' && limitToastText('zh').includes('/provider switch'), 'texts')
  assert(wantsApiOnlyToast('api-only', undefined) && wantsApiOnlyToast('api-only', 'nope'), 'unwrapped')
  assert(!wantsApiOnlyToast('api-only', WRAPPER) && !wantsApiOnlyToast('rc-keep', undefined) && !wantsApiOnlyToast('switch', undefined), 'wrapped, or another mode')
  assert(apiOnlyToastText('en').includes('Remote Control stays on here') && apiOnlyToastText('zh').includes('Remote Control'), 'texts')
  assert(helpText([], 'en', [], true).includes('/provider switch [<account>]') && helpText([], 'zh', [], true).includes('/provider switch'), 'listed in help in mode switch (B12)')
})

test('fix 7: the panel of an account window shows its own route, never main\'s failover; fix 5: a refusal is read from the status line', () => {
  const h = health({ failoverSince: 5, nextClaudeTry: 9, failoverProvider: 'other', providers: { other: 'other-model' }, session: 'claude', account: 'other-org' })
  const own = buildPanelData(h, 8950, false, 'en', 0, false, 'other-org')
  assert(own.failoverSince === 0 && own.nextClaudeTry === 0 && own.failoverProvider === null, 'no failover in the account window')
  assert(own.session === 'claude' && own.providers.other === 'other-model', 'its providers still listed')
  const main = buildPanelData(h, 8950, false, 'en', 0)
  assert(main.failoverSince === 5 && main.failoverProvider === 'other', 'main\'s window unchanged')
  assert(accountAnswer(0, '{"ok":true}\n200').result === 'changed', '2xx')
  const refused = accountAnswer(0, '{"type":"error","error":{"message":"model-relay router: that account is not in accounts"}}\n400')
  assert(refused.result === 'refused' && 'why' in refused && refused.why === 'that account is not in accounts', JSON.stringify(refused))
  assert(accountAnswer(7, '').result === 'failed' && accountAnswer(0, '{"ok":true}').result === 'failed', 'no answer, or no status: not a change')
})

test('fallback 11: a second Claude account in the status text and status file is named, never "anthropic-account"; accountServing likewise', () => {
  const fc = (x: [string, string]) => x.join(' ')
  const accts = { providers: { aaa: 'aaa-9', 'team-2': 'anthropic-account' }, kinds: { 'team-2': 'anthropic' }, failoverChain: [] }
  // a pin to the account, in a main window (rc-keep) and in team-1's window (switch, its fallback)
  const pinned = health({ ...accts, session: 'team-2' })
  assert(statusText(pinned, false) === '主線：Claude（team-2）（這個視窗固定用它）', statusText(pinned, false))
  assert(statusText(pinned, false, 'en') === 'Main: Claude (team-2) (pinned for this window)', statusText(pinned, false, 'en'))
  assert(statusText(pinned, false, 'en', 'team-1') === 'Main: Claude (team-2) (pinned for this window)', 'the same in the account window')
  assert(fc(statusFields(pinned, false)) === 'pinned claude/team-2' && fc(statusFields(pinned, false, false, 'team-1')) === 'pinned claude/team-2', 'status file: pinned')
  // team-1 at its usage limit: the router serves the window with team-2
  const serving = health({ ...accts, session: 'claude', account: 'team-1', accountServing: 'Team-2' })
  assert(serving.accountServing === 'team-2', 'accountServing read, lower case')
  assert(statusText(serving, false, 'en', 'team-1') === 'Main: Claude (team-2) (team-1 is at its usage limit)', statusText(serving, false, 'en', 'team-1'))
  assert(statusText(serving, false, 'zh', 'team-1') === '主線：Claude（team-2）（team-1 額度用完）', statusText(serving, false, 'zh', 'team-1'))
  assert(fc(statusFields(serving, false, false, 'team-1')) === 'claude claude/team-2', 'status file: serving')
  const unlisted = health({ ...accts, providers: { aaa: 'aaa-9' }, session: 'claude', account: 'team-1', accountServing: 'team-2' })
  assert(statusText(unlisted, false, 'en', 'team-1') === 'Main: Claude (team-1)' && fc(statusFields(unlisted, false, false, 'team-1')) === 'claude claude/team-1', 'a name the router does not list is not shown')
  // the rc-keep failover to an account names it too
  const fo = health({ providers: { spare: 'anthropic-account' }, kinds: { spare: 'anthropic' }, session: 'claude', failoverSince: 1, failoverProvider: 'spare', failoverChain: ['spare'] })
  assert(statusText(fo, false, 'en') === 'Claude limit reached: routing to Claude (spare)', statusText(fo, false, 'en'))
  assert(fc(statusFields(fo, false)) === 'failover claude/spare', 'status file: failover')
  for (const x of [pinned, serving, fo]) for (const lang of ['zh', 'en'] as const) assert(!statusText(x, false, lang, x === serving ? 'team-1' : null).includes('anthropic-account'), 'never the label')
  // an ordinary provider keeps its model id
  assert(fc(statusFields(health({ ...accts, session: 'aaa' }), false)) === 'pinned aaa-9' && statusText(health({ ...accts, session: 'aaa' }), false, 'en') === 'Main: aaa-9 (pinned for this window)', 'a model id as before')
  assert(accountServingText('team-1', 'team-2') === 'team-1 額度用完，這個視窗改用 team-2' && accountServingText('team-1', 'team-2', 'en') === 'team-1 reached its usage limit; this window uses team-2 now', 'the toast')
})

test('list 11 and 13: a main window names the account the relay\'s own account\'s limit moved it to (selfServing, a name only); an account window shows the current account of its list', () => {
  const fc = (x: [string, string]) => x.join(' ')
  // the router lists the fallback account nowhere else for a main window: the name alone is enough
  const main = health({ providers: { aaa: 'aaa-9' }, session: 'claude', failoverChain: ['aaa'], selfServing: 'Team-2' })
  assert(main.selfServing === 'team-2', 'read, lower case')
  assert(statusText(main, false, 'en') === 'Main: Claude (team-2) (your account is at its usage limit)', statusText(main, false, 'en'))
  assert(statusText(main, false) === '主線：Claude（team-2）（你的帳號額度用完）', statusText(main, false))
  assert(fc(statusFields(main, false)) === 'claude claude/team-2', fc(statusFields(main, false)))
  assert(selfServingText('team-2', 'en') === 'Your account reached its usage limit; this window uses team-2 now' && selfServingText('team-2') === '你的帳號額度用完，這個視窗改用 team-2', 'the toast')
  // a pin still wins; anything that is not a plain name is dropped
  assert(statusText(health({ providers: { aaa: 'aaa-9' }, session: 'aaa', failoverChain: [], selfServing: 'team-2' }), false, 'en') === 'Main: aaa-9 (pinned for this window)', 'a pin first')
  for (const bad of ['../x', 'a b', '', 7, 'x\ty']) assert(health({ providers: {}, session: 'claude', failoverChain: [], selfServing: bad }).selfServing === undefined, String(bad))
  // an account window walking its list: the router's accountServing is the account serving it now
  const walk = health({ providers: { 'team-2': 'anthropic-account', 'team-3': 'anthropic-account' }, kinds: { 'team-2': 'anthropic', 'team-3': 'anthropic' }, session: 'claude', account: 'team-1', accountServing: 'team-3', failoverChain: [] })
  assert(statusText(walk, false, 'en', 'team-1') === 'Main: Claude (team-3) (team-1 is at its usage limit)', statusText(walk, false, 'en', 'team-1'))
  assert(fc(statusFields(walk, false, false, 'team-1')) === 'claude claude/team-3')
})

// ---------- guidance on the account paths ----------

const accts = { providers: { aaa: 'aaa-9', 'team-2': 'anthropic-account' }, kinds: { 'team-2': 'anthropic' }, failoverChain: ['aaa'], switches: undefined }

test('B2: /provider status in an account window shows that account, its own view, never your failover, and the account its limit moved it to', () => {
  const h = health({ ...accts, session: 'claude', account: 'team-1', failoverSince: 5, nextClaudeTry: 9, failoverProvider: 'aaa', selfServing: 'team-3', accountServing: 'team-2', config: { failoverEnabled: true, retryEnabled: true, proxyEnabled: false } })
  const text = providerReport(h, 0, 'en', 'team-1')
  const lines = text.split('\n')
  assert(lines[0] === 'Main: Claude (team-2) (team-1 is at its usage limit)', lines[0]!)
  assert(!text.includes('limit reached') && !text.includes('retrying Claude') && !text.includes('429 failover') && !text.includes('team-3'), 'no failover suffix, no failover switch, no selfServing')
  assert(text.includes('○ /provider claude   Claude (team-1) (switching back rebuilds the prompt cache)') && text.includes('● /provider team-2   Claude (team-2)  ← in use'), 'the account is the Claude row; the account serving it is the row in use')
  const own = providerReport(health({ ...accts, session: 'claude', account: 'team-1' }), 0, 'en', 'team-1')
  assert(own.split('\n')[0] === 'Main: Claude (team-1)' && own.includes('● /provider claude   Claude (team-1)  ← in use'), own)
  const limited = providerReport(health({ ...accts, session: 'claude', account: 'team-1', accountLimited: true }), 0, 'en', 'team-1')
  assert(limited.split('\n')[0] === 'Main: Claude (team-1) (team-1 is at its usage limit and has no fallback account to move to)', limited)
  // a main window as before: its own failover, Anthropic Claude
  const main = providerReport(health({ ...accts, session: 'claude', failoverSince: 5, nextClaudeTry: 9, failoverProvider: 'aaa' }), 0, 'en')
  assert(main.includes('Claude limit reached: routing to aaa-9 (retrying Claude') && main.includes('● /provider claude   Anthropic Claude  ← in use'), 'main window: its own failover, Anthropic Claude')
  assert(main.includes('429 failover'), 'main keeps its failover line')
})

test('B5: a second Claude account is Claude under its name in /provider rows, the switch reply and the panel data, never "anthropic-account"', () => {
  const h = health({ ...accts, session: 'team-2' })
  for (const lang of ['en', 'zh'] as const) {
    assert(!providerReport(h, 0, lang).includes('anthropic-account') && !pingReport(h, lang).includes('anthropic-account'), `${lang}: rows`)
  }
  assert(pingReport(h, 'en').includes('/provider team-2   Claude (team-2)'), 'ping rows')
  assert(routeLabel(h.providers, h.kinds!, 'team-2', 'en') === 'Claude (team-2)' && routeLabel(h.providers, h.kinds!, 'aaa', 'en') === 'aaa-9' && routeLabel(h.providers, h.kinds!, 'nope', 'en') === undefined, 'routeLabel')
  assert(claudeAs('team-2', 'zh') === 'Claude（team-2）', 'zh label')
  assert(JSON.stringify(buildPanelData(h, 8950, false, 'en', 0).kinds) === '{"team-2":"anthropic"}', 'the panel gets the kinds, to label its rows')
})

test('B6: the panel data of an account window carries its account, what serves it and no failover chain; a main window carries the relay\'s own account\'s fallback', () => {
  const served = health({ ...accts, session: 'claude', account: 'team-1', accountServing: 'team-2', failoverSince: 5, failoverProvider: 'aaa' })
  const a = buildPanelData(served, 8950, false, 'en', 0, false, 'team-1')
  assert(a.account === 'team-1' && a.serving === 'team-2' && a.limited === false && a.failoverChain.length === 0 && a.failoverSince === 0, JSON.stringify([a.account, a.serving, a.limited, a.failoverChain]))
  const stuck = buildPanelData(health({ ...accts, session: 'claude', account: 'team-1', accountLimited: true }), 8950, false, 'en', 0, false, 'team-1')
  assert(stuck.limited === true && stuck.serving === null, 'at its limit with nobody to go to')
  const main = buildPanelData(health({ ...accts, session: 'claude', selfServing: 'team-3' }), 8950, false, 'en', 0)
  assert(main.account === null && main.serving === 'team-3' && main.limited === false && main.failoverChain.join() === 'aaa', 'a main window')
  assert(buildPanelData(null, 8950, true, 'en', 0).serving === null, 'offline: none')
})

test('B12: /provider help lists /provider switch [<account>] only where it works, and always names the account commands', () => {
  for (const lang of ['en', 'zh'] as const) {
    assert(!helpText([], lang).includes('/provider switch'), `${lang}: not outside mode switch or in an account window`)
    assert(helpText([], lang, [], true).includes('/provider switch [<account>]'), `${lang}: in a main window in mode switch`)
    assert(helpText([], lang).includes('account-add') && helpText([], lang).includes('account-sync') && helpText([], lang).includes('launcher'), `${lang}: Accounts line`)
  }
})

test('B13: the texts a person reads say your account, not "main"', () => {
  for (const lang of ['en', 'zh'] as const) {
    const texts = [limitToastText(lang), selfServingText('team-2', lang), accountServingText('team-1', 'team-2', lang), apiOnlyToastText(lang), accountRefusedText('team-1', 'x', lang), accountLimitedText('team-1', lang)]
    for (const t of texts) assert(!/\bmain\b|主帳號/i.test(t), t)
  }
})

test('B15: the router\'s 4xx reason reaches the person from /__session, as a refusal; no answer stays "did not respond"', () => {
  const body = '{"type":"error","error":{"type":"api_error","message":"model-relay router: provider \\"spare\\" is the fallback of another account\'s windows; this session cannot use it (configured: aaa)"}}'
  const refused = sessionAnswer(0, `${body}\n400`)
  assert(refused.result === 'refused' && 'why' in refused && refused.why.startsWith('provider "spare" is the fallback of another account\'s windows'), JSON.stringify(refused))
  assert(sessionRefusedText('x y', 'en') === 'The relay refused: x y. Nothing changed.' && sessionRefusedText('x y').includes('轉發站拒絕了：x y'), 'texts')
  assert(sessionAnswer(0, '{"ok":true,"session":"aaa"}').result === 'changed' && sessionAnswer(0, '{"ok":true}\n200').result === 'changed', 'changed')
  assert(sessionAnswer(7, '').result === 'failed' && sessionAnswer(0, '').result === 'failed', 'no answer')
})

test('B18: a zh refusal puts the router\'s English reason in its own parenthesis, after the zh sentence', () => {
  const zh = accountRefusedText('team-1', 'that account is not in accounts', 'zh')
  assert(zh === '轉發站沒有把這個視窗登記為 team-1 的視窗（轉發站回報：that account is not in accounts）。修好之前，它的 Claude 請求走你帳號的路徑。', zh)
  assert(accountRefusedText('team-1', 'x', 'en') === "The relay did not take this window as team-1's: x. Its Claude requests take your account's path until that is fixed.", 'en as before')
})

test('B14 (hook half): an account window at its usage limit with nobody to go to is told what to do; the health field is read as a boolean only', () => {
  assert(health({ accountLimited: true }).accountLimited === true && health({ accountLimited: 'yes' }).accountLimited === undefined && health({}).accountLimited === undefined, 'parseHealth')
  const en = accountLimitedText('team-1', 'en')
  assert(en.includes('team-1 reached its usage limit') && en.includes('accounts.team-1.fallback') && en.includes('continue in a window of your own account'), en)
  assert(accountLimitedText('team-1').includes('額度用完') && accountLimitedText('team-1').includes('你自己帳號的視窗'), 'zh')
})

test('/provider switch refuses an account name the launcher wrapper would refuse, before any handoff, with the command that sets a plain one', () => {
  const base = { arg: '', wrapperId: WRAPPER, interactive: true, typed: true, sid: SID, home: '/Users/me', relayDir: '/Users/me/.claude', setup: '/p/tools/setup.mjs' }
  for (const account of ['bad name', '../x', 'a/b', '-x']) {
    for (const lang of ['en', 'zh'] as const) {
      const p = switchPlan({ ...base, fallback: { mode: 'switch', account, accountDir: '~/d', accounts: {}, claudeIsAnthropic: true } }, lang)
      assert(p.action === 'say' && p.text.includes('node /p/tools/setup.mjs set accountFallback.account <name>') && p.text.includes(account), `${account}: ${JSON.stringify(p)}`)
      const r = switchRefusal({ account, ownDir: '/h/.claude', accountDir: '/h/d', setup: '/p/tools/setup.mjs', real: { own: '/h/.claude', account: '/h/d', ownProjects: '/p', accountProjects: '/p' } }, lang)
      assert(r !== null && r.includes('node /p/tools/setup.mjs set accountFallback.account <name>'), `${account}: ${r}`)
    }
  }
  assert(switchPlan({ ...base, fallback: fb('switch') }).action === 'write', 'a plain name still writes')
})

test('B4: /provider switch is refused before the handoff is written when the account folder is missing, is this window\'s own, or its projects folder is another one', () => {
  const base = { account: 'second', ownDir: '/h/.claude', accountDir: '/h/.claude-second' }
  const ok = { own: '/h/.claude', account: '/h/.claude-second', ownProjects: '/h/.claude/projects', accountProjects: '/h/.claude/projects' }
  assert(switchRefusal({ ...base, real: ok }, 'en') === null, 'a shared projects folder: nothing to refuse')
  const missing = switchRefusal({ ...base, real: { ...ok, account: undefined } }, 'en')!
  assert(missing.includes('/h/.claude-second (accounts.second.configDir) does not exist') && missing.includes('account-add') && missing.endsWith('Nothing was changed.'), missing)
  const same = switchRefusal({ ...base, real: { ...ok, account: '/h/.claude' } }, 'en')!
  assert(same.startsWith('accounts.second.configDir is this window\'s own config dir'), same)
  const apart = switchRefusal({ ...base, real: { ...ok, accountProjects: '/h/.claude-second/projects' } }, 'en')!
  assert(apart.includes('Make /h/.claude-second/projects a link to /h/.claude/projects (move or remove /h/.claude-second/projects first): ln -s /h/.claude/projects /h/.claude-second/projects. Nothing was changed.'), apart)
  assert(switchRefusal({ ...base, real: { ...ok, accountProjects: undefined } }, 'en')!.includes('ln -s /h/.claude/projects'), 'no projects folder at all')
  const ps = switchRefusal({ account: 'second', ownDir: 'C:/Users/me/.claude', accountDir: "C:/Users/me/it's", isWin: true, real: { ...ok, ownProjects: 'C:/A', accountProjects: 'C:/B' } }, 'en')!
  assert(ps.includes("New-Item -ItemType SymbolicLink -Path 'C:/Users/me/it''s/projects' -Target 'C:/Users/me/.claude/projects'"), ps)
  assert(switchRefusal({ ...base, real: { ...ok, account: '/H/.CLAUDE', own: '/h/.claude' }, isWin: true }, 'en')!.startsWith('accounts.second.configDir is this window'), 'Windows paths compare without case')
  assert(switchRefusal({ ...base, real: { ...ok, accountProjects: '/x' } }, 'zh')!.includes('沒有做任何變更'), 'zh')
})

test('B9: the api-only toast says why the window matters and which command starts the right one', () => {
  const en = apiOnlyToastText('en')
  assert(en.includes('Remote Control stays on here') && en.includes('"api-only" turns off') && en.includes('setup.mjs launcher'), en)
  assert(apiOnlyToastText('zh').includes('setup.mjs launcher') && apiOnlyToastText('zh').includes('沒有關閉'), 'zh')
})

test('B8 (hook half): off macOS a keychain item the relay cannot read is answered with what to write instead', () => {
  const h = health({ unresolved: [{ provider: 'late', keychain: 'svc/acct' }] })
  assert(healthHints(h, 'en', false, true)[0] === 'late is skipped: keychain: tokens work on macOS only; write env:<VAR> in its token here', 'Windows: no retry promise')
  const other = healthHints(h, 'en')[0]!
  assert(other.includes('any change to model-relay.json') && other.includes('keychain: tokens work on macOS only, on Linux write env:<VAR>'), 'elsewhere: both facts')
  assert(healthHints(h, 'zh', false, true)[0]!.includes('只能在 macOS 使用') && buildPanelData(h, 8950, false, 'en', 0, false, null, true).hints[0] === healthHints(h, 'en', false, true)[0], 'zh, and the panel follows')
})

test('B11 (setupBrief half), F12: the setup brief names the account commands, forbids running setup-token or passing a value to security -w, and asks before accountFallback changes', () => {
  const b = setupBrief('/p/tools/setup.mjs', 'node', 'add my second account', true, 'en')
  for (const word of ['account-add <name>', 'account-sync <name>', 'account-token <name> keychain:<service>/<account>', 'account-token <name> env:<VAR>', 'account-fallback <name>', 'set accountFallback.mode', 'terms of use']) assert(b.includes(word), word)
  assert(b.includes('Never run "claude setup-token" yourself, never pass a token value to "security -w"') && b.includes('Ask me before you change accountFallback.mode'), 'F12 rules')
  assert(b.includes('Never ask me to paste an API key into this chat'), 'the paste ban stays')
  assert(setupBrief('/p/tools/setup.mjs', 'node', '', false, 'zh').includes('account-add <name>'), 'also with no config yet')
})

test('A8, A16, F9: the command to resume by hand drops the wrapper\'s variables, keeps the relay only when claudeUrl is Anthropic, and has a PowerShell form', () => {
  const via = { dir: '/h/.claude', anthropic: true }
  const unset = RESUME_UNSET.map((v) => `-u ${v}`).join(' ')
  const sh = manualSwitchText('a', '~/d', SID, '/h', 'no-wrapper', false, 'en', via)
  assert(sh.includes(`env ${unset} CLAUDE_CONFIG_DIR=/h/d MODEL_RELAY_CONFIG_DIR=/h/.claude claude --resume ${SID}`) && !sh.includes('leaves the relay out'), sh)
  assert(RESUME_UNSET.includes('MODEL_RELAY_WRAPPER_ID') && RESUME_UNSET.includes('CLAUDE_CODE_OAUTH_TOKEN') && RESUME_UNSET.includes('ANTHROPIC_API_KEY') && RESUME_UNSET.includes('ANTHROPIC_AUTH_TOKEN'), 'the credentials are in the list')
  const plain = manualSwitchText('a', '~/d', SID, '/h', 'no-wrapper', false, 'en', { dir: '/h/.claude', anthropic: false })
  // claudeUrl elsewhere: no command at all (it would send the window through the relay as an unregistered one); the wrapper does the switch
  assert(!plain.includes('claude --resume') && !plain.includes('CLAUDE_CONFIG_DIR') && !plain.includes('leaves the relay out') && plain.includes('launcher wrapper') && plain.includes('/provider switch') && plain.startsWith('Nothing was written'), plain)
  assert(!manualSwitchText('a', '~/d', SID, '/h', 'no-wrapper', true, 'zh', { dir: '/h/.claude', anthropic: false }).includes('--resume'), 'zh, PowerShell: none either')
  const spaced = manualSwitchText('a', "/x/it's dir", SID, '/h', 'no-wrapper', false, 'en', { dir: '/r d/.claude', anthropic: true })
  assert(spaced.includes("CLAUDE_CONFIG_DIR='/x/it'\\''s dir' MODEL_RELAY_CONFIG_DIR='/r d/.claude' claude"), 'paths are expanded and quoted')
  const ps = manualSwitchText('a', "~/it's", SID, 'C:\\Users\\me', 'no-wrapper', true, 'en', { dir: 'C:\\Users\\me\\.claude', anthropic: true })
  assert(ps.includes('in a new PowerShell window') && ps.includes(`Remove-Item ${RESUME_UNSET.map((v) => `Env:${v}`).join(',')} -ErrorAction SilentlyContinue; $env:CLAUDE_CONFIG_DIR='C:/Users/me/it''s'; $env:MODEL_RELAY_CONFIG_DIR='C:/Users/me/.claude'; claude --resume ${SID}`), ps)
  assert(manualSwitchText('a', '~/d', SID, '/h', 'no-wrapper', true, 'zh', via).includes('在新的 PowerShell 視窗裡'), 'zh PowerShell')
  // switchPlan carries the relay dir and claudeUrl from the config
  const p = switchPlan({ fallback: fb('switch'), arg: '', wrapperId: undefined, interactive: true, typed: true, sid: SID, home: '/h', relayDir: '/h/.claude' }, 'en')
  assert(p.action === 'say' && p.text.includes('MODEL_RELAY_CONFIG_DIR=/h/.claude'), 'claudeUrl unset is Anthropic')
  const elsewhere = switchPlan({ fallback: fb('switch', { claudeUrl: 'https://gateway.example' }), arg: '', wrapperId: undefined, interactive: true, typed: true, sid: SID, home: '/h', relayDir: '/h/.claude' }, 'en')
  assert(elsewhere.action === 'say' && !elsewhere.text.includes('--resume') && elsewhere.text.includes('launcher wrapper'), 'a gateway claudeUrl: no command, the wrapper')
  assert(parseFallback({ claudeUrl: 'https://api.anthropic.com/' }).claudeIsAnthropic && parseFallback({}).claudeIsAnthropic && !parseFallback({ claudeUrl: 'http://api.anthropic.com' }).claudeIsAnthropic, 'claudeIsAnthropic')
})

test('A17: the zh texts use one term each: 額度用完 for a usage limit, 對話 ID for a session id', () => {
  const zh = [
    statusText(health({ ...accts, session: 'claude', account: 'team-1', accountServing: 'team-2' }), false, 'zh', 'team-1'),
    statusText(health({ providers: {}, session: 'claude', selfServing: 'team-2' }), false, 'zh'),
    accountServingText('team-1', 'team-2'), selfServingText('team-2'), limitToastText('zh'), accountLimitedText('team-1'),
    switchPlan({ fallback: fb('switch'), arg: '', wrapperId: WRAPPER, interactive: true, typed: true, sid: 'nope', home: '/h' }).text,
  ]
  for (const t of zh) assert(!t.includes('用量已滿') && !t.includes('代號'), t)
  assert(zh.slice(0, 6).every((t) => t.includes('額度用完')), 'the usage limit is 額度用完 everywhere')
  assert(zh[6]!.includes('對話 ID'), zh[6]!)
})
