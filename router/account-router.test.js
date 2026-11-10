'use strict'
// kind "anthropic" end to end: the router started with a preload that stands in for /usr/bin/security (no test ever
// runs the real one), a stand-in for Anthropic that tells the two accounts apart by their token, and another provider.
require('./test-env')
const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const http = require('node:http')
const net = require('node:net')
const os = require('node:os')
const path = require('node:path')
const { spawn, execFile } = require('node:child_process')
const L = require('./logic')

const SETUP = path.join(__dirname, '..', 'tools', 'setup.mjs')
const ROUTER = path.join(__dirname, 'router.js')
const MAIN = 'MAIN-TOKEN-1b2c'
const SECRET = 'SPARE-SECRET-7f3a'
const MAIN_UUID = '11111111-2222-4333-8444-555555555555'
const SPARE_UUID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
const SPARE_DEV = 'd'.repeat(64)
const IDS = { deviceId: SPARE_DEV, email: 'spare@example.test' } // what account-sync writes beside accountUuid
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
// A token-shaped string built at run time, so this source never holds one (GitHub's secret scanning matches the literal)
const tokenLike = (kind, rest) => ['sk', 'ant', kind, rest].join('-')

// Loaded with `node --require` before router.js or setup.mjs. It stands in for the keychain tool in execFile (the
// router's background read) and execFileSync (the CLI's existence check), logs each call with the API used, and refuses
// any other way of starting it; it also sets the test-only global that lets the account use a local stand-in for
// Anthropic. RELAY_TEST_KEYCHAIN_ITEMS maps "service/account" to a token, or to "HANG" (a real child process that never
// answers, cut by the caller's timeout).
const STUB = `'use strict'
const cp = require('child_process')
const fs = require('fs')
const realSync = cp.execFileSync
const realAsync = cp.execFile
const items = JSON.parse(process.env.RELAY_TEST_KEYCHAIN_ITEMS || '{}')
const HANG = ['-e', 'setTimeout(() => {}, 60000)']
const isSecurity = (f) => /security/.test(String(f))
globalThis.__modelRelayAnyClaudeUrl = true
// setup.mjs prints macOS steps and checks keychain items only on macOS; this stand-in is macOS's keychain, on any OS
globalThis.__modelRelayTestPlatform = 'darwin'
for (const n of ['spawn', 'spawnSync', 'exec', 'execSync']) {
  const orig = cp[n]
  cp[n] = function (f, ...rest) {
    if (isSecurity(f)) throw new Error('the keychain tool must be run with execFile or execFileSync')
    return orig.call(this, f, ...rest)
  }
}
const record = (api, file, args, opts) => fs.appendFileSync(process.env.RELAY_TEST_KEYCHAIN_LOG, JSON.stringify({ api, file, args, timeout: opts && opts.timeout, shell: opts && opts.shell }) + '\\n')
const lookup = (args) => items[args[args.indexOf('-s') + 1] + '/' + args[args.indexOf('-a') + 1]]
const out = (args, v) => (args.includes('-w') ? v + '\\n' : 'keychain: "x"\\nclass: "genp"\\n')
cp.execFileSync = function (file, args, opts) {
  if (!isSecurity(file)) return realSync.apply(this, arguments)
  record('execFileSync', file, args, opts)
  const v = lookup(args)
  if (v === 'HANG') return realSync(process.execPath, HANG, opts)
  if (v === undefined) throw Object.assign(new Error('The specified item could not be found in the keychain.'), { status: 44 })
  return out(args, v)
}
cp.execFile = function (file, args, opts, cb) {
  if (!isSecurity(file)) return realAsync.apply(this, arguments)
  record('execFile', file, args, opts)
  const v = lookup(args)
  if (v === 'HANG') return realAsync(process.execPath, HANG, opts, (e) => cb(e, '', ''))
  setImmediate(() => (v === undefined ? cb(Object.assign(new Error('Command failed'), { code: 44 }), '', '') : cb(null, out(args, v), '')))
}
// RELAY_TEST_REALPATH_LOG: a file that gets a line for every fs.realpathSync.native call (logic.js realDir), so a test can
// count how often the router resolves its account folders
if (process.env.RELAY_TEST_REALPATH_LOG) {
  const realPath = fs.realpathSync.native
  fs.realpathSync.native = function (p) {
    fs.appendFileSync(process.env.RELAY_TEST_REALPATH_LOG, 'x\\n')
    return realPath.apply(this, arguments)
  }
}
// RELAY_TEST_CLOCK: a file holding how many ms this process's Date.now runs ahead, so a test can skip a cooldown
if (process.env.RELAY_TEST_CLOCK) {
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
const count = (raw, name) => raw.filter((_, i) => i % 2 === 0 && raw[i].toLowerCase() === name).length

// An upstream that records every request and answers with whatever `answer(req)` says
function upstream(t, answer) {
  const seen = []
  const server = http.createServer((req, res) => {
    const ch = []
    req.on('data', (c) => ch.push(c))
    req.on('end', () => {
      const r = { method: req.method, url: req.url, raw: req.rawHeaders, headers: req.headers, body: Buffer.concat(ch) }
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
  const stub = path.join(dir, 'keychain-stub.js')
  fs.writeFileSync(stub, STUB)
  const log = path.join(dir, 'keychain-calls.log')
  fs.writeFileSync(log, '')
  const calls = () => fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
  return { dir, stub, log, calls }
}

// The router with { spare: kind "anthropic", other: an ordinary provider }, both answering through `anthropic` and `other`
// account: false leaves the account out; top: more top-level keys (accountFallback replaces rc-keep); clock: the router's
// Date.now can be moved ahead with advance(ms); home: the scratch dir is the router's HOME and its config dir is
// <home>/.claude (the default dir); dirArg: false names that dir by CLAUDE_CONFIG_DIR alone; env: more environment
async function relay(t, { anthropic = () => OK('claude'), other = () => OK('other'), chain = ['spare', 'other'], retry = {}, providers = {}, items = { 'relay-test/spare': SECRET }, account = true, top = {}, clock = false, home = false, dirArg = true, env: moreEnv = {} } = {}) {
  const a = await upstream(t, anthropic)
  const o = await upstream(t, other)
  const s = scratch(t, 'relay-acct-')
  const port = await freePort()
  const dir = home ? path.join(s.dir, '.claude') : s.dir
  if (home) fs.mkdirSync(dir)
  fs.writeFileSync(path.join(dir, 'model-relay.json'), JSON.stringify({
    format: 2,
    port,
    accountFallback: { mode: 'rc-keep' },
    claudeUrl: `http://127.0.0.1:${a.port}`,
    failover: { enabled: true, chain },
    retry: { attempts: 1, delayMs: 10, maxDelayMs: 10, failover: false, ...retry },
    providers: {
      ...(account ? { spare: { kind: 'anthropic', token: 'keychain:relay-test/spare', accountUuid: SPARE_UUID, ...IDS } } : {}),
      other: { baseUrl: `http://127.0.0.1:${o.port}`, token: 'OTHER-KEY', model: 'other-model' },
      ...providers,
    },
    ...top,
  }))
  const clockFile = path.join(s.dir, 'clock')
  fs.writeFileSync(clockFile, '0')
  const env = { ...process.env, RELAY_TEST_KEYCHAIN_LOG: s.log, RELAY_TEST_KEYCHAIN_ITEMS: JSON.stringify(items), ...(clock ? { RELAY_TEST_CLOCK: clockFile } : {}), ...(home ? { HOME: s.dir, USERPROFILE: s.dir } : {}), ...(dirArg ? {} : { CLAUDE_CONFIG_DIR: dir }), ...moreEnv }
  const child = spawn(process.execPath, ['--require', s.stub, ROUTER, ...(dirArg ? [dir] : [])], { stdio: 'ignore', env })
  t.after(() => child.kill())
  const t0 = Date.now()
  for (let i = 0; i < 200; i++) {
    const up = await new Promise((resolve) => http.get(`http://127.0.0.1:${port}/__health`, (r) => { r.resume(); resolve(true) }).on('error', () => resolve(false)))
    if (up) break
    await sleep(100)
  }
  const upAfterMs = Date.now() - t0
  // The keychain is read in the background: wait for the items that hold a token to land
  if (account && L.accountActive({ accountFallback: { mode: 'rc-keep' }, ...top }) && items['relay-test/spare'] && items['relay-test/spare'] !== 'HANG') {
    for (let i = 0; i < 100 && !JSON.parse((await control(port, '/__health')).body).providers.spare; i++) await sleep(50)
  }
  return { port, a, o, ...s, dir, home: s.dir, upAfterMs, advance: (ms) => fs.writeFileSync(clockFile, String(ms)) }
}

const uid = (account, device = 'dev-1', session = 'sess-1') => JSON.stringify({ account_uuid: account, device_id: device, session_id: session })
const BODY = [
  '{"model":"claude-opus-5-5","max_tokens":5,',
  `"metadata":{"user_id":${JSON.stringify(uid(MAIN_UUID))}},`,
  '"tools":[{"name":"ToolSearch","defer_loading":true,"input_schema":{"type":"object"}},{"name":"DeferredToolPlaceholder"}],',
  `"messages":[{"role":"user","content":[{"type":"text","text":${JSON.stringify(`quoted "${uid(MAIN_UUID)}"`)}}]},`,
  '{"role":"assistant","content":[{"type":"tool_use","id":"t1","name":"calc","input":{"2":"b","1":"a","n":12345678901234567890123}}]}]}',
].join('')
// The request of the window with this session id: metadata.user_id carries it, as Claude Code sends it
const bodyFor = (sid) => BODY.replace(JSON.stringify(uid(MAIN_UUID)), JSON.stringify(uid(MAIN_UUID, 'dev-1', sid)))
// What the account gets for it: its own ids and the window's replacement session id (the one in the request's header)
const splicedFor = (replacement) => BODY.replace(JSON.stringify(uid(MAIN_UUID)), JSON.stringify(uid(SPARE_UUID, SPARE_DEV, replacement)))

