'use strict'
// Mode "switch" end to end: the router against a stand-in for Anthropic that tells the main login
// from the second account's by its token. A second account's window is registered by sid (POST /__account); its 429 at
// the usage limit is read to say that its account is out (/__health accountLimited), and passed back byte for byte.
require('./test-env')
const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const http = require('node:http')
const net = require('node:net')
const os = require('node:os')
const path = require('node:path')
const { spawn, execFileSync } = require('node:child_process')
const L = require('./logic')

const ROUTER = path.join(__dirname, 'router.js')
const MAIN = 'MAIN-TOKEN-1b2c'
const MAIN_UUID = '11111111-2222-4333-8444-555555555555'
const OTHER_UUID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
const OPUS_ID = 'claude-opus-5-5'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// Loaded with `node --require` before router.js: the test-only global that lets claudeUrl be a local stand-in for
// Anthropic, and RELAY_TEST_CLOCK, a file holding how many ms this process's Date.now runs ahead, to skip a cooldown
const PRELOAD = `'use strict'
globalThis.__modelRelayAnyClaudeUrl = true
if (process.env.RELAY_TEST_CLOCK) {
  const fs = require('fs')
  const realNow = Date.now
  Date.now = () => realNow() + Number(fs.readFileSync(process.env.RELAY_TEST_CLOCK, 'utf8'))
}
`

const listen = (server) => new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)))
const freePort = async () => {
  const s = net.createServer()
  const p = await listen(s)
  await new Promise((r) => s.close(r))
  return p
}

// An upstream that records every request and answers with whatever `answer(req)` says
function upstream(t, answer) {
  const seen = []
  const server = http.createServer((req, res) => {
    const ch = []
    req.on('data', (c) => ch.push(c))
    req.on('end', () => {
      const r = { method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(ch) }
      seen.push(r)
      const [status, headers, body] = answer(r)
      res.writeHead(status, { 'content-type': 'application/json', ...headers })
      res.end(body)
    })
  })
  t.after(() => server.close())
  return listen(server).then((port) => ({ port, seen }))
}

const USAGE_LIMIT = [429, { 'anthropic-ratelimit-unified-status': 'rejected' }, '{"type":"error","error":{"type":"rate_limit_error","message":"usage limit reached"}}']
const OK = (from) => [200, {}, JSON.stringify({ from })]

function scratch(t, prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return { dir }
}

const bodyOf = (sid, account = MAIN_UUID) => JSON.stringify({ model: OPUS_ID, max_tokens: 5, metadata: { user_id: JSON.stringify({ account_uuid: account, device_id: 'd'.repeat(64), session_id: sid }) }, messages: [] })
function ask(port, { sid = 'sid-1', body = bodyOf(sid), method = 'POST', url = '/v1/messages' } = {}) {
  return new Promise((resolve, reject) => {
    const buf = Buffer.from(method === 'GET' ? '' : body)
    const headers = { host: `127.0.0.1:${port}`, authorization: `Bearer ${MAIN}`, 'content-type': 'application/json', 'x-claude-code-session-id': sid, 'content-length': String(buf.length) }
    const req = http.request({ host: '127.0.0.1', port, path: url, method, headers }, (res) => {
      const ch = []
      res.on('data', (c) => ch.push(c))
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(ch).toString('utf8') }))
    })
    req.on('error', reject)
    req.end(buf)
  })
}
const control = (port, p, obj) => new Promise((resolve, reject) => {
  const data = obj === undefined ? null : Buffer.from(JSON.stringify(obj))
  const req = http.request({ host: '127.0.0.1', port, path: p, method: data ? 'POST' : 'GET', headers: data ? { 'content-length': data.length } : {} }, (res) => {
    const ch = []
    res.on('data', (c) => ch.push(c))
    res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(ch).toString('utf8') }))
  })
  req.on('error', reject)
  req.end(data || undefined)
})

// The router on a free port in a scratch dir, with `anthropic` standing in for Anthropic. top: more top-level keys
// (accountFallback and accounts); clock: the router's Date.now can be moved ahead with advance(ms)
async function relay(t, { anthropic = () => OK('claude'), chain = [], top = {}, clock = false } = {}) {
  const a = await upstream(t, anthropic)
  const s = scratch(t, 'relay-acct-')
  const port = await freePort()
  const preload = path.join(s.dir, 'preload.js')
  fs.writeFileSync(preload, PRELOAD)
  fs.writeFileSync(path.join(s.dir, 'model-relay.json'), JSON.stringify({
    format: 2,
    port,
    claudeUrl: `http://127.0.0.1:${a.port}`,
    failover: { enabled: true, chain },
    retry: { attempts: 1, delayMs: 10, maxDelayMs: 10, failover: false },
    providers: {},
    ...top,
  }))
  const clockFile = path.join(s.dir, 'clock')
  fs.writeFileSync(clockFile, '0')
  const env = { ...process.env, ...(clock ? { RELAY_TEST_CLOCK: clockFile } : {}) }
  const child = spawn(process.execPath, ['--require', preload, ROUTER, s.dir], { stdio: 'ignore', env })
  t.after(() => child.kill())
  for (let i = 0; i < 200; i++) {
    const up = await new Promise((resolve) => http.get(`http://127.0.0.1:${port}/__health`, (r) => { r.resume(); resolve(true) }).on('error', () => resolve(false)))
    if (up) break
    await sleep(100)
  }
  const health = async (sid = '') => JSON.parse((await control(port, `/__health?sid=${sid}`)).body)
  const routerLog = () => fs.readFileSync(path.join(s.dir, 'model-relay.log'), 'utf8')
  return { port, a, dir: s.dir, health, routerLog, advance: (ms) => fs.writeFileSync(clockFile, String(ms)) }
}

