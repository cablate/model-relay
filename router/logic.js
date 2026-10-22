'use strict'
// Pure routing decisions for router.js, tested by logic.test.js (node --test).

const fs = require('fs')
const path = require('path')
const { Transform } = require('stream')
const { StringDecoder } = require('string_decoder')

const isPort = (n) => Number.isInteger(n) && n > 1024 && n < 65536

// Two spellings of one directory (symlinks, `c:\x` vs `C:\X` on Windows) compare equal; the router and setup.mjs
// both use this to tell whose router answers on a port
function realDir(d) {
  try {
    return fs.realpathSync.native(d)
  } catch {
    return path.resolve(d)
  }
}
const dirKey = (d, win) => (win ? d.replace(/\\/g, '/').toLowerCase() : d)
const sameDir = (a, b, win = process.platform === 'win32') => dirKey(realDir(a), win) === dirKey(realDir(b), win)

function str(v) {
  return typeof v === 'string' && v.length > 0 ? v : null
}

function resolveToken(rawToken, env = process.env) {
  const s = str(rawToken)
  if (!s) return null
  if (s.startsWith('env:')) {
    const key = s.slice(4).trim()
    return key ? str(env[key]) : null
  }
  return s
}

// Providers whose `env:VAR` token has no value in `env`, as [{ provider, env }]; never the value itself
function unresolvedEnv(raw, env = process.env) {
  const out = []
  if (!isFormat2(raw)) return out // an older config is not used at all, so none of its keys counts as missing
  for (const [k, v] of Object.entries(isObj(raw.providers) ? raw.providers : {})) {
    const key = k.trim().toLowerCase()
    if (!key || key === 'claude' || !v || typeof v.token !== 'string' || !v.token.startsWith('env:')) continue // the keys parseCfg ignores
    const name = v.token.slice(4).trim() // empty when the token is a bare "env:"
    if (!name || !str(env[name])) out.push({ provider: key, env: name })
  }
  return out
}

// The error for "parseCfg gave nothing": names the skipped providers when unset env vars are the reason
function cfgMissingMessage(unresolved) {
  if (!unresolved.length) return 'model-relay.json is missing or invalid, or has no usable provider'
  const list = unresolved.map((u) => `${u.provider} (${u.env ? `${u.env} is unset in the router process` : 'its token "env:" names no variable'})`).join(', ')
  return `no provider is usable; skipped ${list}. Export the variable(s), then restart the router (it keeps the environment it was started with)`
}

// null for a Claude-looking model: a default ^claude would catch every Claude request and send it to this provider
function defaultPrefixRegex(name, model) {
  const clean = wireModel(model)
  const prefix = clean.split(/[-_.:/]/)[0] || name
  if (isClaudeModel(prefix)) return null
  return `^${prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`
}

