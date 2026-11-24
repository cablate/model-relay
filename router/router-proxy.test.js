'use strict'
// End to end: a real router process, a fake Anthropic, a fake provider, and a client that does what Claude Code does
// with HTTPS_PROXY — CONNECT, then TLS to api.anthropic.com trusting only the relay's CA.
const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const http = require('node:http')
const net = require('node:net')
const os = require('node:os')
const path = require('node:path')
const tls = require('node:tls')
const { spawn } = require('node:child_process')
const PKI = require('./pki')

const HOST = 'api.anthropic.com'
const listen = (server) => new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)))
const freePort = async () => {
  const s = net.createServer()
  const p = await listen(s)
  await new Promise((r) => s.close(r))
  return p
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function waitHealth(port) {
  for (let i = 0; i < 60; i++) {
    const ok = await new Promise((resolve) => {
      http.get(`http://127.0.0.1:${port}/__health`, (res) => {
        res.resume()
        resolve(res.statusCode === 200)
      }).on('error', () => resolve(false))
    })
    if (ok) return
    await sleep(100)
  }
  throw new Error('router did not come up')
}

const getJson = (port, p) =>
  new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:${port}${p}`, (res) => {
      const ch = []
      res.on('data', (c) => ch.push(c))
      res.on('end', () => resolve(JSON.parse(Buffer.concat(ch).toString('utf8'))))
    }).on('error', reject)
  })

function connectTunnel(routerPort, authority) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: routerPort, method: 'CONNECT', path: authority })
    // the router is killed at the end of each test, which resets any socket still open; that is not a failure
    req.on('connect', (res, socket) => {
      socket.on('error', () => {})
      resolve({ res, socket })
    })
    req.on('error', reject)
    req.end()
  })
}

// One HTTPS request through the tunnel, validating the certificate the way Claude Code would
function viaTunnel(socket, ca, { method = 'POST', p, headers = {}, body = '' }) {
  return new Promise((resolve, reject) => {
    // Plain http.request on a ready-made TLS socket: https.request would ignore it and dial the real host
    const secure = tls.connect({ socket, servername: HOST, ca })
    secure.on('error', () => {})
    const req = http.request({
      host: HOST,
      method,
      path: p,
      headers: { ...headers, 'content-length': Buffer.byteLength(body) },
      createConnection: () => secure, // no `agent` option, otherwise Node ignores createConnection
    }, (res) => {
      const ch = []
      res.on('data', (c) => ch.push(c))
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(ch).toString('utf8') }))
    })
    req.on('error', reject)
    req.end(body)
  })
}

async function setup(t, opts = {}) {
  const seen = { anthropic: [], provider: [], upgrades: [] }
  const anthropic = http.createServer((req, res) => {
    const ch = []
    req.on('data', (c) => ch.push(c))
    req.on('end', () => {
      seen.anthropic.push({ method: req.method, url: req.url, host: req.headers.host, auth: req.headers.authorization, body: Buffer.concat(ch).toString('utf8') })
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ from: 'anthropic', url: req.url }))
    })
  })
  anthropic.on('upgrade', (req, socket) => {
    seen.upgrades.push({ url: req.url, host: req.headers.host })
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n')
    socket.on('error', () => {})
    socket.on('data', (d) => socket.write(Buffer.concat([Buffer.from('echo:'), d])))
  })
  const provider = http.createServer((req, res) => {
    const ch = []
    req.on('data', (c) => ch.push(c))
    req.on('end', () => {
      seen.provider.push({ url: req.url, auth: req.headers.authorization, body: Buffer.concat(ch).toString('utf8') })
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ from: 'provider' }))
    })
  })
  const anthropicPort = await listen(anthropic)
  const providerPort = await listen(provider)
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-proxy-'))
  const port = await freePort()
  fs.writeFileSync(path.join(dir, 'model-relay.json'), JSON.stringify({
    format: 2,
    port,
    claudeUrl: `http://127.0.0.1:${anthropicPort}`,
    proxy: { enabled: opts.proxy === false ? false : true },
    providers: { glm: { baseUrl: `http://127.0.0.1:${providerPort}`, token: 'provider-token', model: 'glm-5.3' } },
  }))
  const pki = PKI.ensure(dir, { hosts: [HOST] })
  const child = spawn(process.execPath, [path.join(__dirname, 'router.js'), dir], {
    stdio: 'ignore',
    // proxy settings in the parent must not leak into the router; the router scrubs them itself
    env: { ...process.env, HTTPS_PROXY: 'http://127.0.0.1:9' },
  })
  t.after(() => {
    child.kill()
    anthropic.close()
    provider.close()
  })
  await waitHealth(port)
  return { seen, port, dir, pki, ca: fs.readFileSync(pki.ca, 'utf8'), anthropicPort }
}

