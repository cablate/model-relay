'use strict'
// legacy:begin — the one place that knows configs from 0.6 and earlier. The router reads "format": 2 only; this is what
// "setup.mjs migrate" turns an older file into one with, and it refuses any result the router would route differently.
// Tested by migrate.test.js.

const L = require('./logic')

// Older file names, each with the name "migrate --go" moves it to
const OLD_FILES = [
  ['custom-agent.json', 'model-relay.json'],
  ['custom-agent-state.json', 'model-relay-state.json'],
  ['custom-agent-router.log', 'model-relay.log'],
  ['custom-agent-requests.log', 'model-relay-requests.log'],
]

// What the older version filled in: every preset came with a model, zai (and glm, its other name) also caught haiku,
// and gemini and magpie pointed at a local gateway. Without a chain, glm or else the first provider took over a 429.
const GATEWAY = { baseUrl: 'http://127.0.0.1:3425', model: 'gemini-4-argon', matchModels: ['^gemini'], stripCacheControl: true, authHeader: 'both' }
const OLD_PRESETS = {
  zai: { ...L.PRESETS.zai, model: 'glm-5.3[1m]', matchModels: ['^glm', 'haiku'] },
  glm: { ...L.PRESETS.zai, model: 'glm-5.3[1m]', matchModels: ['^glm', 'haiku'] },
  deepseek: { ...L.PRESETS.deepseek, model: 'deepseek-chat' },
  kimi: { ...L.PRESETS.kimi, model: 'kimi-k2' },
  minimax: { ...L.PRESETS.minimax, model: 'MiniMax-M1' },
  openrouter: { ...L.PRESETS.openrouter, model: 'anthropic/claude-sonnet-4' },
  gemini: GATEWAY,
  magpie: GATEWAY,
}
const OLD_DEFAULT_FAILOVER = 'glm'

const str = (v) => (typeof v === 'string' && v.length > 0 ? v : null)

// The layouts before multi-provider configs: the first provider's keys at the top level, a separate top-level block
// for the second one, and failoverEnabled / probeEveryMin / failoverProvider. One note per thing it moves.
function moveLayout(raw) {
  const notes = []
  const config = { ...raw }
  const providers = L.isObj(raw.providers) ? { ...raw.providers } : {}
  const has = (name) => Object.keys(providers).some((k) => k.trim().toLowerCase() === name)

  if (!has('glm') && str(raw.baseUrl) && str(raw.token) && str(raw.model)) {
    providers.glm = {
      baseUrl: raw.baseUrl,
      token: raw.token,
      model: raw.model,
      matchModels: ['^glm'],
      stripCacheControl: false,
      authHeader: 'bearer',
      ...(raw.launch ? { launch: raw.launch } : {}),
    }
    notes.push('top-level baseUrl/token/model -> providers.glm')
  }
  for (const k of ['baseUrl', 'token', 'model', 'launch']) {
    if (k in config && (has('glm') || !str(raw.baseUrl))) {
      delete config[k]
      if (k !== 'launch' || raw.launch) notes.push(`removed top-level ${k} (providers.glm replaces it)`)
    }
  }

  if (L.isObj(raw.gemini)) {
    if (!has('gemini')) {
      providers.gemini = {
        ...raw.gemini,
        matchModels: raw.gemini.matchModels || ['^gemini'],
        stripCacheControl: raw.gemini.stripCacheControl !== undefined ? raw.gemini.stripCacheControl : true,
        authHeader: raw.gemini.authHeader || 'both',
      }
      notes.push('top-level gemini -> providers.gemini')
    } else {
      notes.push('removed top-level gemini (providers.gemini replaces it)')
    }
    delete config.gemini
  }

  const fo = L.isObj(raw.failover) ? raw.failover : {}
  const oldMin = typeof fo.probeEveryMin === 'number' ? fo.probeEveryMin : raw.probeEveryMin
  const cooldownMs = typeof fo.cooldownMs === 'number' && fo.cooldownMs >= 0
    ? fo.cooldownMs
    : (typeof oldMin === 'number' && Number.isFinite(oldMin) ? oldMin * 60000 : 600000)
  const chain = Array.isArray(fo.chain) ? fo.chain : [fo.provider || raw.failoverProvider].filter(Boolean)
  const nextFo = {
    enabled: fo.enabled !== undefined ? fo.enabled !== false : raw.failoverEnabled !== false,
    chain: L.lowerNames(chain),
    cooldownMs,
  }
  const sameFo = L.isObj(raw.failover) && raw.failover.enabled === nextFo.enabled && raw.failover.cooldownMs === nextFo.cooldownMs
    && Array.isArray(raw.failover.chain) && raw.failover.chain.join() === nextFo.chain.join() && !('provider' in raw.failover) && !('probeEveryMin' in raw.failover)
  if (!sameFo) notes.push('failover -> { enabled, chain, cooldownMs }')
  for (const k of ['failoverEnabled', 'probeEveryMin', 'failoverProvider']) {
    if (k in raw) notes.push(`removed top-level ${k} (failover.* replaces it)`)
    delete config[k]
  }
  config.failover = nextFo
  config.providers = providers
  return { config, notes }
}