test('A8: the protected routing functions are byte-identical to 96fa186', () => {
  const want = {
    decide: '5ac91de82dfca603b1a641fa39c8a8f4d293e148aed52fda29bbd120a646026f',
    parseRoute: '30b04e7bdfebbb1c5e5bbbd57b01963e00d7ee9d9337962a8f2752d4281ca5a5',
    onLimited: '8d3cdb4b6bd1448b107aa6376e802366f9b32fa720bf745ee1dfb5972ee13f46',
    onClaudeOk: 'cab1afc84d6f7490208e64daa5e5cb8a4d8d29680cb412449c7281f5fe82befb',
    getSessionProvider: '0dda5801255714c29f962973859d8735640f8248d71a577f514c973b85e7d5d6',
    setSticky: '22c3241d78a64e80003219a8d7bd1bc5e38e81a3646d9698d381d7cba195f425',
    pruneSticky: 'e621abd0a1218bbb331f3f8aa681adbf8f3a21c7c42695abbf09d9fa70ba445d',
    parseState: '14636f499675247cf6c60cc2304997fccb6054d380a242a298f9c847944b409c',
    emptyState: '9ba994a9d97becc384e780e7fb19bb03979c6616877f91b484405245aa88989e',
    isRoutedRequest: 'd58647be0f22558c917cdcac8e4c9c5f7feaa170b64fcd2b4cc3188077c81f2f',
  }
  const got = Object.fromEntries(Object.keys(want).map((n) => [n, require('node:crypto').createHash('sha256').update(L[n].toString()).digest('hex')]))
  assert.deepStrictEqual(got, want)
})

test('A3: /__health reports when Claude last answered its usage limit, with an empty chain too; failover state stays as it was', async (t) => {
  let answer = [429, { 'retry-after': '1' }, '{"type":"error","error":{"type":"rate_limit_error","message":"slow down"}}']
  const r = await relay(t, { chain: [], top: { accountFallback: { mode: 'switch', account: 'second' } }, anthropic: () => answer })
  const h0 = await r.health()
  assert.strictEqual(h0.claudeLimitedAt, 0, 'nothing seen yet')
  assert.strictEqual(h0.config.cooldownMs, 600000)
  assert.strictEqual((await ask(r.port)).status, 429)
  assert.strictEqual((await r.health()).claudeLimitedAt, 0, 'a plain rate limit is not the usage limit')
  answer = USAGE_LIMIT
  const t0 = Date.now()
  const x = await ask(r.port)
  assert.strictEqual(x.status, 429, 'with nobody in the chain the 429 goes back as it came')
  const h = await r.health()
  assert.ok(h.claudeLimitedAt >= t0 && h.claudeLimitedAt <= Date.now(), String(h.claudeLimitedAt))
  assert.strictEqual(h.failoverSince, 0, 'no failover state: the chain is empty')
  assert.ok(!fs.existsSync(path.join(r.dir, 'model-relay-state.json')) || !fs.readFileSync(path.join(r.dir, 'model-relay-state.json'), 'utf8').includes('claudeLimitedAt'), 'not saved')
})

// ---------- an account window at its own usage limit ----------

const W1 = '0a0b0c0d-1111-4222-8333-444444444444'
const W2 = '0e0f0a0b-5555-4666-8777-888888888888'
const MAIN_STATE = { failoverSince: 0, nextClaudeTry: 0, claudeLimitedAt: 0, sessionsOnCustom: 0, sticky: {} }