// Claude Code's request as it reaches the router: its own token, written twice in two spellings, plus an x-api-key
function ask(port, { sid = 'sid-1', body = bodyFor(sid), method = 'POST', url = '/v1/messages', extra = [] } = {}) {
  return new Promise((resolve, reject) => {
    const buf = Buffer.from(method === 'GET' ? '' : body)
    const headers = [
      'Host', `127.0.0.1:${port}`,
      'Authorization', `Bearer ${MAIN}`,
      'authorization', `Bearer ${MAIN}`,
      'x-api-key', MAIN,
      'accept-encoding', 'gzip, br',
      'content-type', 'application/json',
      'anthropic-version', '2023-06-01',
      'x-claude-code-session-id', sid,
      'content-length', String(buf.length),
      ...extra,
    ]
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

const byToken = (seen, token) => seen.filter((r) => r.headers.authorization === `Bearer ${token}`)
// What the account receives: exactly one authorization, its own; no x-api-key; the caller's accept-encoding; the body
// as sent except the ids and the session id
function assertAccountRequest(r, why, sid) {
  assert.strictEqual(count(r.raw, 'authorization'), 1, `${why}: one authorization`)
  assert.strictEqual(r.headers.authorization, `Bearer ${SECRET}`, why)
  assert.strictEqual(count(r.raw, 'x-api-key'), 0, `${why}: no x-api-key`)
  assert.strictEqual(r.headers['accept-encoding'], 'gzip, br', `${why}: accept-encoding as the caller sent it`)
  assert.ok(!r.raw.join('\n').includes(MAIN), `${why}: the main token does not reach the account`)
  const replacement = r.headers['x-claude-code-session-id']
  assert.ok(L.UUID_RE.test(replacement) && (sid === undefined || replacement !== sid), `${why}: a replacement session id of the window, not its own`)
  assert.strictEqual(r.body.toString('utf8'), splicedFor(replacement), `${why}: the original bytes but the ids and the session id`)
}
const noToken = (r, why) => {
  const all = r.raw.join('\n')
  assert.ok(!all.includes(MAIN) && !all.includes(SECRET), `${why}: neither account's token`)
}

test('A1, A2, A3, A5, A10, A12, A7, A8: failover, pin and cooldown on the account; the rest stays the caller\'s', async (t) => {
  let claudeLimited = false
  const r = await relay(t, { anthropic: (q) => (q.headers.authorization === `Bearer ${MAIN}` && q.url.startsWith('/v1/messages') && claudeLimited ? USAGE_LIMIT : OK(q.headers.authorization === `Bearer ${SECRET}` ? 'spare' : 'claude')) })
  const replies = []
  const go = async (o) => {
    const x = await ask(r.port, o)
    replies.push(x.body)
    return x
  }

  // A1: Claude answers, so a Claude request never reaches the account
  assert.strictEqual(JSON.parse((await go({ sid: 's1' })).body).from, 'claude')
  assert.strictEqual(byToken(r.a.seen, SECRET).length, 0)
  assert.strictEqual(r.a.seen[0].body.toString(), bodyFor('s1'), 'Claude gets the request untouched')

  // A2: the first failover
  claudeLimited = true
  const first = await go({ sid: 's2' })
  assert.strictEqual(first.status, 200, first.body)
  assert.strictEqual(JSON.parse(first.body).from, 'spare')
  assert.strictEqual(byToken(r.a.seen, SECRET).length, 1)
  assertAccountRequest(byToken(r.a.seen, SECRET)[0], 'first failover', 's2')
  assert.strictEqual(r.o.seen.length, 0)

  // A3: through the cooldown the session stays on the account, and a new session goes there too, neither asking Claude first
  const mainBefore = byToken(r.a.seen, MAIN).length
  assert.strictEqual(JSON.parse((await go({ sid: 's2' })).body).from, 'spare')
  assert.strictEqual(JSON.parse((await go({ sid: 's3' })).body).from, 'spare')
  assert.strictEqual(byToken(r.a.seen, MAIN).length, mainBefore, 'Claude was not asked')
  for (const [i, q] of byToken(r.a.seen, SECRET).entries()) assertAccountRequest(q, `request ${i + 1} on the account`)

  // A10: a pinned session's non-model request reaches Anthropic with the caller's own credentials
  const models = await go({ sid: 's2', method: 'GET', url: '/v1/models' })
  assert.strictEqual(models.status, 200)
  const m = r.a.seen.at(-1)
  assert.strictEqual(m.url, '/v1/models')
  assert.strictEqual(m.headers.authorization, `Bearer ${MAIN}`)
  assert.ok(!m.raw.join('\n').includes(SECRET))

  // A5: Message Threads are refused as for any other provider
  const beta = ['anthropic-beta', 'message-threads-2026-01-01,oauth-2025-04-20']
  const seenBefore = r.a.seen.length
  const refused = await go({ sid: 's2', extra: beta })
  assert.strictEqual((await control(r.port, '/__session', { sid: 's9', on: 'other' })).status, 200)
  const refusedOther = await go({ sid: 's9', extra: beta })
  assert.strictEqual(refused.status, 400)
  assert.deepStrictEqual([refused.status, refused.body], [refusedOther.status, refusedOther.body])
  assert.strictEqual(JSON.parse(refused.body).error.message, L.threadBetaRefusal({ 'anthropic-beta': beta[1] }))
  assert.strictEqual(r.a.seen.length, seenBefore, 'nothing was sent')

  // A12: /provider <account> pins a session by hand
  claudeLimited = false
  const pin = await control(r.port, '/__session', { sid: 's5', on: 'spare' })
  assert.strictEqual(pin.status, 200, pin.body)
  assert.strictEqual(JSON.parse((await go({ sid: 's5' })).body).from, 'spare')

  // /__health: the account is listed for the picker, with its kind, and never by a model id
  const h = JSON.parse((await control(r.port, '/__health')).body)
  assert.strictEqual(h.providers.spare, 'anthropic-account')
  assert.deepStrictEqual(h.kinds, { spare: 'anthropic' })
  assert.deepStrictEqual(h.aliases, {})
  assert.deepStrictEqual(h.unresolved, [])

  // A7: one keychain read, in the background, over every request and config read since
  const calls = r.calls()
  assert.strictEqual(calls.length, 1, JSON.stringify(calls))
  assert.strictEqual(calls[0].api, 'execFile', 'never a synchronous read')
  assert.strictEqual(calls[0].file, '/usr/bin/security')
  assert.deepStrictEqual(calls[0].args.slice(0, 6), ['find-generic-password', '-s', 'relay-test', '-a', 'spare', '-w'])
  assert.match(calls[0].args[6], /Library\/Keychains\/login\.keychain-db$/)
  assert.strictEqual(calls[0].timeout, 5000)
  assert.ok(!calls[0].shell)

  // A8: the account's token is in no log, no health answer and no reply
  const logs = ['model-relay.log', 'model-relay-requests.log', 'model-relay-state.json'].map((f) => {
    try {
      return fs.readFileSync(path.join(r.dir, f), 'utf8')
    } catch {
      return ''
    }
  })
  assert.ok(logs[1].includes('spare-reply'), 'the request log was written')
  for (const text of [...logs, JSON.stringify(h), ...replies]) assert.ok(!text.includes(SECRET))
})

test('the account always sends the OAuth beta, appended only when the caller did not', async (t) => {
  const r = await relay(t)
  assert.strictEqual((await control(r.port, '/__session', { sid: 's1', on: 'spare' })).status, 200)
  const cases = [
    [null, 'oauth-2025-04-20'],
    ['interleaved-thinking-2025-05-14', 'interleaved-thinking-2025-05-14,oauth-2025-04-20'],
    ['oauth-2025-04-20, context-1m-2025-08-07', 'oauth-2025-04-20, context-1m-2025-08-07'],
  ]
  for (const [sent, want] of cases) {
    await ask(r.port, { sid: 's1', extra: sent ? ['anthropic-beta', sent] : [] })
    const q = r.a.seen.at(-1)
    assert.strictEqual(q.headers.authorization, `Bearer ${SECRET}`)
    assert.strictEqual(count(q.raw, 'anthropic-beta'), 1, String(sent))
    assert.strictEqual(q.headers['anthropic-beta'], want, String(sent))
  }
  await ask(r.port, { sid: 'claude-session', extra: ['anthropic-beta', 'interleaved-thinking-2025-05-14'] })
  assert.strictEqual(r.a.seen.at(-1).headers['anthropic-beta'], 'interleaved-thinking-2025-05-14', "Claude's own request is untouched")
})

// A body as Claude Code writes it for a main turn: the email sentence in a <system-reminder> of the first message
const MAIN_DEV = 'a'.repeat(64)
const MAIN_EMAIL = 'main@example.test'
const sentence = (email) => `The user's email address is ${email}. Use it only to identify the user.`
const reminderBody = (blocks, user = uid(MAIN_UUID, MAIN_DEV)) => JSON.stringify({ model: OPUS_ID, max_tokens: 5, metadata: { user_id: user }, messages: [{ role: 'user', content: blocks.map((text) => ({ type: 'text', text })) }] })
const REMINDER = `<system-reminder>\n# userEmail\n${sentence(MAIN_EMAIL)}\n</system-reminder>`

const byAccount = (q) => OK(q.headers.authorization === `Bearer ${SECRET}` ? 'spare' : 'claude')

test('A2: rc-keep sends the account its own account_uuid, device_id and email, nothing else changed', async (t) => {
  const r = await relay(t, { anthropic: byAccount })
  assert.strictEqual((await control(r.port, '/__session', { sid: 's1', on: 'spare' })).status, 200)
  const body = reminderBody([REMINDER, 'hello'], uid(MAIN_UUID, MAIN_DEV, 's1'))
  const x = await ask(r.port, { sid: 's1', body })
  assert.strictEqual(JSON.parse(x.body).from, 'spare', x.body)
  const q = byToken(r.a.seen, SECRET)
  assert.strictEqual(q.length, 1)
  // the window's replacement session id goes in the same splice: header and metadata alike, never the window's own
  const s2 = sidOf(q[0])
  assert.ok(L.UUID_RE.test(s2) && s2 !== 's1', s2)
  const want = body.replace(JSON.stringify(uid(MAIN_UUID, MAIN_DEV, 's1')), JSON.stringify(uid(SPARE_UUID, SPARE_DEV, s2))).replace(MAIN_EMAIL, IDS.email)
  assert.strictEqual(q[0].body.toString('utf8'), want)
  assert.ok(!q[0].body.toString().includes(MAIN_DEV) && !q[0].body.toString().includes(MAIN_EMAIL), 'nothing of the main account is left')
  // Only the metadata ids and the injected sentence are replaced: your address or id written elsewhere (a git log, a
  // prompt) is not scrubbed, and does not stop the request
  const mention = `git log: Author <${MAIN_EMAIL}>, account ${MAIN_UUID}`
  const withMention = reminderBody([REMINDER, mention], uid(MAIN_UUID, MAIN_DEV, 's1'))
  assert.strictEqual(JSON.parse((await ask(r.port, { sid: 's1', body: withMention })).body).from, 'spare')
  const sent = byToken(r.a.seen, SECRET).at(-1).body.toString()
  assert.ok(sent.includes(JSON.stringify(mention)) && sent.includes(sentence(IDS.email)), 'the mention goes on as written, the sentence is replaced')
})

test('chain accounts (rc-keep, api-only) carry one replacement session id per window, in the header and in metadata.user_id', async (t) => {
  for (const mode of ['rc-keep', 'api-only']) {
    let limited = false
    const r = await relay(t, { anthropic: (q) => (limited && q.headers.authorization === `Bearer ${MAIN}` && q.url.startsWith('/v1/messages') ? USAGE_LIMIT : byAccount(q)), top: { accountFallback: { mode } } })
    for (const sid of ['w1', 'w2']) assert.strictEqual((await control(r.port, '/__session', { sid, on: 'spare' })).status, 200)
    const inBody = (q) => JSON.parse(JSON.parse(q.body.toString()).metadata.user_id).session_id
    for (const sid of ['w1', 'w1', 'w2']) assert.strictEqual(JSON.parse((await ask(r.port, { sid })).body).from, 'spare')
    const [a, b, c] = byToken(r.a.seen, SECRET)
    for (const [q, sid] of [[a, 'w1'], [b, 'w1'], [c, 'w2']]) {
      assert.ok(L.UUID_RE.test(sidOf(q)) && sidOf(q) !== sid, `${mode}: ${sid} gets an id of its own on the account`)
      assert.strictEqual(inBody(q), sidOf(q), `${mode}: the same id in the header and in metadata`)
    }
    assert.strictEqual(sidOf(a), sidOf(b), `${mode}: one id for a window`)
    assert.notStrictEqual(sidOf(a), sidOf(c), `${mode}: another window, another id`)
    // a body whose session_id is not the header's sid is refused, as on a fallback account: nothing is sent with either token
    const seen = r.a.seen.length
    const x = await ask(r.port, { sid: 'w1', body: bodyFor('w2') })
    assert.strictEqual(x.status, 200, 'the next link (other) takes it')
    assert.strictEqual(JSON.parse(x.body).from, 'other', mode)
    assert.strictEqual(r.a.seen.length, seen, `${mode}: nothing was sent to Anthropic`)
    // no session header at all: there is no id to replace, and the body goes on with its own
    limited = true
    const none = await ask(r.port, { sid: '', body: bodyFor('sess-x') })
    assert.strictEqual(JSON.parse(none.body).from, 'spare', `${mode}: ${none.body}`)
    assert.strictEqual(inBody(byToken(r.a.seen, SECRET).at(-1)), 'sess-x', `${mode}: the body's own session id`)
  }
})

test('A2: a body the splice refuses never goes out with the account token; the next link takes it, or the caller gets an error', async (t) => {
  const refusals = [
    ['the sentence only in the user prompt', reminderBody(['<system-reminder>\nnothing here\n</system-reminder>', sentence(MAIN_EMAIL)])],
    ['the sentence in CLAUDE.md content and in the reminder', reminderBody([`<system-reminder>\nCLAUDE.md: ${sentence('other@example.test')}\n</system-reminder>`, REMINDER])],
    ['a user_id that is no JSON', JSON.stringify({ model: OPUS_ID, metadata: { user_id: 'plain-id' }, messages: [] })],
    ['no user_id, and the sentence only in the user prompt', JSON.stringify({ model: OPUS_ID, messages: [{ role: 'user', content: [{ type: 'text', text: sentence(MAIN_EMAIL) }] }] })],
  ]
  await t.test('the next link takes it', async (t) => {
    const r = await relay(t, { anthropic: byAccount })
    assert.strictEqual((await control(r.port, '/__session', { sid: 's1', on: 'spare' })).status, 200)
    for (const [why, body] of refusals) {
      const x = await ask(r.port, { sid: 's1', body })
      assert.strictEqual(JSON.parse(x.body).from, 'other', `${why}: ${x.body}`)
    }
    assert.strictEqual(byToken(r.a.seen, SECRET).length, 0, 'not one request with the account token')
    assert.strictEqual(r.o.seen.length, refusals.length)
    for (const q of r.o.seen) noToken(q, 'the next link')
    const log = fs.readFileSync(path.join(r.dir, 'model-relay.log'), 'utf8')
    assert.strictEqual((log.match(/provider "spare" not used for this request: /g) || []).length, refusals.length)
    assert.ok(!log.includes(MAIN_EMAIL) && !log.includes(MAIN_DEV), 'the reason quotes nothing from the body')
    // A request with neither a user_id nor the sentence has nothing to replace: it goes to the account unchanged, and is
    // not logged; one with the sentence but no user_id gets the sentence replaced all the same
    const count = JSON.stringify({ model: OPUS_ID, messages: [] })
    await ask(r.port, { sid: 's1', url: '/v1/messages/count_tokens', body: count })
    assert.strictEqual(byToken(r.a.seen, SECRET).length, 1)
    assert.strictEqual(byToken(r.a.seen, SECRET)[0].body.toString(), count)
    const countMail = JSON.stringify({ model: OPUS_ID, messages: [{ role: 'user', content: [{ type: 'text', text: REMINDER }] }] })
    await ask(r.port, { sid: 's1', url: '/v1/messages/count_tokens', body: countMail })
    assert.strictEqual(byToken(r.a.seen, SECRET)[1].body.toString(), countMail.replace(MAIN_EMAIL, IDS.email))
    assert.strictEqual((fs.readFileSync(path.join(r.dir, 'model-relay.log'), 'utf8').match(/not used for this request/g) || []).length, refusals.length)
  })
  await t.test('nobody is left: the caller gets an error, and nothing is resent on your own account', async (t) => {
    let limited = false
    const r = await relay(t, { chain: ['spare'], anthropic: (q) => (q.headers.authorization === `Bearer ${MAIN}` && limited ? USAGE_LIMIT : OK(q.headers.authorization === `Bearer ${SECRET}` ? 'spare' : 'claude')) })
    assert.strictEqual((await control(r.port, '/__session', { sid: 's1', on: 'spare' })).status, 200)
    const refusedWith = (x, why) => {
      assert.strictEqual(x.status, 502, `${why}: ${x.body}`)
      assert.match(JSON.parse(x.body).error.message, /^model-relay router: account "spare" could not serve this request: /, why)
      assert.ok(!x.body.includes(MAIN_EMAIL) && !x.body.includes(MAIN_DEV), `${why}: the reason quotes nothing from the body`)
    }
    for (const [why, body] of refusals) refusedWith(await ask(r.port, { sid: 's1', body }), why)
    assert.strictEqual(r.a.seen.length, 0, 'not one request went out, on either account')
    // the first failover hop too: Claude was asked once, as for any request, and is not asked again
    limited = true
    refusedWith(await ask(r.port, { sid: 's2', body: refusals[0][1] }), 'first hop')
    assert.strictEqual(r.a.seen.length, 1)
    assert.strictEqual(r.a.seen[0].headers.authorization, `Bearer ${MAIN}`)
    assert.strictEqual(byToken(r.a.seen, SECRET).length, 0, 'not one request with the account token')
    // a non-model request on the pinned session still goes to Anthropic with the caller's own headers, unchanged
    assert.strictEqual((await ask(r.port, { sid: 's1', method: 'GET', url: '/v1/models' })).status, 429)
    assert.strictEqual(r.a.seen.at(-1).headers.authorization, `Bearer ${MAIN}`)
  })
})

test('A1: off and switch route exactly as with no account at all; the account is in no answer and its item is never read', async (t) => {
  const run = async (opts) => {
    let limited = false
    const r = await relay(t, { ...opts, anthropic: (q) => (q.headers.authorization === `Bearer ${MAIN}` && limited && q.url.startsWith('/v1/messages') ? USAGE_LIMIT : byAccount(q)) })
    const replies = [await ask(r.port, { sid: 's1' })]
    limited = true
    replies.push(await ask(r.port, { sid: 's2' })) // Claude's usage limit: failover
    replies.push(await ask(r.port, { sid: 's3' })) // the cooldown
    replies.push(await control(r.port, '/__session', { sid: 's4', on: 'spare' })) // a pin by hand
    replies.push(await ask(r.port, { sid: 's4' }))
    replies.push(await ask(r.port, { sid: 's4', method: 'GET', url: '/v1/models' }))
    const h = JSON.parse((await control(r.port, '/__health?sid=s4')).body)
    const seen = (up, name) => up.seen.map((q) => [name, q.method, q.url, q.headers.authorization, q.body.toString()])
    return {
      trace: [...seen(r.a, 'anthropic'), ...seen(r.o, 'other')],
      replies: replies.map((x) => [x.status, x.body]),
      health: [h.providers, h.kinds, h.failoverChain, h.failoverProvider, h.unresolved, h.session, h.sessionsOnCustom],
      calls: r.calls(),
    }
  }
  const none = await run({ account: false })
  assert.deepStrictEqual(none.health.slice(0, 4), [{ other: 'other-model' }, {}, ['other'], 'other'])
  assert.strictEqual(none.trace.filter((x) => x[0] === 'other').length, 4, 'failover, the cooldown, and s4 (stuck there by the cooldown) twice went to the other provider')
  for (const top of [{ accountFallback: undefined }, { accountFallback: { mode: 'off', account: 'spare' } }, { accountFallback: { mode: 'switch', account: 'spare' }, accounts: { spare: { configDir: '/nowhere' } } }]) {
    const x = await run({ top })
    const mode = JSON.stringify(top)
    assert.deepStrictEqual(x.trace, none.trace, `${mode}: every upstream request as with no account`)
    assert.deepStrictEqual(x.replies, none.replies, `${mode}: every answer as with no account`)
    assert.match(JSON.parse(x.replies[3][1]).error.message, /unknown provider "spare"/, `${mode}: /__session does not know the account`)
    assert.deepStrictEqual(x.health, none.health, mode)
    assert.deepStrictEqual(x.calls, [], `${mode}: the keychain was never asked`)
    assert.ok(!x.trace.some((q) => q[3] === `Bearer ${SECRET}`))
  }
})

test('A1: a JSON typo after rc-keep → off does not bring the account back', async (t) => {
  const r = await relay(t, { anthropic: byAccount })
  const file = path.join(r.dir, 'model-relay.json')
  const from = async () => JSON.parse((await ask(r.port, { sid: 's1' })).body).from
  assert.strictEqual((await control(r.port, '/__session', { sid: 's1', on: 'spare' })).status, 200)
  assert.strictEqual(await from(), 'spare')
  // off, and the account was the only provider: nothing usable is left, so every request goes to Claude
  const cfg = JSON.parse(fs.readFileSync(file, 'utf8'))
  fs.writeFileSync(file, JSON.stringify({ ...cfg, accountFallback: { mode: 'off' }, providers: { spare: cfg.providers.spare } }))
  assert.strictEqual(await from(), 'claude')
  // a half-saved file falls back to the last file read, not to the rc-keep one before it
  fs.writeFileSync(file, '{"format": 2, "accountFallback": {"mode": "rc-keep"},')
  assert.strictEqual(await from(), 'claude')
  assert.deepStrictEqual(JSON.parse((await control(r.port, '/__health')).body).providers, {})
  assert.strictEqual(byToken(r.a.seen, SECRET).length, 1, 'only the request made in rc-keep')
})

test('A14: failover to the account pins no session; the trial brings them back to Claude; a hand-made pin stays', async (t) => {
  let claudeLimited = true
  const r = await relay(t, { anthropic: (q) => (q.headers.authorization === `Bearer ${MAIN}` && q.url.startsWith('/v1/messages') && claudeLimited ? USAGE_LIMIT : OK(q.headers.authorization === `Bearer ${SECRET}` ? 'spare' : 'claude')) })
  const from = async (sid) => JSON.parse((await ask(r.port, { sid })).body).from
  assert.strictEqual((await control(r.port, '/__session', { sid: 'hand', on: 'spare' })).status, 200)
  // Claude's usage limit: the request moves to the account, and so do the cooldown's, with no session pinned there
  assert.strictEqual(await from('w1'), 'spare')
  assert.strictEqual(await from('w1'), 'spare')
  assert.strictEqual(await from('w2'), 'spare')
  const h = JSON.parse((await control(r.port, '/__health?sid=w1')).body)
  assert.strictEqual(h.session, 'claude', 'w1 is not pinned to the account')
  assert.strictEqual(h.sessionsOnCustom, 1, 'only the hand-made pin')
  assert.ok(h.failoverSince > 0)
  assert.deepStrictEqual(Object.keys(JSON.parse(fs.readFileSync(path.join(r.dir, 'model-relay-state.json'), 'utf8')).sticky), ['hand'])
  assert.ok(!/moved to spare/.test(fs.readFileSync(path.join(r.dir, 'model-relay.log'), 'utf8')), 'no session was moved to the account')
  // Claude is back: the next request is a trial (/__probe skips the rest of the cooldown), it succeeds, and the
  // windows failover had sent to the account are on Claude again; the session pinned by hand stays
  claudeLimited = false
  assert.strictEqual((await control(r.port, '/__probe', {})).status, 200)
  assert.strictEqual(await from('w1'), 'claude')
  assert.strictEqual(await from('w2'), 'claude')
  assert.strictEqual(JSON.parse((await control(r.port, '/__health')).body).failoverSince, 0, 'failover is over')
  assert.strictEqual(await from('hand'), 'spare')
  assert.strictEqual(JSON.parse((await control(r.port, '/__health?sid=hand')).body).session, 'spare')
})

test('A6: a usage limit on the account is not retried; the next link gets the request without either token', async (t) => {
  const r = await relay(t, { anthropic: (q) => USAGE_LIMIT, retry: { attempts: 3, failover: false } })
  const x = await ask(r.port, { sid: 's1' })
  assert.strictEqual(x.status, 200, x.body)
  assert.strictEqual(JSON.parse(x.body).from, 'other')
  assert.strictEqual(byToken(r.a.seen, SECRET).length, 1, 'no retry on the account, though retry.attempts is 3 and retry.failover off')
  assert.strictEqual(r.o.seen.length, 1)
  assert.strictEqual(r.o.seen[0].headers.authorization, 'Bearer OTHER-KEY')
  noToken(r.o.seen[0], 'next link')
  assert.strictEqual(JSON.parse(r.o.seen[0].body).model, 'other-model')
  assert.match(fs.readFileSync(path.join(r.dir, 'model-relay.log'), 'utf8'), /provider "spare" hit its usage limit; not retried/)
})

test('A4: the account failing with 5xx hands over without either token; a non-Claude request never reaches it', async (t) => {
  await t.test('the account answers 503', async (t) => {
    const r = await relay(t, { anthropic: (q) => (q.headers.authorization === `Bearer ${SECRET}` ? [503, {}, '{}'] : USAGE_LIMIT), retry: { failover: true } })
    const x = await ask(r.port)
    assert.strictEqual(JSON.parse(x.body).from, 'other', x.body)
    assert.strictEqual(byToken(r.a.seen, SECRET).length, 2, 'one try and one retry, as for any provider')
    assert.strictEqual(r.o.seen.length, 1)
    noToken(r.o.seen[0], 'after the account')
  })
  await t.test('another provider fails a request for its own model', async (t) => {
    const r = await relay(t, { other: () => [503, {}, '{"from":"other"}'], chain: ['other', 'spare'], retry: { failover: true } })
    const x = await ask(r.port, { body: JSON.stringify({ model: 'other-model', messages: [] }) })
    assert.strictEqual(x.status, 503)
    assert.strictEqual(byToken(r.a.seen, SECRET).length, 0, 'an other-model body never goes to the account')
  })
  await t.test('another provider fails a Claude request it took over', async (t) => {
    const r = await relay(t, { anthropic: (q) => (q.headers.authorization === `Bearer ${SECRET}` ? OK('spare') : USAGE_LIMIT), other: () => [503, {}, '{}'], chain: ['other', 'spare'], retry: { failover: true } })
    const x = await ask(r.port)
    assert.strictEqual(JSON.parse(x.body).from, 'spare', x.body)
    assertAccountRequest(byToken(r.a.seen, SECRET)[0], 'after the other provider')
  })
})

test('A7: a missing or hanging keychain item is read once in the background; no request or /__health waits on it', async (t) => {
  const r = await relay(t, {
    items: { 'relay-test/hang': 'HANG', 'relay-test/late': 'LATE-TOKEN' },
    providers: { slow: { kind: 'anthropic', token: 'keychain:relay-test/hang', accountUuid: SPARE_UUID, ...IDS } },
  })
  const t0 = Date.now()
  // While the hanging read is out (5 s): /__health and a model request answer at once, the missing item is listed and
  // the one still being read is not
  for (let i = 0; i < 3; i++) {
    const t1 = Date.now()
    const h = JSON.parse((await control(r.port, '/__health')).body)
    const x = await ask(r.port, { sid: `s${i}` })
    assert.ok(Date.now() - t1 < 1000, `/__health and a model request answer at once (${Date.now() - t1} ms)`)
    assert.strictEqual(JSON.parse(x.body).from, 'claude')
    assert.deepStrictEqual(h.unresolved, [{ provider: 'spare', keychain: 'relay-test/spare' }])
    assert.deepStrictEqual(Object.keys(h.providers), ['other'])
  }
  assert.ok(Date.now() - t0 < 4000, 'all of it inside the 5 s the hanging read takes')
  // The hanging read gives up after 5 s; only then is that item reported
  while (Date.now() - t0 < 6500) await sleep(100)
  let h = JSON.parse((await control(r.port, '/__health')).body)
  assert.deepStrictEqual(h.unresolved, [{ provider: 'spare', keychain: 'relay-test/spare' }, { provider: 'slow', keychain: 'relay-test/hang' }])
  const names = () => r.calls().map((c) => c.args[2] + '/' + c.args[4]).sort()
  assert.deepStrictEqual(names(), ['relay-test/hang', 'relay-test/spare'], 'one read per item over every request, a failure included: nothing is read again on a timer')
  assert.ok(r.calls().every((c) => c.api === 'execFile' && c.timeout === 5000 && !c.shell), JSON.stringify(r.calls()))
  // The config changes (here: an item named after the start): the next config parse reads that item in the background and
  // reads the two failed ones again, and the new one is used without a restart
  const file = path.join(r.dir, 'model-relay.json')
  const cfg = JSON.parse(fs.readFileSync(file, 'utf8'))
  cfg.providers.late = { kind: 'anthropic', token: 'keychain:relay-test/late', accountUuid: SPARE_UUID, ...IDS }
  fs.writeFileSync(file, JSON.stringify(cfg))
  await ask(r.port)
  for (let i = 0; i < 100 && !(h = JSON.parse((await control(r.port, '/__health')).body)).providers.late; i++) await sleep(50)
  assert.strictEqual(h.providers.late, 'anthropic-account', 'the new item was read without a restart')
  assert.deepStrictEqual(names(), ['relay-test/hang', 'relay-test/hang', 'relay-test/late', 'relay-test/spare', 'relay-test/spare'], 'a changed config retries each failed item once')
  const log = fs.readFileSync(path.join(r.dir, 'model-relay.log'), 'utf8')
  assert.match(log, /keychain item relay-test\/hang could not be read \(no answer within 5s/)
  assert.match(log, /keychain item relay-test\/spare could not be read \(\/usr\/bin\/security exited 44 \(no such item\)\); providers using it are skipped, and it is read again when model-relay\.json changes or the router restarts/)
  assert.ok(!log.includes('LATE-TOKEN'))
})

test('the router never reads the keychain item of a Claude account it refuses', async (t) => {
  const r = await relay(t, { providers: { bad: { kind: 'anthropic', token: 'keychain:relay-test/bad', accountUuid: SPARE_UUID, ...IDS, model: 'claude-opus-5-5' } }, items: { 'relay-test/spare': SECRET, 'relay-test/bad': 'BAD-TOKEN' } })
  await ask(r.port)
  const h = JSON.parse((await control(r.port, '/__health')).body)
  assert.deepStrictEqual(Object.keys(h.providers).sort(), ['other', 'spare'])
  assert.deepStrictEqual(h.unresolved, [])
  assert.deepStrictEqual(r.calls().map((c) => c.args[2] + '/' + c.args[4]), ['relay-test/spare'], 'only the usable account was read')
})

test('a malformed keychain: reference, which may be a pasted secret, is never echoed', async (t) => {
  const pasted = `keychain:${tokenLike('oat01', 'FAKESECRET')}`
  const r = await relay(t, { providers: {
    odd: { kind: 'anthropic', token: pasted, accountUuid: SPARE_UUID, ...IDS },
    odd2: { baseUrl: 'http://127.0.0.1:9', token: pasted, model: 'odd-model' },
  } })
  const bodies = []
  await ask(r.port)
  for (let i = 0; i < 2; i++) bodies.push((await control(r.port, '/__health')).body)
  const h = JSON.parse(bodies[0])
  assert.deepStrictEqual(h.unresolved, [{ provider: 'odd', keychain: '(malformed)', malformed: true }, { provider: 'odd2', keychain: '(malformed)', malformed: true }])
  const env = { ...process.env, CLAUDE_CONFIG_DIR: r.dir, RELAY_TEST_KEYCHAIN_LOG: r.log, RELAY_TEST_KEYCHAIN_ITEMS: JSON.stringify({ 'relay-test/spare': SECRET }) }
  const run = (...args) => new Promise((resolve) => execFile(process.execPath, ['--require', r.stub, SETUP, ...args], { env }, (e, so, se) => resolve(`${so}${se}`)))
  const doc = await run('doctor')
  // (the CLI has no test-only claudeUrl override, so there the account is refused for its claudeUrl first)
  assert.match(doc, /provider odd2 is skipped: its keychain: reference is malformed; write it as keychain:<service>\/<account>/)
  const listed = await run('providers')
  assert.match(listed, /✗ odd2: not usable \(token keychain:\(malformed\) did not resolve/, 'labelled as a malformed reference, not "inline"')
  const outs = [doc, await run('doctor', '--json'), listed]
  const logs = fs.readdirSync(r.dir).filter((f) => /^model-relay.*\.(log|json)$/.test(f) && f !== 'model-relay.json').map((f) => fs.readFileSync(path.join(r.dir, f), 'utf8'))
  assert.ok(logs.length >= 2, 'the logs were written')
  for (const text of [...bodies, ...outs, ...logs, ...r.calls().map((c) => JSON.stringify(c))]) assert.ok(!text.includes('FAKESECRET'), text.slice(0, 300))
})

test('A9: /__ping tests every provider but the account', async (t) => {
  const r = await relay(t)
  for (const target of [undefined, 'spare']) {
    const p = await control(r.port, '/__ping', target ? { provider: target } : {})
    assert.strictEqual(p.status, 200, p.body)
    const j = JSON.parse(p.body)
    assert.strictEqual(j.ping.other.verdict, 'ok')
    assert.strictEqual(j.ping.spare, undefined)
  }
  assert.strictEqual(r.a.seen.length, 0, 'nothing reached Anthropic')
})

// ---------- the setup CLI: it checks an item exists, never reads it ----------

async function cli(t, { items = { 'relay-test/spare': SECRET }, cfg = {}, settings = { availableModels: [OPUS_ID] } } = {}) {
  const o = await upstream(t, () => OK('other'))
  const s = scratch(t, 'relay-acct-cli-')
  const port = await freePort() // nothing listens there: doctor finds the router offline, and never asks a real one
  const file = path.join(s.dir, 'model-relay.json')
  fs.writeFileSync(file, JSON.stringify({
    format: 2,
    port,
    accountFallback: { mode: 'rc-keep' },
    failover: { enabled: true, chain: ['spare', 'other'] },
    providers: {
      spare: { kind: 'anthropic', token: 'keychain:relay-test/spare', accountUuid: SPARE_UUID, ...IDS },
      other: { baseUrl: `http://127.0.0.1:${o.port}`, token: 'OTHER-KEY', model: 'other-model' },
    },
    ...cfg,
  }))
  fs.writeFileSync(path.join(s.dir, 'settings.json'), JSON.stringify(settings))
  const env = { ...process.env, CLAUDE_CONFIG_DIR: s.dir, RELAY_TEST_KEYCHAIN_LOG: s.log, RELAY_TEST_KEYCHAIN_ITEMS: JSON.stringify(items) }
  const run = (...args) => new Promise((resolve) => {
    fs.writeFileSync(s.log, '')
    execFile(process.execPath, ['--require', s.stub, SETUP, ...args], { cwd: s.dir, env }, (e, stdout, stderr) => {
      const calls = s.calls()
      resolve({ code: e ? e.code : 0, out: `${stdout}${stderr}`, stdout, reads: calls.filter((c) => c.args.includes('-w')).length, checks: calls.length })
    })
  })
  return { run, o, file }
}
const OPUS_ID = 'claude-opus-5-5'

test('A7, A8, A9, A12: doctor, providers and set never read the secret, and check each item at most once', async (t) => {
  const c = await cli(t)
  const doc = await c.run('doctor')
  assert.strictEqual(doc.code, 0, doc.out)
  assert.match(doc.out, /Providers: spare -> anthropic-account, other -> other-model/)
  assert.match(doc.out, /availableModels does not list other-model;/, 'availableModels is checked for the others only')
  assert.deepStrictEqual([doc.reads, doc.checks], [0, 1])

  const js = await c.run('doctor', '--json')
  assert.strictEqual(js.code, 0, js.out)
  const report = JSON.parse(js.stdout)
  assert.strictEqual(report.providers.spare, 'anthropic-account')
  assert.ok(!report.findings.some((f) => /anthropic-account|spare/.test(f.text)), JSON.stringify(report.findings))
  assert.deepStrictEqual([js.reads, js.checks], [0, 1])

  const ping = await c.run('doctor', '--ping')
  assert.strictEqual(ping.code, 0, ping.out)
  assert.match(ping.out, /- spare\s+\(anthropic-account\) -> not pinged \(anthropic account\)/)
  assert.match(ping.out, /✓ other\s+\(other-model\) -> answers/)
  assert.ok(c.o.seen.length >= 1)

  const list = await c.run('providers')
  assert.strictEqual(list.code, 0, list.out)
  assert.match(list.out, /● spare\s+anthropic-account {2}https:\/\/api\.anthropic\.com/)
  assert.match(list.out, /routes: \(a Claude account: only failover and \/provider\)\s+token: keychain:relay-test\/spare/)
  assert.match(list.out, /spare[^\n]*\n[^\n]*hands over to: the chain \(spare → other\) on a usage limit only \(retry\.failover is off\)/)
  assert.match(list.out, /other[^\n]*\n[^\n]*hands over to: off \(retry\.failover is off\)/, 'any other provider reads as before')
  assert.deepStrictEqual([list.reads, list.checks], [0, 1])

  const set = await c.run('set', 'failover.chain', 'other,spare')
  assert.strictEqual(set.code, 0, set.out)
  assert.deepStrictEqual([set.reads, set.checks], [0, 0])

  const alias = await c.run('alias', 'haiku', 'spare')
  assert.strictEqual(alias.code, 1)
  assert.match(alias.out, /is a Claude account \(kind "anthropic"\): it has no model of its own/)
  assert.strictEqual(alias.reads, 0)

  for (const x of [doc, js, ping, list, set, alias]) assert.ok(!x.out.includes(SECRET))
})

test('A13 and a missing item: doctor says why the account is skipped', async (t) => {
  const elsewhere = await cli(t, { cfg: { claudeUrl: 'https://proxy.example' } })
  const a = await elsewhere.run('doctor')
  assert.match(a.out, /provider spare is skipped: claudeUrl is https:\/\/proxy\.example, and kind "anthropic" sends its account token to https:\/\/api\.anthropic\.com only/)
  assert.match(a.out, /Providers: other -> other-model/)
  const refusedAlias = await elsewhere.run('alias', 'haiku', 'spare')
  assert.strictEqual(refusedAlias.code, 1)
  assert.match(refusedAlias.out, /is a Claude account \(kind "anthropic"\): it has no model of its own/)
  assert.ok(!refusedAlias.out.includes('--model'), 'no advice to give it a model')
  const listed = await elsewhere.run('providers')
  assert.match(listed.out, /✗ spare: skipped: claudeUrl is https:\/\/proxy\.example/)
  assert.ok(!/spare: not usable \(token/.test(listed.out), 'not blamed on its token')
  const off = await cli(t, { cfg: { failover: { enabled: false, chain: ['spare', 'other'] } } })
  assert.match((await off.run('providers')).out, /spare[^\n]*\n[^\n]*hands over to: off \(failover is off\)/)
  const bare = await cli(t, { cfg: { providers: { spare: { kind: 'anthropic', token: 'keychain: ', accountUuid: SPARE_UUID, ...IDS }, other: { baseUrl: 'http://127.0.0.1:9', token: 'k', model: 'other-model' } } } })
  const c = await bare.run('doctor')
  assert.match(c.out, /provider spare is skipped: its token "keychain:" names no item/)
  assert.strictEqual(c.checks, 0, 'nothing to look up')
  const missing = await cli(t, { items: {} })
  const b = await missing.run('doctor')
  assert.match(b.out, /provider spare is skipped: keychain item relay-test\/spare \(service\/account\) is not in the login keychain/)
  assert.deepStrictEqual([b.reads, b.checks], [0, 1])
})

// ---------- account-sync: the three values from that account's own .claude.json, and nothing else ----------

test('A5: account-sync copies accountUuid, deviceId and email and prints none of them, nor any other key', async (t) => {
  const s = scratch(t, 'relay-acct-sync-')
  const home = path.join(s.dir, 'home')
  const acctDir = path.join(home, '.claude-spare')
  fs.mkdirSync(acctDir, { recursive: true })
  const FAKE = tokenLike('oat01', 'FAKE-SECRET-5e6f')
  const login = {
    numStartups: 12,
    userID: SPARE_DEV,
    primaryApiKey: FAKE,
    oauthAccount: { accountUuid: SPARE_UUID.toUpperCase(), emailAddress: IDS.email, organizationUuid: '99999999-8888-4777-8666-555555555555', displayName: 'Spare Cat' },
    projects: { '/Users/x/secret-project': { allowedTools: [] } },
  }
  const writeLogin = (dir, j) => fs.writeFileSync(path.join(dir, '.claude.json'), typeof j === 'string' ? j : JSON.stringify(j))
  writeLogin(acctDir, login)
  writeLogin(s.dir, { userID: 'a'.repeat(64), oauthAccount: { accountUuid: MAIN_UUID, emailAddress: 'main@example.test' } })
  const file = path.join(s.dir, 'model-relay.json')
  const port = await freePort() // nothing listens there
  const write = (extra = {}) => fs.writeFileSync(file, JSON.stringify({ format: 2, port, accounts: { spare: { configDir: '~/.claude-spare' } }, providers: { other: { baseUrl: 'http://127.0.0.1:9', token: 'k', model: 'other-model' } }, ...extra }))
  write()
  const env = { ...process.env, HOME: home, USERPROFILE: home, CLAUDE_CONFIG_DIR: s.dir, RELAY_TEST_KEYCHAIN_LOG: s.log, RELAY_TEST_KEYCHAIN_ITEMS: '{}' }
  const run = (...args) => new Promise((resolve) => execFile(process.execPath, ['--require', s.stub, SETUP, ...args], { cwd: s.dir, env }, (e, so, se) => resolve({ code: e ? e.code : 0, out: `${so}${se}` })))
  const values = [SPARE_UUID, SPARE_UUID.toUpperCase(), SPARE_DEV, IDS.email, FAKE, 'Spare Cat', '99999999-8888', 'secret-project', MAIN_UUID]
  const otherKeys = ['numStartups', 'primaryApiKey', 'organizationUuid', 'displayName', 'projects']
  const clean = (x, why) => {
    for (const v of [...values, ...otherKeys]) assert.ok(!x.out.includes(v), `${why}: printed ${v}`)
  }

  const ok = await run('account-sync', 'spare')
  assert.strictEqual(ok.code, 0, ok.out)
  assert.match(ok.out, /providers\.spare: accountUuid, deviceId and email written from /)
  clean(ok, 'success')
  const spare = JSON.parse(fs.readFileSync(file, 'utf8')).providers.spare
  assert.deepStrictEqual(spare, { kind: 'anthropic', accountUuid: SPARE_UUID, deviceId: SPARE_DEV, email: IDS.email }, 'the three values and nothing else from the file')
  // a second run keeps what the entry already had (its token)
  const cfg = JSON.parse(fs.readFileSync(file, 'utf8'))
  cfg.providers.spare.token = 'keychain:relay-test/spare'
  fs.writeFileSync(file, JSON.stringify(cfg))
  assert.strictEqual((await run('account-sync', 'spare')).code, 0)
  assert.strictEqual(JSON.parse(fs.readFileSync(file, 'utf8')).providers.spare.token, 'keychain:relay-test/spare')

  // refused: the router's own config dir (by any spelling), the same account as yours, a file that is not JSON or lacks a value
  const link = path.join(s.dir, 'same-dir-link')
  fs.symlinkSync(s.dir, link)
  for (const dir of [s.dir, link]) {
    write({ accounts: { spare: { configDir: dir } } })
    const x = await run('account-sync', 'spare')
    assert.strictEqual(x.code, 1, x.out)
    assert.match(x.out, /this router's own config directory/)
  }
  write()
  writeLogin(s.dir, { oauthAccount: { accountUuid: SPARE_UUID } })
  const same = await run('account-sync', 'spare')
  assert.strictEqual(same.code, 1)
  assert.match(same.out, /logged in to your own account/)
  clean(same, 'same account')
  writeLogin(s.dir, { userID: SPARE_DEV, oauthAccount: { accountUuid: MAIN_UUID } })
  const sameDevice = await run('account-sync', 'spare')
  assert.strictEqual(sameDevice.code, 1)
  assert.match(sameDevice.out, /has the same userID as your own login/)
  clean(sameDevice, 'same userID')
  writeLogin(s.dir, { oauthAccount: { accountUuid: MAIN_UUID } })
  writeLogin(acctDir, `{"primaryApiKey": "${FAKE}", oops`)
  const broken = await run('account-sync', 'spare')
  assert.strictEqual(broken.code, 1)
  assert.match(broken.out, /\.claude-spare\/\.claude\.json could not be read as a JSON object\. Nothing was changed\./)
  clean(broken, 'parse error')
  writeLogin(acctDir, { ...login, userID: 'x' })
  const lacking = await run('account-sync', 'spare')
  assert.strictEqual(lacking.code, 1)
  assert.match(lacking.out, /has no usable userID \(64 hex digits\)/)
  clean(lacking, 'a missing value')
  writeLogin(acctDir, login)
  write({ providers: { spare: { baseUrl: 'http://127.0.0.1:9', token: 'k', model: 'm' } } })
  assert.match((await run('account-sync', 'spare')).out, /providers\.spare is not a Claude account/)
  write({ accounts: { constructor: {} } })
  assert.match((await run('account-sync', 'constructor')).out, /accounts\.constructor\.configDir is not set/)
  // accounts.<name> is found as providers.<name> is: trimmed and in any case
  write({ accounts: { ' Spare ': { configDir: '~/.claude-spare' } } })
  const cased = await run('account-sync', 'spare')
  assert.strictEqual(cased.code, 0, cased.out)
  assert.strictEqual(JSON.parse(fs.readFileSync(file, 'utf8')).providers.spare.deviceId, SPARE_DEV)
  assert.deepStrictEqual(s.calls(), [], 'no keychain access at all')
})

test('setup refuses a provider named switch', async (t) => {
  const c = await cli(t)
  for (const args of [['add', 'switch', '--model', 'm', '--token', 'k', '--url', 'http://127.0.0.1:9'], ['account-sync', 'switch']]) {
    const x = await c.run(...args)
    assert.strictEqual(x.code, 2, x.out)
    assert.match(x.out, /"switch" is the name of a \/provider command/)
  }
  assert.ok(!('switch' in JSON.parse(fs.readFileSync(c.file, 'utf8')).providers))
})

test('A1: the CLI in off reads no keychain item, and says why the account is not used; doctor flags a mode it does not know', async (t) => {
  for (const mode of ['off', 'rc_keep']) {
    const c = await cli(t, { cfg: { accountFallback: { mode } } })
    const list = await c.run('providers')
    assert.match(list.out, new RegExp(`- spare: a Claude account, not used: accountFallback.mode is "${mode}" \\(only rc-keep and api-only send with its token\\)`))
    const doc = await c.run('doctor')
    assert.match(doc.out, /Providers: other -> other-model\n/)
    assert.strictEqual(/accountFallback\.mode is not one of off, switch, rc-keep, api-only/.test(doc.out), mode === 'rc_keep', doc.out)
    assert.match(doc.out, new RegExp(`failover names spare, a Claude account that accountFallback.mode "${mode}" leaves unused`))
    assert.ok(!/failover names[^\n]*spare[^\n]*no such usable provider/.test(doc.out), 'not reported as an unknown name')
    for (const x of [list, doc]) assert.deepStrictEqual([x.reads, x.checks], [0, 0], 'the keychain was not asked')
  }
})

// ---------- handoff: what /provider switch leaves the launcher wrapper ----------

test('A3: handoff writes {sid} 0600 in a 0700 folder, exclusively and atomically; bad ids and a symlinked folder are refused', async (t) => {
  const s = scratch(t, 'relay-handoff-')
  // the config dir sits one level down, so a path that climbs out of it still lands inside the scratch dir
  const cfgDir = path.join(s.dir, 'cfg')
  fs.mkdirSync(cfgDir)
  const env = { ...process.env, CLAUDE_CONFIG_DIR: cfgDir, RELAY_TEST_KEYCHAIN_LOG: s.log, RELAY_TEST_KEYCHAIN_ITEMS: '{}' }
  const run = (...args) => new Promise((resolve) => execFile(process.execPath, ['--require', s.stub, SETUP, ...args], { cwd: s.dir, env }, (e, so, se) => resolve({ code: e ? e.code : 0, out: `${so}${se}` })))
  const ID = '0f1e2d3c-4b5a-4968-8776-5a4b3c2d1e0f'
  const SID = '22222222-3333-4444-8555-666666666666'
  const dir = path.join(cfgDir, 'model-relay-handoff')
  const file = path.join(dir, `${ID}.json`)
  fs.mkdirSync(dir, { mode: 0o755 }) // a folder already there, too open: tightened
  fs.chmodSync(dir, 0o755)
  const ok = await run('handoff', ID.toUpperCase(), SID)
  assert.strictEqual(ok.code, 0, ok.out)
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { sid: SID })
  if (process.platform !== 'win32') {
    assert.strictEqual(fs.statSync(dir).mode & 0o777, 0o700)
    assert.strictEqual(fs.statSync(file).mode & 0o777, 0o600)
  }
  // A second handoff replaces the file whole (a new inode), never writing into the old one, and leaves no temp file
  const ino = fs.statSync(file).ino
  const SID2 = '33333333-4444-4555-8666-777777777777'
  assert.strictEqual((await run('handoff', ID, SID2)).code, 0)
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { sid: SID2 })
  assert.notStrictEqual(fs.statSync(file).ino, ino)
  assert.deepStrictEqual(fs.readdirSync(dir), [`${ID}.json`])
  // a symlink where the file goes is replaced, not followed
  const outside = path.join(s.dir, 'outside.txt')
  fs.writeFileSync(outside, 'keep')
  fs.rmSync(file)
  fs.symlinkSync(outside, file)
  assert.strictEqual((await run('handoff', ID, SID)).code, 0)
  assert.strictEqual(fs.readFileSync(outside, 'utf8'), 'keep')
  assert.ok(!fs.lstatSync(file).isSymbolicLink())
  // ids that are no UUID never name a path
  for (const [id, sid] of [['../../x', SID], [ID, '--dangerously-skip-permissions'], [ID, '../x'], ['', SID]]) {
    const x = await run('handoff', id, sid)
    assert.strictEqual(x.code, 2, `${id} ${sid}`)
  }
  assert.ok(!fs.existsSync(path.join(s.dir, 'x.json')) && !fs.existsSync(path.join(cfgDir, 'x.json')), 'nothing written outside the folder')
  // a folder that is a symlink is refused, and nothing is written through it
  const s2 = scratch(t, 'relay-handoff-link-')
  const elsewhere = path.join(s2.dir, 'elsewhere')
  fs.mkdirSync(elsewhere)
  fs.rmSync(dir, { recursive: true })
  fs.symlinkSync(elsewhere, dir)
  const linked = await run('handoff', ID, SID)
  assert.strictEqual(linked.code, 1, linked.out)
  assert.match(linked.out, /is not a folder \(a symlink is refused\)\. Nothing was written\./)
  assert.deepStrictEqual(fs.readdirSync(elsewhere), [])
  assert.deepStrictEqual(s.calls(), [], 'no keychain access')
})

test('account-sync and add refuse the name __proto__ instead of reporting a write that never lands', async (t) => {
  const c = await cli(t)
  // a login that account-sync would accept, so only the name stands in the way
  const base = path.dirname(c.file)
  const acct = path.join(base, 'acct')
  fs.mkdirSync(acct)
  fs.writeFileSync(path.join(acct, '.claude.json'), JSON.stringify({ userID: SPARE_DEV, oauthAccount: { accountUuid: SPARE_UUID, emailAddress: IDS.email } }))
  fs.writeFileSync(path.join(base, '.claude.json'), JSON.stringify({ userID: 'a'.repeat(64), oauthAccount: { accountUuid: MAIN_UUID } }))
  const cfg = JSON.parse(fs.readFileSync(c.file, 'utf8'))
  fs.writeFileSync(c.file, JSON.stringify(cfg).replace('"providers":{', `"accounts":{"__proto__":{"configDir":${JSON.stringify(acct)}}},"providers":{`))
  const before = fs.readFileSync(c.file, 'utf8')
  for (const args of [['account-sync', '__proto__'], ['add', '__proto__', '--model', 'm', '--token', 'k', '--url', 'http://127.0.0.1:9']]) {
    const x = await c.run(...args)
    assert.strictEqual(x.code, 2, x.out)
    assert.match(x.out, /"__proto__" cannot be a name in model-relay\.json/)
    assert.ok(!x.out.includes('✓'))
  }
  assert.strictEqual(fs.readFileSync(c.file, 'utf8'), before, 'the file is untouched')
})

test('A3: /__health reports when Claude last answered its usage limit, with an empty chain too; failover state stays as it was', async (t) => {
  let answer = [429, { 'retry-after': '1' }, '{"type":"error","error":{"type":"rate_limit_error","message":"slow down"}}']
  const r = await relay(t, { chain: [], account: false, top: { accountFallback: { mode: 'switch', account: 'second' } }, anthropic: () => answer })
  const h0 = JSON.parse((await control(r.port, '/__health')).body)
  assert.strictEqual(h0.claudeLimitedAt, 0, 'nothing seen yet')
  assert.strictEqual(h0.config.cooldownMs, 600000)
  assert.strictEqual((await ask(r.port)).status, 429)
  assert.strictEqual(JSON.parse((await control(r.port, '/__health')).body).claudeLimitedAt, 0, 'a plain rate limit is not the usage limit')
  answer = USAGE_LIMIT
  const t0 = Date.now()
  const x = await ask(r.port)
  assert.strictEqual(x.status, 429, 'with nobody in the chain the 429 goes back as it came')
  const h = JSON.parse((await control(r.port, '/__health')).body)
  assert.ok(h.claudeLimitedAt >= t0 && h.claudeLimitedAt <= Date.now(), String(h.claudeLimitedAt))
  assert.strictEqual(h.failoverSince, 0, 'no failover state: the chain is empty')
  assert.ok(!fs.existsSync(path.join(r.dir, 'model-relay-state.json')) || !fs.readFileSync(path.join(r.dir, 'model-relay-state.json'), 'utf8').includes('claudeLimitedAt'), 'not saved')
})

// ---------- accounts.<name>.fallback: an account window goes on with another account at its usage limit ----------
// Mode switch. team-1's registered window sends with its own login (MAIN here); spare (kind "anthropic", the keychain
// stand-in holds its token) is team-1's fallback. team-1's .claude.json says whose limit a 429 is.

const W1 = '0a0b0c0d-1111-4222-8333-444444444444'
const W2 = '0e0f0a0b-5555-4666-8777-888888888888'
const uidS = (sid, account = MAIN_UUID) => JSON.stringify({ account_uuid: account, device_id: MAIN_DEV, session_id: sid })
const chainBody = (sid, account = MAIN_UUID) => reminderBody([REMINDER, 'hello'], uidS(sid, account))
// The body spare must get: its account_uuid, device_id and email, and the window's replacement session id
const onSpare = (body, sid, sid2) => body.replace(JSON.stringify(uidS(sid)), JSON.stringify(JSON.stringify({ account_uuid: SPARE_UUID, device_id: SPARE_DEV, session_id: sid2 }))).replace(MAIN_EMAIL, IDS.email)
const SPARE_LIMIT = [429, { 'anthropic-ratelimit-unified-status': 'rejected' }, '{"type":"error","error":{"type":"rate_limit_error","message":"usage limit reached (spare)"}}']
const FROM = (q) => (q.headers.authorization === `Bearer ${SECRET}` ? 'spare' : q.headers.authorization === 'Bearer THIRD-KEY' ? 'third' : 'claude')
const ORG = '0a000000-0000-4000-8000-000000000000' // the organization team-1 and spare share

// state: { limited } flips team-1's own answers to its usage limit; spare(q) answers for spare; fallback: null for none
async function chained(t, { spare = () => OK('spare'), fallback = 'spare', mode = 'switch', chain = ['other'], retry = {}, providers = {}, items, clock = false, team1 = { oauthAccount: { accountUuid: MAIN_UUID.toUpperCase(), organizationUuid: ORG } }, other, team1Answer } = {}) {
  const state = { limited: false }
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-chain-'))
  t.after(() => fs.rmSync(home, { recursive: true, force: true }))
  const d1 = path.join(home, 'team-1')
  const d2 = path.join(home, 'spare')
  for (const d of [d1, d2]) fs.mkdirSync(d)
  if (team1) fs.writeFileSync(path.join(d1, '.claude.json'), JSON.stringify(team1))
  fs.writeFileSync(path.join(d2, '.claude.json'), JSON.stringify({ oauthAccount: { accountUuid: SPARE_UUID, organizationUuid: ORG } }))
  const anthropic = (q) => {
    if (q.headers.authorization === `Bearer ${SECRET}`) return spare(q)
    if (q.headers.authorization === 'Bearer THIRD-KEY') return OK('third')
    if (team1Answer) return team1Answer(q)
    return state.limited && q.url.startsWith('/v1/messages') ? USAGE_LIMIT : OK('claude')
  }
  const r = await relay(t, { anthropic, other, chain, retry, providers, clock, ...(items ? { items } : {}), top: { accountFallback: { mode, account: 'spare' }, accounts: { 'team-1': { configDir: d1, ...(fallback === null ? {} : { fallback }) }, spare: { configDir: d2 } } } })
  const register = async (sid, account = 'team-1') => {
    const x = await control(r.port, '/__account', { sid, account })
    assert.strictEqual(x.status, 200, x.body)
    await sleep(5) // a pin made right after must come later than the registration
  }
  const health = async (sid = '') => JSON.parse((await control(r.port, `/__health?sid=${sid}`)).body)
  // spare's keychain item is read in the background: wait until a registered window sees spare
  const ready = async (sid) => {
    for (let i = 0; i < 100 && !(await health(sid)).providers.spare; i++) await sleep(50)
    assert.strictEqual((await health(sid)).providers.spare, 'anthropic-account', 'spare is loaded for the window')
  }
  const mainState = async () => {
    const h = await health()
    let sticky = {}
    try {
      sticky = JSON.parse(fs.readFileSync(path.join(r.dir, 'model-relay-state.json'), 'utf8')).sticky
    } catch {}
    return { failoverSince: h.failoverSince, nextClaudeTry: h.nextClaudeTry, claudeLimitedAt: h.claudeLimitedAt, sessionsOnCustom: h.sessionsOnCustom, sticky }
  }
  const file = path.join(r.dir, 'model-relay.json')
  const setCfg = (patch) => fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, 'utf8')), ...patch }))
  const routerLog = () => fs.readFileSync(path.join(r.dir, 'model-relay.log'), 'utf8')
  return { ...r, state, register, health, ready, mainState, setCfg, routerLog, d1 }
}
const sidOf = (q) => q.headers['x-claude-code-session-id']
const MAIN_STATE = { failoverSince: 0, nextClaudeTry: 0, claudeLimitedAt: 0, sessionsOnCustom: 0, sticky: {} }

