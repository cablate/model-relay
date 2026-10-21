'use strict'
const test = require('node:test')
const assert = require('node:assert')
const os = require('node:os')
const L = require('./logic')

const cfg = L.parseCfg({
  format: 2,
  failover: { chain: ['glm'] },
  providers: { glm: { baseUrl: 'https://api.z.ai/api/anthropic', token: 't', model: 'glm-5.3[1m]', matchModels: ['^glm'] } },
})
const OPUS = 'claude-opus-5-5'

test('config defaults', () => {
  assert.strictEqual(L.parseCfg({ format: 2, providers: { glm: { baseUrl: 'ftp://x', token: 't', model: 'm' } } }), null)
  assert.strictEqual(cfg.port, 8950)
  assert.strictEqual(cfg.claudeUrl, 'https://api.anthropic.com')
  assert.strictEqual(cfg.cooldownMs, 600000)
  assert.strictEqual(cfg.failoverProvider, 'glm')
  assert.ok(cfg.providers.glm)
})

test('the router reads format 2 only: anything else gives no providers, and no env var of it counts as missing', () => {
  const providers = { glm: { baseUrl: 'https://api.z.ai/api/anthropic', token: 'env:OLD_KEY', model: 'glm-5.3' } }
  assert.strictEqual(L.parseCfg(null), null)
  assert.strictEqual(L.parseCfg({}), null)
  for (const format of [undefined, 1, '2', null, 3]) {
    const raw = { format, port: 8999, providers }
    assert.strictEqual(L.parseCfg(raw, { OLD_KEY: 'k' }), null, `format ${JSON.stringify(format)}`)
    assert.strictEqual(L.parseShape(raw), null)
    assert.deepStrictEqual(L.unresolvedEnv(raw, {}), [], 'an older file is not used at all, so nothing in it is "unset"')
    assert.strictEqual(L.bareCfg(raw).port, 8999, 'the router still keeps its port and sends everything to Claude')
  }
  assert.strictEqual(L.parseCfg({ baseUrl: 'https://api.z.ai/api/anthropic', token: 't', model: 'glm-5.3' }), null, 'the top-level layout is not read either')
  assert.notStrictEqual(L.parseShape({ format: 2, providers }), null, 'the same providers under format 2 are')
})

test('multi-provider config and env:VAR token resolution', () => {
  const multi = L.parseCfg({
    format: 2,
    port: 8955,
    failover: { enabled: true, chain: ['deepseek'], cooldownMs: 300000 },
    providers: {
      glm: { preset: 'zai', token: 'env:' + 'T_VAR', model: 'glm-5.3[1m]' }, // address and switches from the zai preset
      deepseek: { preset: 'deepseek', token: 'ds', model: 'deepseek-chat' }, // address and switches from the deepseek preset
      gemini: { baseUrl: 'http://127.0.0.1:4000', token: 'gw', model: 'gemini-4-argon', matchModels: ['^gemini'], stripCacheControl: true, authHeader: 'both', launch: { command: 'magpie', args: ['web'] } },
    },
  }, { T_VAR: 'resolved-val' })

  assert.strictEqual(multi.port, 8955)
  assert.strictEqual(multi.failoverProvider, 'deepseek')
  assert.strictEqual(multi.cooldownMs, 300000)
  assert.strictEqual(multi.providers.glm.token, 'resolved-val')
  assert.strictEqual(multi.providers.gemini.stripCacheControl, true)
  assert.strictEqual(multi.providers.gemini.authHeader, 'both')
  assert.deepStrictEqual(multi.providers.gemini.launch, { command: 'magpie', args: ['web'] })

  // Model matching routes directly to the matching provider
  assert.strictEqual(L.decide(L.emptyState(), multi, 'deepseek-reasoner', 's1', 0), 'deepseek')
  assert.strictEqual(L.decide(L.emptyState(), multi, 'glm-5.3', 's1', 0), 'glm')
  assert.strictEqual(L.decide(L.emptyState(), multi, 'gemini-4-argon', 's1', 0), 'gemini')

  // Sticky session on custom provider
  const s = L.setSticky(L.emptyState(), 's1', 'deepseek', 100)
  assert.strictEqual(L.decide(s, multi, OPUS, 's1', 200), 'deepseek-rewrite')
})

