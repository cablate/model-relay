// hooks/register.ts against a stand-in host, under plain Node (run by tools/test-hooks.mjs, which loads it with
// tools/hooks-loader.mjs; not a hooks module and not one of the engine's *.test.ts files, since it builds its own `$`
// and imports a fresh copy of register.ts per case). Each noun the module calls answers from `host`, and every call is
// recorded. A fresh copy per case, since the module's once-per-session flags live in module variables.
import '../router/test-env.js'
import { test } from 'node:test'
import assert from 'node:assert'

const WRAPPER = '0f1e2d3c-4b5a-4968-8776-5a4b3c2d1e0f'
const SID = '11111111-2222-4333-8444-555555555555'
const SETUP = '/plugin/tools/setup.mjs'
const REGISTER = new URL('../hooks/register.ts', import.meta.url).href

let copies = 0
async function load(host) {
  const mod = await import(`${REGISTER}?copy=${++copies}`)
  const hooks = {}
  mod.register((event, a, b) => {
    hooks[event] = typeof a === 'function' ? a : b
    return { catch: () => undefined }
  })
  const files = { [`${host.relay}/model-relay.json`]: JSON.stringify(host.cfg), '/plugin/.claude-plugin/plugin.json': '{"version":"9.9.9"}' }
  const $ = {
    plugin: { root: host.pluginRoot ?? '/plugin' },
    env: {
      get: async (k) => {
        host.envReads.push(k)
        return host.env[k]
      },
      set: async () => ({}),
    },
    settings: { read: async () => ({ language: 'English' }) },
    fs: {
      read: async (p) => {
        if (Object.hasOwn(files, p)) return files[p]
        throw new Error('ENOENT')
      },
      write: async (p, text) => {
        host.writes.push({ path: p, text })
      },
      // the directories this host has, by the path each resolves to
      stat: async (p) => {
        host.statted?.push(p)
        if (!Object.hasOwn(host.real, p)) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
        return { kind: 'directory', size: 0, mtimeMs: 0, isLink: host.real[p] !== p, realPath: host.real[p] }
      },
    },
    session: { id: async () => host.sid ?? SID },
    process: {
      run: async (argv, init) => {
        host.runs.push({ argv, init })
        if (host.hangLauncher && argv.includes('launcher')) return new Promise(() => {}) // never answers
        const url = argv.at(-1) ?? ''
        if (url.endsWith('/__account')) {
          // curl -w '\n%{http_code}': the status on a line of its own after the body
          const status = (code) => (argv.includes('-w') ? `\n${code}` : '')
          if (host.accountFails) return { exitCode: 7, stdout: '', stderr: '' }
          if (host.accountRefuse) return { exitCode: 0, stdout: JSON.stringify({ type: 'error', error: { type: 'api_error', message: `model-relay router: ${host.accountRefuse}` } }) + status(400), stderr: '' }
          host.registered = JSON.parse(argv[argv.indexOf('-d') + 1]).account
          return { exitCode: 0, stdout: '{"ok":true}' + status(200), stderr: '' }
        }
        if (url.endsWith('/__session')) {
          // /provider <name>: the answer with its status on a line of its own, or the router's refusal
          if (host.sessionRefuse) return { exitCode: 0, stdout: JSON.stringify({ type: 'error', error: { type: 'api_error', message: `model-relay router: ${host.sessionRefuse}` } }) + '\n400', stderr: '' }
          host.pinned = JSON.parse(argv[argv.indexOf('-d') + 1]).on
          return { exitCode: 0, stdout: '{"ok":true}\n200', stderr: '' }
        }
        if (argv[0] === 'sh') host.down = false // the router start
        // setup.mjs restart (the stale-router restart, /provider restart) and proxy/rc changes start a new router, which
        // knows no registration
        if (argv.includes(SETUP) && (argv.includes('restart') || argv.includes('proxy'))) host.registered = null
        const answer = url.includes('/__health') && !host.down ? { ...host.health, ...(host.registered ? { account: host.registered } : {}) } : null
        const stdout = answer ? JSON.stringify(answer) : argv.includes('handoff') || argv.includes(SETUP) ? 'ok' : ''
        return { exitCode: stdout ? 0 : 1, stdout, stderr: '' }
      },
    },
    ui: { toast: (t) => host.toasts.push(t), status: () => undefined, panes: async () => [], open: async () => ({ isPlaced: false }), close: async () => undefined },
    command: { register: async () => undefined },
    agent: { register: async () => undefined },
    clock: { every: () => undefined },
    prompt: { submit: async () => undefined },
  }
  const start = (isInteractive) => hooks['session.start']($, { cwd: '/w', surface: isInteractive ? 'terminal' : null, isInteractive }, async (e) => e)
  const command = (args, kind) => hooks['command.run']($, { command: 'provider', args, origin: { kind }, presentation: { isFullscreen: false, columns: 100 } })
  return { start, command }
}

