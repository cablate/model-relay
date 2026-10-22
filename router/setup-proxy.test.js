'use strict'
// `setup.mjs proxy` against a throwaway config directory: it must change settings.json only on --go,
// keep everything else in the file, refuse to touch settings it does not own, and be reversible.
const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const http = require('node:http')
const net = require('node:net')
const os = require('node:os')
const path = require('node:path')
const { execFile, spawn, spawnSync } = require('node:child_process')

const setup = path.join(__dirname, '..', 'tools', 'setup.mjs')

async function freePort() {
  const s = net.createServer()
  await new Promise((r) => s.listen(0, '127.0.0.1', r))
  const p = s.address().port
  await new Promise((r) => s.close(r))
  return p
}

function health(port) {
  return new Promise((resolve) => {
    http.get(`http://127.0.0.1:${port}/__health`, (res) => {
      const ch = []
      res.on('data', (c) => ch.push(c))
      res.on('end', () => resolve(JSON.parse(Buffer.concat(ch).toString('utf8'))))
    }).on('error', () => resolve(null))
  })
}

// The CLI is run without the caller's NODE_EXTRA_CA_CERTS (a Claude Code session in proxy mode carries one); runWith adds env back
function runWith(env, dir, ...args) {
  const base = { ...process.env, CLAUDE_CONFIG_DIR: dir }
  delete base.NODE_EXTRA_CA_CERTS
  const r = spawnSync(process.execPath, [setup, ...args], { encoding: 'utf8', env: { ...base, ...env } })
  return { code: r.status, out: `${r.stdout}${r.stderr}` }
}
const run = (dir, ...args) => runWith({}, dir, ...args)

async function fixture(t, settings) {
  const port = await freePort()
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-setup-'))
  fs.writeFileSync(path.join(dir, 'model-relay.json'), JSON.stringify({ format: 2, port, providers: { glm: { baseUrl: 'http://127.0.0.1:9', token: 'dummy', model: 'glm-5.3' } } }))
  const settingsPath = path.join(dir, 'settings.json')
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2))
  t.after(async () => {
    const h = await health(port)
    if (h && h.pid) {
      try {
        process.kill(h.pid)
      } catch {}
    }
  })
  const cfgPath = path.join(dir, 'model-relay.json')
  return { port, dir, settingsPath, read: () => JSON.parse(fs.readFileSync(settingsPath, 'utf8')), proxyOn: () => JSON.parse(fs.readFileSync(cfgPath, 'utf8')).proxy?.enabled === true }
}

test('proxy enable is a dry run until --go, then switches modes and keeps unrelated settings', async (t) => {
  const f = await fixture(t, { model: 'sonnet', env: { FOO: '1', ANTHROPIC_BASE_URL: '' } })
  const url = `http://127.0.0.1:${f.port}`
  const fixed = { model: 'sonnet', env: { FOO: '1', ANTHROPIC_BASE_URL: url } }
  fs.writeFileSync(f.settingsPath, JSON.stringify(fixed))

  const dry = run(f.dir, 'proxy', 'enable')
  assert.strictEqual(dry.code, 0, dry.out)
  assert.match(dry.out, /Dry run/)
  assert.deepStrictEqual(f.read(), fixed, 'a dry run changes nothing')
  assert.ok(!fs.existsSync(path.join(f.dir, 'model-relay-pki')), 'and creates no certificate')
  assert.strictEqual(f.proxyOn(), false, 'the router stays closed to proxy connections until enabled')

  const go = run(f.dir, 'proxy', 'enable', '--go')
  assert.strictEqual(go.code, 0, go.out)
  const after = f.read()
  assert.strictEqual(after.model, 'sonnet')
  assert.strictEqual(after.env.FOO, '1')
  assert.strictEqual(after.env.ANTHROPIC_BASE_URL, undefined, 'Remote Control needs the API address left alone')
  assert.strictEqual(after.env.HTTPS_PROXY, url)
  assert.ok(after.env.NODE_EXTRA_CA_CERTS.endsWith('model-relay-pki/ca.pem'))
  assert.strictEqual(after.env.NO_PROXY, '127.0.0.1,localhost,::1')
  assert.strictEqual(f.proxyOn(), true, 'enable opens the router to proxy connections')
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(`${f.settingsPath}.model-relay-backup`, 'utf8')), fixed, 'the previous file is kept')

  const status = run(f.dir, 'proxy', 'status')
  assert.match(status.out, /HTTPS proxy \(Remote Control works\)/)
  assert.match(status.out, /Self-test .*✓ ok/)

  const doctor = run(f.dir, 'doctor')
  assert.match(doctor.out, /Remote Control works/, 'doctor recognises the proxy wiring')
  const doctorFix = run(f.dir, 'doctor', '--fix')
  assert.strictEqual(f.read().env.ANTHROPIC_BASE_URL, undefined, 'doctor --fix must not undo proxy mode')
  assert.ok(doctorFix.out.length > 0)

  const off = run(f.dir, 'proxy', 'disable', '--go')
  assert.strictEqual(off.code, 0, off.out)
  assert.deepStrictEqual(f.read(), fixed, 'disable puts the settings back exactly')
  assert.strictEqual(f.proxyOn(), false, 'and closes the router to proxy connections again')
})

