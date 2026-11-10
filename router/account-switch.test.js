'use strict'
// Mode "switch": a window of the second account (registered by sid with POST /__account) keeps the relay for provider
// models and its own /provider pins, while its Claude requests go to Claude as sent, never through main's failover.
// The router runs with a preload that only lets claudeUrl be a local stand-in (no keychain is involved in this mode).
require('./test-env')
const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const http = require('node:http')
const net = require('node:net')
const os = require('node:os')
const path = require('node:path')
const { spawn } = require('node:child_process')

const ROUTER = path.join(__dirname, 'router.js')
const MAIN = 'MAIN-TOKEN-1b2c'
const ACCT = 'ACCOUNT-LOGIN-9d8e' // the second account's own login, as its Claude Code sends it
const S = '11111111-2222-4333-8444-555555555555'
const S2 = '66666666-7777-4888-9999-aaaaaaaaaaaa'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const USAGE_LIMIT = [429, { 'anthropic-ratelimit-unified-status': 'rejected' }, '{"type":"error","error":{"type":"rate_limit_error","message":"usage limit reached"}}']
const OK = (from) => [200, {}, JSON.stringify({ from })]

const listen = (server) => new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)))
const freePort = async () => {
  const s = net.createServer()
  const p = await listen(s)
  await new Promise((r) => s.close(r))
  return p
}
function upstream(t, answer) {
  const seen = []
  const server = http.createServer((req, res) => {
    const ch = []
    req.on('data', (c) => ch.push(c))
    req.on('end', () => {
      const r = { method: req.method, url: req.url, auth: req.headers.authorization, body: Buffer.concat(ch).toString('utf8') }
      seen.push(r)
      const [status, headers, body] = answer(r)
      res.writeHead(status, { 'content-type': 'application/json', ...headers })
      res.end(body)
    })
  })
  t.after(() => server.close())
  return listen(server).then((port) => ({ port, seen }))
}
const call = (port, p, { method = 'GET', body = null, sid = '', auth = MAIN, model = 'claude-opus-5-5' } = {}) => new Promise((resolve, reject) => {
  const data = body === null ? (p.startsWith('/v1/') ? Buffer.from(JSON.stringify({ model, max_tokens: 5, messages: [] })) : null) : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))
  const headers = { host: `127.0.0.1:${port}`, ...(p.startsWith('/v1/') ? { authorization: `Bearer ${auth}`, 'x-claude-code-session-id': sid, 'content-type': 'application/json' } : {}), ...(data ? { 'content-length': data.length } : {}) }
  const req = http.request({ host: '127.0.0.1', port, path: p, method: data ? 'POST' : method, headers }, (res) => {
    const ch = []
    res.on('data', (c) => ch.push(c))
    res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(ch).toString('utf8') }))
  })
  req.on('error', reject)
  req.end(data || undefined)
})