const health = (extra = {}) => ({ ok: true, version: '9.9.9', inflight: 0, configDir: '/cfg', session: 'claude', providers: {}, aliases: {}, failoverChain: [], unresolved: [], ...extra })
// the dirs of a window and of its second account, whose projects folders are one folder (what /provider switch needs, B4)
const SHARED_REAL = { '/cfg': '/cfg', '/home/me/.claude-second': '/home/me/.claude-second', '/cfg/projects': '/shared/projects', '/home/me/.claude-second/projects': '/shared/projects' }
// relay: the dir the hook should read its config from; real: the dirs that exist, by where each resolves
const host = (mode, env = {}, h = health(), { relay = '/cfg', real = SHARED_REAL } = {}) => ({
  env: { CLAUDE_CONFIG_DIR: '/cfg', HOME: '/home/me', MODEL_RELAY_WRAPPER_ID: WRAPPER, ...env },
  cfg: { format: 2, port: 59999, accountFallback: { mode, account: 'second' }, accounts: { second: { configDir: '~/.claude-second' } } },
  health: h,
  relay,
  real,
  registered: null,
  down: false,
  runs: [],
  writes: [],
  toasts: [],
  envReads: [],
})
const handoffs = (h) => h.runs.filter((r) => r.argv.includes('handoff'))

test('A3 (stand-in host): /provider switch typed in a wrapped interactive window runs the handoff with this config dir', async () => {
  const h = host('switch')
  const r = await load(h)
  await r.start(true)
  const out = await r.command('switch', 'composer')
  assert.match(out.text, /\/exit/)
  assert.deepStrictEqual(handoffs(h).map((x) => [x.argv.join(' '), x.init?.env]), [[`node ${SETUP} handoff ${WRAPPER} ${SID}`, { CLAUDE_CONFIG_DIR: '/cfg', MODEL_RELAY_CONFIG_DIR: '' }]])
  // from Remote Control (the bridge) as well, a person at the other end
  await r.command('switch second', 'bridge')
  assert.strictEqual(handoffs(h).length, 2)
})

test('A3 (stand-in host): a -p run, a command no person sent, an unwrapped window or another mode writes nothing and says why', async () => {
  // -p: session.start says no person is here, whatever the origin says
  const p = host('switch')
  const rp = await load(p)
  await rp.start(false)
  for (const kind of ['sdk', 'composer']) {
    const out = await rp.command('switch', kind)
    assert.ok(out.text.includes(`CLAUDE_CONFIG_DIR=/home/me/.claude-second MODEL_RELAY_CONFIG_DIR=/cfg claude --resume ${SID}`) && out.text.includes('no person is at this session'), `${kind}: ${out.text}`)
  }
  // a person is at the window, but the command came from elsewhere (a plugin): it must be typed, not "nobody is there"
  const i = host('switch')
  const ri = await load(i)
  await ri.start(true)
  const notTyped = await ri.command('switch', 'plugin')
  assert.ok(notTyped.text.includes('it must be typed at the prompt') && !notTyped.text.includes('no person'), notTyped.text)
  for (const id of [undefined, '../../x']) {
    const u = host('switch', { MODEL_RELAY_WRAPPER_ID: id })
    const ru = await load(u)
    await ru.start(true)
    const out = await ru.command('switch', 'composer')
    assert.ok(out.text.includes('not started by the launcher wrapper') && handoffs(u).length === 0, `${id}: ${out.text}`)
  }
  const o = host('rc-keep')
  const ro = await load(o)
  await ro.start(true)
  assert.match((await ro.command('switch', 'composer')).text, /needs accountFallback\.mode "switch"/)
  for (const x of [p, i, o]) assert.strictEqual(handoffs(x).length, 0, 'nothing written')
})

test('A3 (stand-in host): on Windows the manual command is PowerShell, and ~ is the home configDir() uses', async () => {
  const w = host('switch', { OS: 'Windows_NT', USERPROFILE: 'C:\\Users\\me', HOME: '/not/this', MODEL_RELAY_WRAPPER_ID: undefined })
  const rw = await load(w)
  await rw.start(true)
  const out = await rw.command('switch', 'composer')
  assert.ok(out.text.includes(`$env:CLAUDE_CONFIG_DIR='C:/Users/me/.claude-second'; $env:MODEL_RELAY_CONFIG_DIR='/cfg'; claude --resume ${SID}`), out.text)
})

