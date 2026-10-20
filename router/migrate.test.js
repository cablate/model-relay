'use strict'
// router/migrate.js: how the older versions read a config (oldCfg), the format 2 file that says it out loud
// (toFormat2), and the check that both route the same (sameRouting). Whenever migrate.js goes, this file goes with it.
const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')
const L = require('./logic')
const M = require('./migrate')

// A config in the JSON shape sameRouting compares: regexes as text
const shape = (c) => JSON.stringify(c, (k, v) => (v instanceof RegExp ? String(v) : v))
const OPUS = 'claude-opus-5-5'
const HAIKU = 'claude-haiku-5-5'

// 0.6: presets bring a model, glm and gemini are known by name, and the chain is implicit
const LEGACY = {
  port: 8950,
  failover: { enabled: true },
  providers: {
    glm: { token: 'env:ZAI_API_KEY' },
    gemini: { preset: 'gemini', token: 'env:GW_TOKEN' },
    deepseek: { token: 'inline-secret', model: 'deepseek-chat' },
  },
}

// The shape of a config file that grew over time: providers AND the same data again at the top level
const GROWN = {
  port: 8950,
  nodePath: 'node',
  failover: { enabled: true, provider: 'glm', cooldownMs: 600000 },
  providers: {
    glm: { baseUrl: 'https://api.z.ai/api/anthropic', token: 'tok-glm', model: 'glm-5.3[1m]', matchModels: ['^glm', 'haiku'] },
    gemini: { baseUrl: 'http://127.0.0.1:3425', token: 'tok-gem', model: 'gemini-4-argon', stripCacheControl: true, authHeader: 'both', retry: { attempts: 0 } },
  },
  baseUrl: 'https://api.z.ai/api/anthropic',
  token: 'tok-glm',
  model: 'glm-5.3[1m]',
  failoverEnabled: true,
  probeEveryMin: 10,
  gemini: { baseUrl: 'http://127.0.0.1:3425', token: 'tok-gem', model: 'gemini-4-argon' },
}

// The original single-provider layout: the first provider's keys at the top level, a second one in its own block
const SINGLE = {
  baseUrl: 'https://api.z.ai/api/anthropic',
  token: 't',
  model: 'glm-5.3[1m]',
  gemini: { baseUrl: 'http://127.0.0.1:3425', token: 'g', model: 'gemini-4-argon' },
}

const notesOf = (raw) => M.toFormat2(raw).notes

test('the older router read the top-level layout with its own defaults', () => {
  const old = M.oldCfg({ baseUrl: 'https://api.z.ai/api/anthropic', token: 't', model: 'glm-5.3[1m]' })
  assert.strictEqual(M.oldCfg({ baseUrl: 'ftp://x', token: 't', model: 'm' }), null)
  assert.strictEqual(old.port, 8950)
  assert.strictEqual(old.claudeUrl, 'https://api.anthropic.com')
  assert.strictEqual(old.cooldownMs, 600000)
  assert.strictEqual(old.failoverProvider, 'glm', 'the one provider is the failover target')
  assert.ok(old.providers.glm)
  assert.strictEqual(L.decide(L.emptyState(), old, 'glm-5.3', 'a', 0), 'glm')
  assert.strictEqual(M.oldCfg(null), null)
  assert.strictEqual(M.oldCfg({}), null)
  assert.strictEqual(M.oldCfg([]), null)
})

