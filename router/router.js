'use strict'
// Local relay router for Claude Code: routes requests across Claude and Anthropic-compatible providers, with sticky
// sessions that protect the prompt cache and an optional failover chain for Claude's usage-limit 429.
// Usage: node router.js <config-dir>
const http = require('http')
const https = require('https')
const fs = require('fs')
const path = require('path')
const net = require('net')
const tls = require('tls')
const { pipeline } = require('stream')
const L = require('./logic')
const PKI = require('./pki')
const P = require('./ping')

// This process is itself the HTTPS proxy: it must never send its own traffic, or its children's, through a proxy
// setting inherited from Claude Code, which would loop back into it.
for (const k of ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'all_proxy']) delete process.env[k]

const dir = process.argv[2] || process.env.CLAUDE_CONFIG_DIR || path.join(process.env.USERPROFILE || process.env.HOME || '', '.claude')
// Reported by /__health so a second router, setup.mjs or the plugin hook can tell whose router answers on a port
const realDir = L.realDir(dir)
// The plugin version this code shipped with, so the hook can tell a router left running by an older plugin
const VERSION = (() => {
  try {
    return String(JSON.parse(fs.readFileSync(path.join(__dirname, '..', '.claude-plugin', 'plugin.json'), 'utf8')).version || '')
  } catch {
    return ''
  }
})()
// Model and passthrough requests not answered yet, and open blind tunnels and WebSocket upgrades (Remote Control, a
// git push through HTTPS_PROXY); `setup.mjs restart --if-idle` waits until both are zero
let inflight = 0
let tunnels = 0
const holdTunnel = (sock) => {
  tunnels++
  sock.once('close', () => tunnels--)
}

const CFG_FILE = path.join(dir, 'model-relay.json')
const STATE_FILE = path.join(dir, 'model-relay-state.json')
const LOG_FILE = path.join(dir, 'model-relay.log')
const REQLOG = path.join(dir, 'model-relay-requests.log')
const STATUS_DIR = path.join(dir, 'model-relay-status')

// The file is re-read on every request so edits apply at once. A read that fails (an editor mid-save, a typo) keeps
// the last good config instead of failing requests; "doctor" is what tells a person the file is broken.
let lastGoodCfg = null
// env:VAR tokens that did not resolve in THIS process (a router started before the key was exported never sees it)
let unresolved = []
const readCfg = () => {
  unresolved = [] // a file that cannot be read or parsed must not be blamed on an env var
  try {
    const raw = JSON.parse(fs.readFileSync(CFG_FILE, 'utf8'))
    unresolved = L.unresolvedEnv(raw)
    const parsed = L.parseCfg(raw)
    if (parsed) lastGoodCfg = parsed
    // A file that reads fine but has no usable provider (keys not exported yet) still lets Claude through
    return parsed || L.bareCfg(raw)
  } catch {
    return lastGoodCfg
  }
}

const cfgMissing = () => L.cfgMissingMessage(unresolved)

let state = (() => {
  try {
    return L.parseState(JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')))
  } catch {
    return L.emptyState()
  }
})()

// Per provider: the last real request ({ status, ms, at }) and the last test ({ verdict, status, firstByteMs, at,
// detail }), kept apart so a long reply never reads as a slow provider
const providerStats = {}
const pingStats = {}
// When each model id (lower case, without a [1m]-style suffix) was last asked for: lets the plugin check that a
// model-relay:<name> subagent really reached the relay with its model, which Claude Code can swap silently
const seenModels = {}
const sawModel = (model) => {
  if (typeof model !== 'string' || !model) return
  const key = L.wireModel(model).toLowerCase()
  delete seenModels[key]
  seenModels[key] = Date.now()
  const keys = Object.keys(seenModels)
  if (keys.length > 100) delete seenModels[keys[0]]
}

// Logs are capped at 5 MB: past that the file is emptied and starts over
const capLog = (file) => {
  try {
    if (fs.statSync(file).size > 5 * 1024 * 1024) fs.writeFileSync(file, '')
  } catch {}
}

const log = (line) => {
  capLog(LOG_FILE)
  try {
    fs.appendFileSync(LOG_FILE, `${new Date().toISOString()} ${line}\n`)
  } catch {}
}

const save = () => {
  state = L.pruneSticky(state, Date.now())
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify({ ...state, updatedAt: Date.now() }, null, 2) + '\n')
  } catch {}
}