test('A3 (stand-in host): the limit toast fires once in mode switch on the router\'s claudeLimitedAt, empty chain included; the api-only toast once in an unwrapped window', async () => {
  const limited = health({ claudeLimitedAt: Date.now() - 1000, failoverSince: 0, failoverChain: [] })
  const s = host('switch', {}, limited)
  const rs = await load(s)
  await rs.start(true)
  await rs.command('status', 'composer') // any later tick: still once
  await rs.start(true)
  assert.strictEqual(s.toasts.filter((t) => t === 'Your account reached its usage limit — /provider switch, then /exit').length, 1, JSON.stringify(s.toasts))
  const off = host('off', {}, limited)
  await (await load(off)).start(true)
  assert.ok(!off.toasts.some((t) => t.includes('/provider switch')), 'not in another mode')
  assert.ok(!off.envReads.includes('MODEL_RELAY_WRAPPER_ID'), 'the mode is checked before the variable is read')
  const failoverOnly = host('switch', {}, health({ failoverSince: Date.now() - 1000, nextClaudeTry: Date.now() + 1000 }))
  await (await load(failoverOnly)).start(true)
  assert.ok(!failoverOnly.toasts.some((t) => t.includes('/provider switch')), 'failover state without a seen limit is not it')

  const a = host('api-only', { MODEL_RELAY_WRAPPER_ID: undefined })
  const ra = await load(a)
  await ra.start(true)
  await ra.start(true)
  assert.strictEqual(a.toasts.filter((t) => t.includes('Remote Control stays on here')).length, 1, JSON.stringify(a.toasts))
  const wrapped = host('api-only')
  await (await load(wrapped)).start(true)
  assert.ok(!wrapped.toasts.some((t) => t.includes('Remote Control stays on here')), 'a wrapped window gets none')
})

// ---------- S4: a window of the second account, pointed at main's relay with MODEL_RELAY_CONFIG_DIR ----------

const ACCOUNT_REAL = { '/main': '/main', '/acct': '/acct', '/home/me/.claude-other-org': '/acct' }
const accountHost = (extraHealth = {}, env = {}, real = ACCOUNT_REAL) => {
  const h = host('switch', { MODEL_RELAY_CONFIG_DIR: '/main', CLAUDE_CONFIG_DIR: '/acct', MODEL_RELAY_WRAPPER_ID: undefined, ...env },
    health({ configDir: '/main', providers: { other: 'other-model' }, failoverChain: ['other'], failoverProvider: 'other', ...extraHealth }), { relay: '/main', real })
  h.cfg.accounts = { 'other-org': { configDir: '~/.claude-other-org' } }
  h.cfg.accountFallback.account = 'other-org'
  return h
}
const accountCalls = (h) => h.runs.filter((r) => (r.argv.at(-1) ?? '').endsWith('/__account')).map((r) => JSON.parse(r.argv[r.argv.indexOf('-d') + 1]))
const statusLines = (h) => h.writes.filter((w) => w.path.includes('/model-relay-status/'))
const setupRuns = (h) => h.runs.filter((r) => r.argv.includes(SETUP))

test('A10: an account window reads main\'s config, uses main\'s router, registers its sid, and writes its status in its own dir', async () => {
  const limited = { failoverSince: Date.now() - 1000, nextClaudeTry: Date.now() + 600000, claudeLimitedAt: Date.now() - 1000 }
  const h = accountHost(limited)
  const r = await load(h)
  await r.start(true)
  assert.deepStrictEqual(accountCalls(h), [{ sid: SID, account: 'other-org' }], 'registered at start')
  assert.ok(!h.toasts.some((t) => /another relay/.test(t)), 'main\'s router is not taken for a foreign one')
  assert.ok(!h.toasts.some((t) => t.includes('/provider switch')), 'no limit toast in the account window')
  const lines = statusLines(h)
  assert.ok(lines.length > 0 && lines.every((w) => w.path === `/acct/model-relay-status/${SID}`), JSON.stringify(lines.map((w) => w.path)))
  assert.strictEqual(lines.at(-1).text, 'claude\tclaude/other-org\n', 'claude under the account during main\'s cooldown, never main\'s failover')
  // the router restarted and forgot the sid: the next tick registers it again
  h.registered = null
  await r.start(true)
  assert.deepStrictEqual(accountCalls(h).length, 2)
  assert.strictEqual(h.registered, 'other-org')
  // the second registration says when the window first saw the first one, so the router can keep a /provider pin made since
  const [first, again] = accountCalls(h)
  assert.ok(!('since' in first), 'the first registration has no time yet')
  assert.ok(Number.isFinite(again.since) && again.since > 0 && again.since <= Date.now(), JSON.stringify(again))
  // a /provider pin of this window shows as one
  h.health = { ...h.health, session: 'other' }
  await r.start(true)
  assert.strictEqual(statusLines(h).at(-1).text, 'pinned\tother-model\n')
})

