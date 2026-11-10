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
const crypto = require('crypto')
const { pipeline } = require('stream')
const L = require('./logic')
const PKI = require('./pki')
const P = require('./ping')
const K = require('./keychain')

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
// When this router last saw Claude's usage-limit 429, whatever failover did with it (an empty chain included). Not
// saved: /__health reports it so a window in accountFallback mode "switch" can say the main account is out.
let claudeLimitedAt = 0
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
// env:VAR tokens that did not resolve in THIS process (a router started before the key was exported never sees it),
// and keychain: items it could not read
let unresolved = []

// keychain: tokens are read in the background, started by the first config parse that names them (cfg0 below, a request
// or a /__health), and kept; a failed item is read again only after model-relay.json has changed, never on a timer (see
// K.cachedReader). A request never waits on the keychain: until an item's read lands its providers are skipped. Never put
// in process.env, a log line or an error text.
let cfgStamp = '' // the state of model-relay.json at the last readCfg: mtime and size
const keychain = K.cachedReader(K.readSecretAsync, (line) => log(line), () => cfgStamp)
const HOME = process.env.USERPROFILE || process.env.HOME || ''
// Set only by a test that preloads code into this process (node --require): lets a kind "anthropic" provider use a
// local stand-in for Anthropic. No config key or environment variable can set it. relayDir and home: whose account is
// the relay's own (an accounts entry whose configDir is this dir), which is never reserved as anybody's fallback.
const parseOpts = { keychain: keychain.get, anyClaudeUrl: globalThis.__modelRelayAnyClaudeUrl === true, relayDir: dir, home: HOME }
const where = { relayDir: dir, home: HOME }

// Windows of a second account in mode "switch" (the launcher wrapper's relaunch, or a window started on that account's
// config dir with MODEL_RELAY_CONFIG_DIR): sid -> { account, registeredAt }, set by POST /__account. In memory only, never
// in the state file; emptied whenever the config's mode is not "switch"; the oldest entry goes past the cap.
const accountSessions = new Map()
const ACCOUNT_SESSIONS_MAX = 256
// When each account answered its own usage limit plus failover.cooldownMs, account -> ms: an account whose windows hit it,
// a fallback account and a failover.chain account (rc-keep, api-only) that answered it alike. Until then A's windows go to
// the next account of its list, a fallback account is skipped, and so is a chain account (toAnthropicAccount: the next
// link takes the request). In memory only: after a restart the first request tries the account again.
const accountLimitedUntil = new Map()
const limitedUntil = (name) => accountLimitedUntil.get(name) || 0
// The session id a window's requests carry on an account in place of its own: "<sid>\n<account>" -> a random
// UUID made on first use, so all of one window's requests there share one id and the fallback account never sees the
// window's. In memory only (a restart makes a new one), capped as accountSessions; logged in short form only.
const fallbackSids = new Map()
function fallbackSid(sid, account) {
  const key = `${sid}\n${account}`
  let id = fallbackSids.get(key)
  if (!id) {
    if (fallbackSids.size >= ACCOUNT_SESSIONS_MAX) fallbackSids.delete(fallbackSids.keys().next().value)
    id = crypto.randomUUID()
    fallbackSids.set(key, id)
    log(`session ${short(sid)} is session ${short(id)} on ${account}`)
  }
  return id
}
// An account's login file (L.loginFile: <home>/.claude.json for the default dir, else <configDir>/.claude.json), its
// oauthAccount accountUuid and organizationUuid only (never logged), lower case, or null when it cannot be read: whose
// usage limit a 429 is, and whether two accounts share an organization. Read again when the file's mtime changes.
const logins = new Map() // file -> { mtimeMs, ids }
function loginIdsOf(cfg, account) {
  const given = cfg && cfg.accountView ? cfg.accountView.dirs.get(account) : undefined
  return given ? L.loginIds(L.loginFile(L.expandHome(given, HOME), HOME), logins) : null
}
const ownAccountUuid = (cfg, account) => (loginIdsOf(cfg, account) || {}).accountUuid || null
// The relay dir's own login (main's), or null when it cannot be read
const relayAccountUuid = () => (L.loginIds(L.loginFile(path.resolve(dir), HOME), logins) || {}).accountUuid || null