const setState = (next, why) => {
  state = next
  save()
  if (why) log(why)
}
setInterval(save, 600000).unref()

// Each session's hook writes its status file and never deletes it (the plugin API has no delete); sweep ended ones
const sweepStatus = () => {
  let names = []
  try {
    names = fs.readdirSync(STATUS_DIR)
  } catch {
    return
  }
  const entries = []
  for (const name of names) {
    try {
      const st = fs.lstatSync(path.join(STATUS_DIR, name))
      entries.push({ name, isFile: st.isFile(), mtimeMs: st.mtimeMs })
    } catch {}
  }
  for (const name of L.staleStatusFiles(entries, Date.now())) {
    try {
      fs.unlinkSync(path.join(STATUS_DIR, name))
    } catch {}
  }
}
sweepStatus()
setInterval(sweepStatus, 3600000).unref()

const short = (sid) => (sid ? sid.slice(0, 8) : '-')
const stick = (sid, providerName, why) => {
  if (!sid || !providerName) return
  const prev = state.sticky?.[sid]?.provider
  state = L.setSticky(state, sid, providerName, Date.now())
  if (prev !== providerName) setState(state, `session ${short(sid)} moved to ${providerName} (${why})`)
}

const logReq = (entry) => {
  capLog(REQLOG)
  try {
    fs.appendFileSync(REQLOG, JSON.stringify({ t: Date.now(), ...entry }) + '\n')
  } catch {}
}

const apiError = (res, status, message) => {
  if (res.headersSent) return res.end()
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ type: 'error', error: { type: 'api_error', message: `model-relay router: ${message}` } }))
}

const json = (res, obj) => {
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(JSON.stringify(obj))
}

// Streams an upstream answer whose headers are already sent. pipe() alone never ends `res` when the upstream drops
// mid-stream, so the caller would wait forever; pipeline() destroys `res` instead, and the caller sees the failure.
const relay = (ur, res) => pipeline(ur, res, () => {})

function send(base, req, res, body, headers, onResponse, onError) {
  if (res.destroyed) return // the caller left while a retry or fallback was waiting
  const u = new URL(base)
  const lib = u.protocol === 'http:' ? http : https
  const up = lib.request(
    {
      hostname: u.hostname,
      port: u.port || (u.protocol === 'http:' ? 80 : 443),
      path: L.upstreamPath(base, req.url),
      method: req.method,
      headers: { ...headers, host: u.host, 'content-length': body.length },
    },
    onResponse,
  )
  // A socket error after the answer started streaming (a reset mid-stream) can neither be retried nor reported:
  // the headers are gone, and a second writeHead would throw and take the router down. Cut the caller off instead.
  up.on('error', (e) => (res.headersSent ? res.destroy() : onError(e)))
  // The caller gave up (Esc in Claude Code): stop the upstream generation instead of paying for the rest of it
  const callerLeft = () => {
    if (!res.writableEnded) up.destroy()
  }
  res.on('close', callerLeft)
  up.on('close', () => res.off('close', callerLeft))
  up.end(body)
}

// A test of one provider. One with `launch` whose local port is closed is started first and given 10 seconds.
async function pingOne(provider) {
  const u = new URL(provider.url)
  if (provider.launch && P.isLocal(provider.url) && !(await P.portOpen(u.hostname, Number(u.port) || 80))) {
    launchIfDown(provider)
    for (let i = 0; i < 20 && !(await P.portOpen(u.hostname, Number(u.port) || 80)); i++) await new Promise((r) => setTimeout(r, 500))
  }
  pingStats[provider.name] = await P.ping(provider)
  return pingStats[provider.name]
}