test('a model call for a Claude model goes through the tunnel to Anthropic', async (t) => {
  const env = await setup(t)
  const { res, socket } = await connectTunnel(env.port, `${HOST}:443`)
  assert.strictEqual(res.statusCode, 200)
  const r = await viaTunnel(socket, env.ca, { p: '/v1/messages?beta=true', headers: { authorization: 'Bearer oauth', 'content-type': 'application/json', 'x-claude-code-session-id': 's1' }, body: JSON.stringify({ model: 'claude-opus-5-5', messages: [{ role: 'user', content: 'hi' }] }) })
  assert.strictEqual(r.status, 200, r.body)
  assert.strictEqual(JSON.parse(r.body).from, 'anthropic')
  const hit = env.seen.anthropic.at(-1)
  assert.strictEqual(hit.url, '/v1/messages?beta=true')
  assert.strictEqual(hit.auth, 'Bearer oauth', 'the caller credentials reach Anthropic untouched')
  assert.strictEqual(env.seen.provider.length, 0)
})

test('a model call for a custom provider is routed there with the provider token', async (t) => {
  const env = await setup(t)
  const { socket } = await connectTunnel(env.port, `${HOST}:443`)
  const r = await viaTunnel(socket, env.ca, { p: '/v1/messages', headers: { authorization: 'Bearer oauth', 'content-type': 'application/json' }, body: JSON.stringify({ model: 'glm-5.3', messages: [] }) })
  assert.strictEqual(JSON.parse(r.body).from, 'provider')
  const hit = env.seen.provider.at(-1)
  assert.strictEqual(hit.auth, 'Bearer provider-token', 'the OAuth token is replaced, never sent to a third party')
  assert.strictEqual(env.seen.anthropic.length, 0)
})

test('anything that is not a model call is passed straight to Anthropic, even for a session pinned to a provider', async (t) => {
  const env = await setup(t)
  const pin = await new Promise((resolve) => {
    const body = JSON.stringify({ sid: 'pinned', on: 'glm' })
    const req = http.request({ host: '127.0.0.1', port: env.port, path: '/__session', method: 'POST', headers: { 'content-length': Buffer.byteLength(body) } }, (res) => {
      res.resume()
      res.on('end', () => resolve(res.statusCode))
    })
    req.end(body)
  })
  assert.strictEqual(pin, 200)
  const { socket } = await connectTunnel(env.port, `${HOST}:443`)
  const r = await viaTunnel(socket, env.ca, { p: '/v1/oauth/token', headers: { 'content-type': 'application/json', 'x-claude-code-session-id': 'pinned' }, body: '{"grant_type":"refresh_token"}' })
  assert.strictEqual(JSON.parse(r.body).from, 'anthropic')
  assert.strictEqual(env.seen.provider.length, 0, 'a token refresh must never reach a provider')
  assert.strictEqual(env.seen.anthropic.at(-1).body, '{"grant_type":"refresh_token"}')
})