// The fallback accounts of `account` that may serve it now, in order, as providers: loaded as fallbackOnly and passing
// the org rule (L.fallbackRefusal), re-checked on every call. tell: log a refused one (names and a fixed text only), once
// per reason until it changes or the account is usable again, on request paths
const skipsTold = new Map() // "<account>\n<fallback account>" -> the reason last logged
function usableTargets(cfg, account, tell = false) {
  return L.accountFallbacks(cfg, account).filter(({ provider, allowCrossOrg }) => {
    const why = L.fallbackRefusal(account, provider, allowCrossOrg, (n) => loginIdsOf(cfg, n))
    const key = `${account}\n${provider.name}`
    if (tell && !why) skipsTold.delete(key)
    if (tell && why && skipsTold.get(key) !== why) {
      skipsTold.set(key, why)
      log(`account ${account}: ${provider.name} skipped: ${why}`)
    }
    return !why
  }).map((x) => x.provider)
}
// The next fallback account for this request: usable, not at its own usage limit, not tried yet (tried: names)
const nextTarget = (cfg, account, tried, tell = false) => usableTargets(cfg, account, tell).find((p) => !tried.includes(p.name) && Date.now() >= limitedUntil(p.name)) || null

// opts.walk for a request served from `account`'s list: called with the fallback account that just could not serve it and
// the names tried so far, and gives the next usable one, or null. Always A's list, the config read again, the original
// body each hop (toProvider's caller keeps it). deliver has marked an account that answered its usage limit already;
// refused: that account's body could not be spliced, which says nothing of its limit
const walkFor = (account) => (target, tried, refused = false) => {
  const cfgNow = readCfg()
  const next = cfgNow ? nextTarget(cfgNow, account, tried, true) : null
  log(`account ${target.name} ${refused ? 'could not serve a request' : 'hit its usage limit'} as ${account}'s fallback: ${next ? `${next.name} goes on with the request` : `no other fallback account of ${account} is usable now`}`)
  return next
}

// The account view (the relay's own account by realpath, the fallback lists by scan) of the config text last read. Every
// request reads the config several times, and the view is the same until the text, or something that decides what a path
// in it is, changes: each account folder and the login file in it (and the default login file, <home>/.claude.json) are
// stat'ed for their mtimes (a folder that appears, or a symlink that is pointed elsewhere, changes the realpath the view
// was made from), and that is all it costs per read; no realpath.
let viewCache = null // { text, stamp, view }
const mtimeOf = (p) => {
  try {
    return fs.statSync(p).mtimeMs
  } catch {
    return 0
  }
}
const loginStamp = (view) => [mtimeOf(path.join(HOME, '.claude.json')), ...[...view.dirs.values()].map((given) => {
  const d = L.expandHome(given, HOME)
  return `${mtimeOf(d)}:${mtimeOf(path.join(d, '.claude.json'))}`
})].join('|')
function accountViewOf(raw, text) {
  const stamp = viewCache && viewCache.text === text ? loginStamp(viewCache.view) : null
  if (stamp !== null && stamp === viewCache.stamp) return viewCache.view
  const view = L.accountView(raw, parseOpts.anyClaudeUrl, where)
  viewCache = { text, stamp: loginStamp(view), view }
  return view
}

const readCfg = () => {
  unresolved = [] // a file that cannot be read or parsed must not be blamed on an env var
  try {
    const st = fs.statSync(CFG_FILE)
    cfgStamp = `${st.mtimeMs}:${st.size}`
    const text = fs.readFileSync(CFG_FILE, 'utf8')
    const raw = JSON.parse(text)
    const view = accountViewOf(raw, text)
    // An item still being read is not reported: it is not missing, and its hint would be gone a moment later
    unresolved = L.unresolvedEnv(raw, process.env, keychain.get, parseOpts.anyClaudeUrl, { ...where, view }).filter(keychain.reportable)
    // A file that reads fine but has no usable provider (keys not exported yet) still lets Claude through, and is what a
    // later unreadable file falls back to: never an older file's providers (a Claude account a mode change dropped)
    if (view.mode !== 'switch') accountSessions.clear()
    lastGoodCfg = Object.assign(L.parseCfg(raw, process.env, { ...parseOpts, view }) || L.bareCfg(raw), { accountView: view })
    return lastGoodCfg
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

const short = (sid) => (sid ? String(sid).slice(0, 8) : '-')
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

const errorBody = (message) => JSON.stringify({ type: 'error', error: { type: 'api_error', message: `model-relay router: ${message}` } })
const apiError = (res, status, message) => {
  if (res.headersSent) return res.end()
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(errorBody(message))
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
  // An upstream that accepts the request and then says nothing would hold the caller forever
  const idleMs = readCfg()?.idleTimeoutMs || 300000
  up.setTimeout(idleMs, () => up.destroy(new Error(`no data for ${Math.round(idleMs / 1000)}s`)))
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

// true when the request asked for Message Threads, which no provider holds; it has been answered with Anthropic's refusal
function refusedThreads(provider, req, res, sid) {
  const threadRefusal = L.threadBetaRefusal(req.headers)
  if (!threadRefusal) return false
  logReq({ to: `${provider.name}-thread-refused`, sid: short(sid) })
  if (res.headersSent) res.end()
  else {
    res.writeHead(400, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: threadRefusal } }))
  }
  return true
}