test('fallback 1: team-1\'s usage limit resends the same request with spare\'s token, ids and a new session id; main\'s state untouched', async (t) => {
  const r = await chained(t)
  await r.register(W1)
  await r.ready(W1)
  r.state.limited = true
  const body = chainBody(W1)
  const x = await ask(r.port, { sid: W1, body })
  assert.strictEqual(x.status, 200, x.body)
  assert.strictEqual(JSON.parse(x.body).from, 'spare')
  assert.deepStrictEqual(r.a.seen.map((q) => q.headers.authorization), [`Bearer ${MAIN}`, `Bearer ${SECRET}`], 'team-1 once, then spare once')
  assert.strictEqual(r.a.seen[0].body.toString(), body, 'team-1 got the request as sent')
  const q = r.a.seen[1]
  const s2 = sidOf(q)
  assert.ok(L.UUID_RE.test(s2) && s2 !== W1, 'a replacement session id in the header')
  assert.strictEqual(q.body.toString(), onSpare(body, W1, s2), 'spare\'s account_uuid, device_id, email and the same replacement session id; every other byte as sent')
  // the upstream header set: the caller's names, the x-api-key dropped, anthropic-beta added; one authorization, spare's
  const names = (raw) => [...new Set(raw.filter((_, i) => i % 2 === 0).map((n) => n.toLowerCase()))].filter((n) => n !== 'connection').sort()
  assert.deepStrictEqual(names(q.raw), ['accept-encoding', 'anthropic-beta', 'anthropic-version', 'authorization', 'content-length', 'content-type', 'host', 'x-claude-code-session-id'])
  assert.strictEqual(count(q.raw, 'authorization'), 1)
  assert.strictEqual(count(q.raw, 'x-claude-code-session-id'), 1)
  assert.strictEqual(q.headers['anthropic-beta'], 'oauth-2025-04-20')
  assert.strictEqual(q.headers['accept-encoding'], 'gzip, br')
  assert.ok(!q.raw.join('\n').includes(MAIN) && !q.raw.join('\n').includes(W1), 'neither team-1\'s token nor its session id in the headers')
  assert.strictEqual(r.o.seen.length, 0, 'the chain was not asked')
  assert.deepStrictEqual(await r.mainState(), MAIN_STATE, 'failoverSince, nextClaudeTry, claudeLimitedAt and sticky as they were')
  const h = await r.health(W1)
  assert.deepStrictEqual([h.account, h.accountServing, h.session, h.kinds], ['team-1', 'spare', 'claude', { spare: 'anthropic' }])
  const log = r.routerLog()
  assert.match(log, /account team-1 hit its usage limit: its windows use spare for 10 min \(session 0a0b0c0d\)/)
  for (const v of [SECRET, MAIN, W1, s2, MAIN_UUID, SPARE_UUID]) assert.ok(!log.includes(v), `the log names no ${v.slice(0, 8)}…`)
  assert.ok(log.includes(s2.slice(0, 8)), 'the replacement id only in short form')
})