test('proxy enable refuses settings it does not own', async (t) => {
  const f = await fixture(t, { env: { HTTPS_PROXY: 'http://corp.example:3128' } })
  const a = run(f.dir, 'proxy', 'enable', '--go')
  assert.strictEqual(a.code, 1)
  assert.match(a.out, /chaining proxies is not supported/)
  assert.strictEqual(f.read().env.HTTPS_PROXY, 'http://corp.example:3128')
  assert.strictEqual(f.proxyOn(), false, 'a refused enable leaves the router closed')

  const g = await fixture(t, { env: { ANTHROPIC_BASE_URL: 'https://gateway.example' } })
  const b = run(g.dir, 'proxy', 'enable', '--go')
  assert.strictEqual(b.code, 1)
  assert.match(b.out, /not this relay/)
  assert.strictEqual(g.read().env.ANTHROPIC_BASE_URL, 'https://gateway.example')
})

test('proxy enable refuses to replace a NODE_EXTRA_CA_CERTS someone already relies on, from settings.json or the environment', async (t) => {
  for (const [settings, env, where] of [
    [{ env: { NODE_EXTRA_CA_CERTS: '/etc/corp/ca.pem' } }, {}, /settings\.json env already sets NODE_EXTRA_CA_CERTS=\/etc\/corp\/ca\.pem/],
    [{ env: {} }, { NODE_EXTRA_CA_CERTS: '/etc/corp/ca.pem' }, /your environment already sets NODE_EXTRA_CA_CERTS=\/etc\/corp\/ca\.pem/],
  ]) {
    const f = await fixture(t, settings)
    const before = fs.readFileSync(f.settingsPath, 'utf8')
    for (const args of [['proxy', 'enable'], ['proxy', 'enable', '--go'], ['proxy', 'renew', '--go']]) {
      const r = runWith(env, f.dir, ...args)
      assert.strictEqual(r.code, 1, r.out)
      assert.match(r.out, where)
      assert.match(r.out, /Nothing was changed/)
    }
    assert.strictEqual(fs.readFileSync(f.settingsPath, 'utf8'), before, 'settings.json is byte-identical')
    assert.ok(!fs.existsSync(path.join(f.dir, 'model-relay-pki')), 'no certificate was created')
    assert.strictEqual(f.proxyOn(), false)
  }
})

test('proxy renew in proxy mode accepts the relay\'s own NODE_EXTRA_CA_CERTS, from settings.json and the environment', async (t) => {
  const f = await fixture(t, {})
  const url = `http://127.0.0.1:${f.port}`
  fs.writeFileSync(f.settingsPath, JSON.stringify({ env: { ANTHROPIC_BASE_URL: url } }))
  const on = run(f.dir, 'proxy', 'enable', '--go')
  assert.strictEqual(on.code, 0, on.out)
  const ca = f.read().env.NODE_EXTRA_CA_CERTS
  const r = runWith({ NODE_EXTRA_CA_CERTS: ca }, f.dir, 'proxy', 'renew', '--go')
  assert.strictEqual(r.code, 0, r.out)
})