// tried: providers this request already gave up on, so a fallback never loops back to one of them. opts.noChain: this
// provider answers the request or the caller gets its error; nobody else is asked (set here for a fallbackOnly account,
// and carried through every retry)
function toProvider(provider, req, res, body, rewrite, sid, attempt = 0, tried = [], opts = {}) {
  if (provider.fallbackOnly) opts = { ...opts, noChain: true }
  // The one branch for a Claude account: the first failover, a pinned session, the cooldown, a fallback and every retry
  // all reach a provider through here
  if (L.isAccount(provider)) return toAnthropicAccount(provider, req, res, body, sid, attempt, tried, opts)
  if (refusedThreads(provider, req, res, sid)) return
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
  deliver(provider, req, res, body, out, headers, { rewrite, sid, attempt, tried, restoreToolSearch, opts })
}

// A second Claude subscription (rc-keep, api-only): Claude Code's own request with that account's token, nothing else
// changed but the account_uuid and device_id in metadata.user_id and the address in the injected email sentence
// (L.spliceAccount); any other mention of your account in the conversation is not scrubbed.
// req.headers is never changed, so a later fallback starts from the caller's headers.
// Every account also gets the window's replacement session id (fallbackSid), in metadata.user_id inside the same splice
// and in x-claude-code-session-id: a chain account in rc-keep and api-only, as a fallback account. A request with no
// session header has no id to replace, and goes on with the one in its body.
function toAnthropicAccount(provider, req, res, body, sid, attempt, tried, opts = {}) {
  if (refusedThreads(provider, req, res, sid)) return
  // Only a model call is the account's; anything else (GET /v1/models from a pinned session) goes to Anthropic as it
  // came, with the caller's own credentials
  const asCallerSent = () => send(provider.url, req, res, body, { ...req.headers }, (ur) => {
    res.writeHead(ur.statusCode, ur.headers)
    relay(ur, res)
  }, (e) => apiError(res, 502, `Anthropic unreachable: ${e.message}`))
  if (!L.isRoutedRequest(req.method, req.url)) return asCallerSent()
  // A chain account that answered its own usage limit less than failover.cooldownMs ago is not asked again: the next link
  // of the chain takes the request (decide, a pin by hand and nextFallback all arrive here). With no other link it is
  // asked anyway, and answers its limit again.
  if (!provider.fallbackOnly && !opts.noChain && Date.now() < limitedUntil(provider.name)) {
    const cfgNow = readCfg()
    const next = cfgNow && cfgNow.failoverEnabled ? L.nextFallback(cfgNow, provider.name, tried, L.requestModel(body)) : null
    if (next) {
      log(`provider "${provider.name}" is at its usage limit until its cooldown ends; "${next.name}" takes this request`)
      return toProvider(next, req, res, body, true, sid, 0, [...tried, provider.name])
    }
  }
  const session = sid ? { from: sid, to: fallbackSid(sid, provider.name) } : null
  const { body: out, why } = body.length ? L.spliceAccount(body, provider, session) : { body, why: null }
  if (why) {
    // A body whose metadata ids or injected email sentence cannot be replaced exactly never goes out with this account's
    // token: the next link takes it, or the caller gets an error. It is never resent on your own account behind your back.
    log(`provider "${provider.name}" not used for this request: ${why}`)
    // A fallback account of a list: the next account of that list; when the list is out, the relay's own account goes on
    // with main's failover (opts.exhausted), and any other window gets the error. The window's own account is at its
    // usage limit, so "back to your own account" is no way out for it.
    if (opts.walk) {
      const next = opts.walk(provider, [...tried, provider.name], true)
      if (next) return toProvider(next, req, res, body, true, sid, 0, [...tried, provider.name], { walk: opts.walk, exhausted: opts.exhausted })
      const text = `account "${provider.name}" could not serve this request: ${why}; nothing was sent with that account, and this window's own account is at its usage limit. Continue in ${provider.name}'s own login (/provider switch, then /exit, when it is the account accountFallback.account names; otherwise start Claude Code with CLAUDE_CONFIG_DIR set to its folder and --continue), or wait for the limit to reset; details in model-relay.log`
      return opts.exhausted ? opts.exhausted(502, errorBody(text), { 'content-type': 'application/json' }) : apiError(res, 502, text)
    }
    const cfgNow = readCfg()
    const next = !opts.noChain && cfgNow && cfgNow.failoverEnabled ? L.nextFallback(cfgNow, provider.name, tried, L.requestModel(body)) : null
    return next ? toProvider(next, req, res, body, true, sid, 0, [...tried, provider.name]) : apiError(res, 502, `account "${provider.name}" could not serve this request: ${why}; nothing was sent with that account. /provider claude (or waiting out the cooldown) continues on your own account; details in model-relay.log`)
  }
  // A fresh object with exactly one authorization, the account's; the caller's authorization and x-api-key are dropped
  const headers = P.authHeaders(provider, req.headers)
  headers['anthropic-beta'] = L.withOAuthBeta(headers['anthropic-beta'])
  if (session) headers['x-claude-code-session-id'] = session.to
  deliver(provider, req, res, body, out, headers, { rewrite: true, sid, attempt, tried, restoreToolSearch: false, usageLimitMovesOn: true, opts })
}