test('what the older router read from a multi-provider file: presets with models, env tokens, a failover provider', () => {
  const raw = {
    port: 8955,
    failover: { enabled: true, provider: 'deepseek', probeEveryMin: 5 },
    providers: {
      glm: { token: 'env:' + 'T_VAR' }, // the glm preset
      deepseek: { token: 'ds' }, // the deepseek preset
      gemini: { token: 'gw', launch: { command: 'magpie', args: ['web'] } }, // the gemini preset
    },
  }
  const env = { T_VAR: 'resolved-val' }
  const old = M.oldCfg(raw, env)
  assert.strictEqual(old.port, 8955)
  assert.strictEqual(old.failoverProvider, 'deepseek')
  assert.strictEqual(old.cooldownMs, 300000)
  assert.strictEqual(old.providers.glm.token, 'resolved-val')
  assert.strictEqual(old.providers.deepseek.model, 'deepseek-chat')
  assert.strictEqual(old.providers.gemini.stripCacheControl, true)
  assert.strictEqual(old.providers.gemini.authHeader, 'both')
  assert.deepStrictEqual(old.providers.gemini.launch, { command: 'magpie', args: ['web'] })
  assert.strictEqual(L.decide(L.emptyState(), old, 'deepseek-reasoner', 's1', 0), 'deepseek')
  assert.strictEqual(L.decide(L.emptyState(), old, 'glm-5.3', 's1', 0), 'glm')
  assert.strictEqual(L.decide(L.emptyState(), old, 'gemini-4-argon', 's1', 0), 'gemini')
  // The format 2 file reads the same under the same environment: the token is written as it was, "env:T_VAR"
  const next = M.toFormat2(raw).config
  assert.strictEqual(next.providers.glm.token, 'env:T_VAR')
  assert.strictEqual(shape(L.parseCfg(next, env)), shape(old))
})

test('an older config: every default it relied on is written out, and each one is named once', () => {
  const old = M.oldCfg(LEGACY, { ZAI_API_KEY: 'z', GW_TOKEN: 'g' })
  assert.strictEqual(old.providers.glm.model, 'glm-5.3[1m]')
  assert.strictEqual(L.matchProviderByModel(old, HAIKU), 'glm', 'glm (zai) caught every haiku request')
  assert.strictEqual(old.providers.gemini.url, 'http://127.0.0.1:3425')
  assert.deepStrictEqual(old.failoverChain, ['glm'], 'without a chain, glm took over')

  const notes = notesOf(LEGACY)
  const text = notes.join('\n')
  for (const want of [
    /^write out providers\.glm: model glm-5\.3\[1m\]/m,
    /^write out providers\.glm: routes \["\^glm","haiku"\], which send every haiku request to it$/m,
    /^write out providers\.gemini: address http:\/\/127\.0\.0\.1:3425/m,
    /^write out failover\.chain: glm takes over/m,
  ]) {
    assert.match(text, want)
    assert.strictEqual(notes.filter((n) => want.test(n)).length, 1, `${want} is said once`)
  }
  assert.strictEqual(new Set(notes).size, notes.length, 'no note is repeated')
  assert.doesNotMatch(text, /deepseek/, 'a provider that spells everything out relies on nothing old')
  for (const secret of ['inline-secret', 'ZAI_API_KEY', 'GW_TOKEN']) assert.ok(!text.includes(secret), `never a token: ${secret}`)
  assert.deepStrictEqual(notesOf({ format: 2, failover: { enabled: true, chain: [], cooldownMs: 600000 }, providers: {} }), [], 'a file that already says it all has nothing to name')
})

test('the zai preset caught haiku and the older glm name meant zai; no other preset claimed a Claude model', () => {
  const token = 't'
  for (const providers of [{ glm: { token } }, { zai: { token } }, { x: { preset: 'zai', token, baseUrl: 'https://x.example', model: 'm' } }]) {
    const old = M.oldCfg({ providers })
    assert.strictEqual(L.matchProviderByModel(old, HAIKU), Object.keys(providers)[0], JSON.stringify(providers))
    assert.strictEqual(L.matchProviderByModel(old, OPUS), null)
  }
  for (const preset of ['deepseek', 'kimi', 'minimax', 'openrouter']) {
    const old = M.oldCfg({ providers: { [preset]: { token } } })
    assert.ok(old.providers[preset].model, `${preset} came with a model`)
    assert.strictEqual(L.matchProviderByModel(old, HAIKU), null, preset)
  }
  assert.strictEqual(M.toFormat2({ providers: { glm: { token } } }).config.providers.glm.matchModels.includes('haiku'), true, 'written out, so it stays visible')
})