test('glm models always go to the custom endpoint', () => {
  assert.strictEqual(L.decide(L.emptyState(), cfg, 'glm-5.3', 'a', 0), 'glm')
})

test('failover: new sessions trial Claude when due, otherwise failover provider', () => {
  const s = L.emptyState()
  assert.strictEqual(L.decide(s, cfg, OPUS, 'a', 0), 'claude')
  const limited = L.onLimited(s, cfg, 1000)
  assert.strictEqual(L.decide(limited, cfg, OPUS, 'a', 1000 + 599999), 'glm-rewrite')
  assert.strictEqual(L.decide(limited, cfg, OPUS, 'a', 1000 + 600000), 'claude-trial')
  assert.strictEqual(L.decide(limited, { ...cfg, failoverEnabled: false }, OPUS, 'a', 1000), 'claude')
  const again = L.onLimited(limited, cfg, 700000)
  assert.strictEqual(again.failoverSince, 1000, 'episode start kept')
  assert.strictEqual(L.onClaudeOk(again).failoverSince, 0)
})

test('a session that moved to GLM stays there after Claude recovers', () => {
  let s = L.onLimited(L.emptyState(), cfg, 1000)
  s = L.setSticky(s, 'long', 'glm', 1000)
  s = L.onClaudeOk(s)
  assert.strictEqual(L.decide(s, cfg, OPUS, 'long', 5e6), 'glm-rewrite', 'sticky session keeps GLM')
  assert.strictEqual(L.decide(s, cfg, OPUS, 'fresh', 5e6), 'claude', 'other sessions back on Claude')
  assert.strictEqual(L.decide(s, cfg, OPUS, undefined, 5e6), 'claude', 'no session id: no stickiness')
  s = L.setSticky(s, 'long', 'claude', 6e6)
  assert.strictEqual(L.decide(s, cfg, OPUS, 'long', 6e6), 'claude', 'released session returns')
  assert.deepStrictEqual(L.setSticky(s, '', 'glm', 1), s, 'empty id ignored')
})

test('sticky sessions expire after a week', () => {
  const s = L.setSticky(L.setSticky(L.emptyState(), 'old', 'glm', 0), 'new', 'glm', 8 * 24 * 3600e3)
  assert.deepStrictEqual(Object.keys(L.pruneSticky(s, 8 * 24 * 3600e3).sticky), ['new'])
  const week = 7 * 24 * 3600e3
  const files = [
    { name: 'ended', isFile: true, mtimeMs: 0 },
    { name: 'live', isFile: true, mtimeMs: 1 },
    { name: 'a-dir', isFile: false, mtimeMs: 0 },
  ]
  assert.deepStrictEqual(L.staleStatusFiles(files, week), ['ended'], 'status files: only a regular file untouched for a week')
})

test('only a usage-limit 429 triggers failover', () => {
  assert.ok(L.isUsageLimit(429, { 'anthropic-ratelimit-unified-status': 'rejected' }, '{}'))
  assert.ok(L.isUsageLimit(429, {}, '{"error":{"message":"You have hit your usage limit"}}'))
  assert.ok(!L.isUsageLimit(429, {}, '{"error":{"message":"Too many requests"}}'))
  assert.ok(!L.isUsageLimit(500, { 'anthropic-ratelimit-unified-status': 'rejected' }, 'usage limit'))
})

test('model rewrite and upstream path', () => {
  const out = JSON.parse(L.rewriteBody(Buffer.from('{"model":"claude-opus-5-5","x":1}'), { model: 'glm-5.3[1m]' }).toString())
  assert.deepStrictEqual(out, { model: 'glm-5.3', x: 1 })
  const plain = Buffer.from('{"model":"glm-5.3","tools":[{"name":"Read"}]}')
  assert.strictEqual(L.rewriteBody(plain, {}), plain)
  // When a Claude tier/model name is routed via matchModels (e.g. "haiku" -> deepseek), defaultModel rewrites it
  const aliased = JSON.parse(L.rewriteBody(Buffer.from('{"model":"claude-haiku-4-5-20251001"}'), { defaultModel: 'deepseek-chat', stripToolSearch: false }).toString())
  assert.strictEqual(aliased.model, 'deepseek-chat')
  // A provider's own sub-model (e.g. deepseek-reasoner) is preserved when only defaultModel is set
  const native = JSON.parse(L.rewriteBody(Buffer.from('{"model":"deepseek-reasoner"}'), { defaultModel: 'deepseek-chat', stripToolSearch: false }).toString())
  assert.strictEqual(native.model, 'deepseek-reasoner')
  assert.deepStrictEqual(L.detectAliases(L.parseCfg({ format: 2, providers: { glm: { preset: 'zai', token: 't', model: 'glm-5.3[1m]', matchModels: ['^glm', 'haiku'] } } })), { haiku: 'glm' })
  assert.strictEqual(L.upstreamPath('https://api.z.ai/api/anthropic', '/v1/messages?beta=true'), '/api/anthropic/v1/messages?beta=true')
  assert.strictEqual(L.upstreamPath('https://api.anthropic.com', '/v1/messages'), '/v1/messages')
})