// tried: providers this request already gave up on, so a fallback never loops back to one of them
function toProvider(provider, req, res, body, rewrite, sid, attempt = 0, tried = []) {
  const threadRefusal = L.threadBetaRefusal(req.headers)
  if (threadRefusal) {
    logReq({ to: `${provider.name}-thread-refused`, sid: short(sid) })
    if (res.headersSent) return res.end()
    res.writeHead(400, { 'content-type': 'application/json' })
    return res.end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: threadRefusal } }))
  }
  const t0 = Date.now()
  let out = body
  let restoreToolSearch = false
  if (body.length) {
    try {
      ;({ body: out, restoreToolSearch } = L.rewriteBody(body, {
        model: rewrite ? provider.model : null,
        defaultModel: provider.model,
        stripCacheControl: provider.stripCacheControl,
      }))
    } catch {
      if (rewrite) return apiError(res, 400, `could not rewrite request for provider "${provider.name}"`)
    }
  }
  const headers = P.authHeaders(provider, req.headers)
  // The answer is read to rename the search back, so it has to come uncompressed
  if (restoreToolSearch) headers['accept-encoding'] = 'identity'
  // Per-provider switch: retryCfg === null means this provider never retries
  const retryCfg = provider.retryCfg !== undefined ? provider.retryCfg : null

  // Retries exhausted on this provider: hand the ORIGINAL body to the failover provider when one exists
  const giveUp = (status, text, upstreamHeaders) => {
    const cfgNow = readCfg()
    const next = retryCfg && retryCfg.failover && cfgNow && cfgNow.failoverEnabled ? L.nextFallback(cfgNow, provider.name, tried) : null
    if (next) {
      log(`provider "${provider.name}" kept failing (last ${status}); falling back to "${next.name}" for this request`)
      return toProvider(next, req, res, body, true, sid, 0, [...tried, provider.name])
    }
    if (text !== null) {
      res.writeHead(status, upstreamHeaders || { 'content-type': 'application/json' })
      return res.end(text)
    }
    return apiError(res, 502, `provider "${provider.name}" unreachable`)
  }

  const maybeRetry = (status, upstreamHeaders, onErrorText) => {
    providerStats[provider.name] = { status, ms: Date.now() - t0, at: Date.now() }
    if (!retryCfg) return false
    if (res.writableEnded || res.destroyed) return false // the client gave up; stop retrying for it
    const wait = L.retryWaitMs(status, upstreamHeaders, attempt, retryCfg)
    if (wait === null) return false
    log(`provider "${provider.name}" answered ${status}; retry ${attempt + 1}${retryCfg.attempts ? '/' + retryCfg.attempts : ' (unlimited)'} in ${wait}ms`)
    setTimeout(() => toProvider(provider, req, res, body, rewrite, sid, attempt + 1, tried), wait)
    return true
  }

  send(provider.url, req, res, out, headers, (ur) => {
    const status = ur.statusCode || 0
    if (status >= 200 && status < 300) {
      const encoded = ur.headers['content-encoding'] && ur.headers['content-encoding'] !== 'identity'
      const restore = restoreToolSearch && !encoded
      const { 'content-length': _length, ...renamedHeaders } = ur.headers
      res.writeHead(ur.statusCode, restore ? renamedHeaders : ur.headers)
      let tail = ''
      ur.on('data', (c) => {
        tail = (tail + c.toString('utf8')).slice(-4000)
      })
      ur.on('end', () => {
        providerStats[provider.name] = { status, ms: Date.now() - t0, at: Date.now() }
        const all = [...tail.matchAll(/"input_tokens"\s*:\s*(\d+)/g)]
        const last = all.length ? Number(all[all.length - 1][1]) : null
        logReq({ to: `${provider.name}-reply`, sid: short(sid), rewrite, status, bytes: out.length, inputTokens: last, attempt })
      })
      return restore ? pipeline(ur, L.toolSearchRestorer(), res, () => {}) : relay(ur, res)
    }
    // Failure: buffer the whole answer, then retry, fail over, or pass it through untouched
    const chunks = []
    ur.on('data', (c) => chunks.push(c))
    ur.on('end', () => {
      const text = Buffer.concat(chunks)
      logReq({ to: `${provider.name}-fail`, sid: short(sid), status, bytes: text.length, attempt })
      if (maybeRetry(status, ur.headers, null)) return
      giveUp(status, text, ur.headers)
    })
  }, (e) => {
    logReq({ to: `${provider.name}-fail`, sid: short(sid), status: 0, attempt, error: e.message })
    if (maybeRetry(502, null, e.message)) return
    giveUp(502, null, null)
  })
}

