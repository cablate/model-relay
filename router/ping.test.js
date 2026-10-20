'use strict'
// The upstream test behind /__ping and "doctor --ping": what each answer means, and that a key never shows in it.
const test = require('node:test')
const assert = require('node:assert')
const http = require('node:http')
const P = require('./ping')

function upstream(t, handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler)
    server.listen(0, '127.0.0.1', () => {
      t.after(() => server.close())
      resolve(`http://127.0.0.1:${server.address().port}`)
    })
  })
}
const provider = (url, extra = {}) => ({ name: 'aaa', url, token: 'SECRET-KEY', model: 'aaa-9[1m]', authHeader: 'x-api-key', ...extra })

test('each answer reads as one verdict', () => {
  assert.strictEqual(P.verdict(200, ''), 'ok')
  assert.strictEqual(P.verdict(401, ''), 'key')
  assert.strictEqual(P.verdict(403, ''), 'key')
  assert.strictEqual(P.verdict(429, ''), 'quota')
  assert.strictEqual(P.verdict(404, ''), 'model')
  assert.strictEqual(P.verdict(400, '{"error":{"message":"unknown model aaa-9"}}'), 'model')
  assert.strictEqual(P.verdict(400, 'bad request'), 'error')
  assert.strictEqual(P.verdict(0, '', 'ECONNREFUSED'), 'not-running')
  assert.strictEqual(P.verdict(0, '', 'ENOTFOUND'), 'unreachable')
  assert.strictEqual(P.verdict(0, '', 'timeout'), 'timeout')
})

test('a working provider is timed to its first byte, with the model sent as it travels', async (t) => {
  let seen = null
  const url = await upstream(t, (req, res) => {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      seen = { key: req.headers['x-api-key'], auth: req.headers.authorization, body: JSON.parse(body) }
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write('event: message_start\n\n') // and never ends: the test must not wait for the rest
    })
  })
  const r = await P.ping(provider(url))
  assert.strictEqual(r.verdict, 'ok')
  assert.ok(r.firstByteMs >= 0 && r.firstByteMs < 5000)
  assert.strictEqual(seen.key, 'SECRET-KEY')
  assert.strictEqual(seen.auth, undefined, 'only the header the provider asked for')
  assert.deepStrictEqual([seen.body.model, seen.body.max_tokens, seen.body.stream], ['aaa-9', 1, true])
})

test('a refused key is named, and the upstream echoing the key back does not print it', async (t) => {
  const url = await upstream(t, (req, res) => {
    res.writeHead(401, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: { message: `invalid key SECRET-KEY for this account` } }))
  })
  const r = await P.ping(provider(url))
  assert.strictEqual(r.verdict, 'key')
  assert.strictEqual(r.status, 401)
  assert.match(r.detail, /invalid key \*\*\* for this account/)
  assert.ok(!JSON.stringify(r).includes('SECRET'), 'the key is masked everywhere')
})

test('nothing listening, and an answer that never starts, are told apart', async (t) => {
  const closed = await new Promise((resolve) => {
    const s = http.createServer().listen(0, '127.0.0.1', () => {
      const port = s.address().port
      s.close(() => resolve(`http://127.0.0.1:${port}`))
    })
  })
  assert.strictEqual((await P.ping(provider(closed))).verdict, 'not-running')
  const silent = await upstream(t, () => {}) // takes the request and never answers
  const r = await P.ping(provider(silent), 300)
  assert.strictEqual(r.verdict, 'timeout')
})

test('a key that cannot go into a header is an answer, not a crash, and is not quoted', async () => {
  const r = await P.ping(provider('http://127.0.0.1:9', { token: 'SECRET-KEY\nX' }))
  assert.strictEqual(r.verdict, 'error')
  assert.ok(!JSON.stringify(r).includes('SECRET'), JSON.stringify(r))
})