test('the relay\'s own CA path spelled differently, or a shell CA already overridden by settings.json, does not block proxy renew', async (t) => {
  const f = await fixture(t, {})
  fs.writeFileSync(f.settingsPath, JSON.stringify({ env: { ANTHROPIC_BASE_URL: `http://127.0.0.1:${f.port}` } }))
  assert.strictEqual(run(f.dir, 'proxy', 'enable', '--go').code, 0)
  const ca = f.read().env.NODE_EXTRA_CA_CERTS
  if (process.platform === 'win32') {
    const r = runWith({ NODE_EXTRA_CA_CERTS: ca.replace(/\//g, '\\').toUpperCase() }, f.dir, 'proxy', 'renew', '--go')
    assert.strictEqual(r.code, 0, `drive-letter case and backslashes: ${r.out}`)
  }
  const o = runWith({ NODE_EXTRA_CA_CERTS: '/etc/corp/ca.pem' }, f.dir, 'proxy', 'renew', '--go')
  assert.strictEqual(o.code, 0, `settings.json already holds the relay CA: ${o.out}`)
})

test('doctor only looks until --fix, then hints at it; --fix wires the relay\'s own address and nothing else', async (t) => {
  const f = await fixture(t, { model: 'sonnet', env: { FOO: '1' } })
  const url = `http://127.0.0.1:${f.port}`
  const before = fs.readFileSync(f.settingsPath, 'utf8')

  const look = run(f.dir, 'doctor')
  assert.strictEqual(look.code, 0, look.out)
  assert.strictEqual(fs.readFileSync(f.settingsPath, 'utf8'), before, 'a read-only doctor changes nothing')
  assert.match(look.out.trim().split('\n').pop(), /\/provider doctor --fix/, 'and the last line says how to apply the fix')
  assert.strictEqual(run(f.dir, 'doctor', '--json').out.includes('/provider doctor --fix'), false, 'json stays machine output')

  const fixed = run(f.dir, 'doctor', '--fix')
  assert.strictEqual(f.read().env.ANTHROPIC_BASE_URL, url)
  assert.doesNotMatch(fixed.out, /\/provider doctor --fix/, 'nothing left to hint at')

  // the address spelled with localhost is the relay's too, and is written back in the usual form
  fs.writeFileSync(f.settingsPath, JSON.stringify({ env: { ANTHROPIC_BASE_URL: `http://localhost:${f.port}` } }))
  run(f.dir, 'doctor', '--fix')
  assert.strictEqual(f.read().env.ANTHROPIC_BASE_URL, url)
})

test('doctor --fix leaves a local gateway on another port alone, and does not offer to replace it', async (t) => {
  for (const gateway of ['http://127.0.0.1:4000', 'http://localhost:4000/']) {
    const f = await fixture(t, { env: { ANTHROPIC_BASE_URL: gateway } })
    const before = fs.readFileSync(f.settingsPath, 'utf8')
    for (const args of [['doctor'], ['doctor', '--fix'], ['init', '--fix']]) {
      const r = run(f.dir, ...args)
      assert.match(r.out, /not this relay/, `${gateway} ${args.join(' ')}: ${r.out}`)
      assert.doesNotMatch(r.out, /\/provider doctor --fix/, 'a fix that would not apply is not offered')
      assert.strictEqual(fs.readFileSync(f.settingsPath, 'utf8'), before, `${gateway} ${args.join(' ')}: settings.json is byte-identical`)
    }
  }
})

test('proxy enable --go kills only what answers /__health as a router, never any process whose pid it reports', async (t) => {
  const f = await fixture(t, { env: {} })
  const bystander = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
  t.after(() => bystander.kill())
  // not a router: no "ok": true, but a pid
  const fake = http.createServer((q, r) => r.end(JSON.stringify({ pid: bystander.pid })))
  await new Promise((r) => fake.listen(f.port, '127.0.0.1', r))
  t.after(() => fake.close())
  // the server above lives in this process, which a synchronous spawn would block
  const env = { ...process.env, CLAUDE_CONFIG_DIR: f.dir }
  delete env.NODE_EXTRA_CA_CERTS
  const r = await new Promise((resolve) => {
    execFile(process.execPath, [setup, 'proxy', 'enable', '--go'], { env }, (e, stdout, stderr) => resolve({ code: e ? e.code : 0, out: `${stdout}${stderr}` }))
  })
  assert.doesNotThrow(() => process.kill(bystander.pid, 0), `the process the answer named is still alive: ${r.out}`)
  assert.doesNotMatch(r.out, /Restarting the router/)
  assert.strictEqual(r.code, 1, 'and the enable does not go through on that answer')
  assert.deepStrictEqual(f.read(), { env: {} })
})