test('z.ai requests lose ToolSearch and deferred placeholders', () => {
  const tools = [{ name: 'Read' }, { name: 'ToolSearch' }, { name: 'DeferredToolPlaceholder', defer_loading: true }, { name: 'Bash' }]
  const body = Buffer.from(JSON.stringify({ model: 'glm-5.3', tools }))
  assert.deepStrictEqual(JSON.parse(L.rewriteBody(body, {}).toString()).tools, [{ name: 'Read' }, { name: 'Bash' }])
  const rw = JSON.parse(L.rewriteBody(body, { model: 'glm-5.3[1m]' }).toString())
  assert.strictEqual(rw.model, 'glm-5.3')
  assert.deepStrictEqual(rw.tools.map((t) => t.name), ['Read', 'Bash'])
})

test('provider retry waits: statuses, backoff, Retry-After, exhaustion', () => {
  const providers = { glm: { preset: 'zai', token: 't', model: 'glm-5.3[1m]' } }
  const cfg = L.parseCfg({ format: 2, providers })
  assert.strictEqual(cfg.retry.attempts, 3, 'retry defaults: 3 attempts')
  assert.strictEqual(cfg.retry.delayMs, 2000, 'retry defaults: 2s base delay')
  assert.strictEqual(cfg.retry.failover, false, 'retry defaults: same-provider only, failover opt-in')

  assert.strictEqual(L.retryWaitMs(404, {}, 0, cfg.retry), null, 'client errors are not retried')
  assert.strictEqual(L.retryWaitMs(200, {}, 0, cfg.retry), null, 'success is not retried')
  assert.strictEqual(L.retryWaitMs(429, {}, 0, cfg.retry), 2000, 'first 429 waits the base delay')
  assert.strictEqual(L.retryWaitMs(429, {}, 1, cfg.retry), 4000, 'second 429 waits base * backoff')
  assert.strictEqual(L.retryWaitMs(429, {}, 3, cfg.retry), null, 'attempts exhausted')
  assert.strictEqual(L.retryWaitMs(503, {}, 0, cfg.retry), 2000, '5xx retried like 429')
  assert.strictEqual(L.retryWaitMs(429, { 'retry-after': '1' }, 0, cfg.retry), 2000, 'Retry-After below base uses the base delay')
  assert.strictEqual(L.retryWaitMs(429, { 'retry-after': ['3600'] }, 0, cfg.retry), 10000, 'Retry-After beyond budget keeps polling at maxDelayMs')
  const fast = L.parseCfg({ format: 2, providers, retry: { attempts: 1, delayMs: 500, backoff: 3, maxDelayMs: 700, failover: true } })
  assert.strictEqual(fast.retry.attempts, 1, 'attempts configurable')
  assert.strictEqual(L.retryWaitMs(429, {}, 0, fast.retry), 500, 'custom base delay')
  assert.strictEqual(L.retryWaitMs(429, {}, 1, fast.retry), null, 'single attempt then stop')
  assert.strictEqual(fast.retry.failover, true, 'failover can be turned on')
  const endless = L.parseCfg({ format: 2, providers: { glm: { ...providers.glm, retry: { attempts: 0, maxDelayMs: 30000 } } } })
  assert.strictEqual(L.retryWaitMs(429, {}, 500, endless.providers.glm.retryCfg), 30000, 'attempts:0 retries without end, polling at maxDelayMs')
})

