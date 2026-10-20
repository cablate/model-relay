'use strict'
// Install-flow guards: setup wires the configured port, `set port` rewires, two routers on one port are told apart by
// config directory, and setup refuses to work against someone else's router. Every port is ephemeral and set through a temp config.
const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const http = require('node:http')
const net = require('node:net')
const os = require('node:os')
const path = require('node:path')
const { spawn, spawnSync } = require('node:child_process')

const SETUP = path.join(__dirname, '..', 'tools', 'setup.mjs')
const ROUTER = path.join(__dirname, 'router.js')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function freePort() {
  const s = net.createServer()
  await new Promise((r) => s.listen(0, '127.0.0.1', r))
  const p = s.address().port
  await new Promise((r) => s.close(r))
  return p
}

function getHealth(port) {
  return new Promise((resolve) => {
    http.get(`http://127.0.0.1:${port}/__health`, (res) => {
      const ch = []
      res.on('data', (c) => ch.push(c))
      res.on('end', () => resolve(JSON.parse(Buffer.concat(ch).toString('utf8'))))
    }).on('error', () => resolve(null))
  })
}

async function waitHealth(port) {
  for (let i = 0; i < 60; i++) {
    const h = await getHealth(port)
    if (h) return h
    await sleep(100)
  }
  throw new Error('router did not come up')
}

function configDir(t, port, extra = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-flow-'))
  fs.writeFileSync(path.join(dir, 'model-relay.json'), JSON.stringify({ port, providers: { glm: { baseUrl: 'http://127.0.0.1:9', token: 'dummy', model: 'glm-5.3' } }, ...extra }))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return dir
}

const routerLog = (dir) => {
  try {
    return fs.readFileSync(path.join(dir, 'custom-agent-router.log'), 'utf8')
  } catch {
    return ''
  }
}

function startRouter(t, dir) {
  const child = spawn(process.execPath, [ROUTER, dir], { stdio: 'ignore' })
  t.after(() => child.kill())
  const exited = new Promise((r) => child.on('exit', (code) => r(code)))
  return { child, exited }
}

const setup = (dir, ...args) => {
  const env = { ...process.env, CLAUDE_CONFIG_DIR: dir }
  delete env.NODE_EXTRA_CA_CERTS // a Claude Code session in proxy mode carries its own; proxy enable would refuse it
  const r = spawnSync(process.execPath, [SETUP, ...args], { encoding: 'utf8', env })
  return { code: r.status, out: `${r.stdout}${r.stderr}` }
}
const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'))

test('init --fix wires settings.json to the configured port, not 8950', async (t) => {
  const port = await freePort()
  const dir = configDir(t, port)
  const r = setup(dir, 'init', '--fix')
  assert.strictEqual(r.code, 0, r.out)
  assert.strictEqual(readJson(path.join(dir, 'settings.json')).env.ANTHROPIC_BASE_URL, `http://127.0.0.1:${port}`)
})