// Sends `out` with `headers`, then streams a success back, or retries this provider, or hands the original `body` to
// the next provider. usageLimitMovesOn: a usage-limit 429 is not retried here (the account stays out for hours) and
// moves on to the next link whatever retry.failover says. opts.noChain (see toProvider): nobody takes over.
function deliver(provider, req, res, body, out, headers, { rewrite, sid, attempt, tried, restoreToolSearch, usageLimitMovesOn = false, opts = {} }) {
  const t0 = Date.now()
  // Per-provider switch: retryCfg === null means this provider never retries
  const retryCfg = provider.retryCfg !== undefined ? provider.retryCfg : null

  // Retries exhausted on this provider: hand the ORIGINAL body to the failover provider when one exists. A fallback
  // account's own usage limit (opts.walk) goes to the next account of the list instead, and when none is left to
  // opts.exhausted (the relay's own account: main's failover) or back to the caller
  const giveUp = (status, text, upstreamHeaders, limited = false) => {
    if (limited && opts.walk) {
      const next = opts.walk(provider, [...tried, provider.name])
      if (next) return toProvider(next, req, res, body, true, sid, 0, [...tried, provider.name], { walk: opts.walk, exhausted: opts.exhausted })
      if (opts.exhausted) return opts.exhausted(status, text, upstreamHeaders)
    }
    const cfgNow = readCfg()
    const allowed = limited || (retryCfg && retryCfg.failover)
    const next = !opts.noChain && allowed && cfgNow && cfgNow.failoverEnabled ? L.nextFallback(cfgNow, provider.name, tried, L.requestModel(body)) : null
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
    setTimeout(() => toProvider(provider, req, res, body, rewrite, sid, attempt + 1, tried, opts), wait)
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
      if (usageLimitMovesOn && status === 429) {
        const encoded = ur.headers['content-encoding'] && ur.headers['content-encoding'] !== 'identity'
        if (L.isUsageLimit(429, ur.headers, encoded ? '' : text.toString('utf8'))) {
          providerStats[provider.name] = { status, ms: Date.now() - t0, at: Date.now() }
          log(`provider "${provider.name}" hit its usage limit; not retried`)
          // a Claude account out of usage is not asked again until failover.cooldownMs has passed (toAnthropicAccount, nextTarget)
          if (L.isAccount(provider)) accountLimitedUntil.set(provider.name, Date.now() + ((readCfg() || {}).cooldownMs || 600000))
          return giveUp(status, text, ur.headers, true)
        }
      }
      if (maybeRetry(status, ur.headers, null)) return
      giveUp(status, text, ur.headers)
    })
    // The provider dropped the connection before the error body ended: 'end' never comes, so answer as unreachable
    ur.on('close', () => {
      if (ur.complete) return
      logReq({ to: `${provider.name}-fail`, sid: short(sid), status, attempt, error: 'connection dropped mid-answer' })
      if (maybeRetry(502, null, 'connection dropped')) return
      giveUp(502, null, null)
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
      const raw = Buffer.concat(chunks)
      // A compressed body is passed back byte for byte; only a plain one can be read for the usage-limit wording
      const encoded = ur.headers['content-encoding'] && ur.headers['content-encoding'] !== 'identity'
      const text = encoded ? '' : raw.toString('utf8')
      const limited = L.isUsageLimit(429, ur.headers, text)
      // the relay's own account's list comes first, for a request of that account only; main's failover after it
      const self = limited ? selfFallback(req, res, body, sid) : null
      if (self) return toProvider(self.next, req, res, body, true, sid, 0, [], { walk: walkFor(self.account), exhausted: () => mainLimit(cfg, req, res, body, trial, sid, limited, ur.statusCode, ur.headers, raw) })
      mainLimit(cfg, req, res, body, trial, sid, limited, ur.statusCode, ur.headers, raw)
    })
  }, (e) => apiError(res, 502, `Anthropic unreachable: ${e.message}`))
}