test('a WebSocket-style upgrade is forwarded untouched', async (t) => {
  const env = await setup(t)
  const { socket } = await connectTunnel(env.port, `${HOST}:443`)
  const secure = tls.connect({ socket, servername: HOST, ca: env.ca })
  secure.on('error', () => {})
  await new Promise((resolve, reject) => {
    secure.once('secureConnect', resolve)
    secure.once('error', reject)
  })
  secure.write(`GET /v1/session_ingress/ws HTTP/1.1\r\nHost: ${HOST}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Key: x\r\n\r\n`)
  const head = await new Promise((resolve) => secure.once('data', (d) => resolve(d.toString('utf8'))))
  assert.match(head, /^HTTP\/1\.1 101/)
  secure.write('ping')
  const echoed = await new Promise((resolve) => secure.once('data', (d) => resolve(d.toString('utf8'))))
  assert.strictEqual(echoed, 'echo:ping')
  assert.strictEqual(env.seen.upgrades.at(-1).host, HOST)
  secure.destroy()
})

test('other hosts are a blind byte tunnel', async (t) => {
  const env = await setup(t)
  const echo = net.createServer((s) => {
    s.on('error', () => {})
    s.on('data', (d) => s.write(Buffer.concat([Buffer.from('raw:'), d])))
  })
  const echoPort = await listen(echo)
  t.after(() => echo.close())
  const { res, socket } = await connectTunnel(env.port, `127.0.0.1:${echoPort}`)
  assert.strictEqual(res.statusCode, 200)
  socket.write('hello')
  const got = await new Promise((resolve) => socket.once('data', (d) => resolve(d.toString('utf8'))))
  assert.strictEqual(got, 'raw:hello')
  socket.destroy()
})

test('an unreachable tunnel target answers 502 instead of hanging', async (t) => {
  const env = await setup(t)
  const dead = await freePort()
  const { res } = await connectTunnel(env.port, `127.0.0.1:${dead}`).catch(() => ({ res: { statusCode: 502 } }))
  assert.strictEqual(res.statusCode, 502)
})

test('the router reports proxy state, counts tunnels, and does not use its own proxy', async (t) => {
  const env = await setup(t)
  await connectTunnel(env.port, `${HOST}:443`)
  const h = await getJson(env.port, '/__health')
  assert.strictEqual(h.proxy.enabled, true)
  assert.strictEqual(h.proxy.certificate, true)
  assert.ok(h.proxy.mitm >= 1)
})

test('without a certificate the router still answers and reports it', async (t) => {
  const env = await setup(t)
  for (const f of ['ca.pem', 'leaf.pem', 'leaf.key']) fs.rmSync(path.join(env.pki.dir, f))
  await sleep(10500) // the router re-checks the files at most every 10 seconds
  const h = await getJson(env.port, '/__health')
  assert.strictEqual(h.proxy.certificate, false)
})

test('with proxy mode off the router refuses CONNECT and does not act as an open tunnel', async (t) => {
  const env = await setup(t, { proxy: false })
  const echo = net.createServer((s) => s.on('error', () => {}))
  const echoPort = await listen(echo)
  t.after(() => echo.close())
  for (const authority of [`${HOST}:443`, `127.0.0.1:${echoPort}`]) {
    const { res, socket } = await connectTunnel(env.port, authority).catch(() => ({ res: { statusCode: 0 } }))
    assert.strictEqual(res.statusCode, 403, authority)
    socket && socket.destroy()
  }
  const h = await getJson(env.port, '/__health')
  assert.strictEqual(h.proxy.enabled, false)
  assert.strictEqual(h.proxy.mitm + h.proxy.tunnel, 0)
})

// ---------- the plain-HTTP side serves only this machine ----------

function call(port, { method = 'GET', p, headers = {}, body = '' }) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: p, headers: { ...headers, 'content-length': Buffer.byteLength(body) } }, (res) => {
      const ch = []
      res.on('data', (c) => ch.push(c))
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(ch).toString('utf8') }))
    })
    req.on('error', reject)
    req.end(body)
  })
}