// A provider as the older version read it: the older presets, and a provider named or modelled after Gemini without a
// preset guessed to sit behind a gateway (cache_control stripped, both auth headers)
function oldProvider(key, v, env, retry) {
  if (!L.isObj(v)) return null
  const presetKey = (str(v.preset) || key).toLowerCase()
  const guessed = !Object.hasOwn(OLD_PRESETS, presetKey) && (/^gemini$/i.test(key) || /^gemini/i.test(str(v.model) || ''))
  const raw = guessed
    ? { ...v, stripCacheControl: v.stripCacheControl !== undefined ? v.stripCacheControl : true, authHeader: ['bearer', 'x-api-key', 'both'].includes(v.authHeader) ? v.authHeader : 'both' }
    : v
  return L.parseProvider(key, raw, env, retry, OLD_PRESETS)
}

// The whole config as the older router read it, in the shape parseCfg gives, so the two can be compared
function oldCfg(raw, env = L.ANY_ENV) {
  if (!L.isObj(raw)) return null
  const { config } = moveLayout(raw)
  const base = L.bareCfg({ ...config, format: 2 })
  const providers = Object.create(null)
  for (const [k, v] of Object.entries(config.providers)) {
    const key = k.trim().toLowerCase()
    if (!key || key === 'claude') continue
    const p = oldProvider(key, v, env, base.retry)
    if (p) providers[key] = p
  }
  const names = Object.keys(providers)
  if (!names.length) return null
  let chain = [...new Set(config.failover.chain.filter((n) => providers[n]))]
  if (!chain.length) chain = [providers[OLD_DEFAULT_FAILOVER] ? OLD_DEFAULT_FAILOVER : names[0]]
  return { ...base, providers, failoverChain: chain, failoverProvider: chain[0] }
}

// Each field parseProvider resolves, the config key that sets it, and how migrate names the value it writes
const FIELDS = {
  url: ['baseUrl', (v) => `address ${v} (from an older preset)`],
  model: ['model', (v) => `model ${v} (from an older preset; presets no longer pick a model)`],
  matchSources: ['matchModels', (v) => `routes ${JSON.stringify(v)}${v.includes('haiku') ? ', which send every haiku request to it' : ''}`],
  stripCacheControl: ['stripCacheControl', (v) => `stripCacheControl ${v}`],
  authHeader: ['authHeader', (v) => `authHeader "${v}"`],
}

// The same config in format 2: the older layout moved and every value the older version filled in written out.
// { config, notes }, or null when raw is not an object.
function toFormat2(raw) {
  if (!L.isObj(raw)) return null
  const { config, notes } = moveLayout(raw)
  const old = oldCfg(raw)
  const { format: _old, ...rest } = config // a "format": 1 or "2" left in the file must not survive the mark
  const next = { format: 2, ...rest, providers: { ...config.providers } }
  for (const [k, v] of Object.entries(config.providers)) {
    const key = k.trim().toLowerCase()
    const was = old && old.providers[key]
    if (!was) continue
    // The preset stays, even one format 2 does not know (glm, gemini, magpie, which pick nothing there): an older router
    // still running reads the new file with it and with every value written out below, so it routes as before too.
    // A provider the older router could not use is left as it is.
    const p = { ...v }
    let now = L.parseProvider(key, p, L.ANY_ENV, old.retry)
    for (const [f, [field, say]] of Object.entries(FIELDS)) {
      // A provider format 2 cannot read at all (no model, no address) needs the fields its file does not already say;
      // once its address and model are written, the rest is compared as format 2 reads it
      const said = f === 'url' ? p.baseUrl || p.url : p[field]
      if (JSON.stringify(now ? now[f] : said) === JSON.stringify(was[f])) continue
      p[field] = was[f]
      if (f === 'url') delete p.url
      notes.push(`write out providers.${key}: ${say(was[f])}`)
      now = L.parseProvider(key, p, L.ANY_ENV, old.retry)
    }
    next.providers[k] = p
  }
  if (old && !config.failover.chain.some((n) => old.providers[n])) {
    next.failover = { ...config.failover, chain: [...old.failoverChain] }
    notes.push(`write out failover.chain: ${old.failoverChain.join(', ')} takes over on Claude's usage-limit 429, as before`)
  }
  return { config: next, notes }
}

// Whether the router reads next (format 2) exactly as the older router read raw, every env:VAR counted as set
function sameRouting(raw, next) {
  const shape = (c) => JSON.stringify(c, (k, v) => (v instanceof RegExp ? String(v) : v))
  return shape(oldCfg(raw)) === shape(L.parseCfg(next, L.ANY_ENV))
}

module.exports = { OLD_FILES, oldCfg, toFormat2, sameRouting }
// legacy:end