test('per-provider retry switch: off, inherit, and partial override', () => {
  const cfg = L.parseCfg({
    format: 2,
    retry: { attempts: 4, delayMs: 3000, failover: true },
    providers: {
      glm: { preset: 'zai', token: 't', model: 'glm-5.3[1m]', retry: false },
      deepseek: { token: 't', model: 'deepseek-chat' },
      kimi: { token: 't', model: 'kimi-k2', retry: { attempts: 1, failover: false } },
    },
  })
  assert.strictEqual(cfg.providers.glm.retryCfg, null, 'retry:false never retries')
  assert.strictEqual(cfg.providers.deepseek.retryCfg.attempts, 4, 'no retry field inherits the global settings')
  assert.strictEqual(cfg.providers.deepseek.retryCfg.delayMs, 3000, 'inherited delayMs')
  assert.strictEqual(cfg.providers.kimi.retryCfg.attempts, 1, 'partial override wins')
  assert.strictEqual(cfg.providers.kimi.retryCfg.delayMs, 3000, 'partial override keeps global defaults for the rest')
  assert.strictEqual(cfg.providers.kimi.retryCfg.failover, false, 'partial override of failover')
  assert.strictEqual(L.retryWaitMs(429, {}, 0, cfg.providers.kimi.retryCfg), 3000, 'kimi still waits per merged settings')
  assert.strictEqual(L.retryWaitMs(429, {}, 1, cfg.providers.kimi.retryCfg), null, 'kimi exhausts after its single attempt')
})

test('state parsing tolerates junk and old files', () => {
  assert.deepStrictEqual(L.parseState(null), L.emptyState())
  const old = L.parseState({ mode: 'glm', failoverSince: 5, onGlm: { a: 1, b: 'x' } })
  assert.strictEqual(old.failoverSince, 5)
  assert.ok(!('onGlm' in old), 'the legacy per-provider views are gone')
  assert.deepStrictEqual(Object.keys(old.sticky), [], 'and are not turned into sticky sessions any more')
  assert.ok(!('mode' in old), 'global mode no longer exists')
})

test('gemini route: model name or sticky session, off without config', () => {
  const g = L.parseCfg({
    format: 2,
    providers: {
      glm: { baseUrl: 'https://api.z.ai/api/anthropic', token: 't', model: 'glm-5.3[1m]', matchModels: ['^glm'] },
      gemini: { baseUrl: 'https://x', token: 'k', model: 'gemini-4-argon-lb', matchModels: ['^gemini'] },
    },
  })
  assert.strictEqual(L.decide(L.emptyState(), g, 'gemini-4-argon-lb', 'a', 0), 'gemini')
  let s = L.setSticky(L.setSticky(L.emptyState(), 'a', 'glm', 1), 'a', 'gemini', 2)
  assert.strictEqual(s.sticky.a.provider, 'gemini', 'moving to another provider replaces the pin')
  assert.strictEqual(L.decide(s, g, OPUS, 'a', 3), 'gemini-rewrite')
  assert.strictEqual(L.decide(s, cfg, OPUS, 'a', 3), 'claude', 'no gemini config: ignored')
  s = L.setSticky(s, 'a', 'claude', 4)
  assert.strictEqual(L.decide(s, g, OPUS, 'a', 5), 'claude')
})

test('gemini requests lose cache_control everywhere', () => {
  const b = Buffer.from(JSON.stringify({ model: 'm', system: [{ type: 'text', text: 'x', cache_control: { type: 'ephemeral' } }], messages: [{ role: 'user', content: [{ type: 'text', text: 'y', cache_control: { type: 'ephemeral' } }] }] }))
  assert.ok(!L.rewriteBody(b, { stripCacheControl: true }).toString().includes('cache_control'))
  assert.ok(L.rewriteBody(b, { stripCacheControl: false }).toString().includes('cache_control'))
})

test('proxy config: off unless explicitly enabled', () => {
  const base = { format: 2, providers: { glm: { baseUrl: 'https://api.z.ai/api/anthropic', token: 't', model: 'm' } } }
  assert.deepStrictEqual(cfg.proxy, { enabled: false }, 'default')
  for (const raw of [false, true, {}, { enabled: false }, { enabled: 'yes' }, 1, null]) {
    assert.strictEqual(L.parseCfg({ ...base, proxy: raw }).proxy.enabled, false, JSON.stringify(raw))
  }
  assert.strictEqual(L.parseCfg({ ...base, proxy: { enabled: true } }).proxy.enabled, true)
})

