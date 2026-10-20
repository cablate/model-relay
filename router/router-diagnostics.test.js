'use strict'
// What the running router tells you when it cannot see something: env:VAR tokens unset in its own process, and a
// certificate that appears after it started.
const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const http = require('node:http')
const net = require('node:net')
const os = require('node:os')
const path = require('node:path')
const tls = require('node:tls')
const { spawn, spawnSync } = require('node:child_process')
const PKI = require('./pki')

const HOST = 'api.anthropic.com'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const freePort = () => new Promise((resolve) => {
  const s = net.createServer()
  s.listen(0, '127.0.0.1', () => {
    const p = s.address().port
    s.close(() => resolve(p))
  })
})
const get = (port, p) => new Promise((resolve, reject) => {
  http.get(`http://127.0.0.1:${port}${p}`, (res) => {
    const ch = []
    res.on('data', (c) => ch.push(c))
    res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(ch).toString('utf8') }))
  }).on('error', reject)
})
async function waitHealth(port) {
  for (let i = 0; i < 60; i++) {
    try {
      if ((await get(port, '/__health')).status === 200) return
    } catch {}
    await sleep(100)
  }
  throw new Error('router did not come up')
}

async function start(t, providers, extra = {}, envOver = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-diag-'))
  const port = await freePort()
  fs.writeFileSync(path.join(dir, 'model-relay.json'), JSON.stringify({ port, providers, ...extra }))
  const env = { ...process.env }
  delete env.RELAY_DIAG_KEY
  Object.assign(env, envOver)
  const child = spawn(process.execPath, [path.join(__dirname, 'router.js'), dir], { stdio: 'ignore', env })
  t.after(() => {
    child.kill()
    fs.rmSync(dir, { recursive: true, force: true })
  })
  await waitHealth(port)
  return { dir, port }
}

const GLM = { baseUrl: 'http://127.0.0.1:9', model: 'glm-5.3' }

test('/__health names the provider and env var of an unresolved token, never a resolved value', async (t) => {
  const r = await start(t, {
    glm: { ...GLM, token: 'literal-secret' },
    kimi: { ...GLM, model: 'kimi-k3', token: 'env:RELAY_DIAG_SET' },
    gemini: { ...GLM, model: 'gemini-4', token: 'env:RELAY_DIAG_KEY' },
    claude: { ...GLM, token: 'env:RELAY_DIAG_CLAUDE' },
  }, {}, { RELAY_DIAG_SET: 'distinct-set-value' })
  const body = (await get(r.port, '/__health')).body
  assert.deepStrictEqual(JSON.parse(body).unresolved, [{ provider: 'gemini', env: 'RELAY_DIAG_KEY' }])
  assert.ok(!body.includes('distinct-set-value') && !body.includes('literal-secret'))
})

test('a config file that stops parsing is not blamed on an env var', async (t) => {
  const r = await start(t, { glm: { ...GLM, token: 'literal' }, gemini: { ...GLM, model: 'gemini-4', token: 'env:RELAY_DIAG_KEY' } })
  assert.strictEqual(JSON.parse((await get(r.port, '/__health')).body).unresolved.length, 1)
  fs.writeFileSync(path.join(r.dir, 'model-relay.json'), '{ not json')
  assert.deepStrictEqual(JSON.parse((await get(r.port, '/__health')).body).unresolved, [])
})

const doctor = (dir, env) => {
  const d = spawnSync(process.execPath, [path.join(__dirname, '..', 'tools', 'setup.mjs'), 'doctor'], {
    env: { ...process.env, CLAUDE_CONFIG_DIR: dir, ...env },
    encoding: 'utf8',
  })
  return `${d.stdout}${d.stderr}`
}

test('doctor advises a restart only when its own shell has the variable the router lacks', async (t) => {
  const r = await start(t, { glm: { ...GLM, token: 'literal' }, gemini: { ...GLM, model: 'gemini-4', token: 'env:RELAY_DIAG_KEY' } })
  const has = doctor(r.dir, { RELAY_DIAG_KEY: 'shell-secret' })
  assert.match(has, /Config OK/)
  assert.match(has, /started without RELAY_DIAG_KEY.*this shell has it/)
  assert.ok(!has.includes('shell-secret'))
  const lacks = doctor(r.dir, { RELAY_DIAG_KEY: '' })
  assert.match(lacks, /RELAY_DIAG_KEY is unset here too/)
  assert.ok(!/start(ed)? Claude Code from this shell/.test(lacks))
})

test('a certificate created after the router started is used by the next CONNECT', async (t) => {
  const r = await start(t, { glm: { ...GLM, token: 'literal' } }, { proxy: { enabled: true } })
  const h0 = JSON.parse((await get(r.port, '/__health')).body)
  assert.strictEqual(h0.proxy.certificate, false)
  const pki = PKI.ensure(r.dir, { hosts: [HOST] }) // what `proxy enable` does while the router is already running
  const socket = await new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: r.port, method: 'CONNECT', path: `${HOST}:443` })
    req.on('connect', (res, s) => resolve(s))
    req.on('error', reject)
    req.end()
  })
  socket.on('error', () => {})
  const secure = tls.connect({ socket, servername: HOST, ca: fs.readFileSync(pki.ca, 'utf8') })
  await new Promise((resolve, reject) => {
    secure.once('secureConnect', resolve)
    secure.once('error', reject)
  })
  secure.destroy()
})