// The router on a free port in a scratch config dir: mode switch, accounts { second }, one ordinary provider in the chain
async function relay(t, { anthropic, other = () => OK('other'), top = {}, preload = true, account = true } = {}) {
  const a = await upstream(t, anthropic || ((q) => OK(q.auth === `Bearer ${ACCT}` ? 'account' : 'claude')))
  const o = await upstream(t, other)
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-switch-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const preloadFile = path.join(dir, 'any-claude-url.js')
  fs.writeFileSync(preloadFile, 'globalThis.__modelRelayAnyClaudeUrl = true\n')
  const port = await freePort()
  const file = path.join(dir, 'model-relay.json')
  const cfg = {
    format: 2,
    port,
    claudeUrl: `http://127.0.0.1:${a.port}`,
    ...(account ? { accountFallback: { mode: 'switch', account: 'second' }, accounts: { second: { configDir: path.join(dir, 'second') } } } : {}),
    failover: { enabled: true, chain: ['other'] },
    retry: { attempts: 1, delayMs: 10, maxDelayMs: 10 },
    providers: { other: { baseUrl: `http://127.0.0.1:${o.port}`, token: 'OTHER-KEY', model: 'other-model' } },
    ...top,
  }
  fs.writeFileSync(file, JSON.stringify(cfg))
  let child
  const start = async () => {
    child = spawn(process.execPath, [...(preload ? ['--require', preloadFile] : []), ROUTER, dir], { stdio: 'ignore' })
    for (let i = 0; i < 200; i++) {
      if (await new Promise((r) => http.get(`http://127.0.0.1:${port}/__health`, (x) => { x.resume(); r(true) }).on('error', () => r(false)))) return
      await sleep(50)
    }
  }
  const stop = () => new Promise((r) => {
    child.once('exit', r)
    child.kill()
  })
  t.after(() => child.kill())
  await start()
  const health = async (sid = '') => JSON.parse((await call(port, `/__health?sid=${sid}`)).body)
  // main's failover state as the router holds it and saves it
  const mainState = async () => {
    const h = await health()
    let sticky = {}
    try {
      sticky = JSON.parse(fs.readFileSync(path.join(dir, 'model-relay-state.json'), 'utf8')).sticky
    } catch {}
    return { failoverSince: h.failoverSince, nextClaudeTry: h.nextClaudeTry, claudeLimitedAt: h.claudeLimitedAt, sessionsOnCustom: h.sessionsOnCustom, sticky }
  }
  const setCfg = (patch) => fs.writeFileSync(file, JSON.stringify(Object.assign(cfg, patch)))
  const register = (sid, name = 'second') => call(port, '/__account', { body: { sid, account: name } })
  const ask = (sid, opts = {}) => call(port, opts.url || '/v1/messages', { sid, ...opts })
  return { port, a, o, dir, health, mainState, setCfg, register, ask, restart: async () => { await stop(); await start() } }
}
const from = (x) => JSON.parse(x.body).from

test('A9: a sid main pinned at its usage limit, registered as the account: Claude and count_tokens go to Claude as sent, main\'s state untouched', async (t) => {
  let limited = true
  const r = await relay(t, { anthropic: (q) => (q.auth === `Bearer ${MAIN}` && limited ? USAGE_LIMIT : q.auth === `Bearer ${ACCT}` && q.body.includes('"limit-me"') ? USAGE_LIMIT : OK(q.auth === `Bearer ${ACCT}` ? 'account' : 'claude')) })
  // main's window S hits the limit: failover to other, S stuck there, the cooldown starts
  assert.strictEqual(from(await r.ask(S)), 'other')
  assert.strictEqual((await r.health(S)).session, 'other')
  // the switched window resumes S under the account and registers it
  const reg = await r.register(S)
  assert.strictEqual(reg.status, 200, reg.body)
  const h = await r.health(S)
  assert.strictEqual(h.account, 'second')
  assert.strictEqual(h.session, 'claude', 'the pin from before the registration does not count')
  const before = await r.mainState()
  assert.ok(before.failoverSince > 0 && before.sticky[S], 'main is in its cooldown and S holds main\'s pin')
  const seen = r.a.seen.length
  assert.strictEqual(from(await r.ask(S, { auth: ACCT })), 'account', 'during the cooldown')
  assert.strictEqual(from(await r.ask(S, { auth: ACCT, url: '/v1/messages/count_tokens', body: { model: 'claude-opus-5-5', messages: [] } })), 'account', 'count_tokens, no metadata')
  // a trial (cooldown over): still the account's own path, no trial, no onClaudeOk
  assert.strictEqual((await call(r.port, '/__probe', { body: {} })).status, 200)
  const afterProbe = await r.mainState()
  assert.strictEqual(from(await r.ask(S, { auth: ACCT })), 'account', 'during a trial')
  // the account's own 429 comes back as it is, the state unchanged
  const own = await r.ask(S, { auth: ACCT, body: { model: 'claude-opus-5-5', messages: [], metadata: { note: 'limit-me' } } })
  assert.strictEqual(own.status, 429)
  assert.match(own.body, /usage limit reached/)
  const added = r.a.seen.slice(seen)
  assert.strictEqual(added.length, 4)
  assert.ok(added.every((q) => q.auth === `Bearer ${ACCT}`), 'the caller\'s own Authorization')
  assert.deepStrictEqual(added.map((q) => q.url), ['/v1/messages', '/v1/messages/count_tokens', '/v1/messages', '/v1/messages'])
  assert.strictEqual(r.o.seen.length, 1, 'nothing more went to the failover provider')
  const after = await r.mainState()
  assert.deepStrictEqual(after, afterProbe, 'failoverSince, nextClaudeTry, claudeLimitedAt and sticky byte-equal')
  assert.deepStrictEqual({ ...before, nextClaudeTry: 0 }, afterProbe, 'only the probe moved nextClaudeTry')
  // a provider's model from the account window follows matchModels
  assert.strictEqual(from(await r.ask(S, { auth: ACCT, model: 'other-model' })), 'other')
  // a /provider pin made in the account window wins
  assert.strictEqual((await call(r.port, '/__session', { body: { sid: S, on: 'other' } })).status, 200)
  assert.strictEqual((await r.health(S)).session, 'other')
  assert.strictEqual(from(await r.ask(S, { auth: ACCT })), 'other')
  limited = false
})