function toClaude(cfg, req, res, body, trial, sid) {
  send(cfg.claudeUrl, req, res, body, { ...req.headers }, (ur) => {
    if (ur.statusCode !== 429) {
      if (trial && ur.statusCode < 400) setState(L.onClaudeOk(state), 'claude ok again: new sessions use Claude')
      res.writeHead(ur.statusCode, ur.headers)
      return relay(ur, res)
    }
    const chunks = []
    ur.on('data', (c) => chunks.push(c))
    ur.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8')
      const foProvider = cfg.failoverProvider ? cfg.providers[cfg.failoverProvider] : null
      if (cfg.failoverEnabled && foProvider && L.isUsageLimit(429, ur.headers, text)) {
        setState(L.onLimited(state, cfg, Date.now()), `claude usage limit${trial ? ' (still)' : ''}: using ${foProvider.name} (${foProvider.model})`)
        stick(sid, foProvider.name, 'usage limit')
        return toProvider(foProvider, req, res, body, true, sid)
      }
      res.writeHead(ur.statusCode, ur.headers)
      res.end(text)
    })
  }, (e) => apiError(res, 502, `Anthropic unreachable: ${e.message}`))
}

function control(req, res, body) {
  const u = new URL(req.url, 'http://x')
  const cfg = readCfg()
  if (u.pathname === '/__health') {
    const sid = u.searchParams.get('sid') || ''
    const providers = {}
    if (cfg) {
      for (const [k, p] of Object.entries(cfg.providers)) providers[k] = p.model
    }
    return json(res, {
      ok: true,
      pid: process.pid,
      configDir: realDir,
      configDirArg: dir, // as given on the command line; the hook compares its own spelling against both
      version: VERSION,
      inflight,
      tunnels,
      failoverSince: state.failoverSince,
      nextClaudeTry: state.nextClaudeTry,
      failoverProvider: cfg ? cfg.failoverProvider : null,
      failoverChain: cfg ? cfg.failoverChain : [],
      aliases: cfg ? L.detectAliases(cfg) : {},
      config: cfg ? { failoverEnabled: cfg.failoverEnabled, retryEnabled: cfg.retry.enabled, proxyEnabled: cfg.proxy.enabled } : null,
      providers,
      unresolved,
      stats: providerStats,
      ping: pingStats,
      seenModels,
      sessionsOnCustom: Object.keys(state.sticky || {}).length,
      session: L.getSessionProvider(state, cfg, sid),
      proxy: { enabled: Boolean(cfg && cfg.proxy.enabled), certificate: Boolean(mitmServer()), ...proxyStats },
    })
  }
  if (u.pathname === '/__session' && req.method === 'POST') {
    let sid = ''
    let on = ''
    try {
      ;({ sid, on } = JSON.parse(body.toString('utf8')))
    } catch {}
    on = String(on || '').trim().toLowerCase()
    if (!sid || !on) return apiError(res, 400, 'need {sid, on: "<provider>" | "claude"}')
    if (on !== 'claude' && !cfg?.providers?.[on]) {
      const avail = cfg ? Object.keys(cfg.providers).join(', ') : 'none'
      return apiError(res, 400, `unknown provider "${on}" (configured: ${avail})`)
    }
    setState(L.setSticky(state, sid, on, Date.now()), `session ${short(sid)} set to ${on} by hand`)
    return json(res, { ok: true, session: on })
  }
  if (u.pathname === '/__probe' && req.method === 'POST') {
    setState({ ...state, nextClaudeTry: 0 }, 'manual probe requested: next new session will try Claude')
    return json(res, { ok: true, failoverSince: state.failoverSince, nextClaudeTry: 0 })
  }
  if (u.pathname === '/__ping' && req.method === 'POST') {
    if (!cfg) return apiError(res, 500, cfgMissing())
    let target = ''
    try {
      target = String(JSON.parse(body.toString('utf8')).provider || '').trim().toLowerCase()
    } catch {}
    const list = target && cfg.providers[target] ? [cfg.providers[target]] : Object.values(cfg.providers)
    Promise.all(list.map(pingOne)).then(
      () => json(res, { ok: true, ping: pingStats, stats: providerStats }),
      (e) => apiError(res, 500, `the test failed: ${e.message}`),
    )
    return
  }
  return apiError(res, 404, 'unknown control path')
}