// A /resume inside the window changes $.session.id(): the new sid is registered for the first time then. Its registration
// has no time (the router counts it from now, so main's automatic pin made on that sid before does not hold the account
// window); only a sid the router forgets later (a restart) comes back with the time this window first saw it registered.
test('A10-since: a sid the window registers for the first time sends no time, and each sid sends its own after a router restart', async () => {
  const RESUMED = '99999999-2222-4333-8444-555555555555'
  const h = accountHost()
  const r = await load(h)
  await r.start(true)
  await r.start(true) // first sid seen registered: its time starts here
  const t1 = Date.now()
  await new Promise((res) => setTimeout(res, 30))
  h.sid = RESUMED
  h.registered = null
  await r.start(true)
  const resumed = accountCalls(h).at(-1)
  assert.deepStrictEqual(resumed, { sid: RESUMED, account: 'other-org' }, 'the resumed sid inherits no time of the first one')
  // the router restarts: each sid comes back with its own first time, the resumed one later than the first
  h.registered = null
  await r.start(true)
  const again = accountCalls(h).at(-1)
  assert.strictEqual(again.sid, RESUMED)
  assert.ok(again.since > t1, `the resumed sid's own time (${again.since}) is later than the first sid's (${t1})`)
  h.sid = SID
  h.registered = null
  await r.start(true)
  const back = accountCalls(h).at(-1)
  assert.strictEqual(back.sid, SID)
  assert.ok(back.since <= t1, `the first sid still sends its own, earlier time (${back.since})`)
})

test('A10-F4: every setup.mjs run from an account window targets main\'s dir', async () => {
  const h = accountHost({ version: '0.0.1' }) // an older router answering nothing: the tick restarts it through setup.mjs
  const r = await load(h)
  await r.start(true)
  for (const args of ['doctor', 'failover on', 'retry off', 'alias haiku other', 'rc status', 'avatar on', 'restart']) await r.command(args, 'composer')
  const runs = setupRuns(h)
  assert.ok(runs.length >= 8, `${runs.length} setup runs`)
  assert.ok(runs.some((x) => x.argv.includes('--if-stale')), 'the stale-router restart is among them')
  for (const x of runs) assert.deepStrictEqual(x.init?.env, { CLAUDE_CONFIG_DIR: '/main', MODEL_RELAY_CONFIG_DIR: '' }, x.argv.join(' '))
})

test('A10: with no router running, an account window starts main\'s router', async () => {
  const h = accountHost()
  h.down = true
  const r = await load(h)
  await r.start(true)
  const start = h.runs.find((x) => x.argv[0] === 'sh')
  assert.ok(start && start.argv[2].endsWith("'/main' >/dev/null 2>&1 &"), start && start.argv[2])
})

test('A10-F11: a relative or unresolvable MODEL_RELAY_CONFIG_DIR counts as unset: the window\'s own dir, as before', async () => {
  for (const given of ['rel/dir', '/nowhere', '']) {
    // a relative path that would resolve still does not count
    const h = host('switch', { MODEL_RELAY_CONFIG_DIR: given }, health(), { real: { '/cfg': '/cfg', 'rel/dir': '/main', '/main': '/main' } })
    h.down = true
    const r = await load(h)
    await r.start(true)
    const start = h.runs.find((x) => x.argv[0] === 'sh')
    assert.ok(start && start.argv[2].endsWith("'/cfg' >/dev/null 2>&1 &"), `${given}: ${start && start.argv[2]}`)
    assert.ok(!start.argv[2].includes(given || '\u0000'), 'nothing started for it')
  }
})

test('A10-F2: main\'s window resuming a sid an account window had registered ends that registration; its label and toast are main\'s', async () => {
  const h = host('switch', {}, health({ providers: { other: 'other-model' }, failoverChain: [], claudeLimitedAt: Date.now() - 1000 }))
  h.registered = 'second'
  const r = await load(h)
  await r.start(true)
  assert.deepStrictEqual(accountCalls(h), [{ sid: SID, account: null }])
  assert.strictEqual(h.registered, null)
  assert.strictEqual(statusLines(h).at(-1).text, 'claude\tclaude\n')
  assert.ok(h.toasts.includes('Your account reached its usage limit — /provider switch, then /exit'), JSON.stringify(h.toasts))
  // the router did not take the change: still main's label, never the account's
  const stuck = host('switch', {}, health({ claudeLimitedAt: Date.now() - 1000 }))
  stuck.registered = 'second'
  stuck.accountFails = true
  await (await load(stuck)).start(true)
  assert.strictEqual(statusLines(stuck).at(-1).text, 'claude\tclaude\n')
  // and with nothing registered, nothing is sent
  const quiet = host('switch')
  await (await load(quiet)).start(true)
  assert.deepStrictEqual(accountCalls(quiet), [])
})