// Requests every case below sends, and what they came to: the upstream trace and the replies
async function sequence(r, sid) {
  const out = []
  out.push(await r.ask(sid))
  out.push(await r.ask(sid, { url: '/v1/messages/count_tokens', body: { model: 'claude-opus-5-5', messages: [] } }))
  out.push(await r.ask('other-sid'))
  out.push(await r.ask(sid, { model: 'other-model' }))
  out.push(await call(r.port, '/__session', { body: { sid: 'pinned', on: 'other' } }))
  out.push(await r.ask('pinned'))
  const strip = (q) => [q.method, q.url, q.auth, q.body]
  const h = await r.health(sid)
  return { replies: out.map((x) => [x.status, x.body]), anthropic: r.a.seen.map(strip), other: r.o.seen.map(strip), health: [h.session, h.failoverSince > 0, h.account] }
}
const limitedMain = () => {
  let n = 0
  return (q) => (q.auth === `Bearer ${MAIN}` && n++ >= 0 && q.url.startsWith('/v1/messages') ? USAGE_LIMIT : OK('claude'))
}

test('A9: mode off and rc-keep with accounts configured refuse /__account and route as with no account at all', async (t) => {
  const none = await relay(t, { anthropic: limitedMain(), account: false })
  const refusedNone = await none.register(S)
  const base = await sequence(none, S)
  for (const mode of ['off', 'rc-keep']) {
    const r = await relay(t, { anthropic: limitedMain(), top: { accountFallback: { mode, account: 'second' } } })
    const x = await r.register(S)
    assert.strictEqual(x.status, 400, mode)
    assert.deepStrictEqual([x.status, x.body], [refusedNone.status, refusedNone.body], `${mode}: the same refusal as with no account`)
    assert.match(JSON.parse(x.body).error.message, /accountFallback\.mode is not "switch"/)
    assert.deepStrictEqual(await sequence(r, S), base, `${mode}: the same trace`)
  }
})

test('A9-F6: registered under switch, then the mode flips to off: the trace equals the one with no account', async (t) => {
  const none = await relay(t, { anthropic: limitedMain(), account: false })
  const base = await sequence(none, S)
  const r = await relay(t, { anthropic: limitedMain() })
  assert.strictEqual((await r.register(S)).status, 200)
  r.setCfg({ accountFallback: { mode: 'off', account: 'second' } })
  assert.deepStrictEqual(await sequence(r, S), base)
  // and back to switch: the registration did not survive the flip
  r.setCfg({ accountFallback: { mode: 'switch', account: 'second' } })
  assert.strictEqual((await r.health(S)).account, undefined)
})

test('A9-restart: after a router restart the sid is re-registered, and a pin made in the gap does not hold it', async (t) => {
  const r = await relay(t, { anthropic: (q) => (q.auth === `Bearer ${MAIN}` ? USAGE_LIMIT : OK(q.auth === `Bearer ${ACCT}` ? 'account' : 'claude')) })
  assert.strictEqual(from(await r.ask(S2)), 'other', 'main\'s limit: the cooldown starts')
  assert.strictEqual((await r.register(S)).status, 200)
  await r.restart()
  assert.strictEqual((await r.health(S)).account, undefined, 'the registration lived in memory only')
  // in the gap, before the hook's next tick, S is an ordinary sid in main's cooldown (accepted)
  assert.strictEqual(from(await r.ask(S, { auth: ACCT })), 'other')
  await sleep(5)
  assert.strictEqual((await r.register(S)).status, 200)
  const seen = r.a.seen.length
  assert.strictEqual(from(await r.ask(S, { auth: ACCT })), 'account')
  assert.strictEqual(r.a.seen.at(-1).auth, `Bearer ${ACCT}`)
  assert.strictEqual(r.a.seen.length, seen + 1)
})