// An http(s) address that new URL() accepts, or null: anything else would throw inside a request and stop the router
function httpUrl(s) {
  if (!str(s) || !/^https?:\/\//i.test(s)) return null
  try {
    return new URL(s).hostname ? s : null
  } catch {
    return null
  }
}

// Built-in providers: each service's address and the switches it needs. The model is always the person's to name,
// because model ids go out of date.
const PRESETS = {
  zai: { baseUrl: 'https://api.z.ai/api/anthropic', matchModels: ['^glm'], stripCacheControl: false, authHeader: 'both' },
  deepseek: { baseUrl: 'https://api.deepseek.com/anthropic', matchModels: ['^deepseek'], stripCacheControl: false, authHeader: 'bearer' },
  kimi: { baseUrl: 'https://api.moonshot.ai/anthropic', matchModels: ['^kimi', '^moonshot'], stripCacheControl: false, authHeader: 'bearer' },
  minimax: { baseUrl: 'https://api.minimax.io/anthropic', matchModels: ['^minimax'], stripCacheControl: false, authHeader: 'bearer' },
  openrouter: { baseUrl: 'https://openrouter.ai/api', matchModels: ['^openrouter/'], stripCacheControl: false, authHeader: 'bearer' },
}

// Format 2 is the only layout the router reads; "setup.mjs migrate" turns an older file into it
const isFormat2 = (raw) => isObj(raw) && raw.format === 2

// presets: the table a "preset" (or the provider's own name) is looked up in; migrate passes the older one
function parseProvider(name, raw, env = process.env, baseRetry = parseRetryCfg(undefined), presets = PRESETS) {
  if (typeof raw !== 'object' || raw === null) return null
  const presetKey = (str(raw.preset) || name || '').toLowerCase()
  const preset = Object.hasOwn(presets, presetKey) ? presets[presetKey] : null
  const url = httpUrl(raw.baseUrl || raw.url || preset?.baseUrl)
  const token = resolveToken(raw.token, env)
  const model = str(raw.model || preset?.model)
  if (!url || !token || !model) return null

  const stripCacheControl = raw.stripCacheControl !== undefined
    ? Boolean(raw.stripCacheControl)
    : Boolean(preset?.stripCacheControl)
  const authHeader = raw.authHeader === 'bearer' || raw.authHeader === 'x-api-key' || raw.authHeader === 'both'
    ? raw.authHeader
    : (preset?.authHeader || 'bearer')

  const rawMatchers = Array.isArray(raw.matchModels) && raw.matchModels.length > 0
    ? raw.matchModels.filter((m) => typeof m === 'string' && m.length > 0)
    : (preset?.matchModels || [defaultPrefixRegex(name, model)].filter(Boolean))

  const matchRegexes = []
  for (const pat of rawMatchers) {
    try {
      matchRegexes.push(new RegExp(pat, 'i'))
    } catch {}
  }

  let launch = null
  if (typeof raw.launch === 'object' && raw.launch !== null && str(raw.launch.command)) {
    launch = {
      command: raw.launch.command,
      args: Array.isArray(raw.launch.args) ? raw.launch.args.filter((a) => typeof a === 'string') : [],
    }
  }

  return {
    name,
    url,
    token,
    model,
    stripCacheControl,
    authHeader,
    matchSources: rawMatchers,
    matchRegexes,
    launch,
    // null: never retried; otherwise the effective retry settings (per-provider overrides merged over the global ones)
    retryCfg: baseRetry.enabled ? resolveProviderRetry(raw.retry, baseRetry) : null,
    // Who takes over when this provider cannot answer: undefined = the failover chain, null = nobody, or its own list
    fallback: raw.fallback === false ? null : Array.isArray(raw.fallback) ? dedupe(lowerNames(raw.fallback)) : undefined,
  }
}

// raw.retry: false (off) | undefined (use global) | { attempts, delayMs, backoff, maxDelayMs, failover } (partial override)
function resolveProviderRetry(raw, base) {
  if (raw === false) return null
  if (typeof raw !== 'object' || raw === null) return base
  if (raw.enabled === false) return null
  const num = (v, d) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : d)
  return {
    attempts: Math.min(30, Math.floor(num(raw.attempts, base.attempts))),
    delayMs: Math.min(300000, num(raw.delayMs, base.delayMs)),
    backoff: Math.min(4, Math.max(1, num(raw.backoff, base.backoff))),
    maxDelayMs: Math.min(300000, num(raw.maxDelayMs, base.maxDelayMs)),
    failover: typeof raw.failover === 'boolean' ? raw.failover : base.failover,
    enabled: true,
  }
}

const isObj = (v) => typeof v === 'object' && v !== null && !Array.isArray(v)
const lowerNames = (list) => (Array.isArray(list) ? list : []).map((n) => String(n).trim().toLowerCase()).filter((n) => n && n !== 'claude')
const dedupe = (list) => [...new Set(list)]
const DEFAULT_COOLDOWN_MS = 600000