test('A10-Nit: /provider switch is refused in an account window; without MODEL_RELAY_CONFIG_DIR nothing of this applies', async () => {
  const h = accountHost()
  const r = await load(h)
  await r.start(true)
  const out = await r.command('switch', 'composer')
  assert.match(out.text, /already runs on the second account/)
  assert.strictEqual(handoffs(h).length, 0)
  // a window on its own dir with no MODEL_RELAY_CONFIG_DIR, mode off: no registration, setup on its own dir
  const plain = host('off')
  const rp = await load(plain)
  await rp.start(true)
  await rp.command('doctor', 'composer')
  assert.deepStrictEqual(accountCalls(plain), [])
  // mode off: no launcher file is written for someone who uses no second account (A2), so only doctor ran
  assert.deepStrictEqual(setupRuns(plain).map((x) => [x.argv[2], x.init?.env?.CLAUDE_CONFIG_DIR]), [['doctor', '/cfg']])
  assert.strictEqual(statusLines(plain).at(-1).path, `/cfg/model-relay-status/${SID}`)
})

test('A10: a main window pointed at another relay dir writes its handoff where its wrapper looks: its own dir', async () => {
  const h = host('switch', { MODEL_RELAY_CONFIG_DIR: '/main' }, health({ configDir: '/main' }), { relay: '/main', real: { ...SHARED_REAL, '/main': '/main' } })
  const r = await load(h)
  await r.start(true)
  assert.match((await r.command('switch', 'composer')).text, /\/exit/)
  assert.deepStrictEqual(handoffs(h).map((x) => x.init?.env), [{ CLAUDE_CONFIG_DIR: '/cfg', MODEL_RELAY_CONFIG_DIR: '' }])
  assert.ok(setupRuns(h).filter((x) => !x.argv.includes('handoff')).every((x) => x.init?.env?.CLAUDE_CONFIG_DIR === '/main'), 'the rest goes to the relay dir')
})

// ---------- S4 fix round ----------

test('fix 2: right after the hook restarts or starts the router, the account window registers again, without waiting for a tick', async () => {
  // the stale-router restart in the tick
  const stale = accountHost({ version: '0.0.1' })
  const rs = await load(stale)
  await rs.start(true)
  assert.strictEqual(stale.registered, 'other-org', 'registered again right after the restart')
  // /provider restart, /provider rc on, /provider proxy enable
  for (const args of ['restart', 'rc on', 'proxy enable']) {
    const h = accountHost()
    const r = await load(h)
    await r.start(true)
    const before = accountCalls(h).length
    await r.command(args, 'composer')
    assert.strictEqual(h.registered, 'other-org', `${args}: registered again`)
    assert.strictEqual(accountCalls(h).length, before + 1, `${args}: in the same command`)
  }
  // the tick that starts a router with none running
  const down = accountHost()
  down.down = true
  const rd = await load(down)
  await rd.start(true)
  assert.strictEqual(down.registered, 'other-org')
  assert.strictEqual(statusLines(down).at(-1).text, 'claude\tclaude/other-org\n', 'the first status already under the account')
})

test('fix 5: a refused registration is a failure: no account label, one hint with the router\'s reason, asked again a minute later at most', async () => {
  const h = accountHost({ failoverSince: Date.now() - 1000, failoverProvider: 'other' })
  h.accountRefuse = 'account windows are routed only while claudeUrl is https://api.anthropic.com'
  const r = await load(h)
  await r.start(true)
  const healthReads = h.runs.filter((x) => (x.argv.at(-1) ?? '').includes('/__health')).length
  assert.strictEqual(healthReads, 1, 'a refusal is no change: the health is not read again for it')
  await r.start(true)
  await r.start(true)
  assert.strictEqual(accountCalls(h).length, 1, 'not asked again within the minute')
  const hints = h.toasts.filter((t) => t.includes('did not take this window as other-org'))
  assert.deepStrictEqual(hints, ['The relay did not take this window as other-org\'s: account windows are routed only while claudeUrl is https://api.anthropic.com. Its Claude requests take your account\'s path until that is fixed.'])
  assert.strictEqual(statusLines(h).at(-1).text, 'failover\tother-model\n', 'the route as it really is')
})