test('CONNECT targets are parsed strictly', () => {
  assert.deepStrictEqual(L.parseConnectTarget('API.Anthropic.com:443'), { host: 'api.anthropic.com', port: 443 })
  assert.deepStrictEqual(L.parseConnectTarget('[::1]:8443'), { host: '::1', port: 8443 })
  for (const bad of ['', 'api.anthropic.com', 'a b:443', 'x:0', 'x:70000', 'x:443/path', null, undefined]) {
    assert.strictEqual(L.parseConnectTarget(bad), null, String(bad))
  }
})

test('only api.anthropic.com:443 is opened up, and only with a usable certificate', () => {
  const on = { enabled: true }
  const anthropic = { host: 'api.anthropic.com', port: 443 }
  assert.strictEqual(L.proxyAction(on, anthropic, true), 'mitm')
  assert.strictEqual(L.proxyAction(on, anthropic, false), 'tunnel', 'no certificate: stay usable, unrouted')
  assert.strictEqual(L.proxyAction(on, { host: 'api.anthropic.com', port: 8443 }, true), 'tunnel')
  assert.strictEqual(L.proxyAction(on, { host: 'claude.ai', port: 443 }, true), 'tunnel')
  assert.strictEqual(L.proxyAction(on, { host: 'evil-api.anthropic.com.example', port: 443 }, true), 'tunnel')
  assert.strictEqual(L.proxyAction({ enabled: false }, anthropic, true), 'refuse')
  assert.strictEqual(L.proxyAction(on, null, true), 'refuse')
})

test('inside the opened tunnel only model calls are routed', () => {
  assert.strictEqual(L.isRoutedRequest('POST', '/v1/messages'), true)
  assert.strictEqual(L.isRoutedRequest('POST', '/v1/messages?beta=true'), true)
  assert.strictEqual(L.isRoutedRequest('POST', '/v1/messages/count_tokens?beta=true'), true)
  for (const [m, u] of [['GET', '/v1/messages'], ['POST', '/v1/oauth/token'], ['POST', '/v1/messagesX'], ['GET', '/api/oauth/profile'], ['POST', '/v1/code/sessions'], ['POST', undefined]]) {
    assert.strictEqual(L.isRoutedRequest(m, u), false, `${m} ${u}`)
  }
})

test('unset env:VAR tokens are reported by name, and explained when no provider is usable', () => {
  const raw = { format: 2, providers: { Gemini: { token: 'env:K1', baseUrl: 'http://127.0.0.1:1', model: 'gemini-4' }, glm: { token: 'lit', baseUrl: 'http://127.0.0.1:1', model: 'glm-5.3' } } }
  assert.deepStrictEqual(L.unresolvedEnv(raw, {}), [{ provider: 'gemini', env: 'K1' }])
  assert.deepStrictEqual(L.unresolvedEnv(raw, { K1: 'v' }), [])
  const msg = L.cfgMissingMessage(L.unresolvedEnv({ format: 2, providers: { gemini: raw.providers.Gemini } }, {}))
  assert.match(msg, /gemini \(K1 is unset in the router process\)/)
  assert.match(msg, /restart the router/)
  assert.ok(!msg.includes('config missing'))
})

test('unresolvedEnv skips keys parseCfg ignores and flags a bare "env:"', () => {
  const p = (token) => ({ token, baseUrl: 'http://127.0.0.1:1', model: 'm' })
  assert.deepStrictEqual(L.unresolvedEnv({ format: 2, providers: { claude: p('env:A'), ' ': p('env:B'), x: p('env:') } }, {}), [{ provider: 'x', env: '' }])
  assert.match(L.cfgMissingMessage([{ provider: 'x', env: '' }]), /x \(its token "env:" names no variable\)/)
  assert.deepStrictEqual(L.unresolvedEnv({ baseUrl: 'http://127.0.0.1:1', token: 'env:LEG', model: 'm' }, {}), [], 'a top-level token belongs to an older layout, which is not used at all')
})