test('gemini and magpie meant a local gateway, and a provider named or modelled after Gemini guessed the same switches', () => {
  for (const name of ['gemini', 'magpie']) {
    const old = M.oldCfg({ providers: { [name]: { token: 't' } } })
    assert.strictEqual(old.providers[name].url, 'http://127.0.0.1:3425', name)
    assert.strictEqual(old.providers[name].model, 'gemini-4-argon', name)
    assert.strictEqual(old.providers[name].stripCacheControl, true, name)
    assert.strictEqual(old.providers[name].authHeader, 'both', name)
  }
  // no preset of its own, but the name (or the model) said Gemini: cache_control stripped, both auth headers
  for (const raw of [{ gemini: { baseUrl: 'https://gw.example', token: 't', model: 'x-1' } }, { other: { baseUrl: 'https://gw.example', token: 't', model: 'gemini-9' } }]) {
    const [name] = Object.keys(raw)
    const old = M.oldCfg({ providers: raw })
    assert.strictEqual(old.providers[name].stripCacheControl, true, name)
    assert.strictEqual(old.providers[name].authHeader, 'both', name)
    // format 2 guesses nothing: the guess is written into the file instead
    const next = M.toFormat2({ providers: raw }).config
    assert.strictEqual(next.providers[name].stripCacheControl, true, name)
    assert.strictEqual(next.providers[name].authHeader, 'both', name)
  }
})

