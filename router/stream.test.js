'use strict'
// Streamed answers: an upstream that drops mid-stream must not leave the caller hanging, and a caller that gives up
// must stop the upstream generation.
const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const http = require('node:http')
const net = require('node:net')
const os = require('node:os')
const path = require('node:path')
const { spawn } = require('node:child_process')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function freePort() {
  const probe = net.createServer().listen(0, '127.0.0.1')
  await new Promise((r) => probe.once('listening', r))
  const { port } = probe.address()
  await new Promise((r) => probe.close(r))
  return port
}

// A provider that sends its headers and one event, then calls onRequest(req, res) to decide what happens next
async function startRouter(t, onRequest) {
  const upstream = http.createServer((req, res) => {
    req.resume()
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write('event: message_start\ndata: {"type":"message_start"}\n\n')
      onRequest(req, res)
    })
  }).listen(0, '127.0.0.1')
  await new Promise((r) => upstream.once('listening', r))
  const port = await freePort()
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-stream-'))
  fs.writeFileSync(path.join(dir, 'model-relay.json'), JSON.stringify({
    format: 2,
    port,
    failover: { enabled: false },
    retry: { attempts: 1, delayMs: 10, maxDelayMs: 10 },
    providers: { stub: { baseUrl: `http://127.0.0.1:${upstream.address().port}`, token: 't', model: 'stub-1' } },
  }))
  const child = spawn(process.execPath, [path.join(__dirname, 'router.js'), dir], { stdio: 'ignore' })
  t.after(() => {
    child.kill()
    upstream.close()
    fs.rmSync(dir, { recursive: true, force: true })
  })
  for (let i = 0; i < 60; i++) {
    const up = await new Promise((resolve) => http.get(`http://127.0.0.1:${port}/__health`, (r) => { r.resume(); resolve(true) }).on('error', () => resolve(false)))
    if (up) break
    await sleep(100)
  }
  return { port, child }
}

function ask(port) {
  const body = JSON.stringify({ model: 'stub-1', stream: true, messages: [{ role: 'user', content: 'hi' }] })
  const req = http.request({ host: '127.0.0.1', port, path: '/v1/messages', method: 'POST', headers: { 'content-length': Buffer.byteLength(body) } })
  req.end(body)
  return req
}

test('an upstream that drops mid-stream ends the caller\'s connection instead of leaving it waiting', async (t) => {
  const { port, child } = await startRouter(t, (req, res) => setTimeout(() => res.socket.destroy(), 50))
  const req = ask(port)
  const outcome = await Promise.race([
    new Promise((resolve) => req.on('response', (r) => {
      r.resume()
      r.on('error', () => resolve('ended'))
      r.on('aborted', () => resolve('ended'))
      r.on('end', () => resolve('ended'))
    })),
    new Promise((resolve) => req.on('error', () => resolve('ended'))),
    sleep(3000).then(() => 'hung'),
  ])
  req.destroy()
  assert.strictEqual(outcome, 'ended')
  assert.strictEqual(child.exitCode, null, 'the router is still running')
})

test('an upstream reset mid-stream (RST) with retries on cuts the caller off and leaves the router running', async (t) => {
  // A reset surfaces as an error on the upstream request after the headers went out; retrying it used to call
  // writeHead a second time, which threw ERR_HTTP_HEADERS_SENT and killed the router
  const { port, child } = await startRouter(t, (req, res) => setTimeout(() => res.socket.resetAndDestroy(), 50))
  const req = ask(port)
  const outcome = await Promise.race([
    new Promise((resolve) => req.on('response', (r) => {
      r.resume()
      r.on('error', () => resolve('cut'))
      r.on('aborted', () => resolve('cut'))
      r.on('end', () => resolve('ended cleanly'))
    })),
    new Promise((resolve) => req.on('error', () => resolve('cut'))),
    sleep(3000).then(() => 'hung'),
  ])
  req.destroy()
  await sleep(500) // the retry timer that used to crash fires about 10 ms later
  assert.strictEqual(outcome, 'cut', 'a truncated stream must not look complete')
  assert.strictEqual(child.exitCode, null, 'the router is still running')
})

test('a caller that gives up stops the upstream request', async (t) => {
  let upstreamClosed = false
  const { port } = await startRouter(t, (req, res) => res.on('close', () => { upstreamClosed = true })) // never finishes
  const req = ask(port)
  await new Promise((resolve) => req.on('response', (r) => r.once('data', resolve)))
  req.destroy()
  for (let i = 0; i < 30 && !upstreamClosed; i++) await sleep(100)
  assert.ok(upstreamClosed, 'the upstream connection was closed after the caller left')
})
