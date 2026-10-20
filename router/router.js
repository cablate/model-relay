'use strict'
// Local relay router for Claude Code: routes requests across Claude and custom providers
// (GLM, Gemini, DeepSeek, Kimi, MiniMax, OpenRouter, etc.), with sticky session cache protection and 429 failover.
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

// This process is itself the HTTPS proxy: it must never send its own traffic, or its children's, through a proxy
// setting inherited from Claude Code, which would loop back into it.
for (const k of ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'all_proxy']) delete process.env[k]

const dir = process.argv[2] || process.env.CLAUDE_CONFIG_DIR || path.join(process.env.USERPROFILE || process.env.HOME || '', '.claude')

function resolveCfgPath() {
  const relay = path.join(dir, 'model-relay.json')
  if (fs.existsSync(relay)) return relay
  return path.join(dir, 'custom-agent.json')
}

function resolveStatePath() {
  const relay = path.join(dir, 'model-relay-state.json')
  if (fs.existsSync(relay)) return relay
  const legacy = path.join(dir, 'custom-agent-state.json')
  if (fs.existsSync(legacy)) return legacy
  return relay
}

const LOG_FILE = path.join(dir, 'custom-agent-router.log')
const REQLOG = path.join(dir, 'custom-agent-requests.log')

// The file is re-read on every request so edits apply at once. A read that fails (an editor mid-save, a typo) keeps
// the last good config instead of failing requests; "doctor" is what tells a person the file is broken.
let lastGoodCfg = null
// env:VAR tokens that did not resolve in THIS process (a router started before the key was exported never sees it)
let unresolved = []
const readCfg = () => {
  unresolved = [] // a file that cannot be read or parsed must not be blamed on an env var
  try {
    const raw = JSON.parse(fs.readFileSync(resolveCfgPath(), 'utf8'))
    unresolved = L.unresolvedEnv(raw)
    const parsed = L.parseCfg(raw)
    if (parsed) lastGoodCfg = parsed
    return parsed || lastGoodCfg
  } catch {
    return lastGoodCfg
  }
}

const cfgMissing = () => L.cfgMissingMessage(unresolved)

let state = (() => {
  try {
    return L.parseState(JSON.parse(fs.readFileSync(resolveStatePath(), 'utf8')))
  } catch {
    return L.emptyState()
  }
})()

// In-memory runtime latency/status per provider
const providerStats = {}

const log = (line) => {
  try {
    fs.appendFileSync(LOG_FILE, `${new Date().toISOString()} ${line}\n`)
  } catch {}
}

const save = () => {
  state = L.pruneSticky(state, Date.now())
  try {
    fs.writeFileSync(resolveStatePath(), JSON.stringify({ ...state, updatedAt: Date.now() }, null, 2) + '\n')
  } catch {}
}

const setState = (next, why) => {
  state = next
  save()
  if (why) log(why)
}
setInterval(save, 600000).unref()

const short = (sid) => (sid ? sid.slice(0, 8) : '-')
const stick = (sid, providerName, why) => {
  if (!sid || !providerName) return
  const prev = state.sticky?.[sid]?.provider
  state = L.setSticky(state, sid, providerName, Date.now())
  if (prev !== providerName) setState(state, `session ${short(sid)} moved to ${providerName} (${why})`)
}