// The settings that do not depend on any provider. An older config (no "format": 2) gets only these: the router keeps
// its port and sends everything to Claude until "setup.mjs migrate --go" rewrites the file.
function bareCfg(raw) {
  const r = isObj(raw) ? raw : {}
  const fo = isObj(r.failover) ? r.failover : {}
  const cooldownMs = typeof fo.cooldownMs === 'number' && fo.cooldownMs >= 0 ? fo.cooldownMs : DEFAULT_COOLDOWN_MS
  return {
    providers: Object.create(null),
    failoverChain: [],
    failoverProvider: null,
    port: isPort(r.port) ? r.port : 8950,
    claudeUrl: httpUrl(r.claudeUrl) || 'https://api.anthropic.com',
    failoverEnabled: fo.enabled !== false,
    cooldownMs: Math.min(7200000, Math.max(60000, cooldownMs)),
    // How long an upstream may stay silent (no bytes either way) before the request is treated as failed
    idleTimeoutMs: typeof r.idleTimeoutMs === 'number' && r.idleTimeoutMs > 0 ? Math.min(3600000, Math.max(1000, r.idleTimeoutMs)) : 300000,
    retry: parseRetryCfg(r.retry),
    proxy: parseProxyCfg(r.proxy),
  }
}

function parseCfg(raw, env = process.env) {
  if (!isFormat2(raw)) return null
  const base = bareCfg(raw)
  // No prototype: names arrive from config files, sticky state and /__session, and "constructor" or "toString"
  // must never look up an inherited Object.prototype member as if it were a provider.
  const providers = Object.create(null)
  for (const [k, v] of Object.entries(isObj(raw.providers) ? raw.providers : {})) {
    const key = k.trim().toLowerCase()
    if (!key || key === 'claude') continue
    const p = parseProvider(key, v, env, base.retry)
    if (p) providers[key] = p
  }
  if (Object.keys(providers).length === 0) return null
  // The chain is the order providers are used when Claude is out of quota; names that are not configured are skipped.
  // Without one, a 429 from Claude is passed back as it is.
  const failoverChain = dedupe(lowerNames(raw.failover?.chain).filter((n) => providers[n]))
  return {
    ...base,
    providers,
    failoverChain,
    failoverProvider: failoverChain[0] || null, // the first link; kept as its own field for callers that show a single target
  }
}

// Every env:VAR counts as set, so a config is judged by its shape alone and never by this shell's keys
const ANY_ENV = new Proxy({}, { get: () => 'set' })
const parseShape = (raw) => parseCfg(raw, ANY_ENV)

// HTTPS proxy mode: Claude Code keeps talking to api.anthropic.com (Remote Control insists on it) and uses the
// router as its HTTPS proxy. Only this host is opened up and routed; every other host is a plain byte tunnel.
const PROXY_MITM_HOST = 'api.anthropic.com'

// raw.proxy: { enabled: true } turns it on; anything else leaves it off, so the router is never an open CONNECT proxy by accident.
// `setup.mjs proxy enable` writes the setting; `proxy disable` clears it.
function parseProxyCfg(raw) {
  return { enabled: typeof raw === 'object' && raw !== null && raw.enabled === true }
}

// "host:port" from a CONNECT request line; null when it is not a usable target
function parseConnectTarget(authority) {
  const m = /^(?:\[([0-9a-f:.]+)\]|([a-z0-9._-]+)):(\d{1,5})$/i.exec(String(authority || '').trim())
  if (!m) return null
  const port = Number(m[3])
  if (port < 1 || port > 65535) return null
  return { host: (m[1] || m[2]).toLowerCase(), port }
}

// What to do with a CONNECT: answer for it ('mitm'), pass the bytes through untouched ('tunnel'), or turn it away.
// Without a usable certificate even api.anthropic.com is tunnelled, so Claude Code keeps working, just unrouted.
function proxyAction(proxyCfg, target, haveCert) {
  if (!proxyCfg || !proxyCfg.enabled || !target) return 'refuse'
  return target.host === PROXY_MITM_HOST && target.port === 443 && haveCert ? 'mitm' : 'tunnel'
}