test('the plain-HTTP side answers only local programs: loopback Host on the bound port, no browser markers', () => {
  for (const host of ['127.0.0.1:9123', 'localhost:9123', 'LocalHost:9123']) {
    assert.strictEqual(L.isLocalRequest({ host }, 9123), true, host)
  }
  assert.strictEqual(L.isLocalRequest({ host: '127.0.0.1:9123', 'sec-fetch-mode': 'cors' }, 9123), true, "Node's fetch sends sec-fetch-mode: cors")
  const local = { host: '127.0.0.1:9123' }
  const refused = [
    [{ host: 'evil.test:9123' }, 'another host (DNS rebinding)'],
    [{ host: 'evil.test@127.0.0.1:9123' }, 'userinfo trick'],
    [{ host: '127.0.0.1.evil.test:9123' }, 'loopback as a prefix'],
    [{ host: '[::1]:9123' }, 'IPv6 loopback: the router never listens there'],
    [{ host: '127.0.0.1:9124' }, 'wrong port'],
    [{ host: '127.0.0.1' }, 'no port'],
    [{}, 'missing Host'],
    [{ ...local, origin: 'https://evil.test' }, 'foreign Origin'],
    [{ ...local, origin: 'http://localhost:3000' }, 'another local server'],
    [{ ...local, origin: 'http://127.0.0.1:9123' }, 'even our own origin: no browser page is a client'],
    [{ ...local, origin: 'null' }, 'Origin null'],
    [{ ...local, origin: '' }, 'empty Origin'],
    [{ ...local, 'sec-fetch-site': 'cross-site' }, 'no-cors GET from a page (<img>) carries no Origin'],
  ]
  for (const [headers, why] of refused) assert.strictEqual(L.isLocalRequest(headers, 9123), false, why)
})

test('a session id of "__proto__" is an ordinary sticky entry', () => {
  const c = L.parseCfg({ format: 2, providers: { glm: { preset: 'zai', token: 't', model: 'glm-5.3[1m]' } } })
  let s = L.setSticky(L.emptyState(), '__proto__', 'glm', 1)
  assert.strictEqual(L.getSessionProvider(s, c, '__proto__'), 'glm')
  assert.deepStrictEqual(Object.keys(s.sticky), ['__proto__'])
  assert.strictEqual(L.getSessionProvider(s, c, 'other'), 'claude', 'other sessions are not affected')
  s = L.parseState(JSON.parse(JSON.stringify(L.pruneSticky(s, 2))))
  assert.strictEqual(L.getSessionProvider(s, c, '__proto__'), 'glm', 'survives a save and reload')
  s = L.setSticky(s, '__proto__', 'claude', 3)
  assert.deepStrictEqual(Object.keys(s.sticky), [])
})

test('Object.prototype names never resolve to a provider', () => {
  const c = L.parseCfg({ format: 2, providers: { glm: { preset: 'zai', token: 't', model: 'glm-5.3[1m]' } } })
  for (const name of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
    assert.strictEqual(c.providers[name], undefined, name)
    const s = L.setSticky(L.emptyState(), 'sid', name, 1)
    assert.strictEqual(L.getSessionProvider(s, c, 'sid'), 'claude', name)
    assert.strictEqual(L.decide(s, c, OPUS, 'sid', 2), 'claude', name)
    assert.strictEqual(L.parseRoute(`${name}-rewrite`, c).provider, null, name)
    assert.strictEqual(L.nextFallback({ ...c, failoverChain: [name] }, 'glm', []), null, name)
  }
  assert.strictEqual(c.providers.glm.name, 'glm')
})

test('directories compare by real path, and case-insensitively only on Windows', () => {
  assert.strictEqual(L.sameDir('c:\\Users\\x\\.claude', 'C:\\Users\\X\\.claude', true), true)
  assert.strictEqual(L.sameDir('c:\\Users\\x\\.claude', 'C:/users/x/.claude', true), true)
  assert.strictEqual(L.sameDir('/tmp/Relay-A', '/tmp/relay-a', false), false)
  assert.strictEqual(L.sameDir(os.tmpdir(), os.tmpdir() + '/', false), true)
  assert.strictEqual(L.isPort(1025) && L.isPort(65535) && !L.isPort(1024) && !L.isPort(65536) && !L.isPort('8950'), true)
})