test('a foreign Host, any browser request or an absolute-form URL is refused before any routing or control', async (t) => {
  const env = await setup(t, { proxy: false })
  const msg = JSON.stringify({ model: 'glm-5.3', messages: [] })
  const refused = [
    // DNS rebinding: a page on evil.test resolved to 127.0.0.1 sends its own name as Host
    [{ method: 'POST', p: '/v1/messages', headers: { host: `evil.test:${env.port}`, 'content-type': 'text/plain' }, body: msg }, 'rebound Host'],
    [{ p: '/__health', headers: { host: 'evil.test' } }, 'rebound Host on control'],
    // A simple cross-site POST from a page: right Host, foreign Origin
    [{ method: 'POST', p: '/__probe', headers: { origin: 'https://evil.test' } }, 'foreign Origin on control'],
    [{ method: 'POST', p: '/v1/messages', headers: { origin: 'null', 'content-type': 'text/plain' }, body: msg }, 'Origin null'],
    // Another local server (a dev server, Jupyter) is still a browser page
    [{ method: 'POST', p: '/v1/messages', headers: { origin: 'http://localhost:3000', 'content-type': 'text/plain' }, body: msg }, 'local Origin'],
    // <img src="http://127.0.0.1:port/v1/messages">: no Origin, but the browser marks it
    [{ p: '/v1/messages', headers: { 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'no-cors' } }, 'no-cors GET'],
    // Absolute-form request line with a loopback Host
    [{ method: 'POST', p: 'http://example.com/v1/messages', body: msg }, 'absolute-form URL'],
  ]
  for (const [opts, why] of refused) {
    const r = await call(env.port, opts)
    assert.strictEqual(r.status, 403, `${why}: ${r.body}`)
  }
  assert.strictEqual(env.seen.provider.length + env.seen.anthropic.length, 0, 'nothing was spent upstream')
  assert.strictEqual((await call(env.port, { p: '/__health' })).status, 200, 'a plain local call still works')
  assert.strictEqual((await call(env.port, { p: '/__health', headers: { host: `localhost:${env.port}` } })).status, 200)
  // A Node program using the built-in fetch (it adds sec-fetch-mode: cors) is a local client, not a browser
  const r = await fetch(`http://127.0.0.1:${env.port}/__health`)
  assert.strictEqual(r.status, 200, await r.text())
})

test('/__session refuses an Object.prototype name as a provider', async (t) => {
  const env = await setup(t, { proxy: false })
  for (const on of ['constructor', 'toString', '__proto__']) {
    const r = await call(env.port, { method: 'POST', p: '/__session', body: JSON.stringify({ sid: 's', on }) })
    assert.strictEqual(r.status, 400, `${on}: ${r.body}`)
  }
})

test('the Host check follows the port the router holds, not a port edited into the file later', async (t) => {
  const env = await setup(t, { proxy: false })
  const file = path.join(env.dir, 'model-relay.json')
  const other = await freePort()
  fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, 'utf8')), port: other }))
  const h = await call(env.port, { p: '/__health' })
  assert.strictEqual(h.status, 200, h.body)
  const stale = await call(env.port, { p: '/__health', headers: { host: `127.0.0.1:${other}` } })
  assert.strictEqual(stale.status, 403, 'a Host naming the edited port is not this router')
})

// ---------- Per-provider models/efforts & hardened single-writer status (SEC-01, SEC-02, SEC-03, SEC-05) ----------