// The plain-HTTP side of the router serves only local programs (Claude Code, the plugin, setup.mjs), none of which
// is a browser. A web page can still reach 127.0.0.1: a simple text/plain POST needs no preflight, an <img> GET
// carries no Origin, and DNS rebinding puts a foreign name on our address. So the Host header must name 127.0.0.1 or
// localhost on the port actually bound, and a browser marker (Origin, Sec-Fetch-Site) is refused, even from another
// local server such as localhost:3000. Browsers send Sec-Fetch-Site on every request to a loopback URL; Sec-Fetch-Mode
// is not a browser marker, because Node's built-in fetch sends "sec-fetch-mode: cors" on every request.
const LOCAL_HOST_RE = /^(127\.0\.0\.1|localhost):(\d{1,5})$/i
function isLocalRequest(headers, port) {
  const m = LOCAL_HOST_RE.exec(String((headers && headers.host) || ''))
  if (!m || Number(m[2]) !== port) return false
  return headers.origin === undefined && headers['sec-fetch-site'] === undefined
}

// Inside the opened-up tunnel only model calls are for the router. Token refresh, profile lookups, Remote Control
// and anything else must reach Anthropic unchanged: running them through decide() could send them to a provider.
function isRoutedRequest(method, url) {
  return method === 'POST' && /^\/v1\/messages(?:\/|\?|$)/.test(String(url || ''))
}

const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504, 529])

function parseRetryCfg(raw) {
  const r = typeof raw === 'object' && raw !== null ? raw : {}
  const num = (v, d) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : d)
  return {
    enabled: r.enabled !== false, // the global switch: false means no provider is ever retried
    attempts: Math.min(30, Math.floor(num(r.attempts, 3))), // 0 = unlimited: keep retrying until it answers
    delayMs: Math.min(60000, num(r.delayMs, 2000)),
    backoff: Math.min(4, Math.max(1, num(r.backoff, 2))),
    maxDelayMs: Math.min(300000, num(r.maxDelayMs, 10000)),
    failover: r.failover === true,
  }
}

// How long to wait before retrying the SAME provider, or null when retrying cannot help
// (status not retryable, or attempts exhausted — never when attempts is 0, the unlimited setting).
// Retry-After within budget is honoured; a longer one keeps polling at maxDelayMs instead of giving up.
function retryWaitMs(status, headers, attempt, cfg) {
  if (!RETRYABLE_STATUSES.has(status)) return null
  if (cfg.attempts > 0 && attempt >= cfg.attempts) return null
  const ra = headers && headers['retry-after']
  const raText = Array.isArray(ra) ? ra[0] : ra
  const raSec = Number(raText)
  if (Number.isFinite(raSec) && raSec > 0) {
    return Math.min(Math.max(raSec * 1000, cfg.delayMs), cfg.maxDelayMs)
  }
  return Math.min(cfg.maxDelayMs, cfg.delayMs * Math.pow(cfg.backoff, attempt))
}

// The provider that takes over when `providerName` cannot answer: its own `fallback` list, else the failover chain,
// skipping itself and every provider already tried for this request. null when nobody is left.
function nextFallback(cfg, providerName, tried = []) {
  if (!cfg || !cfg.providers) return null
  const own = cfg.providers[providerName] && cfg.providers[providerName].fallback
  if (own === null) return null
  const skip = new Set([providerName, ...tried])
  const next = (own || cfg.failoverChain || []).find((n) => !skip.has(n) && cfg.providers[n])
  return next ? cfg.providers[next] : null
}