// Streams a request to Anthropic untouched. Used inside the opened-up tunnel for everything that is not a model call.
function passthrough(cfg, req, res) {
  const u = new URL(cfg.claudeUrl)
  const lib = u.protocol === 'http:' ? http : https
  const headers = { ...req.headers, host: u.host }
  for (const h of ['connection', 'proxy-connection', 'keep-alive', 'upgrade']) delete headers[h]
  const up = lib.request(
    { hostname: u.hostname, port: u.port || (u.protocol === 'http:' ? 80 : 443), path: L.upstreamPath(cfg.claudeUrl, req.url), method: req.method, headers },
    (ur) => {
      res.writeHead(ur.statusCode, ur.headers)
      relay(ur, res)
    },
  )
  up.on('error', (e) => apiError(res, 502, `Anthropic unreachable: ${e.message}`))
  res.on('close', () => up.destroy())
  req.pipe(up)
}

// tunneled: the request arrived through a CONNECT tunnel opened for api.anthropic.com
function dispatch(req, res, tunneled) {
  if (tunneled || !req.url.startsWith('/__')) {
    inflight++
    res.once('close', () => inflight--)
  }
  if (tunneled) {
    const cfg = readCfg()
    if (!cfg) return apiError(res, 500, cfgMissing())
    if (!L.isRoutedRequest(req.method, req.url)) return passthrough(cfg, req, res)
  } else if (!req.url.startsWith('/') || !L.isLocalRequest(req.headers, server.address().port)) {
    // The port is the one this process holds, not the config file's: that can be edited while the router runs, and
    // re-reading it per request would turn away every caller of the still-running router.
    return apiError(res, 403, 'only local programs may use the router (Host 127.0.0.1 or localhost on the router port, no browser requests)')
  }
  const chunks = []
  req.on('data', (c) => chunks.push(c))
  req.on('end', () => {
    const body = Buffer.concat(chunks)
    if (!tunneled && req.url.startsWith('/__')) return control(req, res, body)
    const cfg = readCfg()
    if (!cfg) return apiError(res, 500, cfgMissing())
    const sid = String(req.headers['x-claude-code-session-id'] || '')
    let model = null
    let nMsgs = 0
    if (body.length) {
      try {
        const j = JSON.parse(body.toString('utf8'))
        model = j.model
        nMsgs = (j.messages || []).length
      } catch {}
    }
    sawModel(model)
    const route = L.decide(state, cfg, model, sid, Date.now())
    logReq({ sid: short(sid), model, nMsgs, route, ...(tunneled ? { via: 'proxy' } : {}) })
    const parsed = L.parseRoute(route, cfg)
    if (parsed.kind === 'provider' && parsed.provider) {
      if (parsed.rewrite && state.failoverSince && L.getSessionProvider(state, cfg, sid) === 'claude') {
        stick(sid, parsed.name, 'claude still out')
      }
      return toProvider(parsed.provider, req, res, body, parsed.rewrite, sid)
    }
    return toClaude(cfg, req, res, body, parsed.trial, sid)
  })
}

const server = http.createServer((req, res) => dispatch(req, res, false))