const logReq = (entry) => {
  try {
    if (fs.statSync(REQLOG).size > 5 * 1024 * 1024) fs.writeFileSync(REQLOG, '')
  } catch {}
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

function buildAuthHeaders(provider, baseHeaders = {}) {
  const headers = { ...baseHeaders }
  delete headers['x-api-key']
  delete headers['authorization']
  if (provider.authHeader === 'bearer' || provider.authHeader === 'both') {
    headers['authorization'] = `Bearer ${provider.token}`
  }
  if (provider.authHeader === 'x-api-key' || provider.authHeader === 'both') {
    headers['x-api-key'] = provider.token
  }
  return headers
}

function pingOne(provider) {
  return new Promise((resolve) => {
    const t0 = Date.now()
    const u = new URL(provider.url)
    const lib = u.protocol === 'http:' ? http : https
    const payload = Buffer.from(JSON.stringify({
      model: L.wireModel(provider.model),
      max_tokens: 1,
      messages: [{ role: 'user', content: 'hi' }],
    }))
    const headers = buildAuthHeaders(provider, {
      'content-type': 'application/json',
      'anthropic-version': '2023-06-01',
      'content-length': payload.length,
      host: u.host,
    })
    const up = lib.request({
      hostname: u.hostname,
      port: u.port || (u.protocol === 'http:' ? 80 : 443),
      path: L.upstreamPath(provider.url, '/v1/messages'),
      method: 'POST',
      headers,
      timeout: 8000,
    }, (ur) => {
      ur.resume()
      ur.on('end', () => {
        const entry = { status: ur.statusCode || 0, ms: Date.now() - t0, at: Date.now() }
        providerStats[provider.name] = entry
        resolve(entry)
      })
    })
    up.on('timeout', () => {
      up.destroy()
      const entry = { status: 0, ms: Date.now() - t0, at: Date.now() }
      providerStats[provider.name] = entry
      resolve(entry)
    })
    up.on('error', () => {
      const entry = { status: 0, ms: Date.now() - t0, at: Date.now() }
      providerStats[provider.name] = entry
      resolve(entry)
    })
    up.end(payload)
  })
}

// tried: providers this request already gave up on, so a fallback never loops back to one of them
function toProvider(provider, req, res, body, rewrite, sid, attempt = 0, tried = []) {
  const t0 = Date.now()
  let out = body
  if (body.length) {
    try {
      out = L.rewriteBody(body, {
        model: rewrite ? provider.model : null,
        defaultModel: provider.model,
        stripCacheControl: provider.stripCacheControl,
        stripToolSearch: provider.stripToolSearch,
      })
    } catch {
      if (rewrite) return apiError(res, 400, `could not rewrite request for provider "${provider.name}"`)
    }
  }
  const headers = buildAuthHeaders(provider, req.headers)
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
      res.writeHead(ur.statusCode, ur.headers)
      let tail = ''
      ur.on('data', (c) => {
        tail = (tail + c.toString('utf8')).slice(-4000)
      })
      ur.on('end', () => {
        providerStats[provider.name] = { status, ms: Date.now() - t0, at: Date.now() }
        const all = [...tail.matchAll(/"input_tokens"\s*:\s*(\d+)/g)]
        const last = all.length ? Number(all[all.length - 1][1]) : null
        const tag = provider.name === 'glm' ? 'zai' : provider.name
        logReq({ to: `${tag}-reply`, sid: short(sid), rewrite, status, bytes: out.length, inputTokens: last, attempt })
      })
      return relay(ur, res)
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
      const foProvider = cfg.providers[cfg.failoverProvider]
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
      failoverSince: state.failoverSince,
      nextClaudeTry: state.nextClaudeTry,
      failoverProvider: cfg ? cfg.failoverProvider : 'glm',
      failoverChain: cfg ? cfg.failoverChain : [],
      aliases: cfg ? L.detectAliases(cfg) : {},
      config: cfg ? { failoverEnabled: cfg.failoverEnabled, retryEnabled: cfg.retry.enabled, proxyEnabled: cfg.proxy.enabled } : null,
      providers,
      unresolved,
      stats: providerStats,
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
    Promise.all(list.map(pingOne)).then(() => {
      json(res, { ok: true, stats: providerStats })
    })
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
  if (tunneled) {
    const cfg = readCfg()
    if (!cfg) return apiError(res, 500, cfgMissing())
    if (!L.isRoutedRequest(req.method, req.url)) return passthrough(cfg, req, res)
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

function mitmServer() {
  const now = Date.now()
  if (mitmCache && mitmCache.server && now - mitmCache.checkedAt < 10000) return mitmCache.server
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
  mitmCache = { server: srv, cert, checkedAt: now }
  return srv
}

// WebSocket and other upgrades are not ours to inspect: forward the raw request and pipe both ways
function tunnelUpgrade(req, socket, head) {
  const cfg = readCfg()
  const host = String(req.headers.host || '').replace(/:\d+$/, '').toLowerCase()
  if (!cfg || host !== L.PROXY_MITM_HOST) return socket.destroy()
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
  const action = L.proxyAction(cfg ? cfg.proxy : { enabled: true }, target, Boolean(srv))
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
server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') process.exit(0)
  log(`server error: ${e.message}`)
  process.exit(1)
})
server.listen(cfg0 ? cfg0.port : 8950, '127.0.0.1', () => {
  log(`router up on ${cfg0 ? cfg0.port : 8950}, pid ${process.pid}`)
  superviseLaunchers()
  setInterval(superviseLaunchers, 30000).unref()
})

// Any local provider with `launch: {command, args}` is automatically started when its local port is closed.
function superviseLaunchers() {
  const cfg = readCfg()
  if (!cfg) return
  for (const p of Object.values(cfg.providers)) {
    const l = p.launch
    if (!l || typeof l.command !== 'string' || !/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?/i.test(p.url)) continue
    const u = new URL(p.url)
    const port = Number(u.port) || 80
    const sock = require('net').connect({ host: '127.0.0.1', port })
    sock.setTimeout(2000)
    sock.on('connect', () => sock.destroy())
    const down = () => {
      sock.destroy()
      try {
        const c = require('child_process').spawn(l.command, Array.isArray(l.args) ? l.args : [], {
          detached: true,
          stdio: 'ignore',
          windowsHide: true,
        })
        c.on('error', (e) => log(`launch [${p.name}] failed: ${e.message}`))
        c.unref()
        log(`launched [${p.name}] ${l.command} (port ${port} was closed)`)
      } catch (e) {
        log(`launch [${p.name}] failed: ${e.message}`)
      }
    }
    sock.on('error', down)
    sock.on('timeout', down)
  }
}