function matchProviderByModel(cfg, model) {
  if (typeof model !== 'string' || !model || !cfg || !cfg.providers) return null
  const clean = wireModel(model)
  const all = Object.values(cfg.providers)
  // A provider's own model wins over another provider's pattern, whichever comes first in the file
  const own = all.find((p) => clean.toLowerCase() === wireModel(p.model).toLowerCase())
  if (own) return own.name
  const byPattern = all.find((p) => p.matchRegexes && p.matchRegexes.some((re) => re.test(model) || re.test(clean)))
  return byPattern ? byPattern.name : null
}

// Claude's three model tiers and their full model IDs. When a provider's matchModels catches one of these (for
// example "haiku" on glm), the router must also rewrite the body's `model` field to the provider's model ID so
// providers that do not recognize "claude-haiku-*" still accept the request.
const ALIAS_SLOTS = {
  haiku: 'claude-haiku-5-5',
  sonnet: 'claude-sonnet-5-5',
  opus: 'claude-opus-5-5',
}

function isClaudeModel(model) {
  return typeof model === 'string' && /^(claude[-_]|claude$|haiku\b|sonnet\b|opus\b)/i.test(wireModel(model).trim())
}

// Which provider (if any) currently claims each Claude model tier (`haiku`, `sonnet`, `opus`) via matchModels.
function detectAliases(cfg) {
  const out = {}
  if (!cfg || !cfg.providers) return out
  for (const [slot, sample] of Object.entries(ALIAS_SLOTS)) {
    const target = matchProviderByModel(cfg, sample)
    if (target) out[slot] = target
  }
  return out
}

// Subscription usage limits come back as 429 with the unified rate-limit status
// "rejected"; the message wording is the fallback signal.
function isUsageLimit(status, headers, bodyText) {
  if (status !== 429) return false
  if (String((headers && headers['anthropic-ratelimit-unified-status']) || '').toLowerCase() === 'rejected') return true
  return /usage limit|limit reached|hit your limit|limit (will )?resets?/i.test(bodyText || '')
}

// `sticky` maps sessionId -> { provider, at }. Session ids come from request headers and /__session, so the map has
// no prototype: a sid of "__proto__" is an ordinary entry instead of replacing the object's prototype.
function emptyState() {
  return { failoverSince: 0, nextClaudeTry: 0, sticky: Object.create(null) }
}

function parseState(raw) {
  const s = emptyState()
  if (typeof raw !== 'object' || raw === null) return s
  if (typeof raw.failoverSince === 'number') s.failoverSince = raw.failoverSince
  if (typeof raw.nextClaudeTry === 'number') s.nextClaudeTry = raw.nextClaudeTry

  const sticky = Object.create(null)
  if (typeof raw.sticky === 'object' && raw.sticky !== null) {
    for (const [sid, v] of Object.entries(raw.sticky)) {
      if (v && typeof v === 'object' && typeof v.provider === 'string' && typeof v.at === 'number') {
        sticky[sid] = { provider: v.provider.toLowerCase(), at: v.at }
      }
    }
  }
  return { failoverSince: s.failoverSince, nextClaudeTry: s.nextClaudeTry, sticky }
}

const STICKY_TTL_MS = 7 * 24 * 3600e3

// The hook rewrites its session's status file (model-relay-status/<session id>) at least daily, so a regular file
// untouched for a week belongs to a session that ended; anything else in the directory is left alone
function staleStatusFiles(entries, now) {
  return entries.filter((e) => e.isFile && now - e.mtimeMs >= STICKY_TTL_MS).map((e) => e.name)
}

function pruneSticky(state, now) {
  const base = parseState(state)
  const sticky = Object.create(null)
  for (const [sid, entry] of Object.entries(base.sticky)) {
    if (now - entry.at < STICKY_TTL_MS) sticky[sid] = entry
  }
  return { ...base, sticky }
}

function setSticky(state, sid, provider, now) {
  if (!sid) return state
  const base = parseState(state)
  const sticky = Object.assign(Object.create(null), base.sticky)
  if (!provider || provider === 'claude') {
    delete sticky[sid]
  } else {
    sticky[sid] = { provider: provider.toLowerCase(), at: now }
  }
  return { ...base, sticky }
}