test('fallback 2: within the cooldown the window goes straight to spare; after it, team-1 is tried again', async (t) => {
  const r = await chained(t, { clock: true })
  await r.register(W1)
  await r.ready(W1)
  r.state.limited = true
  assert.strictEqual(JSON.parse((await ask(r.port, { sid: W1, body: chainBody(W1) })).body).from, 'spare')
  const s2 = sidOf(r.a.seen[1])
  for (let i = 0; i < 2; i++) assert.strictEqual(JSON.parse((await ask(r.port, { sid: W1, body: chainBody(W1) })).body).from, 'spare')
  assert.strictEqual(byToken(r.a.seen, MAIN).length, 1, 'team-1 was not asked again')
  assert.deepStrictEqual(byToken(r.a.seen, SECRET).map(sidOf), [s2, s2, s2], 'one replacement id for the window')
  // a count_tokens call (no metadata) goes there too, with the replacement id in its header
  await ask(r.port, { sid: W1, url: '/v1/messages/count_tokens', body: JSON.stringify({ model: OPUS_ID, messages: [] }) })
  assert.strictEqual(r.a.seen.at(-1).headers.authorization, `Bearer ${SECRET}`)
  assert.strictEqual(sidOf(r.a.seen.at(-1)), s2)
  r.state.limited = false
  r.advance(600001)
  const back = await ask(r.port, { sid: W1, body: chainBody(W1) })
  assert.strictEqual(JSON.parse(back.body).from, 'claude', 'team-1 again after failover.cooldownMs')
  assert.strictEqual(r.a.seen.at(-1).headers.authorization, `Bearer ${MAIN}`)
  assert.strictEqual(r.a.seen.at(-1).body.toString(), chainBody(W1))
  assert.strictEqual((await r.health(W1)).accountServing, undefined)
  assert.deepStrictEqual(await r.mainState(), MAIN_STATE)
})

test('fallback 3: spare\'s own usage limit goes back to the caller; nobody else is asked, with failover on', async (t) => {
  const r = await chained(t, { spare: () => SPARE_LIMIT, chain: ['other'], retry: { attempts: 3, failover: true } })
  await r.register(W1)
  await r.ready(W1)
  r.state.limited = true
  const x = await ask(r.port, { sid: W1, body: chainBody(W1) })
  assert.strictEqual(x.status, 429)
  assert.match(x.body, /usage limit reached \(spare\)/, 'spare\'s answer')
  assert.deepStrictEqual(r.a.seen.map((q) => q.headers.authorization), [`Bearer ${MAIN}`, `Bearer ${SECRET}`], 'no third attempt')
  assert.strictEqual(r.o.seen.length, 0, 'the chain was not consulted')
  assert.deepStrictEqual(await r.mainState(), MAIN_STATE)
})

test('fallback 4: a 429 that is no usage limit, or a 500, from team-1 goes back as it came; spare is not asked', async (t) => {
  let answer = [429, { 'retry-after': '1' }, '{"type":"error","error":{"type":"rate_limit_error","message":"slow down"}}']
  const r = await chained(t, { team1Answer: () => answer })
  await r.register(W1)
  await r.ready(W1)
  const slow = await ask(r.port, { sid: W1, body: chainBody(W1) })
  assert.deepStrictEqual([slow.status, slow.body], [429, answer[2]])
  answer = [500, {}, '{"type":"error","error":{"type":"api_error","message":"boom"}}']
  const boom = await ask(r.port, { sid: W1, body: chainBody(W1) })
  assert.deepStrictEqual([boom.status, boom.body], [500, answer[2]])
  assert.strictEqual(byToken(r.a.seen, SECRET).length, 0)
  assert.strictEqual((await r.health(W1)).accountServing, undefined, 'team-1 not counted as limited')
  assert.deepStrictEqual(await r.mainState(), MAIN_STATE)
})

test('fallback 5: with no fallback configured, team-1\'s usage limit comes back as at c1b1fef and spare\'s item is never read', async (t) => {
  const r = await chained(t, { fallback: null })
  await r.register(W1)
  r.state.limited = true
  const x = await ask(r.port, { sid: W1, body: chainBody(W1) })
  assert.deepStrictEqual([x.status, x.body], [429, USAGE_LIMIT[2]])
  assert.deepStrictEqual(r.a.seen.map((q) => q.headers.authorization), [`Bearer ${MAIN}`])
  const h = await r.health(W1)
  assert.deepStrictEqual([h.providers, h.kinds, h.accountServing], [{ other: 'other-model' }, {}, undefined])
  assert.deepStrictEqual(r.calls(), [], 'the keychain was never asked')
  assert.deepStrictEqual(await r.mainState(), MAIN_STATE)
})

test('fallback 6: mode off never reads the keychain with fallback set; in switch only the fallback account is read; main windows route as without it', async (t) => {
  const off = await chained(t, { mode: 'off', providers: { lone: { kind: 'anthropic', token: 'keychain:relay-test/lone', accountUuid: SPARE_UUID, ...IDS } } })
  off.state.limited = true
  await ask(off.port, { sid: 'm1' })
  await control(off.port, '/__health?sid=m1')
  assert.deepStrictEqual(off.calls(), [], 'off: no keychain read, fallback or not')
  // switch: lone is no account's fallback, so its item is never read; spare's is, once
  const sw = await chained(t, { providers: { lone: { kind: 'anthropic', token: 'keychain:relay-test/lone', accountUuid: SPARE_UUID, ...IDS } }, items: { 'relay-test/spare': SECRET, 'relay-test/lone': 'LONE-TOKEN' } })
  await sw.register(W1)
  await sw.ready(W1)
  assert.deepStrictEqual(sw.calls().map((c) => c.args[2] + '/' + c.args[4]), ['relay-test/spare'])
  // a main window: the same trace as the same config without any fallback
  const run = async (fallback) => {
    const r = await chained(t, { fallback })
    if (fallback) await r.ready((await r.register(W1), W1))
    const out = [await ask(r.port, { sid: 'm1' })]
    r.state.limited = true
    out.push(await ask(r.port, { sid: 'm2' })) // the usage limit: failover to other
    out.push(await ask(r.port, { sid: 'm3' })) // the cooldown
    const h = await r.health('m2')
    const mainOnly = r.a.seen.filter((q) => q.headers.authorization !== `Bearer ${SECRET}`)
    return { replies: out.map((x) => [x.status, x.body]), anthropic: mainOnly.map((q) => [q.url, q.headers.authorization, q.body.toString()]), other: r.o.seen.map((q) => [q.url, q.headers.authorization, q.body.toString()]), secret: byToken(r.a.seen, SECRET).length, health: [h.providers, h.kinds, h.failoverChain, h.session] }
  }
  const without = await run(null)
  const withIt = await run('spare')
  assert.deepStrictEqual(withIt, without)
  assert.strictEqual(withIt.secret, 0)
})

test('fallback 7: a body the splice refuses on spare gets a 502; nothing goes out with spare\'s token and nothing is resent on team-1', async (t) => {
  const r = await chained(t, { chain: ['other'], retry: { failover: true } })
  await r.register(W1)
  await r.ready(W1)
  r.state.limited = true
  const bad = reminderBody(['<system-reminder>\nnothing here\n</system-reminder>', sentence(MAIN_EMAIL)], uidS(W1))
  const x = await ask(r.port, { sid: W1, body: bad })
  assert.strictEqual(x.status, 502, x.body)
  assert.match(JSON.parse(x.body).error.message, /^model-relay router: account "spare" could not serve this request: /)
  assert.ok(!x.body.includes(MAIN_EMAIL))
  assert.deepStrictEqual(r.a.seen.map((q) => q.headers.authorization), [`Bearer ${MAIN}`], 'team-1 once, the original try; spare never')
  assert.strictEqual(r.o.seen.length, 0, 'not handed to the chain')
})