// Claude's 429 as main's failover takes it, as at c1b1fef: a usage limit sets claudeLimitedAt and hands the ORIGINAL body
// to the chain's first link (onLimited, stick); anything else, or no link, goes back to the caller as it came
function mainLimit(cfg, req, res, body, trial, sid, limited, status, headers, raw) {
  const foProvider = cfg.failoverProvider ? cfg.providers[cfg.failoverProvider] : null
  if (limited) claudeLimitedAt = Date.now()
  if (cfg.failoverEnabled && foProvider && limited) {
    setState(L.onLimited(state, cfg, Date.now()), `claude usage limit${trial ? ' (still)' : ''}: using ${foProvider.name} (${L.modelLabel(foProvider)})`)
    // A Claude account is never stuck to: the session stays unpinned, so the trial brings it back to Claude
    if (!L.isAccount(foProvider)) stick(sid, foProvider.name, 'usage limit')
    return toProvider(foProvider, req, res, body, true, sid)
  }
  res.writeHead(status, headers)
  res.end(raw)
}

// The relay's own account (an accounts entry whose configDir is this dir) with a fallback list: main's windows are its
// windows, never registered. { account, next } when a usage limit Claude just answered for a request of main's window
// goes on with that list, else null (main's failover takes it as before). Only a model call not yet answered, and only
// for a body carrying that account's own account_uuid from its login file: any other body, or an unreadable login, takes
// today's path. The account then counts as limited for failover.cooldownMs, whether or not a fallback is usable.
function selfFallback(req, res, body, sid) {
  if (res.headersSent || !L.isRoutedRequest(req.method, req.url)) return null
  const cfgNow = readCfg()
  const self = cfgNow && cfgNow.accountView ? cfgNow.accountView.self : null
  if (!self || !L.accountFallbacks(cfgNow, self).length) return null
  const own = ownAccountUuid(cfgNow, self)
  if (!own || L.bodyAccountUuid(body) !== own) {
    log(`account ${self} (the relay's own): a usage limit for a request that is not that account's own (or its login could not be read); main's failover takes it`)
    return null
  }
  accountLimitedUntil.set(self, Date.now() + cfgNow.cooldownMs)
  const next = nextTarget(cfgNow, self, [], true)
  log(`account ${self} (the relay's own) hit its usage limit: ${next ? `main's windows use ${next.name} for ${Math.round(cfgNow.cooldownMs / 60000)} min (session ${short(sid)})` : 'no fallback account is usable now; main\'s failover takes it'}`)
  return next ? { account: self, next } : null
}

// While the relay's own account is at its usage limit: the fallback account a request of main's window routed to Claude
// goes to directly, or null. The same ownership rule as selfFallback (no own uuid, or another one: today's path).
function selfDirect(cfg, body) {
  const self = cfg.accountView ? cfg.accountView.self : null
  if (!self || Date.now() >= limitedUntil(self)) return null
  const own = ownAccountUuid(cfg, self)
  if (!own || L.bodyAccountUuid(body) !== own) return null
  const next = nextTarget(cfg, self, [], true)
  return next ? { account: self, next } : null
}

// The registration of sid as a second account's window, checked against the config as it is now: mode "switch",
// claudeUrl at Anthropic, the account still in accounts. A registration the config no longer allows is dropped, and the
// sid takes the normal path again.
function accountOf(cfg, sid) {
  const reg = sid ? accountSessions.get(sid) : undefined
  if (!reg) return undefined
  const view = cfg && cfg.accountView
  if (view && view.mode === 'switch' && view.claudeIsAnthropic && view.names.has(reg.account)) return reg
  accountSessions.delete(sid)
  log(`session ${short(sid)} is no longer an account window (the config no longer allows it)`)
  return undefined
}

// Claude for a second account's window: the caller's request and credentials as they came, and Claude's answer as it
// comes, a 429 included. No onLimited, onClaudeOk, stick or claudeLimitedAt: main's failover state never sees it.
// limitSid: the window's sid; a 429 is read (fallbackAfterLimit) to move it to a fallback account, or, with none to go to,
// to note that its account is at its usage limit (/__health accountLimited), and is then passed back byte for byte.
function toClaudeAsSent(cfg, req, res, body, limitSid = null) {
  send(cfg.claudeUrl, req, res, body, { ...req.headers }, (ur) => {
    if (!limitSid || ur.statusCode !== 429) {
      res.writeHead(ur.statusCode, ur.headers)
      return relay(ur, res)
    }
    const chunks = []
    ur.on('data', (c) => chunks.push(c))
    ur.on('end', () => {
      const raw = Buffer.concat(chunks)
      // as in toClaude: a compressed body is passed back byte for byte, and only a plain one is read for the wording
      const encoded = ur.headers['content-encoding'] && ur.headers['content-encoding'] !== 'identity'
      const go = fallbackAfterLimit(req, res, body, limitSid, ur.headers, encoded ? '' : raw.toString('utf8'))
      if (go) return toProvider(go.next, req, res, body, true, limitSid, 0, [], { walk: walkFor(go.account) })
      res.writeHead(ur.statusCode, ur.headers)
      res.end(raw)
    })
  }, (e) => apiError(res, 502, `Anthropic unreachable: ${e.message}`))
}

// An unregistered window's request in a mode that uses a second account (every mode but "off"; claudeUrl at Anthropic)
// whose body names an account_uuid that is not the relay dir's own login: another account's window, whatever it is
// called. false when either uuid cannot be read, so the request takes the path it always took.
const OTHER_LOGIN_MODES = L.ACCOUNT_MODES.filter((m) => m !== 'off')
function otherLogin(cfg, body) {
  const view = cfg.accountView
  if (!view || !OTHER_LOGIN_MODES.includes(view.mode) || !view.claudeIsAnthropic) return false
  const theirs = L.bodyAccountUuid(body)
  const own = theirs && relayAccountUuid()
  return Boolean(own) && theirs !== own
}

// { account, next }: the fallback account to resend an account window's request to after its 429, or null to pass the
// 429 back. Only a usage limit, only a model call not yet answered, only while the config (read again now) still has
// the sid registered, and only for a body that carries that account's own account_uuid: a sid registered for the wrong
// account never marks the real one limited. The account then counts as limited for failover.cooldownMs; next is the
// first usable account of its list not at its own limit. An account with no list at all is marked the same way and its
// 429 passed back: /__health then says accountLimited, so its window can tell the person what to do.
function fallbackAfterLimit(req, res, body, sid, headers, text) {
  if (!L.isUsageLimit(429, headers, text) || res.headersSent || !L.isRoutedRequest(req.method, req.url)) return null
  const cfgNow = readCfg()
  const reg = accountOf(cfgNow, sid)
  if (!reg) return null
  const first = L.accountFallbacks(cfgNow, reg.account)[0] || null
  const own = ownAccountUuid(cfgNow, reg.account)
  if (!own || L.bodyAccountUuid(body) !== own) {
    if (first) log(`account ${reg.account}: a usage limit for a request that is not that account's own (or its .claude.json could not be read); passed back, ${first.provider.name} not used`)
    return null
  }
  accountLimitedUntil.set(reg.account, Date.now() + cfgNow.cooldownMs)
  if (!first) {
    log(`account ${reg.account} hit its usage limit: it has no fallback list; passed back (session ${short(sid)})`)
    return null
  }
  const next = nextTarget(cfgNow, reg.account, [], true)
  log(next
    ? `account ${reg.account} hit its usage limit: its windows use ${next.name} for ${Math.round(cfgNow.cooldownMs / 60000)} min (session ${short(sid)})`
    : `account ${reg.account} hit its usage limit: no fallback account of it is usable now; passed back (session ${short(sid)})`)
  return next ? { account: reg.account, next } : null
}