function getSessionProvider(state, cfg, sid) {
  if (!sid) return 'claude'
  const base = parseState(state)
  const p = base.sticky[sid]?.provider
  if (p && cfg?.providers?.[p]) return p
  return 'claude'
}

function routeLabel(providerName, rewrite) {
  return rewrite ? `${providerName}-rewrite` : providerName
}

function parseRoute(route, cfg) {
  if (route === 'claude' || route === 'claude-trial') {
    return { kind: 'claude', trial: route === 'claude-trial', provider: null, rewrite: false }
  }
  const rewrite = route.endsWith('-rewrite')
  const name = rewrite ? route.slice(0, -8) : route
  const provider = cfg?.providers?.[name] || null
  return { kind: 'provider', name, provider, rewrite }
}

function decide(state, cfg, model, sid, now) {
  const byModel = matchProviderByModel(cfg, model)
  if (byModel) return routeLabel(byModel, false)

  const stickyProvider = getSessionProvider(state, cfg, sid)
  if (stickyProvider !== 'claude') return routeLabel(stickyProvider, true)

  if (!cfg.failoverEnabled || !state.failoverSince || !cfg.failoverProvider) return 'claude'
  return now >= state.nextClaudeTry ? 'claude-trial' : routeLabel(cfg.failoverProvider, true)
}

function onLimited(state, cfg, now) {
  return { ...state, failoverSince: state.failoverSince || now, nextClaudeTry: now + cfg.cooldownMs }
}

function onClaudeOk(state) {
  return { ...state, failoverSince: 0, nextClaudeTry: 0 }
}

// Claude Code strips its own suffixes such as [1m] before sending; a rewrite must too.
const wireModel = (model) => String(model || '').replace(/\[[^\]]*\]$/, '')

// Claude Code's tool search on a provider other than Anthropic. Anthropic turns a `tool_reference` in a ToolSearch
// result into the deferred tool it names; no other provider does, and z.ai swaps a tool named ToolSearch for its own
// search and hides every other tool. So the provider gets the search under another name, every loaded tool as an
// ordinary one and each reference as text, and its calls to that name go back to Claude Code as ToolSearch.
const TOOL_SEARCH = 'ToolSearch'
const SEARCH_ALIAS = 'load_deferred_tools'
const PLACEHOLDER = 'DeferredToolPlaceholder'
const ALIAS_CALL = new RegExp(`("name"\\s*:\\s*)"${SEARCH_ALIAS}"`, 'g')

const loadedText = (c) => ({ type: 'text', text: `Tool ${c.tool_name} is loaded and can be called now.` })

// Rewrites j in place when it carries tool search: null when it does not, else whether it offers the search by alias
function adaptToolSearch(j) {
  if (!Array.isArray(j.tools) || !j.tools.some((t) => t && (t.name === TOOL_SEARCH || t.defer_loading === true))) return null
  j.tools = j.tools.filter((t) => !(t && t.name === PLACEHOLDER)).map((t) => {
    if (!isObj(t)) return t
    const { defer_loading: _deferred, ...tool } = t
    return tool.name === TOOL_SEARCH ? { ...tool, name: SEARCH_ALIAS } : tool
  })
  if (isObj(j.tool_choice) && j.tool_choice.name === TOOL_SEARCH) j.tool_choice = { ...j.tool_choice, name: SEARCH_ALIAS }
  for (const m of Array.isArray(j.messages) ? j.messages : []) {
    for (const b of Array.isArray(m && m.content) ? m.content : []) {
      if (b && b.type === 'tool_use' && b.name === TOOL_SEARCH) b.name = SEARCH_ALIAS
      if (b && b.type === 'tool_result' && Array.isArray(b.content)) b.content = b.content.map((c) => (c && c.type === 'tool_reference' ? loadedText(c) : c))
    }
  }
  return { aliased: j.tools.some((t) => t && t.name === SEARCH_ALIAS) }
}