async function startCustomRouter(t, cfgOverrides, handlers = {}) {
  const seen = { anthropic: [], providers: {} }
  const anthropic = http.createServer((req, res) => {
    const ch = []
    req.on('data', (c) => ch.push(c))
    req.on('end', () => {
      const body = Buffer.concat(ch).toString('utf8')
      seen.anthropic.push({ url: req.url, body })
      if (handlers.anthropic) return handlers.anthropic(req, res, body)
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ from: 'anthropic' }))
    })
  })
  const anthropicPort = await listen(anthropic)
  const servers = [anthropic]
  const providerPorts = {}
  for (const [name, fn] of Object.entries(handlers.providers || {})) {
    seen.providers[name] = []
    const srv = http.createServer((req, res) => {
      const ch = []
      req.on('data', (c) => ch.push(c))
      req.on('end', () => {
        const body = Buffer.concat(ch).toString('utf8')
        seen.providers[name].push({ url: req.url, body })
        fn(req, res, body)
      })
    })
    providerPorts[name] = await listen(srv)
    servers.push(srv)
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-models-'))
  const port = await freePort()
  const cfg = typeof cfgOverrides === 'function' ? cfgOverrides({ port, anthropicPort, providerPorts }) : { ...cfgOverrides, port, claudeUrl: `http://127.0.0.1:${anthropicPort}` }
  fs.writeFileSync(path.join(dir, 'model-relay.json'), JSON.stringify(cfg))
  const child = spawn(process.execPath, [path.join(__dirname, 'router.js'), dir], { stdio: 'ignore' })
  t.after(() => {
    child.kill()
    for (const s of servers) s.close()
    fs.rmSync(dir, { recursive: true, force: true })
  })
  await waitHealth(port)
  return { port, dir, seen }
}

test('SEC-01 & SEC-02: router writes atomic 0700/0600 status files, byModel does not clobber pinned status, bad sids and symlinked STATUS_DIR are refused', async (t) => {
  const env = await startCustomRouter(
    t,
    ({ port, anthropicPort, providerPorts }) => ({
      format: 2,
      port,
      claudeUrl: `http://127.0.0.1:${anthropicPort}`,
      providers: {
        alt: {
          baseUrl: `http://127.0.0.1:${providerPorts.alt}`,
          token: 'KEY-ALT',
          model: 'alt-primary',
          efforts: ['low', 'high'],
        },
      },
    }),
    {
      providers: {
        alt: (_req, res) => {
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ from: 'alt' }))
        },
      },
    },
  )
  const statusDir = path.join(env.dir, 'model-relay-status')

  // Claude request writes claude\tclaude\n
  const claudeReq = await call(env.port, {
    method: 'POST',
    p: '/v1/messages',
    headers: { 'content-type': 'application/json', 'x-claude-code-session-id': 'main-claude' },
    body: JSON.stringify({ model: 'claude-opus-5-5', messages: [{ role: 'user', content: 'hi' }] }),
  })
  assert.strictEqual(claudeReq.status, 200)
  assert.strictEqual(fs.readFileSync(path.join(statusDir, 'main-claude'), 'utf8'), 'claude\tclaude\n')
  if (process.platform !== 'win32') {
    assert.strictEqual(fs.statSync(statusDir).mode & 0o777, 0o700, 'STATUS_DIR mode is 0700')
    assert.strictEqual(fs.statSync(path.join(statusDir, 'main-claude')).mode & 0o777, 0o600, 'status file mode is 0600')
  }

  // Pinned session status is NOT clobbered by a byModel (rewrite === false) subagent request carrying a different effort
  const pin = await call(env.port, { method: 'POST', p: '/__session', body: JSON.stringify({ sid: 'main-pinned', on: 'alt' }) })
  assert.strictEqual(pin.status, 200)
  assert.strictEqual(fs.readFileSync(path.join(statusDir, 'main-pinned'), 'utf8'), 'pinned\talt-primary\n')
  const byModel = await call(env.port, {
    method: 'POST',
    p: '/v1/messages',
    headers: { 'content-type': 'application/json', 'x-claude-code-session-id': 'main-pinned' },
    body: JSON.stringify({ model: 'alt-primary', output_config: { effort: 'low' }, messages: [{ role: 'user', content: 'subagent' }] }),
  })
  assert.strictEqual(byModel.status, 200)
  assert.strictEqual(fs.readFileSync(path.join(statusDir, 'main-pinned'), 'utf8'), 'pinned\talt-primary\n', 'byModel request does not clobber pinned status')
  const hPinned = await getJson(env.port, '/__health?sid=main-pinned')
  assert.strictEqual(hPinned.sessionEffort, null, 'byModel request does not pollute sessionLastRoute')

  // Unsafe sids write nothing to STATUS_DIR
  for (const badSid of ['../escape', '.dotfile', 'bad.limits', 'bad.tmp', 'bad.LIMITS', 'bad.TMP']) {
    await call(env.port, {
      method: 'POST',
      p: '/v1/messages',
      headers: { 'content-type': 'application/json', 'x-claude-code-session-id': badSid },
      body: JSON.stringify({ model: 'claude-opus-5-5', messages: [] }),
    })
  }
  assert.deepStrictEqual(fs.readdirSync(statusDir).sort(), ['main-claude', 'main-pinned'])

  // Symlinked STATUS_DIR is refused without writing to target
  if (process.platform !== 'win32') {
    const targetDir = path.join(env.dir, 'symlink-target')
    fs.mkdirSync(targetDir)
    fs.rmSync(statusDir, { recursive: true, force: true })
    fs.symlinkSync(targetDir, statusDir)
    const viaLink = await call(env.port, { method: 'POST', p: '/__session', body: JSON.stringify({ sid: 'via-link', on: 'alt' }) })
    assert.strictEqual(viaLink.status, 200)
    assert.deepStrictEqual(fs.readdirSync(targetDir), [], 'symlinked STATUS_DIR is refused')
  }
})

