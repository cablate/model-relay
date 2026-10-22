'use strict'
// Inputs that used to take the router down or leave a caller waiting forever, and how a model name finds its provider.
const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const http = require('node:http')
const net = require('node:net')
const os = require('node:os')
const path = require('node:path')
const { spawn } = require('node:child_process')
const L = require('./logic')

const p = (url, model, extra = {}) => ({ baseUrl: url, token: 't', model, ...extra })

test("a provider's own model reaches it even when an earlier provider's pattern also matches", () => {
  const cfg = L.parseCfg({
    format: 2,
    providers: {
      luna: p('https://a.example', 'codex/gpt-6-luna'),
      sol: p('https://b.example', 'codex/gpt-6.1-sol'),
    },
  })
  assert.strictEqual(L.matchProviderByModel(cfg, 'codex/gpt-6.1-sol'), 'sol')
  assert.strictEqual(L.matchProviderByModel(cfg, 'codex/gpt-6-luna'), 'luna')
  assert.strictEqual(L.matchProviderByModel(cfg, 'codex/other'), 'luna', 'patterns still apply, in config order')
})

test('a provider whose model looks like Claude gets no default pattern, so it never catches every Claude request', () => {
  const cfg = L.parseCfg({ format: 2, providers: { proxy: p('https://a.example', 'claude-sonnet-5-5-custom') } })
  assert.deepStrictEqual(cfg.providers.proxy.matchSources, [])
  assert.strictEqual(L.matchProviderByModel(cfg, 'claude-opus-5-5'), null)
  assert.strictEqual(L.matchProviderByModel(cfg, 'claude-sonnet-5-5-custom'), 'proxy', 'its own model still reaches it')
})

test('a provider address that is not a URL drops that provider instead of failing later', () => {
  for (const url of ['https://', 'http://exa mple.com', 'https://:99999']) {
    assert.strictEqual(L.parseProvider('x', p(url, 'm')), null, url)
  }
  assert.ok(L.parseProvider('x', p('http://127.0.0.1:3425', 'm')))
})

test('a claudeUrl that is not a URL falls back to Anthropic', () => {
  const cfg = L.parseCfg({ format: 2, claudeUrl: 'api.anthropic.com', providers: { x: p('https://a.example', 'm') } })
  assert.strictEqual(cfg.claudeUrl, 'https://api.anthropic.com')
})

test('idleTimeoutMs defaults to five minutes and stays at a second or more', () => {
  const base = { format: 2, providers: { x: p('https://a.example', 'm') } }
  assert.strictEqual(L.parseCfg(base).idleTimeoutMs, 300000)
  assert.strictEqual(L.parseCfg({ ...base, idleTimeoutMs: 5 }).idleTimeoutMs, 1000)
  assert.strictEqual(L.parseCfg({ ...base, idleTimeoutMs: 20000 }).idleTimeoutMs, 20000)
})

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const listen = (srv) => new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv.address().port)))

async function startRouter(t, upstream, extra = {}) {
  const up = http.createServer(upstream)
  const upPort = await listen(up)
  const probe = net.createServer()
  const port = await listen(probe)
  await new Promise((r) => probe.close(r))
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-hard-'))
  fs.writeFileSync(path.join(dir, 'model-relay.json'), JSON.stringify({
    format: 2,
    port,
    claudeUrl: `http://127.0.0.1:${upPort}`,
    retry: { enabled: false },
    providers: { one: p(`http://127.0.0.1:${upPort}`, 'one-model') },
    ...extra,
  }))
  const child = spawn(process.execPath, [path.join(__dirname, 'router.js'), dir], { stdio: 'ignore' })
  t.after(() => {
    child.kill()
    up.closeAllConnections?.()
    up.close()
  })
  for (let i = 0; i < 60; i++) {
    const ok = await new Promise((resolve) => http.get(`http://127.0.0.1:${port}/__health`, (r) => { r.resume(); resolve(true) }).on('error', () => resolve(false)))
    if (ok) break
    await sleep(100)
  }
  return { port, child }
}

function post(port, pathName, body) {
  return new Promise((resolve, reject) => {
    const data = typeof body === 'string' ? body : JSON.stringify(body)
    const req = http.request({ host: '127.0.0.1', port, path: pathName, method: 'POST', headers: { 'content-length': Buffer.byteLength(data) } }, (res) => {
      const ch = []
      res.on('data', (c) => ch.push(c))
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(ch).toString('utf8') }))
      res.on('error', reject)
    })
    req.on('error', reject)
    req.end(data)
  })
}

const alive = (port) => new Promise((resolve) => http.get(`http://127.0.0.1:${port}/__health`, (r) => { r.resume(); resolve(r.statusCode === 200) }).on('error', () => resolve(false)))

test('end to end: a session id that is not a string is refused and the router keeps running', async (t) => {
  const { port } = await startRouter(t, (req, res) => res.end('{}'))
  const r = await post(port, '/__session', { sid: 123, on: 'one' })
  assert.strictEqual(r.status, 400)
  assert.ok(await alive(port))
})

test('end to end: a provider that sends an error status and then drops the body still gets the caller an answer', async (t) => {
  const { port } = await startRouter(t, (req, res) => {
    req.resume()
    res.writeHead(503, { 'content-type': 'application/json' })
    res.write('{"partial":')
    setTimeout(() => res.socket.destroy(), 50)
  })
  const r = await Promise.race([post(port, '/v1/messages', { model: 'one-model', messages: [] }), sleep(5000).then(() => 'hung')])
  assert.notStrictEqual(r, 'hung', 'the caller was left waiting')
  assert.strictEqual(r.status, 502)
  assert.ok(await alive(port))
})

test('end to end: a provider that goes silent is cut off after idleTimeoutMs', async (t) => {
  const { port } = await startRouter(t, (req) => req.resume(), { idleTimeoutMs: 1000 })
  const started = Date.now()
  const r = await Promise.race([post(port, '/v1/messages', { model: 'one-model', messages: [] }), sleep(8000).then(() => 'hung')])
  assert.notStrictEqual(r, 'hung', 'the caller was left waiting')
  assert.strictEqual(r.status, 502)
  assert.ok(Date.now() - started < 6000)
})