// A provider's answer with its calls to the alias named ToolSearch again; works line by line, so a name cut across two
// chunks is still found, and decodes UTF-8 as a stream so a character cut across two chunks stays whole
function toolSearchRestorer() {
  const decoder = new StringDecoder('utf8')
  const restore = (text) => text.replace(ALIAS_CALL, `$1"${TOOL_SEARCH}"`)
  let carry = ''
  return new Transform({
    transform(chunk, _enc, done) {
      const text = carry + decoder.write(chunk)
      const cut = text.lastIndexOf('\n') + 1
      carry = text.slice(cut)
      done(null, restore(text.slice(0, cut)))
    },
    flush(done) {
      done(null, restore(carry + decoder.end()))
    },
  })
}

function stripCache(v) {
  if (Array.isArray(v)) v.forEach(stripCache)
  else if (v && typeof v === 'object') {
    delete v.cache_control
    Object.values(v).forEach(stripCache)
  }
}

function rewriteBody(bodyBuf, opts = {}) {
  const model = opts.model || null
  const defaultModel = opts.defaultModel || null
  const noCache = Boolean(opts.stripCacheControl)
  const j = JSON.parse(bodyBuf.toString('utf8'))
  if (noCache) stripCache(j)
  const search = adaptToolSearch(j)
  const restoreToolSearch = Boolean(search && search.aliased)
  const targetModel = model || (defaultModel && isClaudeModel(j.model) ? defaultModel : null)
  const strippedSame = !targetModel && typeof j.model === 'string' && wireModel(j.model) !== j.model ? wireModel(j.model) : null
  if (!targetModel && !strippedSame && !search && !noCache) return { body: bodyBuf, restoreToolSearch }
  if (targetModel) j.model = wireModel(targetModel)
  else if (strippedSame) j.model = strippedSame
  return { body: Buffer.from(JSON.stringify(j), 'utf8'), restoreToolSearch }
}

// Message Threads (anthropic-beta "message-threads-*"): Claude Code keeps the conversation on Anthropic's server and
// sends each later turn as only the new messages, without system prompt or tools. No provider holds that thread, so a
// provider would answer the last message alone. Refusing the beta the way Anthropic refuses an unknown one makes
// Claude Code drop threading for the session and resend the whole conversation.
function threadBetaRefusal(headers) {
  const raw = headers && headers['anthropic-beta']
  const betas = (Array.isArray(raw) ? raw.join(',') : String(raw || '')).split(',').map((b) => b.trim())
  const threads = betas.filter((b) => b.startsWith('message-threads'))
  if (!threads.length) return null
  return `Unexpected value(s) ${threads.map((b) => `\`${b}\``).join(', ')} for the \`anthropic-beta\` header: this provider keeps no message threads, send the full conversation`
}

function upstreamPath(base, reqUrl) {
  return new URL(base).pathname.replace(/\/$/, '') + reqUrl
}

module.exports = {
  isPort,
  realDir,
  sameDir,
  PRESETS,
  isFormat2,
  isObj,
  lowerNames,
  bareCfg,
  ANY_ENV,
  parseShape,
  wireModel,
  resolveToken,
  retryWaitMs,
  parseProvider,
  parseCfg,
  unresolvedEnv,
  cfgMissingMessage,
  nextFallback,
  matchProviderByModel,
  ALIAS_SLOTS,
  isClaudeModel,
  detectAliases,
  setSticky,
  getSessionProvider,
  isUsageLimit,
  emptyState,
  parseState,
  pruneSticky,
  staleStatusFiles,
  decide,
  parseRoute,
  onLimited,
  onClaudeOk,
  rewriteBody,
  toolSearchRestorer,
  threadBetaRefusal,
  upstreamPath,
  PROXY_MITM_HOST,
  parseProxyCfg,
  parseConnectTarget,
  proxyAction,
  isRoutedRequest,
  isLocalRequest,
}