test('fix 6: an account whose configDir is the relay dir itself never makes a window an account window', async () => {
  const h = host('switch', {}, health({ claudeLimitedAt: Date.now() - 1000 }))
  h.cfg.accounts = { second: { configDir: '/cfg' } }
  const r = await load(h)
  await r.start(true)
  assert.deepStrictEqual(accountCalls(h), [])
  assert.ok(h.toasts.includes('Your account reached its usage limit — /provider switch, then /exit'), 'main\'s window, main\'s toast')
  // B4: its folder is this window's own, which the wrapper would refuse after /exit; it is refused now, with nothing written
  const out = (await r.command('switch', 'composer')).text
  assert.match(out, /^accounts\.second\.configDir is this window's own config dir/)
  assert.ok(!/already runs on the second account/.test(out) && handoffs(h).length === 0)
})

test('fallback 11 (stand-in host): the account window says once that its usage limit moved it to the fallback account, and its status names that account', async () => {
  const h = accountHost({ providers: { other: 'other-model', spare: 'anthropic-account' }, kinds: { spare: 'anthropic' }, accountServing: 'spare' })
  const r = await load(h)
  const told = () => h.toasts.filter((t) => t.includes('usage limit'))
  await r.start(true)
  assert.deepStrictEqual(told(), ['other-org reached its usage limit; this window uses spare now'])
  assert.strictEqual(statusLines(h).at(-1).text, 'claude\tclaude/spare\n')
  await r.start(true)
  assert.strictEqual(told().length, 1, 'once per move')
  // the cooldown ends: back on its own account; the next limit is said again
  h.health = { ...h.health, accountServing: undefined }
  await r.start(true)
  assert.strictEqual(statusLines(h).at(-1).text, 'claude\tclaude/other-org\n')
  h.health = { ...h.health, accountServing: 'spare' }
  await r.start(true)
  assert.strictEqual(told().length, 2)
  // a main window never shows it, whatever a health answer says
  const m = host('switch', {}, health({ providers: { spare: 'anthropic-account' }, kinds: { spare: 'anthropic' }, accountServing: 'spare' }))
  await (await load(m)).start(true)
  assert.ok(!m.toasts.some((t) => t.includes('usage limit;')))
})

test('list 11 (stand-in host): a main window says once that the relay\'s own account\'s limit moved it, and its status names that account; an account window never takes it', async () => {
  const h = host('switch', {}, health({ providers: { other: 'other-model' }, failoverChain: ['other'], selfServing: 'team-2' }))
  const r = await load(h)
  const told = () => h.toasts.filter((t) => t.includes('usage limit'))
  await r.start(true)
  assert.deepStrictEqual(told(), ['Your account reached its usage limit; this window uses team-2 now'])
  assert.strictEqual(statusLines(h).at(-1).text, 'claude\tclaude/team-2\n')
  await r.start(true)
  assert.strictEqual(told().length, 1, 'once per move')
  h.health = { ...h.health, selfServing: undefined }
  await r.start(true)
  assert.strictEqual(statusLines(h).at(-1).text, 'claude\tclaude\n', 'back on its own account')
  h.health = { ...h.health, selfServing: 'team-3' }
  await r.start(true)
  assert.deepStrictEqual(told().slice(1), ['Your account reached its usage limit; this window uses team-3 now'])
  // an account window, registered or refused, shows its own route, never the relay's own account's
  const a = accountHost({ selfServing: 'team-2' })
  a.accountRefuse = 'that account is not in accounts'
  await (await load(a)).start(true)
  assert.ok(!a.toasts.some((t) => t.includes('Your account reached')), JSON.stringify(a.toasts))
  assert.ok(!statusLines(a).at(-1).text.includes('team-2'), statusLines(a).at(-1).text)
})

// ---------- the stable launcher file: written by setup.mjs launcher only, run by the hook at session start ----------

// session.start does not wait for the launcher refresh, so what it ran is read after the host's pending work settles
const settled = () => new Promise((resolve) => setImmediate(resolve))

test('session start does not wait for the launcher refresh: it ends while setup.mjs launcher has not answered', async () => {
  const h = host('switch')
  h.hangLauncher = true
  const r = await load(h)
  // bounded, so a start that waits fails here instead of hanging the run
  const ended = await Promise.race([r.start(true).then(() => true), new Promise((resolve) => setTimeout(resolve, 3000, false))])
  assert.ok(ended, 'session.start ended without the launcher run answering')
  await settled()
  assert.strictEqual(h.runs.filter((x) => x.argv.includes('launcher')).length, 1, 'it was started')
  assert.ok(h.runs.some((x) => (x.argv.at(-1) ?? '').includes('/__health')), 'and the tick before it ran')
})

test('an account window resolves its own config dir once, not at every tick (its accounts are still checked)', async () => {
  const h = accountHost({})
  const r = await load(h)
  h.statted = []
  await r.start(true)
  const own = () => h.statted.filter((p) => p === '/acct').length
  const account = () => h.statted.filter((p) => p === '/home/me/.claude-other-org').length
  const [own1, account1] = [own(), account()]
  assert.ok(own1 >= 1 && account1 >= 1, 'the first tick resolved them')
  await r.start(true)
  await r.start(true)
  assert.strictEqual(own(), own1, 'own dir: not again')
  assert.ok(account() > account1, 'the accounts\' dirs are checked each tick')
})

test('acceptance 3 (stand-in host): session start runs setup.mjs launcher with the relay dir in mode switch, rc-keep or api-only, never in off, and $.fs.write never targets model-relay-launch.mjs', async () => {
  for (const h of [host('switch'), host('rc-keep'), host('api-only'), accountHost({})]) {
    const r = await load(h)
    await r.start(true)
    await settled()
    const runs = h.runs.filter((x) => x.argv.includes('launcher'))
    assert.deepStrictEqual(runs.map((x) => [x.argv, x.init?.env]), [[['node', SETUP, 'launcher'], { CLAUDE_CONFIG_DIR: h.relay, MODEL_RELAY_CONFIG_DIR: '' }]])
    assert.ok(!h.writes.some((w) => w.path.includes('model-relay-launch')), JSON.stringify(h.writes.map((w) => w.path)))
  }
  // mode off (or an unknown mode): no file is written for someone who uses no second account
  for (const mode of ['off', 'rc_keep']) {
    const off = host(mode)
    await (await load(off)).start(true)
    await settled()
    assert.ok(!off.runs.some((x) => x.argv.includes('launcher')), mode)
  }
  // no relay config: nothing is run
  const none = host('switch')
  none.relay = '/nowhere'
  await (await load(none)).start(true)
  await settled()
  assert.ok(!none.runs.some((x) => x.argv.includes('launcher')))
})

test('acceptance 3 (stand-in host): with a plugin root ending in /.claude-plugin, the file setup.mjs launcher writes imports <base>/tools/launch.mjs, and that file exists', async () => {
  const { execFileSync } = await import('node:child_process')
  const fs = await import('node:fs')
  const os = await import('node:os')
  const path = await import('node:path')
  const { fileURLToPath } = await import('node:url')
  const base = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  const h = host('switch')
  h.pluginRoot = `${base}/.claude-plugin`
  await (await load(h)).start(true)
  await settled()
  const run = h.runs.find((x) => x.argv.includes('launcher'))
  assert.ok(run, 'the launcher run')
  assert.strictEqual(run.argv[1], `${base.replace(/\\/g, '/')}/tools/setup.mjs`, 'setup.mjs of the base, not of <base>/.claude-plugin')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-launcher-'))
  try {
    const env = { ...process.env, ...run.init.env, CLAUDE_CONFIG_DIR: dir, HOME: dir, USERPROFILE: dir }
    delete env.MODEL_RELAY_CONFIG_DIR
    execFileSync(process.execPath, run.argv.slice(1), { env, stdio: 'pipe' })
    const text = fs.readFileSync(path.join(dir, 'model-relay-launch.mjs'), 'utf8')
    const target = JSON.parse(/^const target = (.*)$/m.exec(text)[1])
    assert.strictEqual(fileURLToPath(target), path.join(base, 'tools', 'launch.mjs'))
    assert.ok(fs.statSync(fileURLToPath(target)).isFile())
    assert.strictEqual(JSON.parse(/^const root = (.*)$/m.exec(text)[1]), base)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

// ---------- guidance on the account paths ----------

test('A8, A16, F9: the variables the manual resume command drops are exactly the wrapper\'s DROPPED_VARS plus MODEL_RELAY_WRAPPER_ID', async () => {
  const { RESUME_UNSET } = await import(new URL('../hooks/logic.ts', import.meta.url).href)
  const { DROPPED_VARS } = await import(new URL('./launch.mjs', import.meta.url).href)
  assert.deepStrictEqual([...RESUME_UNSET].sort(), [...DROPPED_VARS, 'MODEL_RELAY_WRAPPER_ID'].sort())
  // and the command the hook prints names every one of them, with the relay's dir for an Anthropic claudeUrl
  const h = host('switch', { MODEL_RELAY_WRAPPER_ID: undefined })
  const r = await load(h)
  await r.start(true)
  const text = (await r.command('switch', 'composer')).text
  for (const v of DROPPED_VARS) assert.ok(text.includes(`-u ${v} `), v)
  assert.ok(text.includes('-u MODEL_RELAY_WRAPPER_ID CLAUDE_CONFIG_DIR=/home/me/.claude-second MODEL_RELAY_CONFIG_DIR=/cfg claude --resume'), text)
  // a gateway claudeUrl: no command at all
  const g = host('switch', { MODEL_RELAY_WRAPPER_ID: undefined })
  g.cfg.claudeUrl = 'https://gateway.example'
  const rg = await load(g)
  await rg.start(true)
  const plain = (await rg.command('switch', 'composer')).text
  assert.ok(!plain.includes('--resume') && !plain.includes('CLAUDE_CONFIG_DIR') && plain.includes('launcher wrapper'), plain)
})

test('B4 (stand-in host): /provider switch in a wrapped window refuses before it writes a handoff when the projects folder is not shared, the folder is missing, or it is the window\'s own', async () => {
  const apart = host('switch', {}, health(), { real: { ...SHARED_REAL, '/home/me/.claude-second/projects': '/second/projects' } })
  const ra = await load(apart)
  await ra.start(true)
  const out = (await ra.command('switch', 'composer')).text
  assert.ok(out.includes('Make /home/me/.claude-second/projects a link to /cfg/projects') && out.includes('ln -s /cfg/projects /home/me/.claude-second/projects'), out)
  const gone = host('switch', {}, health(), { real: { '/cfg': '/cfg' } })
  const rg = await load(gone)
  await rg.start(true)
  assert.match((await rg.command('switch', 'composer')).text, /\(accounts\.second\.configDir\) does not exist/)
  for (const x of [apart, gone]) assert.strictEqual(handoffs(x).length, 0, 'nothing written')
  // a shared folder still gets its handoff
  const ok = host('switch')
  const rk = await load(ok)
  await rk.start(true)
  assert.match((await rk.command('switch', 'composer')).text, /\/exit/)
  assert.strictEqual(handoffs(ok).length, 1)
})

test('B13 (stand-in host): /provider switch in an account window says it is for windows of your own account', async () => {
  const h = accountHost()
  const r = await load(h)
  await r.start(true)
  const text = (await r.command('switch', 'composer')).text
  assert.ok(text.includes('for windows of your own account') && !/\bmain\b/.test(text), text)
})

test('B15 (stand-in host): a router refusal of /provider <name> is shown as the router\'s reason, not as "did not respond"', async () => {
  const h = host('switch', {}, health({ providers: { spare: 'anthropic-account' }, kinds: { spare: 'anthropic' } }))
  h.sessionRefuse = 'provider "spare" is the fallback of another account\'s windows; this session cannot use it (configured: none)'
  const r = await load(h)
  await r.start(true)
  const text = (await r.command('spare', 'composer')).text
  assert.strictEqual(text, 'The relay refused: provider "spare" is the fallback of another account\'s windows; this session cannot use it (configured: none). Nothing changed.')
  h.sessionRefuse = null
  h.down = true
  const down = (await r.command('spare', 'composer')).text
  assert.ok(!down.includes('refused'), 'no router at all is not a refusal')
})

test('B5 (stand-in host): /provider <account> answers with Claude under its name', async () => {
  const h = host('switch', {}, health({ providers: { spare: 'anthropic-account', aaa: 'aaa-9' }, kinds: { spare: 'anthropic' } }))
  const r = await load(h)
  await r.start(true)
  assert.strictEqual((await r.command('spare', 'composer')).text, '✓ This window now uses spare (Claude (spare))')
  assert.strictEqual((await r.command('aaa', 'composer')).text, '✓ This window now uses aaa (aaa-9)')
})

test('B2 (stand-in host): /provider status in an account window shows its account and never your failover', async () => {
  const h = accountHost({ failoverSince: Date.now() - 1000, nextClaudeTry: Date.now() + 600000, providers: { other: 'other-model', spare: 'anthropic-account' }, kinds: { spare: 'anthropic' }, accountServing: 'spare' })
  const r = await load(h)
  await r.start(true)
  const text = (await r.command('status', 'composer')).text
  assert.ok(text.startsWith('Main: Claude (spare) (other-org is at its usage limit)'), text)
  assert.ok(!text.includes('retrying Claude') && !text.includes('429 failover') && text.includes('○ /provider claude   Claude (other-org)'), text)
})

test('B14 (stand-in host): an account window at its usage limit with nobody to go to is told once what to do; again after the limit passed and came back', async () => {
  const h = accountHost({ accountLimited: true })
  const r = await load(h)
  const told = () => h.toasts.filter((t) => t.includes('no fallback account to move to'))
  await r.start(true)
  await r.start(true)
  assert.deepStrictEqual(told(), ['other-org reached its usage limit and has no fallback account to move to (accounts.other-org.fallback); continue in a window of your own account, or wait for the limit to reset'])
  h.health = { ...h.health, accountLimited: undefined }
  await r.start(true)
  h.health = { ...h.health, accountLimited: true }
  await r.start(true)
  assert.strictEqual(told().length, 2)
  // a fallback account serving the window is the other toast, not this one; a main window never gets it
  const serving = accountHost({ accountLimited: true, providers: { other: 'other-model', spare: 'anthropic-account' }, kinds: { spare: 'anthropic' }, accountServing: 'spare' })
  await (await load(serving)).start(true)
  assert.strictEqual(serving.toasts.filter((t) => t.includes('no fallback account to move to')).length, 0)
  const main = host('switch', {}, health({ accountLimited: true }))
  await (await load(main)).start(true)
  assert.strictEqual(main.toasts.filter((t) => t.includes('no fallback account to move to')).length, 0)
})