test('without a failover chain the older router handed a 429 to glm, else to the first provider; migrate writes that chain out', () => {
  const p = (n) => ({ baseUrl: `https://${n}.example`, token: 't', model: `${n}-1` })
  assert.deepStrictEqual(M.oldCfg({ providers: { a: p('a'), glm: p('glm') } }).failoverChain, ['glm'])
  assert.deepStrictEqual(M.oldCfg({ providers: { a: p('a'), b: p('b') } }).failoverChain, ['a'])
  assert.deepStrictEqual(M.oldCfg({ providers: { a: p('a') }, failover: { chain: ['ghost'] } }).failoverChain, ['a'], 'a chain naming nobody usable counted as none')
  assert.deepStrictEqual(M.oldCfg({ providers: { a: p('a'), b: p('b') }, failover: { chain: ['b', 'ghost', 'a', 'b'] } }).failoverChain, ['b', 'a'])
  assert.strictEqual(M.oldCfg({ providers: { a: p('a'), b: p('b') }, failoverProvider: 'b' }).failoverProvider, 'b')
  assert.strictEqual(M.oldCfg({ providers: { a: p('a'), b: p('b') }, failover: { provider: 'b' } }).failoverProvider, 'b')

  const raw = { providers: { a: p('a'), b: p('b') } }
  const { config, notes } = M.toFormat2(raw)
  assert.deepStrictEqual(config.failover.chain, ['a'])
  assert.deepStrictEqual(L.parseCfg(config).failoverChain, ['a'], 'format 2 takes the written chain, not a guess')
  assert.ok(notes.some((n) => /^write out failover\.chain: a takes over on Claude's usage-limit 429, as before$/.test(n)), notes.join('\n'))
  const named = M.toFormat2({ ...raw, failover: { chain: ['b'] } })
  assert.deepStrictEqual(named.config.failover.chain, ['b'])
  assert.ok(!named.notes.some((n) => /failover\.chain/.test(n)), 'a chain the person wrote needs no note')
})

test('failover.cooldownMs wins; the older probeEveryMin (minutes) still set it, nested or at the top level', () => {
  const base = { providers: { glm: { baseUrl: 'https://x.example', token: 't', model: 'm' } } }
  assert.strictEqual(M.oldCfg({ ...base, failover: { cooldownMs: 120000 } }).cooldownMs, 120000)
  assert.strictEqual(M.oldCfg({ ...base, failover: { probeEveryMin: 5 } }).cooldownMs, 300000)
  assert.strictEqual(M.oldCfg({ ...base, probeEveryMin: 5 }).cooldownMs, 300000)
  assert.strictEqual(M.oldCfg({ ...base, failover: { cooldownMs: 120000, probeEveryMin: 5 } }).cooldownMs, 120000)
  assert.strictEqual(M.oldCfg({ ...base }).cooldownMs, 600000)
  assert.strictEqual(M.oldCfg({ ...base, failover: { cooldownMs: 1 } }).cooldownMs, 60000, 'never hammers Claude faster than once a minute')
  // migrate turns the minutes into the setting format 2 reads, and leaves the old keys behind
  for (const raw of [{ ...base, failover: { probeEveryMin: 5 } }, { ...base, probeEveryMin: 5 }]) {
    const next = M.toFormat2(raw).config
    assert.strictEqual(next.failover.cooldownMs, 300000, JSON.stringify(raw))
    assert.ok(!('probeEveryMin' in next) && !('probeEveryMin' in next.failover), JSON.stringify(next))
    assert.strictEqual(L.parseCfg(next).cooldownMs, 300000)
  }
})

test('migrating a grown file changes the layout but not what the router does', () => {
  const { config, notes } = M.toFormat2(GROWN)
  assert.strictEqual(config.format, 2)
  assert.ok(M.sameRouting(GROWN, config), `${shape(M.oldCfg(GROWN))}\n${shape(L.parseCfg(config, L.ANY_ENV))}`)
  for (const gone of ['baseUrl', 'token', 'model', 'gemini', 'failoverEnabled', 'probeEveryMin']) assert.ok(!(gone in config), gone)
  assert.deepStrictEqual(config.failover, { enabled: true, chain: ['glm'], cooldownMs: 600000 })
  assert.ok(notes.length >= 3)
  for (const want of ['top-level baseUrl', 'top-level token', 'top-level model', 'top-level gemini', 'top-level failoverEnabled', 'top-level probeEveryMin']) {
    assert.ok(notes.some((n) => n.includes(want)), `a note for ${want}: ${notes.join(' | ')}`)
  }
  assert.strictEqual(config.providers.gemini.token, 'tok-gem', 'secrets are copied through untouched')
  assert.strictEqual(config.providers.glm.token, 'tok-glm')
  assert.strictEqual(config.nodePath, 'node', 'keys the router does not know about stay')
})

test('migrating twice changes nothing more, and an already clean file reports no notes', () => {
  const once = M.toFormat2(GROWN).config
  const twice = M.toFormat2(once)
  assert.deepStrictEqual(twice.config, once)
  assert.deepStrictEqual(twice.notes, [])
  assert.ok(M.sameRouting(once, twice.config))
})

test('the original single-provider layout migrates into providers.glm', () => {
  const old = M.oldCfg(SINGLE)
  assert.deepStrictEqual(Object.keys(old.providers).sort(), ['gemini', 'glm'])
  assert.strictEqual(old.providers.gemini.stripCacheControl, true, 'the old gemini block keeps its old defaults')
  assert.deepStrictEqual(old.providers.glm.matchSources, ['^glm'])
  const { config, notes } = M.toFormat2(SINGLE)
  assert.ok(M.sameRouting(SINGLE, config))
  assert.ok(!('baseUrl' in config) && !('token' in config) && !('model' in config) && !('gemini' in config), JSON.stringify(config))
  assert.deepStrictEqual(config.providers.glm, { baseUrl: SINGLE.baseUrl, token: 't', model: 'glm-5.3[1m]', matchModels: ['^glm'], stripToolSearch: true, stripCacheControl: false, authHeader: 'bearer' })
  assert.strictEqual(config.providers.gemini.token, 'g')
  assert.ok(notes.includes('top-level baseUrl/token/model -> providers.glm'), notes.join(' | '))
  assert.ok(notes.includes('top-level gemini -> providers.gemini'), notes.join(' | '))
  // a top-level block that providers.glm already covers is dropped, not merged
  const both = M.toFormat2({ ...SINGLE, providers: { glm: { baseUrl: 'https://own.example', token: 'own', model: 'own-1' } } })
  assert.strictEqual(both.config.providers.glm.token, 'own')
  assert.ok(both.notes.includes('removed top-level token (providers.glm replaces it)'), both.notes.join(' | '))
})

test('migrate.toFormat2 writes the older defaults out, so the router routes exactly as before', () => {
  const cases = [
    LEGACY,
    GROWN,
    SINGLE,
    { providers: { glm: { preset: 'zai', token: 'x' } }, failover: { enabled: false } },
    { providers: { gemini: { baseUrl: 'http://127.0.0.1:3425', token: 'x', model: 'gemini-4-argon' }, kimi: { token: 'y' } }, failover: { chain: ['nobody'] } },
    { providers: { magpie: { preset: 'magpie', token: 'x', matchModels: ['^gem'] } }, retry: { attempts: 5, maxDelayMs: 30000 } },
  ]
  for (const raw of cases) {
    const { config: next } = M.toFormat2(raw)
    assert.strictEqual(next.format, 2)
    assert.ok(M.sameRouting(raw, next), `routing kept for ${JSON.stringify(raw)}\n${JSON.stringify(next)}`)
    assert.deepStrictEqual(M.toFormat2(next).notes, [], 'nothing is left to write out')
    assert.ok(M.sameRouting(next, M.toFormat2(next).config), 'migrating twice changes nothing')
  }
  const g = M.toFormat2(LEGACY).config.providers.gemini
  assert.ok(g.preset === 'gemini' && g.baseUrl === 'http://127.0.0.1:3425' && g.stripCacheControl === true, 'the preset field stays as it was, with every value it stood for written out: ' + JSON.stringify(g))
  assert.strictEqual(M.toFormat2(LEGACY).config.providers.deepseek.token, 'inline-secret', 'tokens are copied untouched')
  assert.strictEqual(M.toFormat2(LEGACY).config.providers.glm.token, 'env:ZAI_API_KEY', 'and so are env references')
})

test('a provider the older router could not use is left as the person wrote it', () => {
  const raw = { providers: { glm: { baseUrl: 'https://a.example', token: 'a', model: 'glm-1' }, foo: { token: 'no address, no model' }, bad: 'not an object' } }
  const { config, notes } = M.toFormat2(raw)
  assert.deepStrictEqual(config.providers.foo, { token: 'no address, no model' })
  assert.strictEqual(config.providers.bad, 'not an object')
  assert.ok(!notes.some((n) => /providers\.(foo|bad)/.test(n)), notes.join(' | '))
  assert.ok(M.sameRouting(raw, config))
  assert.strictEqual(M.toFormat2(null), null)
  assert.strictEqual(M.toFormat2([]), null)
  assert.strictEqual(M.toFormat2('x'), null)
})

test('a config with no usable provider migrates unchanged except for the format mark', () => {
  const raw = { port: 9123, providers: { foo: { token: 'x' } } }
  const { config, notes } = M.toFormat2(raw)
  assert.strictEqual(M.oldCfg(raw), null)
  assert.strictEqual(L.parseCfg(config, L.ANY_ENV), null)
  assert.ok(M.sameRouting(raw, config))
  assert.strictEqual(config.format, 2)
  assert.strictEqual(config.port, 9123)
  assert.ok(!notes.some((n) => /^write out failover\.chain/.test(n)), 'no chain to write out when nobody can take over')
})

test('older defaults name only what the file leaves out, and never repeat an address or a token the person wrote', () => {
  const raw = { providers: { deepseek: { baseUrl: 'https://user:pw@host.example/x?key=SECRETKEY', token: 'sk-hidden' } } }
  const notes = notesOf(raw)
  assert.ok(notes.some((n) => /^write out providers\.deepseek: model deepseek-chat \(from an older preset/.test(n)), notes.join('\n'))
  assert.ok(notes.every((n) => !n.includes('SECRETKEY') && !n.includes('host.example') && !n.includes('sk-hidden')), notes.join('\n'))
  assert.ok(!notes.some((n) => /providers\.deepseek: address/.test(n)), 'the address was written, so it is not an older default')
  assert.ok(notes.every((n) => !/Gemini/.test(n)), 'no provider-specific guess is claimed')
  const next = M.toFormat2({ providers: { deepseek: { baseUrl: 'https://host.example/x', token: 't' } } }).config
  assert.strictEqual(next.providers.deepseek.baseUrl, 'https://host.example/x', 'the written address is kept')
  assert.strictEqual(next.providers.deepseek.model, 'deepseek-chat')
  assert.ok(!('url' in next.providers.deepseek))
  // a "url" spelling of the address is moved to baseUrl only when the older preset had to supply something else
  const viaUrl = M.toFormat2({ providers: { kimi: { url: 'https://host.example/k', token: 't' } } }).config
  assert.strictEqual(L.parseShape(viaUrl).providers.kimi.url, 'https://host.example/k')
})

test('format 2 replaces any "format" value an older file carries', () => {
  for (const format of [1, '2', null]) {
    const raw = { format, providers: { aaa: { baseUrl: 'https://a.example', token: 't', model: 'aaa-1' } } }
    const next = M.toFormat2(raw).config
    assert.strictEqual(next.format, 2, `from ${JSON.stringify(format)}`)
    assert.ok(M.sameRouting(raw, next))
    assert.strictEqual(L.parseCfg(raw), null, `the router does not read format ${JSON.stringify(format)}`)
  }
})

test('the example config in the repository is format 2 already: no older default to write out, nothing to change', () => {
  const raw = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'model-relay.example.json'), 'utf8'))
  const { config, notes } = M.toFormat2(raw)
  assert.deepStrictEqual(notes, [])
  assert.deepStrictEqual(config, raw)
  assert.ok(M.sameRouting(raw, config))
})