test('SEC-03 & SEC-05: /__session validates non-echoingly, /__health exposes metadata, multi-model/effort rewrites safely, and failover does not bleed', async (t) => {
  let failA = false
  const env = await startCustomRouter(
    t,
    ({ port, anthropicPort, providerPorts }) => ({
      format: 2,
      port,
      claudeUrl: `http://127.0.0.1:${anthropicPort}`,
      failover: { enabled: true, chain: ['prov-b'] },
      retry: { enabled: true, attempts: 1, delayMs: 5, maxDelayMs: 5, failover: true },
      providers: {
        'prov-a': {
          baseUrl: `http://127.0.0.1:${providerPorts['prov-a']}`,
          token: 'KEY-A',
          model: 'a-primary[1m]',
          efforts: ['low', 'high'],
          models: [
            'a-primary[1m]',
            { model: 'a-neon[1m]', efforts: ['high', 'xhigh'] },
            { model: 'a-fast', efforts: [] },
          ],
          fallback: ['prov-b'],
        },
        'prov-b': {
          baseUrl: `http://127.0.0.1:${providerPorts['prov-b']}`,
          token: 'KEY-B',
          model: 'b-primary',
          efforts: ['low'],
        },
      },
    }),
    {
      providers: {
        'prov-a': (_req, res) => {
          if (failA) {
            res.writeHead(500, { 'content-type': 'application/json' })
            return res.end('{"error":"boom"}')
          }
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ from: 'prov-a' }))
        },
        'prov-b': (_req, res) => {
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ from: 'prov-b' }))
        },
      },
    },
  )

  // /__health exposes providerModels and statusWriter: 'router'
  const h0 = await getJson(env.port, '/__health?sid=s-multi')
  assert.strictEqual(h0.statusWriter, 'router')
  assert.deepStrictEqual(h0.providerModels['prov-a'], [
    { model: 'a-primary[1m]', efforts: ['low', 'high'] },
    { model: 'a-neon[1m]', efforts: ['high', 'xhigh'] },
    { model: 'a-fast', efforts: [] },
  ])
  assert.strictEqual(h0.sessionModel, null)
  assert.strictEqual(h0.sessionEffort, null)

  // Reject invalid provider, model, effort, control chars, claude+model/effort, opt-out model+effort without echoing sensitive inputs
  const secretToken = 'SENSITIVE-INPUT-999'
  const rejects = [
    { sid: 's-multi', on: secretToken },
    { sid: 's-multi', on: 'prov-a', model: secretToken },
    { sid: 's-multi', on: 'prov-a', effort: secretToken },
    { sid: 's-multi', on: 'prov-a', model: `a-neon\n${secretToken}` },
    { sid: 's-multi', on: 'prov-a', effort: 'high\n' },
    { sid: 's-multi', on: 'prov-a', model: 'a-fast', effort: 'low' },
    { sid: 's-multi', on: 'claude', effort: 'high' },
    { sid: 's-multi', on: 'claude', model: secretToken },
    { sid: 'bad sid', on: 'prov-a' },
  ]
  for (const payload of rejects) {
    const res = await call(env.port, { method: 'POST', p: '/__session', body: JSON.stringify(payload) })
    assert.strictEqual(res.status, 400, JSON.stringify(payload))
    assert.ok(!res.body.includes(secretToken), `must not echo input: ${res.body}`)
  }

  // Valid pin to prov-a with unique shorthand 'neon' + 'xhigh'
  const pinOk = await call(env.port, { method: 'POST', p: '/__session', body: JSON.stringify({ sid: 's-multi', on: 'prov-a', model: 'neon', effort: 'xhigh' }) })
  assert.strictEqual(pinOk.status, 200, pinOk.body)
  assert.deepStrictEqual(JSON.parse(pinOk.body), { ok: true, session: 'prov-a', model: 'a-neon[1m]', effort: 'xhigh' })

  // /__health reports pinned sessionModel + sessionEffort, status file has 3 fields
  const h1 = await getJson(env.port, '/__health?sid=s-multi')
  assert.strictEqual(h1.session, 'prov-a')
  assert.strictEqual(h1.sessionModel, 'a-neon[1m]')
  assert.strictEqual(h1.sessionEffort, 'xhigh')
  assert.strictEqual(fs.readFileSync(path.join(env.dir, 'model-relay-status', 's-multi'), 'utf8'), 'pinned\ta-neon[1m]\txhigh\n')

  // Request to prov-a gets rewritten wire model and output_config.effort, preserving sibling output_config.format
  const reqBody = JSON.stringify({ model: 'claude-opus-5-5', output_config: { format: { type: 'json' } }, messages: [{ role: 'user', content: 'hi' }] })
  const resA = await call(env.port, {
    method: 'POST',
    p: '/v1/messages',
    headers: { 'content-type': 'application/json', 'x-claude-code-session-id': 's-multi' },
    body: reqBody,
  })
  assert.strictEqual(resA.status, 200, resA.body)
  const sentA = JSON.parse(env.seen.providers['prov-a'].at(-1).body)
  assert.strictEqual(sentA.model, 'a-neon')
  assert.deepStrictEqual(sentA.output_config, { format: { type: 'json' }, effort: 'xhigh' })

  // Failover from prov-a to prov-b must NOT bleed prov-a's pinned model ('a-neon') or effort ('xhigh') onto prov-b
  failA = true
  const resB = await call(env.port, {
    method: 'POST',
    p: '/v1/messages',
    headers: { 'content-type': 'application/json', 'x-claude-code-session-id': 's-multi' },
    body: reqBody,
  })
  assert.strictEqual(resB.status, 200, resB.body)
  assert.strictEqual(JSON.parse(resB.body).from, 'prov-b')
  const sentB = JSON.parse(env.seen.providers['prov-b'].at(-1).body)
  assert.strictEqual(sentB.model, 'b-primary', 'fallback uses B primary model, never A pinned model')
  assert.deepStrictEqual(sentB.output_config, { format: { type: 'json' } }, 'A effort never bleeds onto fallback B')

  // Switching back to claude clears pin and resets status file to 2-field claude line
  const backClaude = await call(env.port, { method: 'POST', p: '/__session', body: JSON.stringify({ sid: 's-multi', on: 'claude' }) })
  assert.strictEqual(backClaude.status, 200, backClaude.body)
  assert.strictEqual(fs.readFileSync(path.join(env.dir, 'model-relay-status', 's-multi'), 'utf8'), 'claude\tclaude\n')
  const h2 = await getJson(env.port, '/__health?sid=s-multi')
  assert.strictEqual(h2.session, 'claude')
  assert.strictEqual(h2.sessionModel, null)
  assert.strictEqual(h2.sessionEffort, null)
})