// team-1's registered window sends with its own login (MAIN here, the stand-in does not tell logins apart); the
// .claude.json in team-1's dir says whose limit a 429 is. limited flips every answer to the usage limit
async function windowed(t, { login = { oauthAccount: { accountUuid: MAIN_UUID.toUpperCase() } } } = {}) {
  const state = { limited: false }
  const home = scratch(t, 'relay-window-')
  const d1 = path.join(home.dir, 'team-1')
  fs.mkdirSync(d1)
  if (login) fs.writeFileSync(path.join(d1, '.claude.json'), JSON.stringify(login))
  const r = await relay(t, {
    anthropic: (q) => (state.limited && q.url.startsWith('/v1/messages') ? USAGE_LIMIT : OK('claude')),
    clock: true,
    top: { accountFallback: { mode: 'switch', account: 'team-1' }, accounts: { 'team-1': { configDir: d1 } } },
  })
  const register = async (sid, account = 'team-1') => {
    const x = await control(r.port, '/__account', { sid, account })
    assert.strictEqual(x.status, 200, x.body)
  }
  const mainState = async () => {
    const h = await r.health()
    let sticky = {}
    try {
      sticky = JSON.parse(fs.readFileSync(path.join(r.dir, 'model-relay-state.json'), 'utf8')).sticky
    } catch {}
    return { failoverSince: h.failoverSince, nextClaudeTry: h.nextClaudeTry, claudeLimitedAt: h.claudeLimitedAt, sessionsOnCustom: h.sessionsOnCustom, sticky }
  }
  return { ...r, state, register, mainState, d1 }
}

test('B14 (router): an account window at its usage limit reports accountLimited, its 429 comes back as sent, and the flag ends with the cooldown; a body of another account marks nothing', async (t) => {
  const r = await windowed(t)
  await r.register(W1)
  assert.strictEqual((await r.health(W1)).accountLimited, undefined, 'not before a limit')
  r.state.limited = true
  // a request that is not team-1's own marks nothing
  const stranger = await ask(r.port, { sid: W1, body: bodyOf(W1, OTHER_UUID) })
  assert.strictEqual(stranger.status, 429)
  assert.strictEqual((await r.health(W1)).accountLimited, undefined, 'a body with another account_uuid')
  const x = await ask(r.port, { sid: W1 })
  assert.deepStrictEqual([x.status, x.body], [429, USAGE_LIMIT[2]], 'passed back byte for byte')
  const h = await r.health(W1)
  assert.deepStrictEqual([h.accountLimited, h.account], [true, 'team-1'])
  assert.strictEqual((await r.health()).accountLimited, undefined, 'a main window never has it')
  assert.strictEqual((await r.health(W2)).accountLimited, undefined, 'nor another window')
  assert.match(r.routerLog(), /account team-1 hit its usage limit; passed back \(session 0a0b0c0d\)/)
  assert.deepStrictEqual(await r.mainState(), MAIN_STATE, 'main\'s state untouched')
  r.state.limited = false
  r.advance(600001)
  assert.strictEqual((await r.health(W1)).accountLimited, undefined, 'the cooldown is over')
})

test('B14 (router): a usage limit for a body that is not team-1\'s own, or with team-1\'s .claude.json unreadable, comes back and marks team-1 nothing', async (t) => {
  const r = await windowed(t)
  await r.register(W1)
  r.state.limited = true
  for (const body of [bodyOf(W1, OTHER_UUID), JSON.stringify({ model: OPUS_ID, messages: [] })]) {
    const x = await ask(r.port, { sid: W1, body })
    assert.deepStrictEqual([x.status, x.body], [429, USAGE_LIMIT[2]])
    assert.strictEqual((await r.health(W1)).accountLimited, undefined)
  }
  fs.writeFileSync(path.join(r.d1, '.claude.json'), '{"oauthAccount": oops')
  assert.strictEqual((await ask(r.port, { sid: W1 })).status, 429)
  assert.strictEqual((await r.health(W1)).accountLimited, undefined, 'unreadable')
  fs.rmSync(path.join(r.d1, '.claude.json'))
  assert.strictEqual((await ask(r.port, { sid: W1 })).status, 429)
  assert.strictEqual((await r.health(W1)).accountLimited, undefined, 'missing')
  // and once it says team-1 again, the same body marks it
  fs.writeFileSync(path.join(r.d1, '.claude.json'), JSON.stringify({ oauthAccount: { accountUuid: MAIN_UUID } }))
  assert.strictEqual((await ask(r.port, { sid: W1 })).status, 429)
  assert.strictEqual((await r.health(W1)).accountLimited, true)
})

test('list 17: a .claude.json that is a directory or a FIFO is never read: it counts as unreadable, with no hang', async (t) => {
  const s = scratch(t, 'relay-acct-fifo-')
  const fifo = path.join(s.dir, 'fifo.json')
  execFileSync('mkfifo', [fifo])
  const t0 = Date.now()
  assert.strictEqual(L.loginIds(fifo), null)
  assert.strictEqual(L.readLoginJson(fifo), null)
  assert.strictEqual(L.loginIds(s.dir), null)
  assert.ok(Date.now() - t0 < 1000, 'answered at once')
  const r = await windowed(t)
  await r.register(W1)
  r.state.limited = true
  for (const make of [(p) => fs.mkdirSync(p), (p) => execFileSync('mkfifo', [p])]) {
    const login = path.join(r.d1, '.claude.json')
    fs.rmSync(login, { recursive: true, force: true })
    make(login)
    const x = await ask(r.port, { sid: W1 })
    assert.deepStrictEqual([x.status, x.body], [429, USAGE_LIMIT[2]], 'team-1\'s 429 back')
    assert.strictEqual((await r.health(W1)).accountLimited, undefined)
  }
})