test('the older file names each move to a model-relay name', () => {
  assert.ok(M.OLD_FILES.length >= 4)
  for (const [from, to] of M.OLD_FILES) {
    assert.match(from, /^custom-agent/)
    assert.match(to, /^model-relay/)
    assert.strictEqual(path.extname(from), path.extname(to), `${from} -> ${to} keeps its kind of file`)
  }
  assert.strictEqual(new Set(M.OLD_FILES.map(([from]) => from)).size, M.OLD_FILES.length)
  assert.strictEqual(new Set(M.OLD_FILES.map(([, to]) => to)).size, M.OLD_FILES.length)
})

// ---------- seeded fuzz: random older configs, migrated ----------

// A seeded generator (mulberry32), so a failure replays with the same input
function seededRandom(seed) {
  let s = seed | 0
  return () => {
    s = (s + 0x6d2b79f5) | 0
    let t = Math.imul(s ^ (s >>> 15), 1 | s)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function randomConfigs(count, seed) {
  const rnd = seededRandom(seed)
  const pick = (a) => a[Math.floor(rnd() * a.length)]
  const maybe = (o, k, vals) => {
    const v = pick(vals)
    if (v !== undefined) o[k] = v
  }
  const provider = () => {
    const p = {}
    maybe(p, 'preset', [undefined, undefined, 'zai', 'glm', 'gemini', 'magpie', 'deepseek', 'kimi', 'bogus'])
    maybe(p, 'baseUrl', [undefined, undefined, 'https://x.example/a', 'http://127.0.0.1:4000'])
    maybe(p, 'model', [undefined, 'glm-5', 'gemini-3', 'foo-1', 'x[1m]'])
    maybe(p, 'matchModels', [undefined, undefined, [], ['^x'], ['haiku', '^y']])
    maybe(p, 'stripToolSearch', [undefined, undefined, true, false])
    maybe(p, 'stripCacheControl', [undefined, undefined, true, false])
    maybe(p, 'authHeader', [undefined, undefined, 'both', 'bearer', 'x-api-key', 'bad'])
    p.token = pick(['t', 'env:SOME', 't2'])
    maybe(p, 'fallback', [undefined, undefined, false, ['glm']])
    return p
  }
  const config = () => {
    const raw = { providers: {} }
    const n = 1 + Math.floor(rnd() * 3)
    for (let i = 0; i < n; i++) raw.providers[pick(['glm', 'gemini', 'magpie', 'zai', 'deepseek', 'kimi', 'foo', 'gemini-x', 'Claude'])] = provider()
    if (rnd() < 0.15) Object.assign(raw, { baseUrl: 'https://top.example', token: 'tt', model: 'glm-top' })
    if (rnd() < 0.1) raw.gemini = { baseUrl: 'http://127.0.0.1:3425', token: 'g', model: 'gemini-4' }
    maybe(raw, 'failoverEnabled', [undefined, undefined, true, false])
    maybe(raw, 'probeEveryMin', [undefined, undefined, 5])
    maybe(raw, 'failoverProvider', [undefined, undefined, 'gemini'])
    if (rnd() < 0.6) {
      raw.failover = {}
      maybe(raw.failover, 'enabled', [undefined, true, false])
      maybe(raw.failover, 'chain', [undefined, [], ['gemini'], ['nope', 'glm']])
      maybe(raw.failover, 'provider', [undefined, undefined, 'kimi'])
      maybe(raw.failover, 'cooldownMs', [undefined, 120000])
    }
    maybe(raw, 'format', [undefined, undefined, 1, '2', null])
    return raw
  }
  return Array.from({ length: count }, config)
}

test('fuzz: 2000 random older configs migrate to a file that routes as before, under either router', () => {
  const configs = randomConfigs(2000, 7)
  assert.strictEqual(new Set(configs.map((c) => JSON.stringify(c))).size, 2000, 'the generator gives 2000 different configs')
  let usable = 0
  let haiku = 0
  let moved = 0
  for (const raw of configs) {
    const before = JSON.stringify(raw)
    const { config: next } = M.toFormat2(raw)
    const why = `input ${before}\nmigrated ${JSON.stringify(next)}`
    assert.strictEqual(JSON.stringify(raw), before, `toFormat2 changed its input\n${why}`)
    // (a) the format 2 router routes as the older one did
    assert.ok(M.sameRouting(raw, next), `the format 2 router would route differently\n${why}\nolder ${shape(M.oldCfg(raw))}\nnow   ${shape(L.parseCfg(next, L.ANY_ENV))}`)
    // (b) an older router that is still running reads the migrated file the same way
    assert.strictEqual(shape(M.oldCfg(next)), shape(L.parseCfg(next, L.ANY_ENV)), `an older router would read the migrated file differently\n${why}`)
    // (c) the mark is there and no token was touched
    assert.strictEqual(next.format, 2, why)
    for (const [k, p] of Object.entries(next.providers)) {
      const source = Object.hasOwn(raw.providers, k) ? raw.providers[k] : k === 'glm' ? raw : raw.gemini // the rest moved from the top level
      assert.strictEqual(p.token, source.token, `token of ${k} changed\n${why}`)
    }
    if (M.oldCfg(raw)) usable++
    if (M.oldCfg(raw) && Object.values(M.oldCfg(raw).providers).some((p) => p.matchSources.includes('haiku'))) haiku++
    if (!('baseUrl' in next) && 'baseUrl' in raw) moved++
  }
  // the generator really reaches the interesting cases, so a pass means something
  assert.ok(usable > 1500, `usable ${usable}`)
  assert.ok(haiku > 500, `haiku catchers ${haiku}`)
  assert.ok(moved > 150, `top-level layouts ${moved}`)
})