// A fallbackOnly provider serves only a registered window whose account's list names it and lets it (the org rule);
// never an unregistered sid, so main's windows reach the relay's own account's list only through selfFallback/selfDirect
const mayUse = (cfg, p, reg) => !p.fallbackOnly || Boolean(reg && usableTargets(cfg, reg.account).includes(p))

function control(req, res, body) {
  const u = new URL(req.url, 'http://x')
  const cfg = readCfg()
  if (u.pathname === '/__health') {
    const sid = u.searchParams.get('sid') || ''
    const reg = accountOf(cfg, sid)
    // For an account's window, where its requests go (a pin from before its registration does not count)
    const accountRoute = reg ? L.accountRoute(state, cfg, null, sid, reg, Date.now(), limitedUntil, usableTargets(cfg, reg.account).map((p) => p.name)) : null
    // a main window while the relay's own account is at its usage limit: the fallback account its requests go to (a name
    // only; that account stays hidden from main's windows everywhere else)
    const self = !reg && cfg && cfg.accountView ? cfg.accountView.self : null
    const selfServing = self && Date.now() < limitedUntil(self) ? nextTarget(cfg, self, []) : null
    // only while decide sends this session to Claude (a pin, or failover's own provider, sends it elsewhere, and then the
    // relay's own account's list does not serve it: dispatch takes it only for a request routed to Claude)
    const selfIsClaude = (cfg, sid) => !cfg || L.parseRoute(L.decide(state, cfg, null, sid, Date.now()), cfg).kind === 'claude'
    const providers = {}
    const kinds = {} // providers that are not a model id: name -> kind ("anthropic")
    // a fallbackOnly account is listed, and its stats shown, only to a window that may use it
    const hidden = (k) => Boolean(cfg && cfg.providers[k] && !mayUse(cfg, cfg.providers[k], reg))
    if (cfg) {
      for (const [k, p] of Object.entries(cfg.providers)) {
        if (hidden(k)) continue
        providers[k] = L.modelLabel(p)
        if (p.kind) kinds[k] = p.kind
      }
    }
    const pinned = L.getSessionProvider(state, cfg, sid)
    const session = (reg && !accountRoute.route) || hidden(pinned) ? 'claude' : pinned
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
      claudeLimitedAt,
      failoverProvider: cfg ? cfg.failoverProvider : null,
      failoverChain: cfg ? cfg.failoverChain : [],
      aliases: cfg ? L.detectAliases(cfg) : {},
      config: cfg ? { failoverEnabled: cfg.failoverEnabled, retryEnabled: cfg.retry.enabled, proxyEnabled: cfg.proxy.enabled, cooldownMs: cfg.cooldownMs } : null,
      providers,
      kinds,
      unresolved,
      stats: Object.fromEntries(Object.entries(providerStats).filter(([k]) => !hidden(k))),
      ping: pingStats,
      seenModels,
      sessionsOnCustom: Object.keys(state.sticky || {}).length,
      session,
      ...(reg ? { account: reg.account } : {}),
      // the account is at its usage limit, and this window's requests go to its fallback account
      ...(accountRoute && accountRoute.account ? { accountServing: accountRoute.account } : {}),
      // the account is at its usage limit and nobody is left to take its window: no list, or every account of it limited
      ...(reg && Date.now() < limitedUntil(reg.account) && !(accountRoute && accountRoute.account) ? { accountLimited: true } : {}),
      ...(selfServing && selfIsClaude(cfg, sid) ? { selfServing: selfServing.name } : {}),
      proxy: { enabled: Boolean(cfg && cfg.proxy.enabled), certificate: Boolean(mitmServer()), ...proxyStats },
    })
  }
  if (u.pathname === '/__session' && req.method === 'POST') {
    let sid = ''
    let on = ''
    try {
      ;({ sid, on } = JSON.parse(body.toString('utf8')))
    } catch {}
    on = typeof on === 'string' ? on.trim().toLowerCase() : ''
    if (typeof sid !== 'string' || !sid || !on) return apiError(res, 400, 'need {sid, on: "<provider>" | "claude"} as strings')
    const reg = accountOf(cfg, sid)
    if (on !== 'claude' && (!cfg?.providers?.[on] || !mayUse(cfg, cfg.providers[on], reg))) {
      const avail = cfg ? Object.keys(cfg.providers).filter((k) => mayUse(cfg, cfg.providers[k], reg)).join(', ') : 'none'
      if (cfg?.providers?.[on]) return apiError(res, 400, `provider "${on}" is the fallback of another account's windows; this session cannot use it (configured: ${avail})`)
      return apiError(res, 400, `unknown provider "${on}" (configured: ${avail})`)
    }
    setState(L.setSticky(state, sid, on, Date.now()), `session ${short(sid)} set to ${on} by hand`)
    return json(res, { ok: true, session: on })
  }
  // {sid, account}: this sid is a window of that second account, whose Claude requests skip main's failover;
  // {sid, account: null} ends that. Only in mode "switch", only with claudeUrl at Anthropic, and only for an account
  // named in accounts. Every refusal is a fixed text that echoes nothing it was sent.
  if (u.pathname === '/__account' && req.method === 'POST') {
    let sid
    let account
    let since
    try {
      ;({ sid, account, since } = JSON.parse(body.toString('utf8')))
    } catch {}
    const view = cfg && cfg.accountView
    if (!view || view.mode !== 'switch') return apiError(res, 400, 'accountFallback.mode is not "switch"; no account window is registered')
    if (!view.claudeIsAnthropic) return apiError(res, 400, 'account windows are routed only while claudeUrl is https://api.anthropic.com')
    if (typeof sid !== 'string' || !L.UUID_RE.test(sid) || (account !== null && typeof account !== 'string')) return apiError(res, 400, 'need {sid: "<session uuid>", account: "<name in accounts>" | null}')
    if (account === null) {
      if (accountSessions.delete(sid)) log(`session ${short(sid)} is no longer an account window`)
      return json(res, { ok: true, account: null })
    }
    const name = account.trim().toLowerCase()
    if (!L.SAFE_NAME.test(name) || !view.names.has(name)) return apiError(res, 400, 'that account is not in accounts')
    if (name === view.self) return apiError(res, 400, 'that account is the relay\'s own; its windows are your own windows and are not registered')
    accountSessions.delete(sid)
    if (accountSessions.size >= ACCOUNT_SESSIONS_MAX) accountSessions.delete(accountSessions.keys().next().value)
    // since: when the window's hook first saw this sid registered, kept across a router restart so its /provider pin
    // (made after that) still counts; a time not a number, or in the future, is now
    const now = Date.now()
    accountSessions.set(sid, { account: name, registeredAt: typeof since === 'number' && since > 0 && since <= now ? since : now })
    log(`session ${short(sid)} registered as a window of account ${name}`)
    return json(res, { ok: true, account: name })
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
    // A Claude account is never tested: a test request would spend that subscription for nothing
    const list = (target && cfg.providers[target] ? [cfg.providers[target]] : Object.values(cfg.providers)).filter((p) => !L.isAccount(p))
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
    // A second account's window: never decide's cooldown or trial, never main's failover state. So is a window that
    // never registered but carries another login than the relay dir's own (one opened on an account's folder without
    // MODEL_RELAY_CONFIG_DIR): its usage-limit 429 is not main's, and it takes provider models only, no pins.
    const reg = accountOf(cfg, sid)
    const foreign = !reg && otherLogin(cfg, body)
    const viaAccount = reg ? L.accountRoute(state, cfg, model, sid, reg, Date.now(), limitedUntil, usableTargets(cfg, reg.account, Date.now() < limitedUntil(reg.account)).map((p) => p.name)) : foreign ? L.accountRoute(state, cfg, model, sid, { registeredAt: Infinity }) : null
    const asAccount = () => {
      logReq({ sid: short(sid), model, nMsgs, route: reg ? `account-${reg.account}` : 'other-login', ...(tunneled ? { via: 'proxy' } : {}) })
      return toClaudeAsSent(cfg, req, res, body, reg ? sid : null)
    }
    if (viaAccount && viaAccount.claude) return asAccount()
    if (viaAccount && viaAccount.account) {
      // the account is at its usage limit: straight to its first fallback account not at its own; only the rest of the
      // account's list takes over from it, nobody else
      logReq({ sid: short(sid), model, nMsgs, route: `account-${reg.account}-fallback-${viaAccount.account}`, ...(tunneled ? { via: 'proxy' } : {}) })
      return toProvider(cfg.providers[viaAccount.account], req, res, body, true, sid, 0, [], { walk: walkFor(reg.account) })
    }
    const route = viaAccount ? viaAccount.route : L.decide(state, cfg, model, sid, Date.now())
    const parsed = L.parseRoute(route, cfg)
    // a pin to a fallbackOnly account from any other session (made in rc-keep, or before the config changed) is ignored:
    // that session takes its own path as if unpinned
    if (parsed.kind === 'provider' && parsed.provider && !mayUse(cfg, parsed.provider, reg)) {
      if (reg) return asAccount()
      logReq({ sid: short(sid), model, nMsgs, route: 'claude', ...(tunneled ? { via: 'proxy' } : {}) })
      return toClaude(cfg, req, res, body, false, sid)
    }
    // a main window's request for Claude while the relay's own account is at its usage limit: straight to that account's
    // fallback, for its own requests only; when the list runs out, main's failover takes it (mainLimit)
    const direct = !reg && parsed.kind === 'claude' && L.isRoutedRequest(req.method, req.url) ? selfDirect(cfg, body) : null
    if (direct) {
      logReq({ sid: short(sid), model, nMsgs, route: `account-${direct.account}-fallback-${direct.next.name}`, ...(tunneled ? { via: 'proxy' } : {}) })
      return toProvider(direct.next, req, res, body, true, sid, 0, [], { walk: walkFor(direct.account), exhausted: (status, text, headers) => mainLimit(readCfg() || cfg, req, res, body, parsed.trial, sid, true, status, headers, text) })
    }
    logReq({ sid: short(sid), model, nMsgs, route, ...(tunneled ? { via: 'proxy' } : {}) })
    if (parsed.kind === 'provider' && parsed.provider) {
      // as in toClaude: the cooldown on a Claude account pins nobody; a /provider pin to it is made by hand only
      if (parsed.rewrite && state.failoverSince && L.getSessionProvider(state, cfg, sid) === 'claude' && !L.isAccount(parsed.provider)) {
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
// Every open Claude Code window goes through this one process, so a slip in one request is logged, not fatal
process.on('uncaughtException', (e) => log(`unexpected error (router kept running): ${e && e.stack ? e.stack : e}`))
process.on('unhandledRejection', (e) => log(`unexpected rejection (router kept running): ${e && e.stack ? e.stack : e}`))

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

// host:port -> { at, waitMs } of the last launch there. Providers that share one gateway start it once, and a gateway
// that keeps failing to come up is started again after 1, 2, 4… up to 10 minutes instead of every 30 seconds.
const launches = new Map()

function launchIfDown(p) {
  const l = p.launch
  if (!l || typeof l.command !== 'string' || !P.isLocal(p.url)) return
  const u = new URL(p.url)
  const host = u.hostname.replace(/^\[|\]$/g, '')
  const port = Number(u.port) || 80
  const key = `${host}:${port}`
  const last = launches.get(key)
  if (last && Date.now() - last.at < last.waitMs) return
  launches.set(key, { at: Date.now(), waitMs: last ? Math.min(600000, last.waitMs * 2) : 60000 }) // claimed before the async probe
  P.portOpen(host, port, 2000).then((up) => {
    if (up) return launches.delete(key) // running: the next time it is down, it is started at once
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