test('set port validates, saves a copy, says the router must restart, and rewires settings.json in either mode', async (t) => {
  const port = await freePort()
  const next = await freePort()
  const dir = configDir(t, port)
  const cfg = path.join(dir, 'model-relay.json')
  const settings = path.join(dir, 'settings.json')
  for (const bad of ['80', '70000', 'abc', '1024']) {
    const r = setup(dir, 'set', 'port', bad)
    assert.strictEqual(r.code, 2, `${bad}: ${r.out}`)
    assert.match(r.out, /1025 to 65535/)
  }
  assert.strictEqual(readJson(cfg).port, port)

  fs.writeFileSync(settings, JSON.stringify({ model: 'sonnet', env: { FOO: '1', ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}` } }))
  const r = setup(dir, 'set', 'port', String(next))
  assert.strictEqual(r.code, 0, r.out)
  assert.match(r.out, /keeps port \d+ until it is stopped/)
  assert.strictEqual(readJson(cfg).port, next)
  assert.strictEqual(readJson(`${cfg}.relay-backup`).port, port)
  const s = readJson(settings)
  assert.deepStrictEqual(s, { model: 'sonnet', env: { FOO: '1', ANTHROPIC_BASE_URL: `http://127.0.0.1:${next}` } })
  assert.strictEqual(readJson(`${settings}.relay-backup`).env.ANTHROPIC_BASE_URL, `http://127.0.0.1:${port}`)

  const ca = path.join(dir, 'ca.pem')
  fs.writeFileSync(settings, JSON.stringify({ env: { HTTPS_PROXY: `http://127.0.0.1:${next}`, NODE_EXTRA_CA_CERTS: ca } }))
  assert.strictEqual(setup(dir, 'set', 'port', String(port)).code, 0)
  assert.deepStrictEqual(readJson(settings).env, { HTTPS_PROXY: `http://127.0.0.1:${port}`, NODE_EXTRA_CA_CERTS: ca })

  fs.writeFileSync(settings, JSON.stringify({ env: {} }))
  const none = setup(dir, 'set', 'port', String(next))
  assert.match(none.out, /doctor --fix/)
  assert.deepStrictEqual(readJson(settings), { env: {} }, 'settings that never pointed at the relay are left alone')
})

test('/__health reports the config dir, and a second router for the same dir exits quietly', async (t) => {
  const port = await freePort()
  const dir = configDir(t, port)
  startRouter(t, dir)
  const h = await waitHealth(port)
  assert.strictEqual(h.configDir, fs.realpathSync(dir))
  const again = startRouter(t, dir)
  assert.strictEqual(await again.exited, 0)
})

test('a router that finds its port taken by another config dir or an unknown process says so and exits non-zero', async (t) => {
  const port = await freePort()
  const dirA = configDir(t, port)
  const dirB = configDir(t, port)
  startRouter(t, dirA)
  await waitHealth(port)
  const b = startRouter(t, dirB)
  assert.notStrictEqual(await b.exited, 0)
  assert.match(routerLog(dirB), new RegExp(`port ${port} is already used by another model-relay router \\(config dir ${fs.realpathSync(dirA).replace(/[\\/.]/g, '\\$&')}\\)`))

  const port2 = await freePort()
  const plain = http.createServer((q, r) => r.end('not a relay'))
  await new Promise((r) => plain.listen(port2, '127.0.0.1', r))
  t.after(() => plain.close())
  const dirC = configDir(t, port2)
  const c = startRouter(t, dirC)
  assert.notStrictEqual(await c.exited, 0)
  assert.match(routerLog(dirC), /already used by an unknown process/)
})

test('doctor warns and proxy enable refuses when the router on the port belongs to another config dir', async (t) => {
  const port = await freePort()
  const other = configDir(t, port)
  const mine = configDir(t, port)
  startRouter(t, other)
  await waitHealth(port)
  const settings = path.join(mine, 'settings.json')
  const before = JSON.stringify({ env: { ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}` } })
  fs.writeFileSync(settings, before)
  const cfgBefore = fs.readFileSync(path.join(mine, 'model-relay.json'), 'utf8')

  const doc = setup(mine, 'doctor')
  assert.match(doc.out, /Router health: ⚠ .*belongs to config dir .*relay-flow-/)
  assert.ok(doc.out.includes(fs.realpathSync(other)) && doc.out.includes(mine))
  assert.ok(!/Router health: ✓/.test(doc.out))

  for (const args of [['proxy', 'enable'], ['proxy', 'enable', '--go']]) {
    const r = setup(mine, ...args)
    assert.strictEqual(r.code, 1, r.out)
    assert.match(r.out, /Refusing to enable: .*belongs to config dir/)
    assert.ok(r.out.includes(fs.realpathSync(other)) && r.out.includes(mine))
  }
  assert.strictEqual(fs.readFileSync(settings, 'utf8'), before)
  assert.strictEqual(fs.readFileSync(path.join(mine, 'model-relay.json'), 'utf8'), cfgBefore)
  assert.ok(!fs.existsSync(path.join(mine, 'model-relay-pki')))
  assert.match(setup(mine, 'proxy', 'status').out, /⚠ .*belongs to config dir/)
})

test('the router log is emptied past 5 MB like the request log', async (t) => {
  const port = await freePort()
  const dir = configDir(t, port)
  const file = path.join(dir, 'custom-agent-router.log')
  fs.writeFileSync(file, Buffer.alloc(5 * 1024 * 1024 + 10, 'x'))
  startRouter(t, dir)
  await waitHealth(port)
  assert.ok(fs.statSync(file).size < 1000)
})

test('set port refuses a port that already answers, names the old router to stop, and reports unreadable settings.json', async (t) => {
  const port = await freePort()
  const next = await freePort()
  const dir = configDir(t, port)
  const cfg = path.join(dir, 'model-relay.json')
  const before = fs.readFileSync(cfg, 'utf8')
  const plain = http.createServer((q, r) => r.end('x'))
  await new Promise((r) => plain.listen(next, '127.0.0.1', r))
  const refused = setup(dir, 'set', 'port', String(next))
  assert.strictEqual(refused.code, 1, refused.out)
  assert.match(refused.out, /already in use \(another process\)/)
  assert.strictEqual(fs.readFileSync(cfg, 'utf8'), before, 'nothing changed')
  await new Promise((r) => plain.close(r))

  const other = configDir(t, next)
  startRouter(t, other)
  await waitHealth(next)
  assert.match(setup(dir, 'set', 'port', String(next)).out, /a model-relay router for config dir .*relay-flow-/)
  assert.strictEqual(fs.readFileSync(cfg, 'utf8'), before)

  const free = await freePort()
  startRouter(t, dir)
  const mine = await waitHealth(port)
  fs.writeFileSync(path.join(dir, 'settings.json'), '{ nope')
  const r = setup(dir, 'set', 'port', String(free))
  assert.strictEqual(r.code, 0, r.out)
  assert.match(r.out, /settings.json is not valid JSON/)
  assert.ok(!/does not point/.test(r.out))
  assert.ok(r.out.includes(`kill ${mine.pid}`), r.out)
  assert.ok(await getHealth(port), 'the old router is not killed for you')
})

test('an older router (no configDir) is asked to restart by doctor and restarted by proxy enable, not refused', async (t) => {
  const port = await freePort()
  const dir = configDir(t, port)
  const old = spawn(process.execPath, ['-e', `require('http').createServer((q,r)=>r.end(JSON.stringify({ok:true,pid:process.pid}))).listen(${port},'127.0.0.1')`], { stdio: 'ignore' })
  t.after(() => old.kill())
  await waitHealth(port)
  t.after(async () => {
    const h = await getHealth(port)
    if (h && h.pid) try { process.kill(h.pid) } catch {}
  })
  const doc = setup(dir, 'doctor')
  assert.match(doc.out, /older model-relay router \(no configDir\).*restart it/)
  assert.ok(!/belongs to config dir/.test(doc.out))
  const go = setup(dir, 'proxy', 'enable', '--go')
  assert.strictEqual(go.code, 0, go.out)
  assert.match(go.out, /Restarting the router/)
  assert.strictEqual((await waitHealth(port)).configDir, fs.realpathSync(dir), 'the router now running is this dir\'s')
})

test('a router whose port is held by an older relay leaves it running and exits 0', async (t) => {
  const port = await freePort()
  const old = http.createServer((q, r) => r.end(JSON.stringify({ ok: true, pid: 1 })))
  await new Promise((r) => old.listen(port, '127.0.0.1', r))
  t.after(() => old.close())
  const dir = configDir(t, port)
  assert.strictEqual(await startRouter(t, dir).exited, 0)
  assert.match(routerLog(dir), /older model-relay router/)
})

test('a config whose only token is unset still binds its own port, and refuses CONNECT while the proxy is off', async (t) => {
  const port = await freePort()
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-flow-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  fs.writeFileSync(path.join(dir, 'model-relay.json'), JSON.stringify({ port, providers: { glm: { preset: 'zai', token: 'env:RELAY_FLOW_UNSET_TOKEN' } } }))
  startRouter(t, dir)
  assert.strictEqual((await waitHealth(port)).configDir, fs.realpathSync(dir))
  let dialled = 0
  const target = net.createServer((sock) => {
    dialled++
    sock.destroy()
  })
  await new Promise((r) => target.listen(0, '127.0.0.1', r))
  t.after(() => target.close())
  const status = await new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method: 'CONNECT', path: `127.0.0.1:${target.address().port}` })
    req.on('connect', (res, sock) => (sock.destroy(), resolve(res.statusCode)))
    req.on('error', reject)
    req.end()
  })
  assert.strictEqual(status, 403)
  assert.strictEqual(dialled, 0, 'nothing was dialled')
})

// ---------- restart: replace a router left running by an older plugin, never while it answers a request ----------

// A process that answers /__health like a router of another version; `body` gets its pid
function fakeRouter(t, port, body) {
  const src = `require('http').createServer((q,r)=>r.end(JSON.stringify({ok:true,pid:process.pid,...${JSON.stringify(body)}}))).listen(${port},'127.0.0.1')`
  const child = spawn(process.execPath, ['-e', src], { stdio: 'ignore' })
  t.after(() => child.kill())
  return child
}
const killHealth = (t, port) => t.after(async () => {
  const h = await getHealth(port)
  if (h && h.pid) try { process.kill(h.pid) } catch {}
})

test('/__health reports the plugin version and the requests in flight', async (t) => {
  const port = await freePort()
  const dir = configDir(t, port)
  startRouter(t, dir)
  const h = await waitHealth(port)
  assert.strictEqual(h.version, readJson(path.join(__dirname, '..', '.claude-plugin', 'plugin.json')).version)
  assert.strictEqual(h.inflight, 0)
})

test('a router from before 0.6.1 is never restarted by --if-idle, only by a plain restart', async (t) => {
  const port = await freePort()
  const dir = configDir(t, port)
  const old = fakeRouter(t, port, {})
  await waitHealth(port)
  killHealth(t, port)
  // even with a request log that has been quiet for an hour: a long reply logs only when it starts
  fs.writeFileSync(path.join(dir, 'custom-agent-requests.log'), '{}\n')
  const quiet = new Date(Date.now() - 60 * 60 * 1000)
  fs.utimesSync(path.join(dir, 'custom-agent-requests.log'), quiet, quiet)
  const busy = setup(dir, 'restart', '--if-stale', '--if-idle')
  assert.strictEqual(busy.code, 3, busy.out)
  assert.match(busy.out, /older than 0\.6\.1 and cannot report requests in flight/)
  assert.strictEqual((await getHealth(port)).pid, old.pid, 'the older router was not touched')

  const r = setup(dir, 'restart', '--if-stale')
  assert.strictEqual(r.code, 0, r.out)
  assert.match(r.out, /older than 0\.6\.1/)
  const h = await waitHealth(port)
  assert.strictEqual(h.configDir, fs.realpathSync(dir), 'the router now running is this version\'s')
  assert.ok(h.version)
})

test('restart refuses something on the port that does not answer like a router, and kills nothing', async (t) => {
  // pid 1 would be init, and process.kill(0) the whole process group
  for (const body of [{ ok: false }, { pid: 1 }, { pid: 0 }]) {
    const port = await freePort()
    const dir = configDir(t, port)
    const odd = fakeRouter(t, port, body)
    await waitHealth(port)
    const r = setup(dir, 'restart')
    assert.strictEqual(r.code, 1, `${JSON.stringify(body)}: ${r.out}`)
    assert.match(r.out, /not as a model-relay router/)
    assert.ok(await getHealth(port), 'what answered is still there')
    odd.kill()
  }
})

test('an open blind tunnel keeps restart --if-idle from cutting it', async (t) => {
  const target = net.createServer((sock) => sock.on('data', () => {}))
  await new Promise((r) => target.listen(0, '127.0.0.1', r))
  t.after(() => target.close())
  const port = await freePort()
  const dir = configDir(t, port, { proxy: { enabled: true } })
  startRouter(t, dir)
  await waitHealth(port)
  const sock = await new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method: 'CONNECT', path: `127.0.0.1:${target.address().port}` })
    req.on('connect', (res, s) => resolve(s))
    req.on('error', reject)
    req.end()
  })
  sock.on('error', () => {})
  assert.strictEqual((await getHealth(port)).tunnels, 1)
  const r = setup(dir, 'restart', '--if-idle')
  assert.strictEqual(r.code, 3, r.out)
  assert.match(r.out, /1 tunnel\(s\) open/)
  sock.destroy()
  for (let i = 0; i < 30 && (await getHealth(port)).tunnels !== 0; i++) await sleep(100)
  assert.strictEqual((await getHealth(port)).tunnels, 0, 'the count drops when the tunnel closes')
})

test('restart --if-stale leaves a current or newer router alone, and refuses another config dir\'s', async (t) => {
  const port = await freePort()
  const dir = configDir(t, port)
  const newer = fakeRouter(t, port, { configDir: fs.realpathSync(dir), version: '99.0.0', inflight: 0 })
  await waitHealth(port)
  const r = setup(dir, 'restart', '--if-stale', '--if-idle')
  assert.strictEqual(r.code, 0, r.out)
  assert.match(r.out, /not restarted/)
  assert.strictEqual((await getHealth(port)).pid, newer.pid, 'a newer router is never replaced by older code')
  newer.kill()
  for (let i = 0; i < 30 && (await getHealth(port)); i++) await sleep(100)

  const other = configDir(t, port)
  fakeRouter(t, port, { configDir: fs.realpathSync(other), version: '0.0.1', inflight: 0 })
  await waitHealth(port)
  const f = setup(dir, 'restart')
  assert.strictEqual(f.code, 1, f.out)
  assert.match(f.out, /Refusing to restart: .*belongs to config dir/)
})

test('restart --if-idle waits while the router is answering a request', async (t) => {
  let hold
  const upstream = http.createServer((req, res) => {
    req.resume()
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.write('event: ping\ndata: {}\n\n')
    hold = res
  })
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r))
  t.after(() => { hold?.destroy(); upstream.close() })
  const port = await freePort()
  const dir = configDir(t, port)
  fs.writeFileSync(path.join(dir, 'model-relay.json'), JSON.stringify({ port, failover: { enabled: false }, providers: { stub: { baseUrl: `http://127.0.0.1:${upstream.address().port}`, token: 't', model: 'stub-1' } } }))
  const { child } = startRouter(t, dir)
  await waitHealth(port)
  const body = JSON.stringify({ model: 'stub-1', stream: true, messages: [] })
  const req = http.request({ host: '127.0.0.1', port, method: 'POST', path: '/v1/messages', headers: { 'content-length': Buffer.byteLength(body) } })
  req.on('error', () => {})
  req.end(body)
  await new Promise((r) => req.on('response', (res) => res.once('data', r)))
  assert.strictEqual((await getHealth(port)).inflight, 1)
  const r = setup(dir, 'restart', '--if-idle')
  assert.strictEqual(r.code, 3, r.out)
  assert.match(r.out, /1 request\(s\) in flight/)
  assert.strictEqual(child.exitCode, null, 'the router answering the request keeps running')
  req.destroy()
  for (let i = 0; i < 30 && (await getHealth(port)).inflight !== 0; i++) await sleep(100)
  assert.strictEqual((await getHealth(port)).inflight, 0, 'the count drops when the caller leaves')
})