// ---------- HTTPS proxy mode ----------
// Claude Code keeps api.anthropic.com as its address (Remote Control requires it) and uses this router as its
// HTTPS proxy. A CONNECT for api.anthropic.com:443 is answered with our own certificate (see pki.js) and the
// decrypted requests join the same routing as before; every other CONNECT is a blind byte tunnel.

const proxyStats = { mitm: 0, tunnel: 0, lastMitmAt: 0 }
let lastTlsError = 0
let mitmCache = null // { server, cert, checkedAt }

// The leaf file's mtime: `proxy renew` rewrites it while the router runs, and its self-test must get the new one at once
const leafMtime = () => {
  try {
    return fs.statSync(PKI.paths(dir).leaf).mtimeMs
  } catch {
    return 0
  }
}

function mitmServer() {
  const now = Date.now()
  const mtime = leafMtime()
  if (mitmCache && mitmCache.server && now - mitmCache.checkedAt < 10000 && mitmCache.mtime === mtime) return mitmCache.server
  const leaf = PKI.loadLeaf(dir)
  if (!leaf) {
    // an absent certificate is not cached: `proxy enable` writes it while the router is already up, and the next CONNECT must use it
    if (mitmCache && mitmCache.server) log('proxy: certificate missing or expired; api.anthropic.com is tunnelled unrouted until it is renewed')
    mitmCache = null
    return null
  }
  const cert = leaf.cert.toString('utf8')
  if (mitmCache && mitmCache.server && mitmCache.cert === cert) {
    mitmCache.checkedAt = now
    mitmCache.mtime = mtime
    return mitmCache.server
  }
  let srv
  try {
    srv = https.createServer({ key: leaf.key, cert: leaf.cert, ALPNProtocols: ['http/1.1'] }, (req, res) => dispatch(req, res, true))
  } catch (e) {
    // key and certificate read mid-renewal do not match; tunnel for this call and try again on the next
    if (mitmCache?.failed !== e.message) log(`proxy: certificate unusable (${e.message}); api.anthropic.com is tunnelled unrouted until it is renewed`)
    mitmCache = { server: null, cert: '', checkedAt: 0, failed: e.message }
    return null
  }
  srv.on('upgrade', tunnelUpgrade)
  srv.on('tlsClientError', (e) => {
    if (Date.now() - lastTlsError < 60000) return
    lastTlsError = Date.now()
    log(`proxy: client refused our certificate (${e.message}); is NODE_EXTRA_CA_CERTS pointing at ${PKI.paths(dir).ca}?`)
  })
  srv.on('clientError', (e, sock) => sock.destroy())
  log(`proxy: serving api.anthropic.com with a certificate valid until ${new Date(leaf.expires).toISOString()}`)
  mitmCache = { server: srv, cert, checkedAt: now, mtime }
  return srv
}

