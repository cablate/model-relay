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
  const r = spawnSync(process.execPath, [SETUP, ...args], { encoding: 'utf8', env: { ...process.env, CLAUDE_CONFIG_DIR: dir } })
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