// ---------- format 2: no private defaults; what the older versions filled in lives in migrate.js ----------

test('format 2 has no built-in models, no haiku capture, no Gemini guesses and no implicit failover chain', () => {
  const env = { A: 'a', B: 'b' }
  const cfg = L.parseCfg({
    format: 2,
    failover: { enabled: true },
    providers: {
      alpha: { preset: 'zai', token: 'env:A', model: 'glm-9' },
      gemini: { baseUrl: 'https://gw.example/anthropic', token: 'env:B', model: 'gemini-9' },
      glm: { token: 'env:A' }, // no preset of that name any more, and no model
      beta: { preset: 'gemini', baseUrl: 'https://b.example', token: 'env:B', model: 'beta-1' },
    },
  }, env)
  assert.deepStrictEqual(Object.keys(cfg.providers).sort(), ['alpha', 'beta', 'gemini'])
  assert.deepStrictEqual(cfg.providers.alpha.matchSources, ['^glm'], 'the zai preset no longer claims haiku')
  assert.strictEqual(L.matchProviderByModel(cfg, 'claude-haiku-5-5'), null)
  assert.strictEqual(cfg.providers.gemini.stripCacheControl, false, 'a Gemini-like name changes nothing')
  assert.strictEqual(cfg.providers.gemini.authHeader, 'bearer')
  assert.strictEqual(cfg.providers.beta.stripCacheControl, false, 'the private gemini preset is gone')
  assert.deepStrictEqual(cfg.failoverChain, [])
  assert.strictEqual(cfg.failoverProvider, null)
  const limited = L.onLimited(L.emptyState(), cfg, 1000)
  assert.strictEqual(L.decide(limited, cfg, 'claude-opus-5-5', 's', 2000), 'claude', 'a 429 with no chain stays with Claude')
  assert.strictEqual(L.parseCfg({ format: 2, providers: { glm: { token: 't' } } }), null)
})

test('with no usable provider the router still has a config that sends everything to Claude', () => {
  const raw = { format: 2, port: 9123, claudeUrl: 'https://claude.example', providers: { a: { token: 'env:UNSET_KEY', model: 'm', baseUrl: 'https://a.example' } } }
  assert.strictEqual(L.parseCfg(raw, {}), null)
  const bare = L.bareCfg(raw)
  assert.strictEqual(bare.port, 9123)
  assert.strictEqual(bare.claudeUrl, 'https://claude.example')
  assert.strictEqual(L.decide(L.emptyState(), bare, 'claude-haiku-5-5', 's', 0), 'claude')
  assert.strictEqual(L.decide(L.onLimited(L.emptyState(), bare, 0), bare, 'claude-opus-5-5', 's', 1), 'claude')
})

test('the example config in the repository is format 2 and names no model of its own', () => {
  const raw = JSON.parse(require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'model-relay.example.json'), 'utf8'))
  assert.strictEqual(L.isFormat2(raw), true)
  const c = L.parseCfg(raw, { BACKUP_API_KEY: 'k', LOCAL_GATEWAY_TOKEN: 'k' })
  assert.deepStrictEqual(Object.keys(c.providers), ['backup', 'local'])
  assert.deepStrictEqual(c.failoverChain, ['backup'])
  assert.strictEqual(L.decide(L.emptyState(), c, 'claude-haiku-5-5', 's', 0), 'claude', 'haiku stays on Claude unless an alias says otherwise')
})

test('a request on Message Threads is refused for a provider, in the wording Claude Code reads as "beta not supported"', () => {
  assert.strictEqual(L.threadBetaRefusal({}), null)
  assert.strictEqual(L.threadBetaRefusal({ 'anthropic-beta': 'claude-code-20250219,oauth-2025-04-20' }), null)
  const msg = L.threadBetaRefusal({ 'anthropic-beta': 'claude-code-20250219, message-threads-2026-08-12,effort-2025-11-24' })
  // Claude Code drops the beta when the message names it and mentions anthropic-beta
  assert.ok(msg.includes('message-threads-2026-08-12'))
  assert.match(msg, /anthropic[-_]beta/)
  assert.ok(L.threadBetaRefusal({ 'anthropic-beta': ['x', 'message-threads-2027-01-01'] }).includes('message-threads-2027-01-01'))
})