// WebSocket and other upgrades are not ours to inspect: forward the raw request and pipe both ways
function tunnelUpgrade(req, socket, head) {
  const cfg = readCfg()
  const host = String(req.headers.host || '').replace(/:\d+$/, '').toLowerCase()
  if (!cfg || host !== L.PROXY_MITM_HOST) return socket.destroy()
  holdTunnel(socket)
  const u = new URL(cfg.claudeUrl)
  const ready = () => {
    const lines = [`${req.method} ${req.url} HTTP/1.1`]
    for (let i = 0; i < req.rawHeaders.length; i += 2) lines.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`)
    up.write(lines.join('\r\n') + '\r\n\r\n')
    if (head && head.length) up.write(head)
    up.pipe(socket)
    socket.pipe(up)
  }
  const up = u.protocol === 'http:'
    ? net.connect({ host: u.hostname, port: Number(u.port) || 80 }, ready)
    : tls.connect({ host: u.hostname, port: Number(u.port) || 443, servername: u.hostname }, ready)
  const stop = () => {
    up.destroy()
    socket.destroy()
  }
  up.on('error', stop)
  socket.on('error', stop)
  up.on('close', stop)
  socket.on('close', stop)
}

server.on('connect', (req, client, head) => {
  const cfg = readCfg()
  const target = L.parseConnectTarget(req.url)
  const srv = cfg ? mitmServer() : null
  const action = L.proxyAction(cfg ? cfg.proxy : { enabled: false }, target, Boolean(srv))
  client.on('error', () => client.destroy())
  if (action === 'refuse') return client.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n')
  if (action === 'mitm') {
    proxyStats.mitm += 1
    proxyStats.lastMitmAt = Date.now()
    client.write('HTTP/1.1 200 Connection Established\r\n\r\n')
    if (head && head.length) client.unshift(head)
    return srv.emit('connection', client)
  }
  proxyStats.tunnel += 1
  holdTunnel(client)
  let open = false
  const up = net.connect({ host: target.host, port: target.port }, () => {
    open = true
    client.write('HTTP/1.1 200 Connection Established\r\n\r\n')
    if (head && head.length) up.write(head)
    up.pipe(client)
    client.pipe(up)
  })
  const stop = () => {
    up.destroy()
    client.destroy()
  }
  up.on('error', () => (open ? stop() : client.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n')))
  up.on('close', stop)
  client.on('close', stop)
})

const cfg0 = readCfg()
// A config parseCfg rejects (an env token not set yet) still names its port; do not fall back to 8950 over it
const PORT = cfg0
  ? cfg0.port
  : (() => {
      try {
        const p = JSON.parse(fs.readFileSync(CFG_FILE, 'utf8')).port
        return L.isPort(p) ? p : 8950
      } catch {
        return 8950
      }
    })()
server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    // The plugin hook starts a router only after a failed health check, so finding our own router here is a startup race
    const refuse = (h) => {
      const other = h && h.configDir
      if (other && L.sameDir(other, realDir)) process.exit(0)
      if (h && !other) {
        log(`port ${PORT} is already used by an older model-relay router (it does not report its config dir); leaving it running`)
        process.exit(0)
      }
      log(`port ${PORT} is already used by ${other ? `another model-relay router (config dir ${other})` : 'an unknown process'}; this router (config dir ${realDir}) did not start. Change the port with "node tools/setup.mjs set port <n>"`)
      process.exit(1)
    }
    const req = http.get(`http://127.0.0.1:${PORT}/__health`, { timeout: 2000 }, (res) => {
      const ch = []
      res.on('data', (c) => ch.push(c))
      res.on('end', () => {
        let h = null
        try {
          const j = JSON.parse(Buffer.concat(ch).toString('utf8'))
          if (j && j.ok === true && j.pid) h = j
        } catch {}
        refuse(h)
      })
    })
    req.on('error', () => refuse(null))
    req.on('timeout', () => refuse(null))
    return
  }
  log(`server error: ${e.message}`)
  process.exit(1)
})
server.listen(PORT, '127.0.0.1', () => {
  log(`router up on ${server.address().port}, pid ${process.pid}`)
  superviseLaunchers()
  setInterval(superviseLaunchers, 30000).unref()
})

// Any local provider with `launch: {command, args}` is started when its local port is closed
function superviseLaunchers() {
  const cfg = readCfg()
  if (!cfg) return
  for (const p of Object.values(cfg.providers)) launchIfDown(p)
}

function launchIfDown(p) {
  const l = p.launch
  if (!l || typeof l.command !== 'string' || !P.isLocal(p.url)) return
  const port = Number(new URL(p.url).port) || 80
  P.portOpen('127.0.0.1', port, 2000).then((up) => {
    if (up) return
    try {
      const c = require('child_process').spawn(l.command, Array.isArray(l.args) ? l.args : [], { detached: true, stdio: 'ignore', windowsHide: true })
      c.on('error', (e) => log(`launch [${p.name}] failed: ${e.message}`))
      c.unref()
      log(`launched [${p.name}] ${l.command} (port ${port} was closed)`)
    } catch (e) {
      log(`launch [${p.name}] failed: ${e.message}`)
    }
  })
}