test('fallback 8: the protected routing functions are byte-identical to 96fa186', () => {
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

test('fallback 9: a main window never reaches spare: not through the chain, a pin, /__health or a stale pin; doctor names it', async (t) => {
  const r = await chained(t, { chain: ['spare', 'other'] })
  await r.register(W1)
  await r.ready(W1)
  r.state.limited = true
  const x = await ask(r.port, { sid: 'main-1' })
  assert.strictEqual(JSON.parse(x.body).from, 'other', 'the chain skips spare')
  assert.strictEqual(byToken(r.a.seen, SECRET).length, 0)
  const pin = await control(r.port, '/__session', { sid: 'main-1', on: 'spare' })
  assert.strictEqual(pin.status, 400)
  assert.match(JSON.parse(pin.body).error.message, /provider "spare" is the fallback of another account's windows; this session cannot use it \(configured: other\)/)
  const unknown = await control(r.port, '/__session', { sid: 'main-1', on: 'nobody' })
  assert.match(JSON.parse(unknown.body).error.message, /\(configured: other\)$/, 'spare is not offered')
  const h = await r.health('main-1')
  assert.deepStrictEqual([h.providers, h.kinds, h.failoverChain, h.failoverProvider], [{ other: 'other-model' }, {}, ['other'], 'other'])
  assert.ok(!('spare' in h.stats))
  // a pin made in rc-keep, before the mode became switch, does not take a main window there
  const rc = await chained(t, { mode: 'rc-keep' })
  assert.strictEqual((await control(rc.port, '/__session', { sid: 'main-2', on: 'spare' })).status, 200)
  assert.strictEqual(JSON.parse((await ask(rc.port, { sid: 'main-2' })).body).from, 'spare', 'rc-keep: the pin holds')
  rc.setCfg({ accountFallback: { mode: 'switch', account: 'spare' } })
  const after = await ask(rc.port, { sid: 'main-2' })
  assert.strictEqual(JSON.parse(after.body).from, 'claude')
  assert.strictEqual(rc.a.seen.at(-1).headers.authorization, `Bearer ${MAIN}`)
  assert.strictEqual(rc.a.seen.at(-1).body.toString(), bodyFor('main-2'), 'as sent, to Claude')
  assert.strictEqual(byToken(rc.a.seen, SECRET).length, 1, 'only the request made in rc-keep')
  const h2 = await rc.health('main-2')
  assert.deepStrictEqual([h2.session, h2.providers.spare], ['claude', undefined])
  // doctor (claudeUrl is Anthropic there): the chain names an account that only team-1's windows use
  const c = await cli(t, { cfg: { accountFallback: { mode: 'switch', account: 'spare' }, accounts: { 'team-1': { configDir: '/nowhere-1', fallback: 'spare' }, spare: { configDir: '/nowhere-2' } } } })
  const doc = await c.run('doctor')
  assert.match(doc.out, /failover names spare, the fallback account of team-1's windows \(accounts\.<name>\.fallback\); your failover skips it/)
  assert.match(doc.out, /Failover: other /, 'the chain doctor shows has no spare')
  assert.ok(!doc.out.includes(SECRET))
  assert.deepStrictEqual([doc.reads, doc.checks], [0, 1], 'the item is only checked for, never read')
})

test('fallback 9b: a main window whose provider lists spare as its own fallback never reaches it', async (t) => {
  const third = { baseUrl: 'http://127.0.0.1:1', token: 'THIRD-KEY', model: 'third-model' }
  const run = async (fallback) => {
    const r = await chained(t, { other: () => [500, {}, '{"from":"other-500"}'], retry: { attempts: 1, failover: true }, chain: [], providers: {} })
    // other's own fallback list, and a third provider on the Anthropic stand-in
    const cfg = JSON.parse(fs.readFileSync(path.join(r.dir, 'model-relay.json'), 'utf8'))
    r.setCfg({ providers: { ...cfg.providers, other: { ...cfg.providers.other, fallback }, third: { ...third, baseUrl: `http://127.0.0.1:${r.a.port}` } } })
    await r.register(W1)
    await r.ready(W1)
    const x = await ask(r.port, { sid: 'main-1', body: JSON.stringify({ model: 'other-model', messages: [] }) })
    // a Claude-model request on a main window pinned to other: the kind of request an account could take over
    assert.strictEqual((await control(r.port, '/__session', { sid: 'main-2', on: 'other' })).status, 200)
    const y = await ask(r.port, { sid: 'main-2' })
    return { r, x, y }
  }
  const alone = await run(['spare'])
  for (const x of [alone.x, alone.y]) assert.deepStrictEqual([x.status, x.body], [500, '{"from":"other-500"}'], 'nobody left: the caller gets other\'s error')
  assert.strictEqual(alone.r.o.seen.length, 4, 'other tried and retried, twice')
  assert.strictEqual(byToken(alone.r.a.seen, SECRET).length, 0)
  const next = await run(['spare', 'third'])
  for (const x of [next.x, next.y]) assert.strictEqual(JSON.parse(x.body).from, 'third', 'the next in its list')
  assert.strictEqual(byToken(next.r.a.seen, SECRET).length, 0)
})

test('fallback 10: spare answering 529 then its usage limit: retried once, then the 429 to the caller; the chain and team-1 get nothing more', async (t) => {
  let n = 0
  const r = await chained(t, { spare: () => (n++ === 0 ? [529, {}, '{"type":"error","error":{"type":"overloaded_error"}}'] : SPARE_LIMIT), chain: ['other'], retry: { attempts: 1, failover: true } })
  await r.register(W1)
  await r.ready(W1)
  r.state.limited = true
  const x = await ask(r.port, { sid: W1, body: chainBody(W1) })
  assert.strictEqual(x.status, 429)
  assert.match(x.body, /usage limit reached \(spare\)/)
  assert.strictEqual(byToken(r.a.seen, SECRET).length, 2, 'one try and one retry for the 529, none for the usage limit')
  assert.strictEqual(byToken(r.a.seen, MAIN).length, 1, 'team-1 not asked again')
  assert.strictEqual(r.o.seen.length, 0)
  const ids = byToken(r.a.seen, SECRET).map(sidOf)
  assert.strictEqual(ids[0], ids[1], 'the retry carries the same replacement id')
})

test('fallback 12: rc-keep with no fallback anywhere: a pin by hand from any session and the cooldown reach the account, as before', async (t) => {
  let limited = false
  const r = await relay(t, { anthropic: (q) => (q.headers.authorization === `Bearer ${MAIN}` && limited ? USAGE_LIMIT : byAccount(q)) })
  const pin = await control(r.port, '/__session', { sid: 'any', on: 'spare' })
  assert.strictEqual(pin.status, 200, pin.body)
  assert.strictEqual(JSON.parse((await ask(r.port, { sid: 'any' })).body).from, 'spare')
  limited = true
  assert.strictEqual(JSON.parse((await ask(r.port, { sid: 'w1' })).body).from, 'spare', 'the failover')
  assert.strictEqual(JSON.parse((await ask(r.port, { sid: 'w2' })).body).from, 'spare', 'a cooldown request')
  // rc-keep too gives each window a session id of its own on the account (one per window, never the window's)
  const onSpareReqs = byToken(r.a.seen, SECRET)
  assert.strictEqual(onSpareReqs.length, 3)
  for (const [i, q] of onSpareReqs.entries()) assertAccountRequest(q, `request ${i + 1} on the account`, ['any', 'w1', 'w2'][i])
  assert.strictEqual(new Set(onSpareReqs.map(sidOf)).size, 3, 'a different id for each window')
  const h = JSON.parse((await control(r.port, '/__health?sid=w1')).body)
  assert.deepStrictEqual([h.providers.spare, h.kinds], ['anthropic-account', { spare: 'anthropic' }], 'listed for every session')
})

test('chain limit: a chain account that answered its own usage limit is not asked again until its cooldown ends; the next link takes the requests meanwhile', async (t) => {
  let mainLimited = true
  const r = await relay(t, { clock: true, anthropic: (q) => (q.headers.authorization === `Bearer ${SECRET}` ? SPARE_LIMIT : mainLimited && q.url.startsWith('/v1/messages') ? USAGE_LIMIT : OK('claude')) })
  const from = (x) => JSON.parse(x.body).from
  // main hits its limit: failover starts at spare (the chain's first link), which answers its own limit; other takes the request
  assert.strictEqual(from(await ask(r.port, { sid: 'w1' })), 'other')
  assert.strictEqual(byToken(r.a.seen, SECRET).length, 1, 'spare asked once')
  // inside main's cooldown, other windows, a pin by hand on spare and a count_tokens call: spare is out
  assert.strictEqual(from(await ask(r.port, { sid: 'w2' })), 'other')
  assert.strictEqual(from(await ask(r.port, { sid: 'w3' })), 'other')
  assert.strictEqual((await control(r.port, '/__session', { sid: 'w4', on: 'spare' })).status, 200)
  assert.strictEqual(from(await ask(r.port, { sid: 'w4' })), 'other', 'a pin on a limited account moves on, as it did after the 429')
  assert.strictEqual(byToken(r.a.seen, SECRET).length, 1, 'spare was not asked again')
  assert.strictEqual(byToken(r.a.seen, MAIN).length, 1, 'nor was Claude, within its own cooldown')
  assert.match(fs.readFileSync(path.join(r.dir, 'model-relay.log'), 'utf8'), /provider "spare" is at its usage limit until its cooldown ends; "other" takes this request/)
  // a request that is not a model call is no business of the account's limit
  assert.strictEqual(from(await ask(r.port, { sid: 'w2', method: 'GET', url: '/v1/models' })), 'claude')
  // after failover.cooldownMs spare is asked again (and says its limit again: the next link takes it)
  r.advance(600001)
  assert.strictEqual(from(await ask(r.port, { sid: 'w5' })), 'other')
  assert.strictEqual(byToken(r.a.seen, SECRET).length, 2, 'asked again after its cooldown')
  // with no other link it is asked each time
  const solo = await relay(t, { chain: ['spare'], anthropic: (q) => (q.headers.authorization === `Bearer ${SECRET}` ? SPARE_LIMIT : USAGE_LIMIT) })
  assert.strictEqual((await ask(solo.port, { sid: 'a' })).status, 429)
  assert.strictEqual((await ask(solo.port, { sid: 'b' })).status, 429)
  assert.strictEqual(byToken(solo.a.seen, SECRET).length, 2)
})

test('fallback 13: an account window\'s model-matched provider failing after its retries goes to the next chain provider, with or without a fallback', async (t) => {
  for (const fallback of [null, 'spare']) {
    const r = await chained(t, { fallback, other: () => [500, {}, '{}'], retry: { attempts: 1, failover: true }, chain: ['other', 'third'], providers: { third: { baseUrl: 'http://127.0.0.1:1', token: 'THIRD-KEY', model: 'third-model' } } })
    const cfg = JSON.parse(fs.readFileSync(path.join(r.dir, 'model-relay.json'), 'utf8'))
    r.setCfg({ providers: { ...cfg.providers, third: { ...cfg.providers.third, baseUrl: `http://127.0.0.1:${r.a.port}` } } })
    await r.register(W1)
    if (fallback) await r.ready(W1)
    const x = await ask(r.port, { sid: W1, body: JSON.stringify({ model: 'other-model', messages: [] }) })
    assert.strictEqual(JSON.parse(x.body).from, 'third', String(fallback))
    assert.strictEqual(r.o.seen.length, 2, `${fallback}: other tried and retried`)
    assert.strictEqual(byToken(r.a.seen, SECRET).length, 0, `${fallback}: spare is no link of the chain`)
  }
})

test('fallback 14: a usage limit for a body that is not team-1\'s own, or with team-1\'s .claude.json unreadable, comes back; team-1 is not marked limited', async (t) => {
  const r = await chained(t)
  await r.register(W1)
  await r.ready(W1)
  r.state.limited = true
  const foreign = await ask(r.port, { sid: W1, body: chainBody(W1, SPARE_UUID) })
  assert.deepStrictEqual([foreign.status, foreign.body], [429, USAGE_LIMIT[2]])
  const noMeta = await ask(r.port, { sid: W1, body: JSON.stringify({ model: OPUS_ID, messages: [] }) })
  assert.strictEqual(noMeta.status, 429, 'no account_uuid at all')
  assert.strictEqual(byToken(r.a.seen, SECRET).length, 0)
  assert.strictEqual((await r.health(W1)).accountServing, undefined)
  assert.match(r.routerLog(), /account team-1: a usage limit for a request that is not that account's own \(or its \.claude\.json could not be read\); passed back, spare not used/)
  fs.writeFileSync(path.join(r.d1, '.claude.json'), '{"oauthAccount": oops')
  const unreadable = await ask(r.port, { sid: W1, body: chainBody(W1) })
  assert.deepStrictEqual([unreadable.status, unreadable.body], [429, USAGE_LIMIT[2]])
  fs.rmSync(path.join(r.d1, '.claude.json'))
  assert.strictEqual((await ask(r.port, { sid: W1, body: chainBody(W1) })).status, 429, 'missing')
  assert.strictEqual(byToken(r.a.seen, SECRET).length, 0)
  assert.strictEqual((await r.health(W1)).accountServing, undefined)
  // and once it says team-1 again, the same body falls back
  fs.writeFileSync(path.join(r.d1, '.claude.json'), JSON.stringify({ oauthAccount: { accountUuid: MAIN_UUID, organizationUuid: ORG } }))
  assert.strictEqual(JSON.parse((await ask(r.port, { sid: W1, body: chainBody(W1) })).body).from, 'spare')
})

test('fallback 15: on spare a window carries one replacement session id, its own; a body whose session_id is not the window\'s is refused', async (t) => {
  const r = await chained(t)
  await r.register(W1)
  await r.register(W2)
  await r.ready(W1)
  // W1 by the fallback, W2 by a pin by hand
  r.state.limited = true
  await ask(r.port, { sid: W1, body: chainBody(W1) })
  await ask(r.port, { sid: W1, body: chainBody(W1) })
  r.state.limited = false
  assert.strictEqual((await control(r.port, '/__session', { sid: W2, on: 'spare' })).status, 200)
  assert.strictEqual((await r.health(W2)).session, 'spare')
  await ask(r.port, { sid: W2, body: chainBody(W2) })
  await ask(r.port, { sid: W2, body: chainBody(W2) })
  const onSpareReqs = byToken(r.a.seen, SECRET)
  assert.strictEqual(onSpareReqs.length, 4)
  const inBody = (q) => JSON.parse(JSON.parse(q.body.toString()).metadata.user_id).session_id
  const [a1, a2, b1, b2] = onSpareReqs.map((q) => [sidOf(q), inBody(q)])
  for (const [h, b] of [a1, a2, b1, b2]) assert.ok(L.UUID_RE.test(h) && h === b, 'the same id in the header and in metadata')
  assert.strictEqual(a1[0], a2[0], 'one id for W1')
  assert.strictEqual(b1[0], b2[0], 'one id for W2')
  assert.ok(![W1, W2, b1[0]].includes(a1[0]) && ![W1, W2].includes(b1[0]), 'neither window\'s own id, and not each other\'s')
  assert.strictEqual(onSpareReqs[2].body.toString(), onSpare(chainBody(W2), W2, b1[0]))
  // a body whose metadata session_id is not the header's sid
  const seen = r.a.seen.length
  const x = await ask(r.port, { sid: W2, body: chainBody(W1) })
  assert.strictEqual(x.status, 502, x.body)
  assert.match(JSON.parse(x.body).error.message, /account "spare" could not serve this request: metadata\.user_id\.session_id is not this window's session id/)
  assert.ok(!x.body.includes(W1) && !x.body.includes(b1[0]))
  assert.strictEqual(r.a.seen.length, seen, 'nothing sent, with either token')
  // the health and status of W2 keep its own sid; the replacement id is in no reply
  assert.ok(!JSON.stringify(await r.health(W2)).includes(b1[0]))
})

test('fallback F5 and F6: no model name, "[1m]" included, picks an account; fallback names are normalised and checked', () => {
  const raw = (extra = {}) => ({
    format: 2,
    accountFallback: { mode: 'switch', account: 'spare' },
    accounts: { 'team-1': { configDir: '/a', fallback: ' Spare ' }, spare: { configDir: '/b' }, self: { configDir: '/c', fallback: 'self' }, ghost: { configDir: '/d', fallback: 'nobody' }, odd: { configDir: '/e', fallback: '../x' }, plain: { configDir: '/f', fallback: 'other' } },
    providers: { spare: { kind: 'anthropic', token: 'keychain:s/a', accountUuid: SPARE_UUID, ...IDS }, other: { baseUrl: 'http://127.0.0.1:9', token: 'k', model: 'other-model' } },
    ...extra,
  })
  const any = { keychain: () => 'T', anyClaudeUrl: true }
  assert.deepStrictEqual([...L.fallbackLists(raw(), true)].map(([a, l]) => [a, l.map((x) => x.name)]), [['team-1', ['spare']]])
  const why = L.fallbackProblems(raw({ claudeUrl: undefined })).map((p) => p.why)
  assert.deepStrictEqual(why, [
    'accounts.self.fallback names the account itself',
    'accounts.ghost.fallback names no account in accounts (with a configDir)',
    'accounts.odd.fallback is not the name of an account',
    'accounts.plain.fallback names no account in accounts (with a configDir)',
  ])
  const cfg = L.parseCfg(raw({ failover: { chain: ['spare', 'other'] } }), {}, any)
  assert.strictEqual(cfg.providers.spare.fallbackOnly, true)
  assert.deepStrictEqual(cfg.failoverChain, ['other'])
  for (const m of ['[1m]', '', 'anthropic-account', 'claude-opus-5-5[1m]']) assert.strictEqual(L.matchProviderByModel(cfg, m), null, m)
  const rc = L.parseCfg(raw({ accountFallback: { mode: 'rc-keep' } }), {}, any)
  assert.strictEqual(rc.providers.spare.fallbackOnly, undefined, 'rc-keep: an ordinary account, as before')
  assert.strictEqual(L.matchProviderByModel(rc, '[1m]'), null, 'F5 holds in rc-keep too')
  for (const mode of ['off', 'rc-keep', 'api-only']) assert.strictEqual(L.fallbackLists(raw({ accountFallback: { mode } }), true).size, 0, mode)
  // B with a bad shape: not a target, and its token is never resolved
  let asked = 0
  const bad = raw({ providers: { spare: { kind: 'anthropic', token: 'keychain:s/a', accountUuid: 'nope', ...IDS } } })
  assert.strictEqual(L.parseCfg(bad, {}, { keychain: () => { asked++; return 'T' }, anyClaudeUrl: true }), null)
  assert.deepStrictEqual(L.unresolvedEnv(bad, {}, () => { asked++; return null }, true), [])
  assert.strictEqual(asked, 0)
  assert.match(L.fallbackProblems(bad).find((p) => p.account === 'team-1').why, /^accounts\.team-1\.fallback names spare, whose providers entry is skipped: accountUuid must be/)
})

test('fallback 9 (setup CLI): providers and doctor read accounts.<name>.fallback as the router does, and print names only', async (t) => {
  // team-1's and spare's logins, in one organization, so the clean case below is clean for the org rule too
  const logins = scratch(t, 'relay-acct-logins-').dir
  for (const [d, uuid] of [['team-1', MAIN_UUID], ['spare', SPARE_UUID]]) {
    fs.mkdirSync(path.join(logins, d))
    fs.writeFileSync(path.join(logins, d, '.claude.json'), JSON.stringify({ oauthAccount: { accountUuid: uuid, organizationUuid: ORG } }))
  }
  const accounts = (fallback) => ({ accountFallback: { mode: 'switch', account: 'spare' }, accounts: { 'team-1': { configDir: path.join(logins, 'team-1'), fallback }, spare: { configDir: path.join(logins, 'spare') } }, failover: { enabled: true, chain: ['other'] } })
  const c = await cli(t, { cfg: accounts('spare') })
  const list = await c.run('providers')
  assert.match(list.out, /● spare\s+anthropic-account/)
  assert.match(list.out, /routes: \(a Claude account: only the windows of team-1, at its usage limit or by \/provider\)\s+token: keychain:relay-test\/spare[^\n]*hands over to: nobody \(it answers for team-1 or returns its error\)/)
  assert.deepStrictEqual([list.reads, list.checks], [0, 1])
  const clean = await c.run('doctor')
  assert.ok(!/accounts\.team-1\.fallback|fallback account of/.test(clean.out), clean.out)
  // a fallback that names nothing usable: doctor says why, and the router's keychain item is never looked up
  for (const [fallback, why] of [['ghost', /accounts\.team-1\.fallback names no account in accounts \(with a configDir\); that account's windows get its usage-limit 429 as it comes/], ['team-1', /accounts\.team-1\.fallback names the account itself/], [tokenLike('oat01', 'PASTED'), /accounts\.team-1\.fallback names no account in accounts/], ['../x', /accounts\.team-1\.fallback is not the name of an account/]]) {
    const x = await cli(t, { cfg: accounts(fallback) })
    const doc = await x.run('doctor')
    assert.match(doc.out, why)
    assert.ok(!doc.out.toLowerCase().includes('pasted') && !doc.out.includes('../x'), 'a value that names no account is never echoed')
    assert.deepStrictEqual([doc.reads, doc.checks], [0, 0], `${fallback}: spare is no fallback, so its item is not looked up`)
  }
  // the item missing: named like any provider's
  const missing = await cli(t, { cfg: accounts('spare'), items: {} })
  assert.match((await missing.run('doctor')).out, /provider spare is skipped: keychain item relay-test\/spare \(service\/account\) is not in the login keychain/)
})

// ---------- RELAY-ACCT-LIST: accounts.<name>.fallback as an ordered list, the relay's own account, the org rule ----------
// More Claude accounts on the Anthropic stand-in, each told apart by its token: kind "anthropic" providers whose tokens
// the keychain stand-in holds. A registered window of team-1 sends as MAIN (its own login); with home: true the relay dir
// is <home>/.claude and "own" (configDir ~/.claude) is the relay's own account, whose windows are main's windows.

const ACCTS = {
  'team-1': { token: 'TEAM1-TOKEN-4a0b', uuid: '1a1a1a1a-aaaa-4bbb-8ccc-111111111111', dev: '1'.repeat(64) },
  'team-2': { token: 'TEAM2-TOKEN-5b1c', uuid: '2b2b2b2b-aaaa-4bbb-8ccc-222222222222', dev: '2'.repeat(64) },
  'team-3': { token: 'TEAM3-TOKEN-6c2d', uuid: '3c3c3c3c-aaaa-4bbb-8ccc-333333333333', dev: '3'.repeat(64) },
  'other-org': { token: 'OTHER-ORG-TOKEN-7d3e', uuid: '4d4d4d4d-aaaa-4bbb-8ccc-444444444444', dev: '4'.repeat(64) },
}
const ORG2 = '0b000000-0000-4000-8000-000000000000' // another organization
const M1 = 'c1c1c1c1-1111-4222-8333-444444444444'
const M2 = 'c2c2c2c2-1111-4222-8333-444444444444'
const M3 = 'c3c3c3c3-1111-4222-8333-444444444444'
const emailOf = (n) => `${n}@example.test`
const acctEntry = (n) => ({ kind: 'anthropic', token: `keychain:relay-test/${n}`, accountUuid: ACCTS[n].uuid, deviceId: ACCTS[n].dev, email: emailOf(n) })
const who = (q) => (q.headers.authorization === `Bearer ${MAIN}` ? 'main' : Object.keys(ACCTS).find((n) => q.headers.authorization === `Bearer ${ACCTS[n].token}`) || '?')
const limitOf = (w) => [429, { 'anthropic-ratelimit-unified-status': 'rejected' }, JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message: `usage limit reached (${w})` } })]
// The body account n gets for a window whose own body is chainBody(sid): its ids and email, and that window's S' there
const onAcct = (n, body, sid, sid2) => body.replace(JSON.stringify(uidS(sid)), JSON.stringify(JSON.stringify({ account_uuid: ACCTS[n].uuid, device_id: ACCTS[n].dev, session_id: sid2 }))).replace(MAIN_EMAIL, emailOf(n))
const SECRETS = [MAIN, ...Object.values(ACCTS).map((a) => a.token)]
const UUIDS = [MAIN_UUID, ORG, ORG2, ...Object.values(ACCTS).map((a) => a.uuid)]
const namesOf = (v) => (Array.isArray(v) ? v : v === undefined ? [] : [v]).map((x) => (typeof x === 'string' ? x : x && x.account))

// accounts: name -> its accounts entry without configDir. Every account gets a dir (own: ~/.claude) and a login in ORG
// with its own uuid (team-1 and own: MAIN_UUID, the window's own), unless logins says otherwise (null: none).
// limited: whose answers are their usage limit now ("main" for MAIN, else an account name).
async function listed(t, { accounts, logins = {}, home = false, chain = ['other'], retry = {}, clock = false, dirArg = true, env = {} } = {}) {
  const limited = new Set()
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-list-'))
  t.after(() => fs.rmSync(base, { recursive: true, force: true }))
  const dirs = {}
  for (const n of Object.keys(accounts)) {
    dirs[n] = n === 'own' ? '~/.claude' : path.join(base, n)
    if (n !== 'own') fs.mkdirSync(dirs[n])
  }
  const anthropic = (q) => (limited.has(who(q)) && q.url.startsWith('/v1/messages') ? limitOf(who(q)) : OK(who(q)))
  const items = Object.fromEntries(Object.keys(ACCTS).map((n) => [`relay-test/${n}`, ACCTS[n].token]))
  const cfgAccounts = Object.fromEntries(Object.entries(accounts).map(([n, e]) => [n, { configDir: dirs[n], ...e }]))
  const r = await relay(t, { anthropic, chain, retry, clock, home, dirArg, env, account: false, items, providers: Object.fromEntries(Object.keys(ACCTS).map((n) => [n, acctEntry(n)])), top: { accountFallback: { mode: 'switch', account: 'team-1' }, accounts: cfgAccounts } })
  const loginOf = (n) => (n === 'own' ? path.join(r.home, '.claude.json') : path.join(dirs[n], '.claude.json'))
  const writeLogin = (n, v) => {
    if (v === null) fs.rmSync(loginOf(n), { force: true })
    else fs.writeFileSync(loginOf(n), typeof v === 'string' ? v : JSON.stringify({ oauthAccount: v }))
  }
  const own = (n) => ({ accountUuid: n === 'team-1' || n === 'own' ? MAIN_UUID : ACCTS[n].uuid, organizationUuid: ORG })
  for (const n of Object.keys(accounts)) if (n !== 'own' || home) writeLogin(n, n in logins ? logins[n] : own(n))
  // the keychain stand-in answers in the background: wait until every listed account's item has landed
  const want = new Set(Object.values(accounts).flatMap((e) => namesOf(e.fallback)).filter((n) => n in ACCTS))
  for (let i = 0; i < 100 && ![...want].every((n) => r.calls().some((c) => c.args[4] === n)); i++) await sleep(20)
  await sleep(100)
  const file = path.join(r.dir, 'model-relay.json')
  const setAccounts = (patch) => {
    const cfg = JSON.parse(fs.readFileSync(file, 'utf8'))
    for (const [n, e] of Object.entries(patch)) cfg.accounts[n] = { configDir: dirs[n], ...e }
    fs.writeFileSync(file, JSON.stringify(cfg))
  }
  const register = async (sid, account = 'team-1') => {
    const x = await control(r.port, '/__account', { sid, account })
    assert.strictEqual(x.status, 200, x.body)
  }
  const health = async (sid = '') => JSON.parse((await control(r.port, `/__health?sid=${sid}`)).body)
  const mainState = async () => {
    const h = await health()
    let sticky = {}
    try {
      sticky = JSON.parse(fs.readFileSync(path.join(r.dir, 'model-relay-state.json'), 'utf8')).sticky
    } catch {}
    return { failoverSince: h.failoverSince, nextClaudeTry: h.nextClaudeTry, claudeLimitedAt: h.claudeLimitedAt, sessionsOnCustom: h.sessionsOnCustom, sticky }
  }
  const routerLog = () => fs.readFileSync(path.join(r.dir, 'model-relay.log'), 'utf8')
  const seen = () => r.a.seen.map(who)
  return { ...r, limited, dirs, loginOf, writeLogin, setAccounts, register, health, mainState, routerLog, seen }
}
const from = (x) => JSON.parse(x.body).from
const leakFree = (text, why) => {
  for (const v of [...SECRETS, ...UUIDS, MAIN_EMAIL, ...Object.keys(ACCTS).map(emailOf)]) assert.ok(!text.includes(v), `${why}: ${v.slice(0, 10)}…`)
}

test('list 1: team-1 walks its list: team-2 at team-1\'s limit, team-3 at team-2\'s; each with its own token, ids and session id; team-3\'s own list is never reached', async (t) => {
  const r = await listed(t, { accounts: { 'team-1': { fallback: ['team-2', 'team-3'] }, 'team-2': {}, 'team-3': { fallback: ['team-1', { account: 'other-org', allowCrossOrg: true }] }, 'other-org': {} }, logins: { 'other-org': { accountUuid: ACCTS['other-org'].uuid, organizationUuid: ORG2 } } })
  await r.register(W1)
  r.limited.add('main')
  const body = chainBody(W1)
  const a = await ask(r.port, { sid: W1, body })
  assert.deepStrictEqual([a.status, from(a)], [200, 'team-2'], a.body)
  assert.deepStrictEqual(r.seen(), ['main', 'team-2'], 'team-1 once, team-2 once')
  const s2 = sidOf(r.a.seen[1])
  assert.ok(L.UUID_RE.test(s2) && s2 !== W1)
  assert.strictEqual(r.a.seen[1].body.toString(), onAcct('team-2', body, W1, s2), 'team-2\'s ids and email, every other byte as sent')
  assert.strictEqual((await r.health(W1)).accountServing, 'team-2')
  // a later request: team-1 is in its cooldown, so team-2 directly; team-2's own limit moves it on to team-3
  r.limited.add('team-2')
  const b = await ask(r.port, { sid: W1, body })
  assert.deepStrictEqual([b.status, from(b)], [200, 'team-3'], b.body)
  assert.deepStrictEqual(r.seen(), ['main', 'team-2', 'team-2', 'team-3'], 'no team-1 attempt; team-2 once, not retried for its limit; then team-3')
  const s3 = sidOf(r.a.seen[3])
  assert.ok(L.UUID_RE.test(s3) && ![W1, s2].includes(s3), 'a session id of its own on team-3')
  assert.strictEqual(r.a.seen[3].body.toString(), onAcct('team-3', body, W1, s3), 'the original body, team-3\'s ids')
  assert.deepStrictEqual([(await r.health(W1)).accountServing, (await r.health(W1)).kinds], ['team-3', { 'team-2': 'anthropic', 'team-3': 'anthropic' }])
  // team-3 at its limit too: the 429 comes back; other-org (team-3's own list, cross-org allowed there) is never asked
  r.limited.add('team-3')
  const c = await ask(r.port, { sid: W1, body })
  assert.deepStrictEqual([c.status, c.body], [429, limitOf('team-3')[2]])
  assert.deepStrictEqual(r.seen().slice(4), ['team-3'], 'only team-3: team-2 is in its own cooldown, team-1 in its')
  assert.strictEqual(r.seen().filter((w) => w === 'other-org').length, 0)
  assert.strictEqual(r.o.seen.length, 0, 'the chain was never asked')
  assert.deepStrictEqual(await r.mainState(), MAIN_STATE)
  const log = r.routerLog()
  assert.match(log, /account team-1 hit its usage limit: its windows use team-2 for 10 min/)
  assert.match(log, /account team-2 hit its usage limit as team-1's fallback: team-3 goes on with the request/)
  assert.match(log, /account team-3 hit its usage limit as team-1's fallback: no other fallback account of team-1 is usable now/)
  leakFree(log.replace(new RegExp(`${s2.slice(0, 8)}|${s3.slice(0, 8)}`, 'g'), ''), 'router log')
  assert.ok(!log.includes(s2) && !log.includes(s3) && !log.includes(W1), 'session ids only in short form')
})

test('list 2: every fallback account at its limit: team-1\'s own 429 comes back and none is asked; after team-2\'s cooldown team-2 serves again', async (t) => {
  const r = await listed(t, { clock: true, accounts: { 'team-1': { fallback: ['team-2', 'team-3'] }, 'team-2': {}, 'team-3': {} } })
  await r.register(W1)
  for (const w of ['main', 'team-2', 'team-3']) r.limited.add(w)
  const first = await ask(r.port, { sid: W1, body: chainBody(W1) })
  assert.deepStrictEqual([first.status, first.body], [429, limitOf('team-3')[2]], 'the last one asked answers')
  assert.deepStrictEqual(r.seen(), ['main', 'team-2', 'team-3'], 'attempts: team-1 once, each fallback account once')
  const again = await ask(r.port, { sid: W1, body: chainBody(W1) })
  assert.deepStrictEqual([again.status, again.body], [429, limitOf('main')[2]], 'team-1\'s own 429')
  assert.deepStrictEqual(r.seen().slice(3), ['main'], 'no fallback account asked')
  assert.strictEqual((await r.health(W1)).accountServing, undefined)
  r.limited.delete('team-2')
  r.advance(600001)
  const back = await ask(r.port, { sid: W1, body: chainBody(W1) })
  assert.deepStrictEqual([back.status, from(back)], [200, 'team-2'])
  assert.deepStrictEqual(r.seen().slice(4), ['main', 'team-2'])
  assert.deepStrictEqual(await r.mainState(), MAIN_STATE)
})

test('list 3: the string form is a one-entry list: the same routing as ["team-2"] while both logins share an organization', async (t) => {
  const raw = (fallback) => ({ format: 2, accountFallback: { mode: 'switch' }, accounts: { 'team-1': { configDir: '/a', fallback }, 'team-2': { configDir: '/b' } }, providers: { 'team-2': acctEntry('team-2') } })
  assert.deepStrictEqual(L.fallbackLists(raw(' Team-2 '), true), L.fallbackLists(raw(['team-2']), true))
  assert.deepStrictEqual([...L.fallbackLists(raw('team-2'), true)], [['team-1', [{ name: 'team-2', allowCrossOrg: false }]]])
  const run = async (fallback, logins = {}) => {
    const r = await listed(t, { accounts: { 'team-1': { fallback }, 'team-2': {} }, logins })
    await r.register(W1)
    r.limited.add('main')
    const out = [await ask(r.port, { sid: W1, body: chainBody(W1) }), await ask(r.port, { sid: W1, body: chainBody(W1) })]
    const h = await r.health(W1)
    return { replies: out.map((x) => [x.status, x.body]), seen: r.seen(), bodies: r.a.seen.map((q) => q.body.toString().replace(sidOf(q), 'S')), health: [h.providers, h.kinds, h.accountServing, h.session] }
  }
  assert.deepStrictEqual(await run('team-2'), await run(['team-2']))
  // the org rule covers the string form too: another organization and no opt-in, and team-1's 429 comes back
  const other = await run('team-2', { 'team-2': { accountUuid: ACCTS['team-2'].uuid, organizationUuid: ORG2 } })
  assert.deepStrictEqual(other.seen, ['main', 'main'])
  assert.deepStrictEqual(other.replies.map((x) => x[0]), [429, 429])
})

test('list 4: the org rule fails closed: another or an unreadable organization, a string "true" and a re-logged dir are skipped; allowCrossOrg: true opts in; the first of two equal names counts', async (t) => {
  const r = await listed(t, { accounts: { 'team-1': { fallback: ['team-2', 'team-3'] }, 'team-2': {}, 'team-3': {} }, logins: { 'team-2': { accountUuid: ACCTS['team-2'].uuid, organizationUuid: ORG2 } } })
  await r.register(W1)
  r.limited.add('main')
  const go = async () => {
    await sleep(20) // a login written just now has a new mtime
    const x = await ask(r.port, { sid: W1, body: chainBody(W1) })
    return x.status === 200 ? from(x) : x.status
  }
  assert.strictEqual(await go(), 'team-3', 'team-2 is in another organization: skipped, team-3 used')
  r.writeLogin('team-3', { accountUuid: ACCTS['team-3'].uuid, organizationUuid: ORG2 })
  assert.strictEqual(await go(), 429, 'both in another organization: team-1\'s 429 comes back')
  r.setAccounts({ 'team-1': { fallback: [{ account: 'team-2', allowCrossOrg: true }, 'team-3'] } })
  assert.strictEqual(await go(), 'team-2', 'allowCrossOrg: true')
  r.setAccounts({ 'team-1': { fallback: [{ account: 'team-2', allowCrossOrg: 'true' }, 'team-3'] } })
  assert.strictEqual(await go(), 429, 'the string "true" is no opt-in')
  r.writeLogin('team-3', { accountUuid: ACCTS['team-3'].uuid, organizationUuid: ORG })
  r.writeLogin('team-1', { accountUuid: MAIN_UUID })
  assert.strictEqual(await go(), 429, 'team-1\'s organization unreadable: team-3 skipped too')
  r.writeLogin('team-3', { accountUuid: ACCTS['team-3'].uuid })
  assert.strictEqual(await go(), 429, 'both organizations unreadable')
  r.writeLogin('team-1', { accountUuid: MAIN_UUID, organizationUuid: ORG })
  r.writeLogin('team-3', { accountUuid: ACCTS['team-3'].uuid, organizationUuid: ORG })
  r.writeLogin('team-2', { accountUuid: MAIN_UUID, organizationUuid: ORG })
  r.setAccounts({ 'team-1': { fallback: [{ account: 'team-2', allowCrossOrg: true }, 'team-3'] } })
  assert.strictEqual(await go(), 'team-3', 'team-2\'s dir logged in to another account: skipped even with allowCrossOrg')
  r.writeLogin('team-2', { accountUuid: ACCTS['team-2'].uuid, organizationUuid: ORG2 })
  r.setAccounts({ 'team-1': { fallback: ['team-2', { account: 'team-2', allowCrossOrg: true }, 'team-3'] } })
  assert.strictEqual(await go(), 'team-3', 'the first team-2 (no opt-in) counts, the second is dropped')
  assert.deepStrictEqual(L.fallbackProblems({ format: 2, accountFallback: { mode: 'switch' }, accounts: { 'team-1': { configDir: '/a', fallback: ['team-2', 'team-2'] }, 'team-2': { configDir: '/b' } }, providers: { 'team-2': acctEntry('team-2') } }).map((p) => p.why), ['accounts.team-1.fallback names team-2 twice; the first one counts'])
  const log = r.routerLog()
  assert.match(log, /account team-1: team-2 skipped: the two logins are not in one organization \(or one cannot be read\), and the entry has no allowCrossOrg: true/)
  assert.match(log, /account team-1: team-2 skipped: its login is not the account its providers entry names, or cannot be read; run account-sync for it again/)
  leakFree(log.replace(/session [0-9a-f]{8}/g, ''), 'router log')
})

// the relay's own account: main's windows, never registered
const selfAccounts = (fallback, more = {}) => ({ own: fallback === undefined ? {} : { fallback }, 'team-2': {}, 'team-3': {}, ...more })

test('list 5: the relay\'s own account walks its list before main\'s failover: main\'s state untouched, the cooldown goes straight there, and when it runs out main\'s failover runs as before', async (t) => {
  const r = await listed(t, { home: true, accounts: selfAccounts(['team-2', 'team-3']) })
  r.limited.add('main')
  const body = chainBody(M1)
  const x = await ask(r.port, { sid: M1, body })
  assert.deepStrictEqual([x.status, from(x)], [200, 'team-2'], x.body)
  assert.deepStrictEqual(r.seen(), ['main', 'team-2'])
  const s2 = sidOf(r.a.seen[1])
  assert.strictEqual(r.a.seen[1].body.toString(), onAcct('team-2', body, M1, s2))
  assert.deepStrictEqual(await r.mainState(), MAIN_STATE, 'claudeLimitedAt, failoverSince, nextClaudeTry and sticky unchanged')
  const h = await r.health(M1)
  assert.deepStrictEqual([h.selfServing, h.providers['team-2'], h.account, h.session], ['team-2', undefined, undefined, 'claude'], 'a name only; the account stays hidden')
  // inside the cooldown another main window goes straight to team-2
  const y = await ask(r.port, { sid: M2, body: chainBody(M2) })
  assert.strictEqual(from(y), 'team-2')
  assert.deepStrictEqual(r.seen().slice(2), ['team-2'], 'Claude not asked')
  assert.strictEqual(r.o.seen.length, 0)
  assert.match(r.routerLog(), /account own \(the relay's own\) hit its usage limit: main's windows use team-2 for 10 min/)
  // the list exhausted on Claude's own 429: main's failover exactly as without the account (onLimited, chain, stick)
  const run = async (accounts) => {
    const q = await listed(t, { home: true, accounts })
    for (const w of ['main', 'team-2', 'team-3']) q.limited.add(w)
    const out = await ask(q.port, { sid: M1, body })
    const st = await q.mainState()
    return { reply: [out.status, out.body], other: q.o.seen.map((o) => o.body.toString()), state: [st.failoverSince > 0, st.nextClaudeTry - st.failoverSince, st.claudeLimitedAt > 0, st.sticky[M1] && st.sticky[M1].provider], seen: q.seen() }
  }
  const walked = await run(selfAccounts(['team-2', 'team-3']))
  const plain = await run({})
  assert.deepStrictEqual(walked.seen, ['main', 'team-2', 'team-3'])
  assert.deepStrictEqual(plain.seen, ['main'])
  assert.deepStrictEqual([walked.reply, walked.other, walked.state[0], walked.state[2], walked.state[3]], [plain.reply, plain.other, true, true, 'other'])
  assert.ok(Math.abs(walked.state[1] - 600000) < 1000 && Math.abs(plain.state[1] - 600000) < 1000, 'onLimited: nextClaudeTry = failoverSince + cooldown')
})

// A body the splice refuses (an email sentence outside a <system-reminder>, as in fallback 7) is refused for every account
// alike, so the walk tries each target in turn and sends with none of them.
const BAD_BODY = (sid) => reminderBody(['<system-reminder>\nnothing here\n</system-reminder>', sentence(MAIN_EMAIL)], uidS(sid))

test('list 19: a splice refusal on a fallback account goes on to the next account of the list; a window of an account with nothing left gets a 502 that does not send it back to its own limited account', async (t) => {
  const r = await listed(t, { accounts: { 'team-1': { fallback: ['team-2', 'team-3'] }, 'team-2': {}, 'team-3': {} } })
  await r.register(W1)
  r.limited.add('main')
  const x = await ask(r.port, { sid: W1, body: BAD_BODY(W1) })
  assert.strictEqual(x.status, 502, x.body)
  const text = JSON.parse(x.body).error.message
  assert.match(text, /^model-relay router: account "team-3" could not serve this request: .*; nothing was sent with that account, and this window's own account is at its usage limit\. Continue in team-3's own login \(/, 'the last account of the list refused')
  assert.ok(!text.includes('/provider claude') && !text.includes('your own account'), text)
  assert.match(text, /CLAUDE_CONFIG_DIR set to its folder and --continue/)
  assert.deepStrictEqual(r.seen(), ['main'], 'team-1 once; nothing was sent with team-2\'s or team-3\'s token')
  const log = r.routerLog()
  assert.match(log, /account team-2 could not serve a request as team-1's fallback: team-3 goes on with the request/)
  assert.match(log, /account team-3 could not serve a request as team-1's fallback: no other fallback account of team-1 is usable now/)
  assert.ok(!log.includes(MAIN_EMAIL), 'no body text in the log')
  // a refusal says nothing of an account's limit: team-2 serves the next good request straight away (team-1 sits out its cooldown)
  const y = await ask(r.port, { sid: W1, body: chainBody(W1) })
  assert.deepStrictEqual([y.status, from(y)], [200, 'team-2'], y.body)
  assert.deepStrictEqual(await r.mainState(), MAIN_STATE)
})

test('list 20: the relay\'s own account: a splice refusal on its whole list goes to main\'s failover as at its usage limit, and only a failover with nobody left answers an error', async (t) => {
  const r = await listed(t, { home: true, accounts: selfAccounts(['team-2', 'team-3']) })
  r.limited.add('main')
  const x = await ask(r.port, { sid: M1, body: BAD_BODY(M1) })
  assert.deepStrictEqual([x.status, from(x)], [200, 'other'], 'main\'s failover took it')
  assert.deepStrictEqual(r.seen(), ['main'], 'nothing was sent with team-2\'s or team-3\'s token')
  assert.strictEqual(r.o.seen.length, 1)
  const st = await r.mainState()
  assert.ok(st.failoverSince > 0 && st.claudeLimitedAt > 0, 'main\'s failover state as at its own limit')
  // with no chain, and the account out of its limit on the direct path: a 502 with the same advice
  const q = await listed(t, { home: true, chain: [], accounts: selfAccounts(['team-2', 'team-3']) })
  q.limited.add('main')
  const first = await ask(q.port, { sid: M1, body: chainBody(M1) })
  assert.strictEqual(from(first), 'team-2', 'the own account is limited now, team-2 serves')
  const y = await ask(q.port, { sid: M2, body: BAD_BODY(M2) })
  assert.strictEqual(y.status, 502, y.body)
  assert.match(JSON.parse(y.body).error.message, /account "team-3" could not serve this request/)
  assert.deepStrictEqual(q.seen(), ['main', 'team-2'], 'the refused request reached nobody')
})

test('list 21: the account views are made once per config content: repeated requests with an unchanged config resolve no folder again, and a changed config does', async (t) => {
  const log = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'relay-rp-')), 'realpath.log')
  t.after(() => fs.rmSync(path.dirname(log), { recursive: true, force: true }))
  const r = await listed(t, { accounts: { 'team-1': { fallback: ['team-2', 'team-3'] }, 'team-2': {}, 'team-3': {} }, env: { RELAY_TEST_REALPATH_LOG: log } })
  const calls = () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).length : 0)
  // plain model calls from a window that never registered, with no account in the body: no login file is read either
  const plain = JSON.stringify({ model: OPUS_ID, max_tokens: 5, messages: [] })
  const ok = async (sid) => assert.strictEqual((await ask(r.port, { sid, body: plain })).status, 200)
  await ok('p0')
  const first = calls()
  assert.ok(first >= 6, `the views of three accounts were made at least once (${first} calls to realpath)`)
  for (let i = 1; i <= 20; i++) await ok(`p${i}`)
  assert.strictEqual(calls(), first, 'twenty more requests resolved no folder again')
  await r.health()
  assert.strictEqual(calls(), first, 'nor did /__health')
  // the config content changes (a fallback list is dropped): the views are made again, once, with the new content
  const file = path.join(r.dir, 'model-relay.json')
  const cfg = JSON.parse(fs.readFileSync(file, 'utf8'))
  cfg.accounts['team-1'].fallback = ['team-2']
  fs.writeFileSync(file, JSON.stringify(cfg))
  await ok('q0')
  const second = calls()
  assert.ok(second > first, 'a changed config is read again')
  for (let i = 1; i <= 5; i++) await ok(`q${i}`)
  assert.strictEqual(calls(), second)
  // a folder that was missing appears (an account's dir made after the router started): the views are made again too
  fs.rmSync(r.dirs['team-3'], { recursive: true })
  await ok('r0')
  const third = calls()
  assert.ok(third > second, 'a folder that vanished changes what its path resolves to')
  for (let i = 1; i <= 5; i++) await ok(`r${i}`)
  assert.strictEqual(calls(), third)
  fs.mkdirSync(r.dirs['team-3'])
  await ok('s0')
  assert.ok(calls() > third, 'and one that appears')
})

test('list 6: no list on the relay\'s own account, or no such account: main routes byte for byte as without accounts', async (t) => {
  const run = async (accounts) => {
    const r = await listed(t, { home: true, accounts })
    const out = [await ask(r.port, { sid: M1, body: chainBody(M1) })]
    r.limited.add('main')
    out.push(await ask(r.port, { sid: M2, body: chainBody(M2) })) // the usage limit: failover to other
    out.push(await ask(r.port, { sid: M1, body: chainBody(M1) })) // the cooldown
    const h = await r.health(M2)
    return { replies: out.map((x) => [x.status, x.body]), anthropic: r.a.seen.map((q) => [q.url, q.headers.authorization, q.body.toString()]), other: r.o.seen.map((q) => [q.url, q.headers.authorization, q.body.toString()]), health: [h.providers, h.kinds, h.failoverChain, h.session, h.selfServing], keychain: r.calls().length }
  }
  const none = await run({})
  assert.deepStrictEqual(await run(selfAccounts(undefined)), none, 'the relay\'s own account without a list')
  assert.deepStrictEqual(await run({ 'team-2': {}, 'team-3': {} }), none, 'accounts, but none of them the relay\'s own')
  assert.strictEqual(none.keychain, 0)
})

test('list 7: a usage limit on a body with no readable account_uuid takes main\'s path only, and the relay\'s own account\'s list is not used', async (t) => {
  const r = await listed(t, { home: true, accounts: selfAccounts(['team-2']) })
  r.limited.add('main')
  const x = await ask(r.port, { sid: M1, body: chainBody(M1, 'not-an-account-uuid') })
  assert.strictEqual(from(x), 'other', 'main\'s failover')
  assert.deepStrictEqual(r.seen(), ['main'], 'team-2 never asked')
  const st = await r.mainState()
  assert.ok(st.failoverSince > 0 && st.claudeLimitedAt > 0)
  assert.strictEqual((await r.health(M1)).selfServing, undefined, 'the relay\'s own account is not marked limited')
  assert.match(r.routerLog(), /account own \(the relay's own\): a usage limit for a request that is not that account's own \(or its login could not be read\); main's failover takes it/)
})

test('list 7b: an unregistered window that names another account than the relay\'s own gets Claude as sent: no fallback of the relay\'s own account, main\'s failover untouched', async (t) => {
  const r = await listed(t, { home: true, accounts: selfAccounts(['team-2']) })
  r.limited.add('main')
  const before = await r.mainState()
  const x = await ask(r.port, { sid: M1, body: chainBody(M1, SPARE_UUID) })
  assert.strictEqual(x.status, 429, 'its own limit, passed back')
  assert.deepStrictEqual(r.seen(), ['main'], 'neither team-2 nor the chain provider asked')
  assert.deepStrictEqual(await r.mainState(), before, 'main\'s failover state unchanged')
  assert.strictEqual((await r.health(M1)).selfServing, undefined)
  // the relay's own account's own request still takes the list
  assert.strictEqual(from(await ask(r.port, { sid: M2, body: chainBody(M2) })), 'team-2', 'main\'s own uuid: the relay\'s own account\'s fallback')
})

// setup.mjs in a scratch home: <home>/.claude is the relay dir (CLAUDE_CONFIG_DIR), holding model-relay.json from cfg
async function homeCli(t, cfg, { items = {}, settings = {} } = {}) {
  const s = scratch(t, 'relay-home-')
  const relayDir = path.join(s.dir, '.claude')
  fs.mkdirSync(relayDir)
  const file = path.join(relayDir, 'model-relay.json')
  fs.writeFileSync(file, JSON.stringify({ format: 2, port: await freePort(), ...cfg }))
  fs.writeFileSync(path.join(relayDir, 'settings.json'), JSON.stringify(settings))
  const env = { ...process.env, HOME: s.dir, USERPROFILE: s.dir, CLAUDE_CONFIG_DIR: relayDir, MODEL_RELAY_CONFIG_DIR: undefined, RELAY_TEST_KEYCHAIN_LOG: s.log, RELAY_TEST_KEYCHAIN_ITEMS: JSON.stringify(items) }
  const run = (...args) => new Promise((resolve) => {
    fs.writeFileSync(s.log, '')
    execFile(process.execPath, ['--require', s.stub, SETUP, ...args], { cwd: s.dir, env }, (e, stdout, stderr) => {
      const calls = s.calls()
      resolve({ code: e ? e.code : 0, out: `${stdout}${stderr}`, stdout, reads: calls.filter((c) => c.args.includes('-w')).length, checks: calls.length })
    })
  })
  const login = (dir, uuid, org, extra = {}) => {
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, '.claude.json'), JSON.stringify({ ...extra, oauthAccount: { accountUuid: uuid, ...(org ? { organizationUuid: org } : {}), emailAddress: 'who@example.test' } }))
  }
  return { run, home: s.dir, relayDir, file, login }
}

test('list 7c: the other-login rule holds in rc-keep and api-only (an unregistered window of another account goes to Claude as sent), and not in off', async (t) => {
  for (const mode of ['rc-keep', 'api-only', 'off']) {
    let limited = true
    const r = await relay(t, { home: true, top: { accountFallback: { mode } }, anthropic: (q) => (limited && q.headers.authorization === `Bearer ${MAIN}` && q.url.startsWith('/v1/messages') ? USAGE_LIMIT : OK(q.headers.authorization === `Bearer ${SECRET}` ? 'spare' : 'claude')) })
    fs.writeFileSync(path.join(r.home, '.claude.json'), JSON.stringify({ oauthAccount: { accountUuid: MAIN_UUID, organizationUuid: ORG } }))
    const failoverSince = async () => JSON.parse((await control(r.port, '/__health')).body).failoverSince
    const foreign = await ask(r.port, { sid: W1, body: chainBody(W1, SPARE_UUID) })
    if (mode === 'off') {
      // 0.7.5: no registration and no other-login rule; the usage limit starts main's failover as it always did
      assert.strictEqual(JSON.parse(foreign.body).from, 'other', `${mode}: ${foreign.body}`)
      assert.ok((await failoverSince()) > 0, `${mode}: main's failover started`)
      continue
    }
    assert.deepStrictEqual([foreign.status, foreign.body], [429, USAGE_LIMIT[2]], `${mode}: the limit comes back as it is`)
    assert.strictEqual(byToken(r.a.seen, MAIN).length, 1, `${mode}: sent to Claude once, with the caller's own credentials`)
    assert.strictEqual(byToken(r.a.seen, SECRET).length, 0, `${mode}: the chain account was not used`)
    assert.strictEqual(r.o.seen.length, 0, `${mode}: nor the chain's other provider`)
    assert.strictEqual(await failoverSince(), 0, `${mode}: main's failover state is untouched`)
    // main's own login takes the failover as always, and reaches the chain account
    const own = await ask(r.port, { sid: W2, body: chainBody(W2) })
    assert.strictEqual(JSON.parse(own.body).from, 'spare', `${mode}: ${own.body}`)
    assert.ok((await failoverSince()) > 0, `${mode}: main's own login starts it`)
  }
})

test('list 8: the default dir\'s login is <home>/.claude.json: the router finds the relay\'s own account there, and account-sync works with CLAUDE_CONFIG_DIR set to the relay dir', async (t) => {
  const r = await listed(t, { home: true, accounts: selfAccounts(['team-2']), env: { CLAUDE_CONFIG_DIR: undefined } })
  assert.ok(fs.existsSync(path.join(r.home, '.claude.json')) && !fs.existsSync(path.join(r.dir, '.claude.json')), 'only <home>/.claude.json')
  r.limited.add('main')
  assert.strictEqual(from(await ask(r.port, { sid: M1, body: chainBody(M1) })), 'team-2')
  // account-sync from the relay dir: your own login is <home>/.claude.json, not <home>/.claude/.claude.json
  const c = await homeCli(t, { accountFallback: { mode: 'switch' }, accounts: { 'team-2': { configDir: '~/.claude-team-2' } }, providers: {} })
  c.login(c.home, MAIN_UUID, ORG, { userID: MAIN_DEV })
  c.login(path.join(c.home, '.claude-team-2'), ACCTS['team-2'].uuid, ORG, { userID: ACCTS['team-2'].dev })
  // a stale copy inside the relay dir naming team-2 would make account-sync refuse "your own account" if it were read
  c.login(c.relayDir, ACCTS['team-2'].uuid, ORG, { userID: 'f'.repeat(64) })
  const x = await c.run('account-sync', 'team-2')
  assert.strictEqual(x.code, 0, x.out)
  assert.strictEqual(JSON.parse(fs.readFileSync(c.file, 'utf8')).providers['team-2'].accountUuid, ACCTS['team-2'].uuid)
  assert.strictEqual(x.out.includes(ACCTS['team-2'].uuid), false)
})

test('list 9: doctor lists each fallback entry with why, names each login file read, and errors on two own accounts or one login shared; /__account refuses the relay\'s own account; no uuid or email printed', async (t) => {
  const items = { 'relay-test/team-2': 'x', 'relay-test/team-3': 'x' }
  const providers = { 'team-2': acctEntry('team-2'), 'team-3': acctEntry('team-3'), 'other-org': acctEntry('other-org') }
  const c = await homeCli(t, { accountFallback: { mode: 'switch' }, accounts: { own: { configDir: '~/.claude', fallback: ['team-2', 'team-3', 'other-org', tokenLike('oat01', 'PASTED'), 'own', 'team-2'] }, 'team-1': { configDir: '~/.claude-team-1', fallback: ['own'] }, 'team-2': { configDir: '~/.claude-team-2' }, 'team-3': { configDir: '~/.claude-team-3' }, 'other-org': { configDir: '~/.claude-other-org' } }, providers }, { items })
  c.login(c.home, MAIN_UUID, ORG)
  c.login(c.relayDir, ACCTS['other-org'].uuid, ORG) // a stale copy inside the default dir, another account
  c.login(path.join(c.home, '.claude-team-1'), ACCTS['team-1'].uuid, ORG)
  c.login(path.join(c.home, '.claude-team-2'), ACCTS['team-2'].uuid, ORG)
  c.login(path.join(c.home, '.claude-team-3'), ACCTS['team-3'].uuid, ORG2)
  fs.writeFileSync(path.join(c.home, '.claude-team-2', '.config.json'), '{}')
  const doc = await c.run('doctor')
  assert.strictEqual(doc.code, 0, doc.out)
  const lines = doc.out.split('\n')
  const line = (re) => lines.find((l) => re.test(l)) || ''
  assert.strictEqual(line(/Fallback of own/), '  Fallback of own (the relay\'s own account): ✓ team-2 (same organization), ✗ team-3 (the two logins are not in one organization (or one cannot be read), and the entry has no allowCrossOrg: true), ✗ other-org (its token does not resolve, see above), ✗ (an entry that names no account) (names no account in accounts (with a configDir)), ✗ own (names the account itself), ✗ team-2 (names team-2 twice; the first one counts)')
  assert.strictEqual(line(/Fallback of team-1/), '  Fallback of team-1: ✗ own (names own, the relay\'s own account, which is never a fallback)')
  assert.strictEqual(line(/Login of own/), `  Login of own (the relay's own account): ${path.join(c.home, '.claude.json')} (an accountUuid found)`)
  assert.strictEqual(line(/Login of other-org/), `  Login of other-org: ${path.join(c.home, '.claude-other-org', '.claude.json')} (not readable)`)
  assert.match(doc.out, /⚠ own's fallback team-3 is skipped: the two logins are not in one organization/)
  assert.ok(doc.out.includes(`⚠ ${path.join(c.home, '.claude', '.claude.json')} names another account than ${path.join(c.home, '.claude.json')}`), doc.out)
  assert.ok(doc.out.includes(`⚠ ${path.join(c.home, '.claude-team-2', '.config.json')} exists; the relay reads ${path.join(c.home, '.claude-team-2', '.claude.json')} only for team-2's login`), doc.out)
  leakFree(doc.out, 'doctor')
  assert.ok(!doc.out.toLowerCase().includes('pasted') && !doc.out.includes('who@example'), 'no value that names no account, no email')
  const js = await c.run('doctor', '--json')
  leakFree(js.stdout, 'doctor --json')
  assert.ok(JSON.parse(js.stdout).findings.some((f) => f.id === 'account-fallback-skipped' && f.provider === 'team-3'))
  // two accounts on the relay dir (by two spellings), and two accounts sharing one login (a symlinked dir, one uuid)
  fs.symlinkSync(path.join(c.home, '.claude-team-2'), path.join(c.home, 'team-2-link'))
  c.login(path.join(c.home, '.claude-copy'), ACCTS['team-3'].uuid, ORG2)
  fs.writeFileSync(c.file, JSON.stringify({ format: 2, port: 9, accountFallback: { mode: 'switch' }, accounts: { a: { configDir: '~/.claude' }, b: { configDir: c.relayDir }, 'team-2': { configDir: '~/.claude-team-2' }, link: { configDir: '~/team-2-link' }, 'team-3': { configDir: '~/.claude-team-3' }, copy: { configDir: '~/.claude-copy' } }, providers }))
  const bad = await c.run('doctor')
  assert.strictEqual(bad.code, 1, bad.out)
  assert.match(bad.out, /✗ accounts a, b all have this relay's own config directory as configDir; at most one may \(the relay's own account\), so none counts/)
  assert.match(bad.out, /✗ accounts team-2, link read one login file; each account needs a login of its own/)
  assert.match(bad.out, /✗ accounts team-3, copy are logged in to one account; each needs a login of its own/)
  leakFree(bad.out, 'doctor errors')
  // the router refuses to register a window as the relay's own account
  const r = await listed(t, { home: true, accounts: selfAccounts(['team-2']) })
  const reg = await control(r.port, '/__account', { sid: W1, account: 'own' })
  assert.strictEqual(reg.status, 400)
  assert.match(JSON.parse(reg.body).error.message, /that account is the relay's own; its windows are your own windows and are not registered/)
})

test('list 10: account-add makes a 0700 dir with exactly the links the relay dir has, writes the entry with a backup, prints the manual steps, and refuses everything else untouched', async (t) => {
  const c = await homeCli(t, { accountFallback: { mode: 'switch' }, accounts: { 'team-2': { configDir: '~/.claude-team-2' } }, providers: {} })
  for (const f of ['CLAUDE.md', 'history.jsonl', '.config.json', 'statusline.sh']) fs.writeFileSync(path.join(c.relayDir, f), 'x')
  for (const d of ['agents', 'projects', 'ide', 'backups', 'shell-snapshots', 'session-env']) fs.mkdirSync(path.join(c.relayDir, d))
  const tree = () => {
    const out = []
    const walk = (d) => {
      for (const e of fs.readdirSync(d).sort()) {
        const p = path.join(d, e)
        const st = fs.lstatSync(p)
        out.push(`${path.relative(c.home, p)} ${st.isSymbolicLink() ? `-> ${fs.readlinkSync(p)}` : (st.mode & 0o777).toString(8)}${st.isFile() ? ` ${fs.readFileSync(p, 'utf8')}` : ''}`)
        if (st.isDirectory() && !st.isSymbolicLink()) walk(p)
      }
    }
    walk(c.home)
    return out
  }
  const cfgText = () => fs.readFileSync(c.file, 'utf8')
  const refused = async (args, code, re) => {
    const before = tree()
    const x = await c.run('account-add', ...args)
    assert.strictEqual(x.code, code, `${args.join(' ')}: ${x.out}`)
    assert.match(x.out, re, args.join(' '))
    assert.match(x.out, /Nothing was changed\./)
    assert.deepStrictEqual(tree(), before, `${args.join(' ')}: nothing touched`)
  }
  for (const n of ['.config.json', '../x', 'ide', 'history.jsonl', 'shell-snapshots', 'session-env', 'backups', '.claude.json', '.credentials.json', 'model-relay.json', 'a/b', '']) {
    await refused(['team-3', '--link', n], 2, /--link .* is refused: only a plain name in the relay dir/)
  }
  await refused(['team-3', '--link', 'nothing-here'], 2, /the relay dir .* has no such entry/)
  await refused(['team-2'], 1, /accounts\.team-2 already exists/)
  await refused(['Team-2'], 1, /accounts\.team-2 already exists/)
  for (const n of ['claude', 'x/y', '-x']) await refused([n], 2, /Usage: node tools\/setup\.mjs account-add/)
  await refused(['__proto__'], 2, /"__proto__" cannot be a name/)
  await refused(['team-3', '--dir', 'relative/dir'], 2, /--dir must be an absolute path or start with ~\//)
  fs.mkdirSync(path.join(c.home, 'real-empty'))
  fs.symlinkSync(path.join(c.home, 'real-empty'), path.join(c.home, 'linked'))
  await refused(['team-3', '--dir', '~/linked'], 1, /is a symlink/)
  fs.mkdirSync(path.join(c.home, 'full'))
  fs.writeFileSync(path.join(c.home, 'full', 'f'), 'x')
  await refused(['team-3', '--dir', path.join(c.home, 'full')], 1, /exists and is not empty/)
  await refused(['team-3', '--dir', '~/.claude/inside'], 1, /is, holds or lies inside the relay dir/)
  await refused(['team-3', '--dir', '~/'], 1, /is, holds or lies inside the relay dir/)
  await refused(['team-3', '--dir', '~/.claude-team-2/sub'], 1, /is, holds or lies inside the dir of accounts\.team-2/)
  await refused(['team-3', '--dir', '~/no-parent/dir'], 1, /does not exist/)
  // the default dir: the four default entries the relay dir has, plus --link statusline.sh; nothing else changes
  const before = tree()
  const ok = await c.run('account-add', 'team-3', '--link', 'statusline.sh')
  assert.strictEqual(ok.code, 0, ok.out)
  const dir = path.join(c.home, '.claude-team-3')
  assert.strictEqual(fs.statSync(dir).mode & 0o777, 0o700)
  assert.deepStrictEqual(fs.readdirSync(dir).sort(), ['CLAUDE.md', 'agents', 'projects', 'settings.json', 'statusline.sh'])
  for (const n of fs.readdirSync(dir)) assert.strictEqual(fs.readlinkSync(path.join(dir, n)), path.join(c.relayDir, n))
  const changed = tree().filter((l) => !before.includes(l)).filter((l) => !l.startsWith('.claude-team-3') && !l.startsWith('.claude/model-relay.json '))
  assert.deepStrictEqual(changed.map((l) => l.split(' ')[0]), ['.claude/model-relay.json.model-relay-backup'], 'only the dir, the config and its backup')
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(`${c.file}.model-relay-backup`, 'utf8')).accounts, { 'team-2': { configDir: '~/.claude-team-2' } })
  assert.deepStrictEqual(JSON.parse(cfgText()).accounts, { 'team-2': { configDir: '~/.claude-team-2' }, 'team-3': { configDir: '~/.claude-team-3' } })
  assert.match(ok.out, /4\. step 5 adds to your default keychain, and the router reads only login\.keychain-db: `security default-keychain` must print it \(if it does not, run `security default-keychain -s ~\/Library\/Keychains\/login\.keychain-db` first\)/)
  assert.match(ok.out, /security add-generic-password -s model-relay-team-3 -a team-3 -w {3}\(-w last, so it asks for the token/)
  assert.match(ok.out, /claude setup-token, then clear the terminal scrollback: it printed the token/)
  // B1: the token step is the account-token command itself
  assert.match(ok.out, /account-sync team-3, then node \S+ account-token team-3 keychain:model-relay-team-3\/team-3/)
  assert.deepStrictEqual([ok.reads, ok.checks], [0, 0], 'the keychain is never touched')
  // a reused empty dir ends 0700
  fs.mkdirSync(path.join(c.home, 'empty'))
  fs.chmodSync(path.join(c.home, 'empty'), 0o755)
  const reuse = await c.run('account-add', 'team-4', '--dir', '~/empty')
  assert.strictEqual(reuse.code, 0, reuse.out)
  assert.strictEqual(fs.statSync(path.join(c.home, 'empty')).mode & 0o777, 0o700)
  assert.strictEqual(JSON.parse(cfgText()).accounts['team-4'].configDir, '~/empty')
})

test('list 12: the protected routing functions are byte-identical to 96fa186 (decide and onLimited included)', () => {
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

test('list 13: while the relay\'s own account is limited, a main request with another account_uuid, none, or an unreadable own login goes to Claude as before on both paths; a pin to its fallback is refused', async (t) => {
  const r = await listed(t, { home: true, chain: [], accounts: selfAccounts(['team-2']) })
  r.limited.add('main')
  assert.strictEqual(from(await ask(r.port, { sid: M1, body: chainBody(M1) })), 'team-2', 'the relay\'s own account is now limited, team-2 serving')
  const onTeam2 = () => r.seen().filter((w) => w === 'team-2').length
  // the direct route: Claude answers again, and gets the request as sent
  const direct = async (body, why) => {
    await sleep(20)
    const x = await ask(r.port, { sid: M2, body })
    assert.deepStrictEqual([x.status, from(x)], [200, 'main'], `${why}: Claude, as sent`)
    assert.strictEqual(r.a.seen.at(-1).body.toString(), body, why)
    assert.strictEqual(r.a.seen.at(-1).headers.authorization, `Bearer ${MAIN}`, why)
  }
  // the toClaude walk: Claude at its limit, and its 429 comes back as at c1b1fef with an empty chain
  const walk = async (body, why) => {
    await sleep(20)
    const x = await ask(r.port, { sid: M2, body })
    assert.deepStrictEqual([x.status, x.body], [429, limitOf('main')[2]], `${why}: Claude's 429`)
  }
  const noMeta = JSON.stringify({ model: OPUS_ID, messages: [] })
  r.limited.delete('main')
  await direct(chainBody(M2, SPARE_UUID), 'another account_uuid')
  await direct(noMeta, 'no account_uuid')
  r.limited.add('main')
  await walk(chainBody(M2, SPARE_UUID), 'another account_uuid')
  await walk(noMeta, 'no account_uuid')
  for (const login of ['{"oauthAccount": oops', null]) {
    const what = login === null ? 'login missing' : 'login corrupt'
    r.writeLogin('own', login)
    r.limited.delete('main')
    await direct(chainBody(M2), `${what}, the former own uuid`)
    await direct(noMeta, `${what}, no uuid`)
    r.limited.add('main')
    await walk(chainBody(M2), `${what}, the former own uuid`)
    await walk(noMeta, `${what}, no uuid`)
  }
  assert.strictEqual(onTeam2(), 1, 'nothing more went out with team-2\'s token')
  assert.strictEqual((await r.mainState()).failoverSince, 0)
  const pin = await control(r.port, '/__session', { sid: M2, on: 'team-2' })
  assert.strictEqual(pin.status, 400)
  assert.match(JSON.parse(pin.body).error.message, /provider "team-2" is the fallback of another account's windows; this session cannot use it/)
  assert.strictEqual((await r.health(M2)).providers['team-2'], undefined)
})

test('list 14: the relay\'s own account limited, its serving fallback answering its own limit with the rest limited: main\'s failover takes the request as at c1b1fef', async (t) => {
  const r = await listed(t, { home: true, accounts: selfAccounts(['team-3', 'team-2']) })
  r.limited.add('main')
  r.limited.add('team-3')
  assert.strictEqual(from(await ask(r.port, { sid: M1, body: chainBody(M1) })), 'team-2', 'team-3 at its limit, team-2 serving')
  assert.deepStrictEqual(r.seen(), ['main', 'team-3', 'team-2'])
  assert.deepStrictEqual(await r.mainState(), MAIN_STATE)
  r.limited.add('team-2')
  const t0 = Date.now()
  const x = await ask(r.port, { sid: M2, body: chainBody(M2) })
  assert.deepStrictEqual([x.status, from(x)], [200, 'other'], 'the chain provider\'s answer')
  assert.deepStrictEqual(r.seen().slice(3), ['team-2'], 'team-2 directly, once; Claude and team-3 not asked')
  assert.strictEqual(r.o.seen.length, 1)
  const st = await r.mainState()
  assert.ok(st.failoverSince >= t0 && st.claudeLimitedAt >= t0, JSON.stringify(st))
  assert.ok(Math.abs(st.nextClaudeTry - st.failoverSince - 600000) < 1000, 'onLimited')
  assert.strictEqual(st.sticky[M2].provider, 'other', 'stuck to the chain provider, as at c1b1fef')
  assert.strictEqual(from(await ask(r.port, { sid: M1, body: chainBody(M1) })), 'other', 'the cooldown: decide, as before')
})

test('list 15: the relay\'s own uuid comes from <home>/.claude.json whatever CLAUDE_CONFIG_DIR the router or account-sync has; a stale <home>/.claude/.claude.json is ignored', async (t) => {
  const run = async (opts) => {
    const r = await listed(t, { home: true, accounts: selfAccounts(['team-2']), ...opts })
    // a stale login inside the relay dir, naming another account
    fs.writeFileSync(path.join(r.dir, '.claude.json'), JSON.stringify({ oauthAccount: { accountUuid: SPARE_UUID, organizationUuid: ORG } }))
    r.limited.add('main')
    return from(await ask(r.port, { sid: M1, body: chainBody(M1) }))
  }
  assert.strictEqual(await run({ dirArg: false }), 'team-2', 'started with CLAUDE_CONFIG_DIR = the relay dir and no argument')
  assert.strictEqual(await run({ env: { CLAUDE_CONFIG_DIR: path.join(os.tmpdir(), 'relay-list-an-account-dir') } }), 'team-2', 'CLAUDE_CONFIG_DIR = an account dir')
  // account-sync with CLAUDE_CONFIG_DIR = the relay dir compares with <home>/.claude.json: a stale inner copy with team-2's
  // userID would make it refuse ("the same userID as your own login") if it were read
  const c = await homeCli(t, { accountFallback: { mode: 'switch' }, accounts: { 'team-2': { configDir: '~/.claude-team-2' } }, providers: {} })
  c.login(c.home, MAIN_UUID, ORG, { userID: MAIN_DEV })
  c.login(path.join(c.home, '.claude-team-2'), ACCTS['team-2'].uuid, ORG, { userID: ACCTS['team-2'].dev })
  c.login(c.relayDir, MAIN_UUID, ORG, { userID: ACCTS['team-2'].dev })
  const x = await c.run('account-sync', 'team-2')
  assert.strictEqual(x.code, 0, x.out)
  assert.ok(x.out.includes(`written from ${path.join(c.home, '.claude-team-2', '.claude.json')}`), x.out)
})

test('list 16: account-add and doctor name, by key only, settings.json keys that would send with something other than the login', async (t) => {
  const settings = { env: { ANTHROPIC_API_KEY: tokenLike('api03', 'FAKE-VALUE'), CLAUDE_CODE_OAUTH_TOKEN: tokenLike('oat01', 'FAKE-VALUE'), OTHER: 'x' }, apiKeyHelper: '/usr/local/bin/fake-helper' }
  const c = await homeCli(t, { accountFallback: { mode: 'switch' }, accounts: { 'team-2': { configDir: '~/.claude-team-2' } }, providers: {} }, { settings })
  const want = `${path.join(c.relayDir, 'settings.json')} sets env.ANTHROPIC_API_KEY, env.CLAUDE_CODE_OAUTH_TOKEN, apiKeyHelper: an account dir that links this settings.json sends with that instead of its own login`
  const add = await c.run('account-add', 'team-3')
  assert.strictEqual(add.code, 0, add.out)
  const doc = await c.run('doctor')
  for (const x of [add, doc]) {
    assert.ok(x.out.includes(`⚠ ${want}`), x.out)
    assert.ok(!x.out.includes('FAKE-VALUE') && !x.out.includes('fake-helper'), 'no value printed')
  }
  assert.ok(!doc.out.includes('ANTHROPIC_AUTH_TOKEN') && !doc.out.includes('env.OTHER'), 'only the keys set, and only those three')
})

test('list 17: a .claude.json that is a directory or a FIFO is never read: it counts as unreadable, with no fallback and no hang', async (t) => {
  const s = scratch(t, 'relay-acct-fifo-')
  const fifo = path.join(s.dir, 'fifo.json')
  require('node:child_process').execFileSync('mkfifo', [fifo])
  const t0 = Date.now()
  assert.strictEqual(L.loginIds(fifo), null)
  assert.strictEqual(L.readLoginJson(fifo), null)
  assert.strictEqual(L.loginIds(s.dir), null)
  assert.ok(Date.now() - t0 < 1000, 'answered at once')
  const r = await listed(t, { accounts: { 'team-1': { fallback: ['team-2'] }, 'team-2': {} } })
  await r.register(W1)
  r.limited.add('main')
  for (const make of [(p) => fs.mkdirSync(p), (p) => require('node:child_process').execFileSync('mkfifo', [p])]) {
    fs.rmSync(r.loginOf('team-1'), { recursive: true, force: true })
    make(r.loginOf('team-1'))
    const x = await ask(r.port, { sid: W1, body: chainBody(W1) })
    assert.deepStrictEqual([x.status, x.body], [429, limitOf('main')[2]], 'team-1\'s 429 back')
  }
  assert.deepStrictEqual(r.seen(), ['main', 'main'], 'team-2 never asked')
  // the same for a fallback account's login: unreadable, so refused
  fs.rmSync(r.loginOf('team-1'), { force: true })
  r.writeLogin('team-1', { accountUuid: MAIN_UUID, organizationUuid: ORG })
  fs.rmSync(r.loginOf('team-2'), { force: true })
  require('node:child_process').execFileSync('mkfifo', [r.loginOf('team-2')])
  const y = await ask(r.port, { sid: W1, body: chainBody(W1) })
  assert.strictEqual(y.status, 429)
  assert.deepStrictEqual(r.seen(), ['main', 'main', 'main'])
})

test('list 18: the plan\'s config: providers and doctor see other-org as team-3\'s fallback only, and the router reads its item and reaches it as team-3\'s second entry; an unreadable org shows doctor\'s org line', async (t) => {
  const example = {
    own: { configDir: '~/.claude' },
    'team-1': { configDir: '~/.claude-team-1', fallback: ['team-2', 'team-3'] },
    'team-2': { configDir: '~/.claude-team-2', fallback: ['team-3', 'team-1'] },
    'team-3': { configDir: '~/.claude-team-3', fallback: ['team-1', { account: 'other-org', allowCrossOrg: true }] },
    'other-org': { configDir: '~/.claude-other-org' },
  }
  const providers = Object.fromEntries(Object.keys(ACCTS).map((n) => [n, acctEntry(n)]))
  const items = Object.fromEntries(Object.keys(ACCTS).map((n) => [`relay-test/${n}`, 'x']))
  const c = await homeCli(t, { accountFallback: { mode: 'switch' }, accounts: example, providers, failover: { enabled: true, chain: [] } }, { items })
  c.login(c.home, MAIN_UUID, ORG)
  for (const n of Object.keys(ACCTS)) c.login(path.join(c.home, `.claude-${n}`), ACCTS[n].uuid, n === 'other-org' ? ORG2 : ORG)
  const list = await c.run('providers')
  assert.strictEqual(list.code, 0, list.out)
  assert.match(list.out, /● other-org\s+anthropic-account[^\n]*\n\s+routes: \(a Claude account: only the windows of team-3, at its usage limit or by \/provider\)/)
  assert.match(list.out, /● team-1\s+anthropic-account[^\n]*\n\s+routes: \(a Claude account: only the windows of team-2, team-3,/)
  const doc = await c.run('doctor')
  assert.ok(!/other-org[^\n]*(unused|no such usable provider)|(unused|no such usable provider)[^\n]*other-org/.test(doc.out), doc.out)
  assert.match(doc.out, /Fallback of team-3: ✓ team-1 \(same organization\), ✓ other-org \(allowCrossOrg\)/)
  assert.match(doc.out, /Fallback of team-1: ✓ team-2 \(same organization\), ✓ team-3 \(same organization\)/)
  leakFree(doc.out, 'doctor')
  // the router: a team-3 window at its limit, team-1 at its own: other-org, read from the keychain stand-in, serves
  const r = await listed(t, { accounts: { 'team-3': { fallback: ['team-1', { account: 'other-org', allowCrossOrg: true }] }, 'team-1': {}, 'other-org': {} }, logins: { 'team-3': { accountUuid: MAIN_UUID, organizationUuid: ORG }, 'team-1': { accountUuid: ACCTS['team-1'].uuid, organizationUuid: ORG }, 'other-org': { accountUuid: ACCTS['other-org'].uuid, organizationUuid: ORG2 } } })
  await r.register(W1, 'team-3')
  r.limited.add('main')
  r.limited.add('team-1')
  const x = await ask(r.port, { sid: W1, body: chainBody(W1) })
  assert.deepStrictEqual([x.status, from(x)], [200, 'other-org'], x.body)
  assert.deepStrictEqual(r.seen(), ['main', 'team-1', 'other-org'])
  assert.ok(r.calls().some((q) => q.args[4] === 'other-org' && q.args.includes('-w')), 'other-org\'s item read by the router')
  // the "fallback 9 (setup CLI)" config with dirs that hold no login: doctor's org line for team-1 -> spare
  const old = await cli(t, { cfg: { accountFallback: { mode: 'switch', account: 'spare' }, accounts: { 'team-1': { configDir: '/nowhere-1', fallback: 'spare' }, spare: { configDir: '/nowhere-2' } }, failover: { enabled: true, chain: ['other'] } } })
  const unreadable = await old.run('doctor')
  // W-8: a login that is not there yet says to log in, with the command, not that the organizations differ
  assert.match(unreadable.out, /Fallback of team-1: ✗ spare \(team-1 is not logged in yet: run CLAUDE_CONFIG_DIR=\/nowhere-1 MODEL_RELAY_CONFIG_DIR=\S+ claude, then \/login there; spare is not logged in yet: run CLAUDE_CONFIG_DIR=\/nowhere-2 MODEL_RELAY_CONFIG_DIR=\S+ claude, then \/login there\)/)
  assert.match(unreadable.out, /⚠ team-1's fallback spare is skipped: team-1 is not logged in yet/)
  assert.ok(!unreadable.out.includes('not in one organization'), unreadable.out)
})

// ---------- guidance on the account paths ----------

test('B10: an account that cannot serve a request says what to do next, and the reason still quotes nothing from the body', async (t) => {
  const r = await chained(t, { chain: ['other'], retry: { failover: true } })
  await r.register(W1)
  await r.ready(W1)
  r.state.limited = true
  const bad = reminderBody(['<system-reminder>\nnothing here\n</system-reminder>', sentence(MAIN_EMAIL)], uidS(W1))
  const x = await ask(r.port, { sid: W1, body: bad })
  assert.strictEqual(x.status, 502, x.body)
  const message = JSON.parse(x.body).error.message
  // a window of team-1, whose own account is at its limit: it is not sent back there
  assert.match(message, /^model-relay router: account "spare" could not serve this request: .+; nothing was sent with that account, and this window's own account is at its usage limit\. Continue in spare's own login \(\/provider switch, then \/exit, when it is the account accountFallback\.account names; otherwise start Claude Code with CLAUDE_CONFIG_DIR set to its folder and --continue\), or wait for the limit to reset; details in model-relay\.log$/)
  assert.ok(!message.includes('/provider claude'), message)
  assert.ok(!x.body.includes(MAIN_EMAIL) && !x.body.includes(MAIN_DEV))
  assert.match(r.routerLog(), /provider "spare" not used for this request: /, 'the details are in the log')
})

test('B13: the router\'s refusal to register the relay\'s own account says your own windows', async (t) => {
  const r = await listed(t, { home: true, accounts: selfAccounts(['team-2']) })
  const x = await control(r.port, '/__account', { sid: M1, account: 'own' })
  assert.strictEqual(x.status, 400)
  const message = JSON.parse(x.body).error.message
  assert.ok(message.includes('its windows are your own windows and are not registered') && !/\bmain\b/.test(message), message)
})

test('B14 (router): an account window at its usage limit with no fallback list reports accountLimited, its 429 comes back as sent, and the flag ends with the cooldown; a body of another account marks nothing', async (t) => {
  const r = await chained(t, { fallback: null, clock: true })
  await r.register(W1)
  assert.strictEqual((await r.health(W1)).accountLimited, undefined, 'not before a limit')
  r.state.limited = true
  // a request that is not team-1\'s own marks nothing
  const stranger = await ask(r.port, { sid: W1, body: chainBody(W1, SPARE_UUID) })
  assert.strictEqual(stranger.status, 429)
  assert.strictEqual((await r.health(W1)).accountLimited, undefined, 'a body with another account_uuid')
  const x = await ask(r.port, { sid: W1, body: chainBody(W1) })
  assert.deepStrictEqual([x.status, x.body], [429, USAGE_LIMIT[2]], 'passed back byte for byte')
  const h = await r.health(W1)
  assert.deepStrictEqual([h.accountLimited, h.accountServing, h.account], [true, undefined, 'team-1'])
  assert.strictEqual((await r.health()).accountLimited, undefined, 'a main window never has it')
  assert.strictEqual((await r.health(W2)).accountLimited, undefined, 'nor another window')
  assert.match(r.routerLog(), /account team-1 hit its usage limit: it has no fallback list; passed back \(session 0a0b0c0d\)/)
  assert.deepStrictEqual(await r.mainState(), MAIN_STATE, 'main\'s state untouched')
  r.state.limited = false
  r.advance(600001)
  assert.strictEqual((await r.health(W1)).accountLimited, undefined, 'the cooldown is over')
})

test('B14 (router): a fallback list whose every account is at its own limit also reports accountLimited, and a list that serves does not', async (t) => {
  const r = await chained(t, { spare: () => SPARE_LIMIT, chain: ['other'], retry: { attempts: 3, failover: true } })
  await r.register(W1)
  await r.ready(W1)
  r.state.limited = true
  const x = await ask(r.port, { sid: W1, body: chainBody(W1) })
  assert.strictEqual(x.status, 429)
  const h = await r.health(W1)
  assert.deepStrictEqual([h.accountLimited, h.accountServing], [true, undefined])
  const ok = await chained(t)
  await ok.register(W1)
  await ok.ready(W1)
  ok.state.limited = true
  assert.strictEqual(from(await ask(ok.port, { sid: W1, body: chainBody(W1) })), 'spare')
  const served = await ok.health(W1)
  assert.deepStrictEqual([served.accountLimited, served.accountServing], [undefined, 'spare'])
})

test('selfServing P3: no selfServing for a main window that decide sends to a provider, though the relay\'s own account is at its usage limit', async (t) => {
  const r = await listed(t, { home: true, accounts: selfAccounts(['team-2']) })
  r.limited.add('main')
  assert.strictEqual(from(await ask(r.port, { sid: M1, body: chainBody(M1) })), 'team-2', 'the relay\'s own account limited: team-2 serves')
  assert.strictEqual((await r.health(M3)).selfServing, 'team-2', 'a fresh main window is served by it')
  // a request that names no readable account meets the limit: main\'s failover starts, and a fresh window goes to its provider
  assert.strictEqual(from(await ask(r.port, { sid: M2, body: chainBody(M2, 'not-an-account-uuid') })), 'other', 'main\'s failover')
  const st = await r.mainState()
  assert.ok(st.failoverSince > 0)
  const h = await r.health(M3)
  assert.strictEqual(h.selfServing, undefined, 'decide sends this window to the chain provider')
  assert.strictEqual(from(await ask(r.port, { sid: M3, body: chainBody(M3) })), 'other', 'and its request really goes there')
})

test('B16, A10: account-add\'s keychain step says why the default keychain matters and what to do, and the output carries the risk line', async (t) => {
  const c = await homeCli(t, { accountFallback: { mode: 'switch' }, accounts: {}, providers: {} })
  fs.mkdirSync(path.join(c.relayDir, 'projects'))
  const x = await c.run('account-add', 'team-3')
  assert.strictEqual(x.code, 0, x.out)
  assert.match(x.out, /4\. step 5 adds to your default keychain, and the router reads only login\.keychain-db: `security default-keychain` must print it \(if it does not, run `security default-keychain -s ~\/Library\/Keychains\/login\.keychain-db` first\)/)
  assert.ok(!x.out.includes('the keychain the router reads'), 'the old reason is gone')
  assert.match(x.out, /Terms: moving a window to team-3 \(mode "switch"\) uses team-3's own login and replaces nothing\. Only the token steps below \(rc-keep, api-only, fallback lists\) send your requests with team-3's token and its identity values in place of yours, which can conflict with Anthropic's terms of use; that risk is yours\./) // W-3
})

test('C7: the keychain service the printed steps name is model-relay-<name>, in the item to add and in the account-token command', async (t) => {
  const c = await homeCli(t, { accountFallback: { mode: 'switch' }, accounts: {}, providers: {} })
  fs.mkdirSync(path.join(c.relayDir, 'projects'))
  const x = await c.run('account-add', 'team-3')
  assert.match(x.out, /security add-generic-password -s model-relay-team-3 -a team-3 -w /)
  assert.match(x.out, /account-token team-3 keychain:model-relay-team-3\/team-3/)
  assert.ok(!x.out.includes('claude-oauth'), x.out)
})