test('A9-F1: with claudeUrl anywhere but Anthropic, /__account is refused', async (t) => {
  const r = await relay(t, { preload: false })
  const x = await r.register(S)
  assert.strictEqual(x.status, 400)
  assert.strictEqual(JSON.parse(x.body).error.message, 'model-relay router: account windows are routed only while claudeUrl is https://api.anthropic.com')
})

test('A9-F9: /__account refuses a bad sid or account with fixed text and no echo; the map is capped; logs carry the short sid', async (t) => {
  const r = await relay(t)
  const bad = [
    [{ sid: 'not-a-uuid', account: 'second' }, /need \{sid/],
    [{ sid: `${S}x`, account: 'second' }, /need \{sid/],
    [{ sid: S, account: 5 }, /need \{sid/],
    [{ sid: S }, /need \{sid/],
    [{ sid: S, account: '__proto__' }, /that account is not in accounts/],
    [{ sid: S, account: '../x' }, /that account is not in accounts/],
    [{ sid: S, account: 'constructor' }, /that account is not in accounts/],
    [{ sid: S, account: 'missing' }, /that account is not in accounts/],
  ]
  for (const [body, why] of bad) {
    const x = await call(r.port, '/__account', { body })
    assert.strictEqual(x.status, 400, JSON.stringify(body))
    assert.match(JSON.parse(x.body).error.message, why)
    for (const v of Object.values(body)) if (typeof v === 'string' && v !== S) assert.ok(!x.body.includes(v), `no echo of ${v}`)
  }
  assert.strictEqual((await call(r.port, '/__account', { body: 'nope' })).status, 400)
  // names that are own keys of accounts, but no plain name, stay refused
  r.setCfg({ accounts: JSON.parse('{"second":{"configDir":"/a"},"__proto__":{"configDir":"/b"},"../x":{"configDir":"/c"}}') })
  for (const account of ['__proto__', '../x']) {
    const x = await call(r.port, '/__account', { body: { sid: S, account } })
    assert.strictEqual(x.status, 400, account)
    assert.match(JSON.parse(x.body).error.message, /that account is not in accounts/)
  }
  assert.strictEqual((await r.health(S)).account, undefined, 'nothing registered')
  // the cap: 256 entries, the oldest goes first
  const sid = (i) => `${String(i).padStart(8, '0')}-0000-4000-8000-000000000000`
  for (let i = 0; i < 257; i++) assert.strictEqual((await r.register(sid(i))).status, 200)
  assert.strictEqual((await r.health(sid(0))).account, undefined, 'the oldest was evicted')
  assert.strictEqual((await r.health(sid(1))).account, 'second')
  assert.strictEqual((await r.health(sid(256))).account, 'second')
  // unregistering
  assert.strictEqual((await call(r.port, '/__account', { body: { sid: sid(1), account: null } })).status, 200)
  assert.strictEqual((await r.health(sid(1))).account, undefined)
  const log = fs.readFileSync(path.join(r.dir, 'model-relay.log'), 'utf8')
  assert.match(log, /session 00000001 registered as a window of account second/)
  assert.match(log, /session 00000001 is no longer an account window/)
  assert.ok(!log.includes(sid(1)), 'the short sid only')
})

test('A9-F3: a pinned provider removed during a trial: the registered sid goes to Claude as sent, the state byte-equal', async (t) => {
  const r = await relay(t, { anthropic: (q) => (q.auth === `Bearer ${MAIN}` ? USAGE_LIMIT : OK(q.auth === `Bearer ${ACCT}` ? 'account' : 'claude')) })
  assert.strictEqual(from(await r.ask(S2)), 'other', 'main\'s limit')
  assert.strictEqual((await r.register(S)).status, 200)
  await sleep(5)
  assert.strictEqual((await call(r.port, '/__session', { body: { sid: S, on: 'other' } })).status, 200)
  assert.strictEqual((await call(r.port, '/__probe', { body: {} })).status, 200) // the next unpinned request would be a trial
  // other leaves; backup takes over the chain, so decide would now give an unpinned sid a trial on main
  r.setCfg({ providers: { backup: { baseUrl: `http://127.0.0.1:${r.o.port}`, token: 'OTHER-KEY', model: 'backup-model' } }, failover: { enabled: true, chain: ['backup'] } })
  const before = await r.mainState()
  const seen = r.a.seen.length
  const x = await r.ask(S, { auth: ACCT })
  assert.strictEqual(from(x), 'account')
  assert.deepStrictEqual(r.a.seen.slice(seen).map((q) => q.auth), [`Bearer ${ACCT}`], 'one request, the caller\'s credentials, no trial on main')
  assert.deepStrictEqual(await r.mainState(), before, 'failoverSince, nextClaudeTry, claudeLimitedAt and sticky byte-equal')
})

// ---------- setup.mjs: one place decides its config dir ----------

test('A10-F4: setup.mjs works on MODEL_RELAY_CONFIG_DIR when it is absolute and exists, and account-sync refuses to run under it', async (t) => {
  const { execFile } = require('node:child_process')
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-switch-setup-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const main = path.join(root, 'main')
  const acct = path.join(root, 'acct')
  for (const d of [main, acct]) fs.mkdirSync(d)
  const port = await freePort() // nothing listens there
  const cfg = (name) => JSON.stringify({ format: 2, port, accountFallback: { mode: 'switch', account: 'second' }, accounts: { second: { configDir: acct } }, providers: { [name]: { baseUrl: 'http://127.0.0.1:9', token: 'k', model: `${name}-model` } } })
  fs.writeFileSync(path.join(main, 'model-relay.json'), cfg('mainprov'))
  fs.writeFileSync(path.join(acct, 'model-relay.json'), cfg('acctprov'))
  const SETUP = path.join(__dirname, '..', 'tools', 'setup.mjs')
  const run = (env, ...args) => new Promise((resolve) => execFile(process.execPath, [SETUP, ...args], { cwd: root, env: { ...process.env, HOME: root, ...env } }, (e, so, se) => resolve({ code: e ? e.code : 0, out: `${so}${se}` })))
  const listed = await run({ CLAUDE_CONFIG_DIR: acct, MODEL_RELAY_CONFIG_DIR: main }, 'providers')
  assert.match(listed.out, /mainprov/)
  assert.ok(!listed.out.includes('acctprov'), 'main\'s config, not the window\'s own')
  for (const given of ['relative/dir', path.join(root, 'nowhere'), '']) {
    const x = await run({ CLAUDE_CONFIG_DIR: acct, MODEL_RELAY_CONFIG_DIR: given }, 'providers')
    assert.match(x.out, /acctprov/, `${given}: treated as unset`)
  }
  const sync = await run({ CLAUDE_CONFIG_DIR: main, MODEL_RELAY_CONFIG_DIR: main }, 'account-sync', 'second')
  assert.strictEqual(sync.code, 2, sync.out)
  assert.match(sync.out, /account-sync does not run while MODEL_RELAY_CONFIG_DIR is set/)
  // fix 10: only a value that counts (absolute and present) stops it; any other goes on to the usual checks
  for (const given of ['relative/dir', path.join(root, 'nowhere')]) {
    const x = await run({ CLAUDE_CONFIG_DIR: main, MODEL_RELAY_CONFIG_DIR: given }, 'account-sync', 'second')
    assert.ok(!/does not run while MODEL_RELAY_CONFIG_DIR/.test(x.out), `${given}: ${x.out}`)
    assert.match(x.out, /could not be read as a JSON object/, 'it went on to read the account\'s login')
  }
})

test('fix 1: a registration the config no longer allows is dropped on the next request: the account removed, or claudeUrl moved away', async (t) => {
  const r = await relay(t, { anthropic: (q) => (q.auth === `Bearer ${MAIN}` ? USAGE_LIMIT : OK(q.auth === `Bearer ${ACCT}` ? 'account' : 'claude')) })
  assert.strictEqual(from(await r.ask(S2)), 'other', 'main\'s limit: the cooldown starts')
  assert.strictEqual((await r.register(S)).status, 200)
  assert.strictEqual(from(await r.ask(S, { auth: ACCT })), 'account')
  r.setCfg({ accounts: { someone: { configDir: '/elsewhere' } } })
  assert.strictEqual(from(await r.ask(S, { auth: ACCT })), 'other', 'the normal path: main\'s cooldown')
  assert.strictEqual((await r.health(S)).account, undefined)
  assert.match(fs.readFileSync(path.join(r.dir, 'model-relay.log'), 'utf8'), /session 11111111 is no longer an account window \(the config no longer allows it\)/)
  // claudeUrl: registered while it is Anthropic itself (no preload), dropped once it points elsewhere. No request is
  // sent anywhere: only /__account and /__health are asked
  const q = await relay(t, { preload: false, top: { claudeUrl: undefined } })
  assert.strictEqual((await q.register(S)).status, 200)
  assert.strictEqual((await q.health(S)).account, 'second')
  q.setCfg({ claudeUrl: `http://127.0.0.1:${q.a.port}` })
  assert.strictEqual((await q.health(S)).account, undefined, 'dropped')
  q.setCfg({ claudeUrl: undefined })
  assert.strictEqual((await q.health(S)).account, undefined, 'and not back by itself')
})

test('a /provider pin made in an account window survives a router restart when the registration comes back with its first time', async (t) => {
  const r = await relay(t)
  const t0 = Date.now()
  assert.strictEqual((await call(r.port, '/__account', { body: { sid: S, account: 'second', since: t0 } })).status, 200)
  await sleep(5)
  assert.strictEqual((await call(r.port, '/__session', { body: { sid: S, on: 'other' } })).status, 200)
  assert.strictEqual((await r.health(S)).session, 'other')
  await r.restart()
  assert.strictEqual((await r.health(S)).account, undefined, 'the registration lived in memory only')
  // without a time the registration starts now: the pin predates it and does not count (as before)
  assert.strictEqual((await r.register(S)).status, 200)
  assert.strictEqual((await r.health(S)).session, 'claude')
  // with the first time it comes back as it was
  assert.strictEqual((await call(r.port, '/__account', { body: { sid: S, account: 'second', since: t0 } })).status, 200)
  assert.strictEqual((await r.health(S)).session, 'other', 'the pin is honoured again')
  assert.strictEqual(from(await r.ask(S, { auth: ACCT })), 'other')
  // a time in the future, or no number, is now
  for (const since of [Date.now() + 3600000, 'yesterday', -1, null]) {
    assert.strictEqual((await call(r.port, '/__account', { body: { sid: S, account: 'second', since } })).status, 200)
    assert.strictEqual((await r.health(S)).session, 'claude', `since ${JSON.stringify(since)}: the registration counts from now`)
  }
})

// The window's /resume to another sid registers that sid for the first time. The hook sends no time then (hooks-host.mjs
// A10-since), so a pin main's own failover made on that sid before does not hold the account window; a registration that
// does carry a time earlier than the pin keeps it (that is the restart case above).
test('a sid registered without a time counts from now: a pin main\'s failover made on it earlier does not hold the account window', async (t) => {
  const limitMain = (q) => (q.auth === `Bearer ${MAIN}` ? USAGE_LIMIT : OK(q.auth === `Bearer ${ACCT}` ? 'account' : 'claude'))
  for (const withTime of [false, true]) {
    const r = await relay(t, { anthropic: limitMain })
    const t1 = Date.now()
    assert.strictEqual((await call(r.port, '/__account', { body: { sid: S, account: 'second', since: t1 } })).status, 200)
    await sleep(5)
    assert.strictEqual(from(await r.ask(S2)), 'other', 'main window S2 at its limit: failover pins S2')
    assert.strictEqual((await r.health(S2)).session, 'other')
    // the account window resumes S2 and registers it
    assert.strictEqual((await call(r.port, '/__account', { body: { sid: S2, account: 'second', ...(withTime ? { since: t1 } : {}) } })).status, 200)
    const y = from(await r.ask(S2, { auth: ACCT }))
    assert.strictEqual(y, withTime ? 'other' : 'account', withTime ? 'a time from before the pin keeps it' : 'no time: the account window goes to its own account')
    assert.strictEqual((await r.health(S2)).session, withTime ? 'other' : 'claude')
  }
})

// A window opened on an account's folder without MODEL_RELAY_CONFIG_DIR is not registered. It is told from main's own
// window by the account in its body: the relay dir's login file against the body's account_uuid. The rule holds in every
// mode that uses a second account (router.js OTHER_LOGIN_MODES, the modes but "off"); only "switch" exists in this change.
const U_MAIN = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa'
const U_OTHER = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb'
const as = (uuid, model = 'claude-opus-5-5') => ({ model, max_tokens: 5, messages: [], metadata: { user_id: JSON.stringify({ account_uuid: uuid }) } })
const writeLogin = (dir, uuid) => fs.writeFileSync(path.join(dir, '.claude.json'), JSON.stringify({ oauthAccount: { accountUuid: uuid } }))

test('an unregistered window carrying another login than the relay dir\'s own goes to Claude as sent, and its usage limit never reaches main\'s failover', async (t) => {
  const r = await relay(t, { anthropic: (q) => (q.url.startsWith('/v1/messages') ? USAGE_LIMIT : OK('claude')) })
  writeLogin(r.dir, U_MAIN)
  const before = await r.mainState()
  const x = await r.ask(S, { auth: ACCT, body: as(U_OTHER) })
  assert.strictEqual(x.status, 429, 'the limit comes back as it is')
  assert.match(x.body, /usage limit reached/)
  assert.strictEqual(r.a.seen.at(-1).auth, `Bearer ${ACCT}`, 'the caller\'s own credentials')
  assert.strictEqual(r.o.seen.length, 0, 'nothing went to the failover provider')
  assert.deepStrictEqual(await r.mainState(), before, 'failoverSince, nextClaudeTry, claudeLimitedAt and sticky unchanged')
  // an earlier pin of that sid (made when main failed over) does not hold it; a provider\'s own model still goes there
  assert.strictEqual(from(await r.ask(S, { auth: ACCT, model: 'other-model', body: as(U_OTHER, 'other-model') })), 'other')
  assert.deepStrictEqual(await r.mainState(), before)
  // main's own window, and a body with no account at all, keep today's path: the limit starts main's failover
  assert.strictEqual(from(await r.ask(S2, { body: as(U_MAIN) })), 'other')
  assert.ok((await r.mainState()).failoverSince > 0, 'main\'s own login: failover as always')
})

test('with no readable login at the relay dir, or a body with no account_uuid, or another mode, an unregistered window takes the path it always took', async (t) => {
  for (const [why, setup, body, top] of [
    ['relay login unreadable', () => {}, as(U_OTHER), {}],
    ['relay login holds no accountUuid', (dir) => fs.writeFileSync(path.join(dir, '.claude.json'), '{"oauthAccount":{}}'), as(U_OTHER), {}],
    ['body without an account_uuid', (dir) => writeLogin(dir, U_MAIN), { model: 'claude-opus-5-5', max_tokens: 5, messages: [] }, {}],
    ['mode off', (dir) => writeLogin(dir, U_MAIN), as(U_OTHER), { accountFallback: { mode: 'off', account: 'second' } }],
    ['an unknown mode, which counts as off', (dir) => writeLogin(dir, U_MAIN), as(U_OTHER), { accountFallback: { mode: 'no-such-mode', account: 'second' } }],
  ]) {
    const r = await relay(t, { anthropic: (q) => (q.url.startsWith('/v1/messages') ? USAGE_LIMIT : OK('claude')), top })
    setup(r.dir)
    assert.strictEqual(from(await r.ask(S, { auth: MAIN, body })), 'other', `${why}: main's failover takes it`)
    assert.ok((await r.mainState()).failoverSince > 0, `${why}: and starts`)
  }
})
