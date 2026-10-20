#!/usr/bin/env node
// Setup, preset management, and doctor CLI for model-relay.
// Usage:
//   node tools/setup.mjs init [--fix]
//   node tools/setup.mjs presets
//   node tools/setup.mjs add <name> --token <token|env:VAR> [--preset <p>] [--model <m>] [--url <u>]
//   node tools/setup.mjs providers                                    list providers, routes, aliases, failover and retry
//   node tools/setup.mjs alias [haiku|sonnet|opus|subagent] [target]  inspect or point a Claude model alias at a provider (or back to claude)
//   node tools/setup.mjs set <key> <value>                            failover.enabled|chain|cooldownMs, retry.enabled|failover|..., providers.<name>.fallback|retry|matchModels
//   node tools/setup.mjs remove <name> [--go]
//   node tools/setup.mjs migrate [--go]                               tidy an old config layout (same behaviour, tokens untouched)
//   node tools/setup.mjs doctor [--fix] [--ping]   (alias: check)
//   node tools/setup.mjs proxy [status|enable|disable|renew] [--go]   HTTPS proxy mode, needed by Remote Control
//   node tools/setup.mjs rc [claude remote-control options]           start the router if needed, then Remote Control

import fs from 'node:fs'
import path from 'node:path'
import http from 'node:http'
import https from 'node:https'
import net from 'node:net'
import tls from 'node:tls'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const L = require('../router/logic.js')
const PKI = require('../router/pki.js')

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const home = process.env.USERPROFILE || process.env.HOME || ''
const cfgDir = process.env.CLAUDE_CONFIG_DIR || path.join(home, '.claude')
const relayCfgPath = path.join(cfgDir, 'model-relay.json')
const legacyCfgPath = path.join(cfgDir, 'custom-agent.json')
const settingsPath = path.join(cfgDir, 'settings.json')
const examplePath = path.join(root, 'model-relay.example.json')

const args = process.argv.slice(2)
const cmd = args[0] || 'doctor'
const hasFlag = (f) => args.includes(f)
const getOpt = (f) => {
  const i = args.indexOf(f)
  return i >= 0 && i + 1 < args.length ? args[i + 1] : null
}

// The running router re-reads these files on every request, so never leave one half written
function writeFileAtomic(file, text) {
  const tmp = `${file}.tmp-${process.pid}`
  fs.writeFileSync(tmp, text)
  for (let i = 0; ; i++) {
    try {
      fs.renameSync(tmp, file)
      return
    } catch (e) {
      if (i >= 8) {
        fs.rmSync(tmp, { force: true })
        throw e
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25) // Windows refuses a rename while a reader has the file open
    }
  }
}

function resolveActiveCfgPath() {
  if (fs.existsSync(relayCfgPath)) return relayCfgPath
  if (fs.existsSync(legacyCfgPath)) return legacyCfgPath
  return relayCfgPath
}

const NO_PROXY_LOCAL = '127.0.0.1,localhost,::1'

// How Claude Code is pointed at the router: as its API address ("base-url"), as its HTTPS proxy ("proxy"), or not at all
function wiringMode(settings, port) {
  const env = settings?.env || {}
  const url = `http://127.0.0.1:${port}`
  if (env.HTTPS_PROXY === url && env.NODE_EXTRA_CA_CERTS && !env.ANTHROPIC_BASE_URL) return 'proxy'
  if (env.ANTHROPIC_BASE_URL === url) return 'base-url'
  return 'none'
}

function readSettings() {
  return fs.existsSync(settingsPath) ? JSON.parse(fs.readFileSync(settingsPath, 'utf8')) : {}
}

// settings.json is shared with everything else Claude Code stores there, so keep a copy of what it was
function writeSettings(next) {
  fs.mkdirSync(cfgDir, { recursive: true })
  let backup = null
  if (fs.existsSync(settingsPath)) {
    backup = `${settingsPath}.relay-backup`
    fs.copyFileSync(settingsPath, backup)
  }
  writeFileAtomic(settingsPath, JSON.stringify(next, null, 2) + '\n')
  return backup
}

function ensureSettingsWiring(port, fix) {
  const expectedUrl = `http://127.0.0.1:${port}`
  if (fs.existsSync(settingsPath)) {
    try {
      if (wiringMode(readSettings(), port) === 'proxy') return { ok: true, msg: `settings.json uses the HTTPS proxy (HTTPS_PROXY=${expectedUrl}); Remote Control works` }
    } catch {}
  }
  if (!fs.existsSync(settingsPath)) {
    if (!fix) return { ok: false, msg: `Missing ${settingsPath} (run with --fix to wire ANTHROPIC_BASE_URL=${expectedUrl})` }
    fs.mkdirSync(cfgDir, { recursive: true })
    fs.writeFileSync(settingsPath, JSON.stringify({ env: { ANTHROPIC_BASE_URL: expectedUrl } }, null, 2) + '\n')
    return { ok: true, msg: `Created ${settingsPath} with ANTHROPIC_BASE_URL=${expectedUrl}` }
  }
  let s = {}
  try {
    s = JSON.parse(fs.readFileSync(settingsPath, 'utf8'))
  } catch (e) {
    return { ok: false, msg: `Invalid JSON in ${settingsPath}: ${e.message}` }
  }
  const cur = s?.env?.ANTHROPIC_BASE_URL
  if (cur === expectedUrl) {
    return { ok: true, msg: `settings.json ANTHROPIC_BASE_URL=${cur}` }
  }
  if (!fix) {
    return {
      ok: false,
      msg: `settings.json env.ANTHROPIC_BASE_URL is ${cur ? `"${cur}"` : 'unset'} (expected "${expectedUrl}" — run "node tools/setup.mjs doctor --fix" to set it)`,
    }
  }
  s.env = { ...(s.env || {}), ANTHROPIC_BASE_URL: expectedUrl }
  fs.writeFileSync(settingsPath, JSON.stringify(s, null, 2) + '\n')
  return { ok: true, msg: `Updated settings.json env.ANTHROPIC_BASE_URL=${expectedUrl}` }
}

function pingProvider(p) {
  return new Promise((resolve) => {
    const start = Date.now()
    const u = new URL(p.url)
    const lib = u.protocol === 'http:' ? http : https
    const payload = Buffer.from(JSON.stringify({
      model: L.wireModel(p.model),
      max_tokens: 1,
      messages: [{ role: 'user', content: 'hi' }],
    }))
    const headers = {
      'content-type': 'application/json',
      'anthropic-version': '2023-06-01',
      'content-length': payload.length,
    }
    if (p.authHeader === 'bearer' || p.authHeader === 'both') headers['authorization'] = `Bearer ${p.token}`
    if (p.authHeader === 'x-api-key' || p.authHeader === 'both') headers['x-api-key'] = p.token

    const req = lib.request({
      hostname: u.hostname,
      port: u.port || (u.protocol === 'http:' ? 80 : 443),
      path: L.upstreamPath(p.url, '/v1/messages'),
      method: 'POST',
      headers,
      timeout: 8000,
    }, (res) => {
      const ch = []
      res.on('data', (c) => ch.push(c))
      res.on('end', () => {
        const ms = Date.now() - start
        const ok = res.statusCode >= 200 && res.statusCode < 300
        resolve({ ok, status: res.statusCode, ms, body: Buffer.concat(ch).toString('utf8').slice(0, 160) })
      })
    })
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, status: 0, ms: Date.now() - start, body: 'timeout' }) })
    req.on('error', (e) => resolve({ ok: false, status: 0, ms: Date.now() - start, body: e.message }))
    req.end(payload)
  })
}

if (cmd === 'presets') {
  console.log('Built-in provider presets (use in model-relay.json or "node tools/setup.mjs add <name>"):')
  for (const [k, v] of Object.entries(L.PRESETS)) {
    console.log(`  - ${k.padEnd(10)} model=${v.model.padEnd(25)} url=${v.baseUrl}`)
  }
  process.exit(0)
}

if (cmd === 'init') {
  fs.mkdirSync(cfgDir, { recursive: true })
  const active = resolveActiveCfgPath()
  if (fs.existsSync(active)) {
    console.log(`Config already exists at: ${active}`)
  } else {
    fs.copyFileSync(examplePath, relayCfgPath)
    console.log(`Created ${relayCfgPath} from model-relay.example.json.`)
  }
  if (hasFlag('--fix')) {
    const w = ensureSettingsWiring(relayPort(), true)
    console.log(`  ${w.msg}`)
  }
  console.log('Set your API key environment variables (e.g. ZAI_API_KEY) or run "node tools/setup.mjs add <name> --token ..." before starting Claude Code.')
  process.exit(0)
}

if (cmd === 'add') {
  const name = (args[1] || '').trim().toLowerCase()
  const token = getOpt('--token')
  if (!name || name.startsWith('--') || !token) {
    console.error('Usage: node tools/setup.mjs add <name> --token <token|env:VAR> [--preset <p>] [--model <m>] [--url <u>]')
    process.exit(2)
  }
  fs.mkdirSync(cfgDir, { recursive: true })
  const active = resolveActiveCfgPath()
  let raw = { port: 8950, failover: { enabled: true, chain: [name], cooldownMs: 600000 }, providers: {} }
  if (fs.existsSync(active)) {
    try { raw = JSON.parse(fs.readFileSync(active, 'utf8')) } catch {}
  }
  raw.providers = raw.providers || {}
  const presetKey = (getOpt('--preset') || name).toLowerCase()
  const preset = L.PRESETS[presetKey] || {}
  raw.providers[name] = {
    ...(presetKey && L.PRESETS[presetKey] ? { preset: presetKey } : {}),
    baseUrl: getOpt('--url') || preset.baseUrl || 'https://api.example.com/anthropic',
    token,
    model: getOpt('--model') || preset.model || `${name}-default`,
  }
  writeFileAtomic(active, JSON.stringify(raw, null, 2) + '\n')
  console.log(`Saved provider "${name}" (${raw.providers[name].model}) in ${active}`)
  process.exit(0)
}

// ---------- editing the config: migrate / set / providers / remove ----------

const LF = String.fromCharCode(10)

function loadRaw() {
  const file = resolveActiveCfgPath()
  if (!fs.existsSync(file)) {
    console.error(`Missing config: ${file} (run "node tools/setup.mjs init" first)`)
    process.exit(1)
  }
  try {
    return { file, raw: JSON.parse(fs.readFileSync(file, 'utf8')) }
  } catch (e) {
    console.error(`Invalid JSON in ${file}: ${e.message}`)
    process.exit(1)
  }
}

// The config holds tokens, so a backup sits right next to it and is never printed
function saveRaw(file, raw, suffix) {
  fs.copyFileSync(file, `${file}.${suffix}`)
  writeFileAtomic(file, JSON.stringify(raw, null, 2) + LF)
}

// What the router would do with a config: two files with the same value behave the same
const effectiveOf = (raw) => JSON.stringify(L.parseCfg(raw), (k, v) => (v instanceof RegExp ? String(v) : v))

const isObj = (v) => typeof v === 'object' && v !== null && !Array.isArray(v)

if (cmd === 'migrate') {
  const { file, raw } = loadRaw()
  const { config, notes } = L.migrateConfig(raw)
  if (!notes.length) {
    console.log(`${file} already uses the current layout; nothing to do.`)
    process.exit(0)
  }
  if (effectiveOf(raw) !== effectiveOf(config)) {
    console.error('Refusing to migrate: the new layout would change what the router does. Please report this.')
    process.exit(1)
  }
  console.log(`${hasFlag('--go') ? 'Migrating' : 'Dry run — would migrate'} ${file} (the router behaves exactly the same afterwards):`)
  for (const n of notes) console.log(`  - ${n}`)
  if (!hasFlag('--go')) {
    console.log('Add --go to apply (a copy is kept as custom-agent.json.pre-migrate next to it; tokens are copied untouched).')
    process.exit(0)
  }
  saveRaw(file, config, 'pre-migrate')
  console.log(`✓ Done. Previous copy: ${file}.pre-migrate`)
  process.exit(0)
}

const bool = (v) => {
  if (['true', 'on', 'yes', '1'].includes(v)) return true
  if (['false', 'off', 'no', '0'].includes(v)) return false
  throw new Error('expected on or off')
}
const wholeNumber = (min) => (v) => {
  const m = /^(\d+)(ms|s|m)?$/.exec(v)
  if (!m) throw new Error('expected a number, optionally with ms, s or m (e.g. 30s)')
  const n = Number(m[1]) * (m[2] === 'm' ? 60000 : m[2] === 's' ? 1000 : 1)
  if (n < min) throw new Error(`must be at least ${min}ms`)
  return n
}
const count = (v) => {
  if (!/^\d+$/.test(v)) throw new Error('expected a whole number (0 = unlimited)')
  return Number(v)
}
const names = (v) => v.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)

// Every key "set" understands; the panel and the CLI go through this one table
const SETTABLE = {
  port: { parse: (v) => {
    if (!/^\d+$/.test(v) || !L.isPort(Number(v))) throw new Error('expected a port from 1025 to 65535')
    return Number(v)
  }, hint: '1025-65535 — the router\'s port; restart the router afterwards (settings.json is rewired for you)' },
  'failover.enabled': { parse: bool, hint: 'on|off — switch to the failover chain when Claude hits its usage limit' },
  'failover.chain': { parse: names, hint: 'a,b,c — who takes over, in order (provider names)' },
  'failover.cooldownMs': { parse: wholeNumber(60000), hint: 'how long to stay off Claude after a 429, e.g. 10m (minimum 1m)' },
  'retry.enabled': { parse: bool, hint: 'on|off — retry a failing provider before giving up' },
  'retry.failover': { parse: bool, hint: 'on|off — after retries run out, hand the request to the next provider' },
  'retry.attempts': { parse: count, hint: 'retries per provider (0 = until it answers)' },
  'retry.delayMs': { parse: wholeNumber(0), hint: 'first wait between retries, e.g. 2s' },
  'retry.maxDelayMs': { parse: wholeNumber(0), hint: 'longest single wait, e.g. 30s' },
}
const PROVIDER_KEYS = {
  fallback: { parse: (v) => (v === 'none' ? false : v === 'default' ? undefined : names(v)), hint: 'none | default | a,b — who takes over from this provider' },
  retry: { parse: (v) => (v === 'off' ? false : v === 'default' ? undefined : bool(v)), hint: 'off | default — retry this provider (default follows the global switch)' },
  matchModels: {
    parse: (v) => {
      if (v === 'default') return undefined
      const list = v.split(',').map((s) => s.trim()).filter(Boolean)
      if (!list.length) throw new Error('give at least one regex pattern (or "default")')
      for (const pat of list) new RegExp(pat, 'i')
      return list
    },
    hint: 'default | ^glm,haiku — regexes matched against the request model',
  },
}

const ALIAS_ENV_KEYS = {
  haiku: 'ANTHROPIC_DEFAULT_HAIKU_MODEL',
  sonnet: 'ANTHROPIC_DEFAULT_SONNET_MODEL',
  opus: 'ANTHROPIC_DEFAULT_OPUS_MODEL',
}

function effectiveMatchersFor(key, pv) {
  if (Array.isArray(pv.matchModels) && pv.matchModels.length > 0) {
    return pv.matchModels.filter((m) => typeof m === 'string' && m.length > 0)
  }
  const presetKey = (typeof pv.preset === 'string' && pv.preset ? pv.preset : key).toLowerCase()
  const preset = L.PRESETS[presetKey]
  if (preset && Array.isArray(preset.matchModels)) return [...preset.matchModels]
  const model = typeof pv.model === 'string' && pv.model ? pv.model : `${key}-default`
  const prefix = L.wireModel(model).split(/[-_.:/]/)[0] || key
  return [`^${prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`]
}

function matchesSlot(pattern, slot) {
  try {
    const re = new RegExp(pattern, 'i')
    return re.test(L.ALIAS_SLOTS[slot]) || re.test(slot)
  } catch {
    return false
  }
}

if (cmd === 'alias') {
  const slot = (args[1] || '').trim().toLowerCase()
  const target = (args[2] || '').trim().toLowerCase()
  const { file, raw } = loadRaw()
  const { config } = L.migrateConfig(raw)
  const cfg = L.parseCfg(raw)
  let settings = {}
  try { settings = readSettings() } catch {}
  const env = settings?.env || {}

  if (!slot || slot === 'status' || slot === 'list') {
    const routed = cfg ? L.detectAliases(cfg) : {}
    console.log('Claude Code model aliases (settings.json env + model-relay matchModels):')
    for (const [s, envKey] of Object.entries(ALIAS_ENV_KEYS)) {
      const pName = routed[s]
      const pModel = pName && cfg?.providers?.[pName] ? cfg.providers[pName].model : null
      const envVal = env[envKey]
      const routeText = pName ? `${pName} (${pModel})` : 'claude (Anthropic default)'
      const envText = envVal ? `${envKey}="${envVal}"` : `${envKey} unset`
      console.log(`  - ${s.padEnd(8)} → ${routeText.padEnd(28)} [${envText}]`)
    }
    const subModel = env.CLAUDE_CODE_SUBAGENT_MODEL || 'unset (Claude Code default)'
    console.log(`  - subagent → CLAUDE_CODE_SUBAGENT_MODEL=${subModel}`)
    console.log('\nCommands:')
    console.log('  node tools/setup.mjs alias <haiku|sonnet|opus> <provider|claude>   point an alias at a provider (or back to Claude)')
    console.log('  node tools/setup.mjs alias subagent <haiku|sonnet|opus|default>    set default subagent model tier in settings.json')
    process.exit(0)
  }

  if (slot === 'subagent') {
    if (!['haiku', 'sonnet', 'opus', 'default', 'off', 'unset'].includes(target)) {
      console.error('Usage: node tools/setup.mjs alias subagent <haiku|sonnet|opus|default>')
      process.exit(2)
    }
    const nextEnv = { ...env }
    const clear = ['default', 'off', 'unset'].includes(target)
    if (clear) delete nextEnv.CLAUDE_CODE_SUBAGENT_MODEL
    else nextEnv.CLAUDE_CODE_SUBAGENT_MODEL = target
    writeSettings({ ...settings, env: nextEnv })
    console.log(`✓ settings.json env.CLAUDE_CODE_SUBAGENT_MODEL: ${clear ? 'unset (Claude Code default)' : `"${target}"`} (applies to new Claude Code sessions)`)
    process.exit(0)
  }

  if (!ALIAS_ENV_KEYS[slot] || !target) {
    console.error('Usage: node tools/setup.mjs alias <haiku|sonnet|opus> <provider|claude>')
    process.exit(2)
  }

  const resetToClaude = ['claude', 'off', 'default', 'reset', 'none'].includes(target)
  const have = Object.keys(config.providers).map((k) => k.trim().toLowerCase())
  if (!resetToClaude && !have.includes(target)) {
    console.error(`Unknown provider "${target}" (have: ${have.join(', ')}, or "claude" to reset)`)
    process.exit(2)
  }

  // 1. Update matchModels across providers in model-relay.json / custom-agent.json
  for (const [k, pv] of Object.entries(config.providers)) {
    const key = k.trim().toLowerCase()
    const current = effectiveMatchersFor(key, pv)
    const withoutSlot = current.filter((pat) => !matchesSlot(pat, slot))
    if (!resetToClaude && key === target) {
      const nextMatchers = [...withoutSlot, slot]
      config.providers[k] = { ...pv, matchModels: nextMatchers }
    } else if (withoutSlot.length !== current.length) {
      config.providers[k] = { ...pv, matchModels: withoutSlot.length ? withoutSlot : [`^${key}`] }
    }
  }
  saveRaw(file, config, 'relay-backup')

  // 2. Sync ANTHROPIC_DEFAULT_<SLOT>_MODEL in settings.json so Claude Code itself resolves the alias & [1m] window
  const envKey = ALIAS_ENV_KEYS[slot]
  const nextEnv = { ...env }
  let targetModel = null
  if (resetToClaude) {
    delete nextEnv[envKey]
  } else {
    const pKey = Object.keys(config.providers).find((k) => k.trim().toLowerCase() === target)
    const pv = config.providers[pKey]
    const preset = L.PRESETS[(pv.preset || target).toLowerCase()]
    targetModel = pv.model || preset?.model || `${target}-default`
    nextEnv[envKey] = targetModel
  }
  writeSettings({ ...settings, env: nextEnv })

  if (resetToClaude) {
    console.log(`✓ alias ${slot} → claude (Anthropic default)`)
    console.log(`  - ${path.basename(file)}: removed "${slot}" from provider matchModels (live immediately)`)
    console.log(`  - settings.json: removed env.${envKey} (new Claude Code sessions use Anthropic ${slot})`)
  } else {
    console.log(`✓ alias ${slot} → ${target} (${targetModel})`)
    console.log(`  - ${path.basename(file)}: providers.${target}.matchModels includes "${slot}" (live on the router's next request)`)
    console.log(`  - settings.json: env.${envKey}="${targetModel}" (new Claude Code sessions resolve ${slot} to ${targetModel})`)
  }
  process.exit(0)
}

if (cmd === 'set') {
  const key = args[1]
  const value = args.slice(2).filter((a) => !a.startsWith('--')).join(' ').trim()
  const pk = /^providers\.([^.]+)\.(fallback|retry|matchModels)$/.exec(key || '')
  const spec = pk ? PROVIDER_KEYS[pk[2]] : SETTABLE[key]
  if (key === 'proxy.enabled') {
    console.error('proxy.enabled also rewires settings.json; use: node tools/setup.mjs proxy enable|disable --go')
    process.exit(2)
  }
  if (!spec || !value) {
    console.error('Usage: node tools/setup.mjs set <key> <value>')
    for (const [k, v] of Object.entries(SETTABLE)) console.error(`  ${k.padEnd(22)} ${v.hint}`)
    for (const [k, v] of Object.entries(PROVIDER_KEYS)) console.error(`  providers.<name>.${k.padEnd(8)} ${v.hint}`)
    process.exit(2)
  }
  const loaded = loadRaw()
  const { config, notes } = L.migrateConfig(loaded.raw)
  const have = Object.keys(config.providers).map((k) => k.trim().toLowerCase())
  let next
  try {
    next = spec.parse(value)
    if (key === 'failover.chain') {
      const unknown = next.filter((n) => !have.includes(n))
      if (!next.length || unknown.length) throw new Error(unknown.length ? `unknown provider ${unknown.join(', ')} (have: ${have.join(', ')})` : 'give at least one provider name')
    }
    if (Array.isArray(next) && pk && pk[2] === 'fallback') {
      const unknown = next.filter((n) => !have.includes(n))
      if (unknown.length) throw new Error(`unknown provider ${unknown.join(', ')} (have: ${have.join(', ')})`)
    }
    if (pk && !have.includes(pk[1].toLowerCase())) throw new Error(`no provider named ${pk[1]} (have: ${have.join(', ')})`)
  } catch (e) {
    console.error(`${key}: ${e.message}`)
    process.exit(2)
  }
  let holder, field, before
  if (pk) {
    const name = Object.keys(config.providers).find((k) => k.trim().toLowerCase() === pk[1].toLowerCase())
    holder = config.providers[name] = { ...config.providers[name] }
    field = pk[2]
  } else if (key === 'port') {
    holder = config
    field = 'port'
  } else {
    const [section, f] = key.split('.')
    holder = config[section] = isObj(config[section]) ? { ...config[section] } : {}
    field = f
  }
  before = holder[field]
  if (next === undefined) delete holder[field]
  else holder[field] = next
  if (JSON.stringify(before) === JSON.stringify(next) && !notes.length) {
    console.log(`${key} is already ${JSON.stringify(next)}`)
    process.exit(0)
  }
  const oldPort = relayPort()
  if (key === 'port' && next !== oldPort) {
    // Never move onto a port something already answers on: the hook would start a router that cannot bind it
    const h = await fetchHealth(next)
    if (h || (await portOpen(next))) {
      console.error(`port: ${next} is already in use (${h ? `a model-relay router${h.configDir ? ` for config dir ${h.configDir}` : ''}, pid ${h.pid}` : 'another process'}); nothing was changed. Pick another port.`)
      process.exit(1)
    }
  }
  saveRaw(loaded.file, config, 'relay-backup')
  if (notes.length) console.log(`(also moved the config to the current layout: ${notes.length} change${notes.length > 1 ? 's' : ''})`)
  if (key === 'port') {
    console.log(`✓ port: ${oldPort} → ${next}. The running router keeps port ${oldPort} until it is stopped; the router started after that uses ${next}.`)
    // Point Claude Code at the new port the way doctor --fix would, keeping the mode it was in
    let s = null
    let bad = null
    try {
      s = readSettings()
    } catch (e) {
      bad = e.message
    }
    const mode = s ? wiringMode(s, oldPort) : 'none'
    if (bad) console.log(`  settings.json is not valid JSON (${bad}); fix it, then run "node tools/setup.mjs doctor --fix" to wire it to ${next}`)
    else if (mode === 'none') console.log(`  settings.json does not point at the relay on ${oldPort}; run "node tools/setup.mjs doctor --fix" to wire it to ${next}`)
    else {
      const url = `http://127.0.0.1:${next}`
      s.env = { ...s.env, ...(mode === 'proxy' ? { HTTPS_PROXY: url } : { ANTHROPIC_BASE_URL: url }) }
      const backup = writeSettings(s)
      console.log(`  settings.json updated: ${mode === 'proxy' ? 'HTTPS_PROXY' : 'ANTHROPIC_BASE_URL'}=${url}${backup ? ` (previous copy: ${backup})` : ''}; new Claude Code sessions use it`)
    }
    // Not killed for you: the plugin hook starts a second router on the new port, so the old one should be stopped by hand
    const old = await fetchHealth(oldPort)
    if (old && old.pid && !foreignRouter(old, oldPort)) console.log(`  The router still on port ${oldPort} is pid ${old.pid}; stop it with "kill ${old.pid}" (a new one starts on ${next} with your next Claude Code session).`)
    process.exit(0)
  }
  console.log(`✓ ${key}: ${before === undefined ? 'default' : JSON.stringify(before)} → ${next === undefined ? 'default' : JSON.stringify(next)} (the router reads this on its next request; no restart)`)
  process.exit(0)
}

if (cmd === 'providers') {
  const { raw } = loadRaw()
  const { config } = L.migrateConfig(raw)
  const cfg = L.parseCfg(raw)
  const live = cfg ? cfg.providers : {}
  const routed = cfg ? L.detectAliases(cfg) : {}
  const aliasPairs = Object.entries(routed).map(([s, p]) => `${s} → ${p} (${live[p]?.model || p})`)
  console.log(`Failover: ${cfg && cfg.failoverEnabled ? `on, chain ${cfg.failoverChain.join(' → ')}, back to Claude after ${cfg.cooldownMs / 60000} min` : 'off'}    Retry: ${cfg && cfg.retry.enabled ? 'on' : 'off'}`)
  console.log(`Aliases:  ${aliasPairs.length ? aliasPairs.join(', ') : 'none (all Claude tiers go to Anthropic unless session is pinned)'}`)
  for (const [k, v] of Object.entries(config.providers)) {
    const key = k.trim().toLowerCase()
    const p = live[key]
    const tokenSrc = typeof v.token === 'string' && v.token.startsWith('env:') ? v.token : 'inline'
    if (!p) {
      console.log(`  ✗ ${key}: not usable (token ${tokenSrc} did not resolve, or incomplete)`)
      continue
    }
    const retryDesc = p.retryCfg
      ? `on (${p.retryCfg.attempts === 0 ? 'unlimited' : `${p.retryCfg.attempts}x`}, max ${Math.round(p.retryCfg.maxDelayMs / 1000)}s)`
      : 'off'
    const to = !p.retryCfg || !p.retryCfg.failover || !cfg.failoverEnabled
      ? (p.fallback === null ? 'nobody' : 'off (retry.failover is off)')
      : p.fallback === null
        ? 'nobody'
        : Array.isArray(p.fallback)
          ? p.fallback.join(' → ')
          : `the chain (${cfg.failoverChain.join(' → ')})`
    console.log(`  ● ${key.padEnd(10)} ${p.model}  ${p.url}`)
    console.log(`    routes: ${p.matchRegexes.map((r) => r.source).join(' | ') || '(only its own model name)'}   token: ${tokenSrc}   retry: ${retryDesc}   hands over to: ${to}`)
  }
  process.exit(0)
}

if (cmd === 'remove') {
  const name = (args[1] || '').trim().toLowerCase()
  if (!name || name.startsWith('--')) {
    console.error('Usage: node tools/setup.mjs remove <name> [--go]')
    process.exit(2)
  }
  const { file, raw } = loadRaw()
  const { config } = L.migrateConfig(raw)
  const key = Object.keys(config.providers).find((k) => k.trim().toLowerCase() === name)
  if (!key) {
    console.error(`No provider named ${name} (have: ${Object.keys(config.providers).join(', ')})`)
    process.exit(2)
  }
  const next = { ...config, providers: { ...config.providers } }
  delete next.providers[key]
  if (!Object.keys(next.providers).length) {
    console.error('That is the only provider; refusing to leave the relay with none.')
    process.exit(1)
  }
  const touched = []
  const chain = (next.failover.chain || []).filter((n) => n !== name)
  if (chain.length !== (next.failover.chain || []).length) touched.push('removed from failover.chain')
  next.failover = { ...next.failover, chain }
  for (const [k, v] of Object.entries(next.providers)) {
    if (Array.isArray(v.fallback) && v.fallback.map((n) => String(n).toLowerCase()).includes(name)) {
      next.providers[k] = { ...v, fallback: v.fallback.filter((n) => String(n).toLowerCase() !== name) }
      touched.push(`removed from ${k}.fallback`)
    }
  }
  console.log(`${hasFlag('--go') ? 'Removing' : 'Dry run — would remove'} provider ${name}${touched.length ? ` (${touched.join('; ')})` : ''}`)
  if (!hasFlag('--go')) {
    console.log('Add --go to apply (the previous file is kept as .relay-backup).')
    process.exit(0)
  }
  saveRaw(file, next, 'relay-backup')
  console.log(`✓ Done. Previous copy: ${file}.relay-backup`)
  process.exit(0)
}

// ---------- HTTPS proxy mode (Remote Control) ----------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// Does anything accept connections on this port?
function portOpen(port) {
  return new Promise((resolve) => {
    const sock = net.connect({ host: '127.0.0.1', port, timeout: 1000 })
    sock.on('connect', () => (sock.destroy(), resolve(true)))
    sock.on('error', () => resolve(false))
    sock.on('timeout', () => (sock.destroy(), resolve(false)))
  })
}

function relayPort() {
  try {
    const raw = JSON.parse(fs.readFileSync(resolveActiveCfgPath(), 'utf8'))
    // parseCfg gives up on a config whose env tokens are not set yet (a fresh install), but the port is still the file's
    return L.parseCfg(raw)?.port ?? (L.isPort(raw.port) ? raw.port : 8950)
  } catch {
    return 8950
  }
}

function fetchHealth(port) {
  return new Promise((resolve) => {
    const req = http.get(`http://127.0.0.1:${port}/__health`, { timeout: 2000 }, (res) => {
      const ch = []
      res.on('data', (c) => ch.push(c))
      res.on('end', () => {
        try {
          resolve(JSON.parse(Buffer.concat(ch).toString('utf8')))
        } catch {
          resolve(null)
        }
      })
    })
    req.on('error', () => resolve(null))
    req.on('timeout', () => {
      req.destroy()
      resolve(null)
    })
  })
}

// A router that answers on our port but was started for another config directory (or by an older version that does
// not say) uses a different config, PKI and tokens; returns a sentence about it, or null when it is ours
function foreignRouter(h, port) {
  if (!h || !h.configDir || L.sameDir(h.configDir, cfgDir)) return null
  return `the router answering on 127.0.0.1:${port} (pid ${h.pid}) belongs to config dir ${h.configDir}, not to ${cfgDir}; it uses that directory's config and certificates. Stop it or give one of them another port ("node tools/setup.mjs set port <n>").`
}
// An older router does not report its config dir; it is most likely ours, so it is restarted, not refused
const olderRouter = (h) => Boolean(h && h.pid && !h.configDir)
const olderNote = (port) => `an older model-relay router (no configDir) answers on 127.0.0.1:${port}; restart it to pick up this version`

// Starts the router when it is down and waits until it answers
async function ensureRouter(port) {
  if (await fetchHealth(port)) return true
  const child = spawn(process.execPath, [path.join(root, 'router', 'router.js'), cfgDir], { detached: true, stdio: 'ignore', windowsHide: true })
  child.unref()
  for (let i = 0; i < 50; i++) {
    await sleep(200)
    if (await fetchHealth(port)) return true
  }
  return false
}

// Does the router, used as an HTTPS proxy, answer for api.anthropic.com with a certificate that the CA file vouches for?
function probeProxy(port, caPath) {
  return new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port, method: 'CONNECT', path: `${L.PROXY_MITM_HOST}:443`, timeout: 4000 })
    req.on('connect', (res, socket) => {
      if (res.statusCode !== 200) {
        socket.destroy()
        return resolve({ ok: false, why: `the router answered CONNECT with ${res.statusCode}` })
      }
      const secure = tls.connect({ socket, servername: L.PROXY_MITM_HOST, ca: fs.readFileSync(caPath) }, () => {
        secure.destroy()
        resolve({ ok: true })
      })
      secure.on('error', (e) => resolve({ ok: false, why: e.message }))
    })
    req.on('error', (e) => resolve({ ok: false, why: e.message }))
    req.on('timeout', () => {
      req.destroy()
      resolve({ ok: false, why: 'timed out' })
    })
    req.end()
  })
}

// The router only accepts proxy connections while the relay config says so (see parseProxyCfg); returns the previous value
function setProxyEnabled(on) {
  const file = resolveActiveCfgPath()
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
  const before = Boolean(raw.proxy && typeof raw.proxy === 'object' && raw.proxy.enabled === true)
  raw.proxy = { ...(raw.proxy && typeof raw.proxy === 'object' ? raw.proxy : {}), enabled: on }
  writeFileAtomic(file, JSON.stringify(raw, null, 2) + String.fromCharCode(10))
  return before
}

const fwd = (p) => p.replace(/\\/g, '/')
const day = (ms) => (ms ? new Date(ms).toISOString().slice(0, 10) : 'n/a')

if (cmd === 'proxy') {
  const sub = args[1] || 'status'
  const port = relayPort()
  const url = `http://127.0.0.1:${port}`
  const go = hasFlag('--go')
  const pki = PKI.paths(cfgDir)
  const ca = fwd(pki.ca)
  let settings
  try {
    settings = readSettings()
  } catch (e) {
    console.error(`Invalid JSON in ${settingsPath}: ${e.message}`)
    process.exit(1)
  }
  const mode = wiringMode(settings, port)

  if (sub === 'status') {
    const st = PKI.status(cfgDir)
    const h = await fetchHealth(port)
    const foreign = foreignRouter(h, port)
    if (foreign) console.log(`⚠ ${foreign}`)
    else if (olderRouter(h)) console.log(`⚠ ${olderNote(port)}`)
    console.log(`Claude Code is wired to the relay as: ${mode === 'proxy' ? 'HTTPS proxy (Remote Control works)' : mode === 'base-url' ? 'API address (ANTHROPIC_BASE_URL; Remote Control refuses to start)' : 'nothing (run "doctor --fix" or "proxy enable --go")'}`)
    console.log(`Certificate: ${st.complete ? `leaf valid until ${day(st.leafExpires)}${st.renewDue ? ' — renewal due, run "proxy renew --go"' : ''}` : 'not created yet (created by "proxy enable --go")'}`)
    console.log(`Router: ${h ? `up on ${port}, ${h.proxy ? `proxy ${h.proxy.enabled ? 'on' : 'off'}, ${h.proxy.mitm} routed / ${h.proxy.tunnel} tunnelled connections since start` : 'running OLD code without proxy support — restart it ("proxy enable --go" does that)'}` : `offline on ${port}`}`)
    if (h && h.proxy && st.complete) {
      const r = await probeProxy(port, pki.ca)
      console.log(`Self-test (CONNECT ${L.PROXY_MITM_HOST}, trusting only the relay CA): ${r.ok ? '✓ ok' : `✗ ${r.why}`}`)
    }
    process.exit(0)
  }

  if (sub === 'enable' || sub === 'renew') {
    const env = { ...(settings.env || {}) }
    if (env.HTTPS_PROXY && env.HTTPS_PROXY !== url) {
      console.error(`settings.json already sets HTTPS_PROXY=${env.HTTPS_PROXY}; chaining proxies is not supported. Remove it first.`)
      process.exit(1)
    }
    if (env.ANTHROPIC_BASE_URL && env.ANTHROPIC_BASE_URL !== url) {
      console.error(`settings.json sets ANTHROPIC_BASE_URL=${env.ANTHROPIC_BASE_URL}, which is not this relay; refusing to remove it.`)
      process.exit(1)
    }
    const foreign = foreignRouter(await fetchHealth(port), port)
    if (foreign) {
      console.error(`Refusing to ${sub}: ${foreign} Nothing was changed.`)
      process.exit(1)
    }
    const noProxy = [...new Set([...(env.NO_PROXY || '').split(',').map((s) => s.trim()).filter(Boolean), ...NO_PROXY_LOCAL.split(',')])].join(',')
    const next = { ...settings, env: { ...env, HTTPS_PROXY: url, NODE_EXTRA_CA_CERTS: ca, NO_PROXY: noProxy } }
    delete next.env.ANTHROPIC_BASE_URL
    const st = PKI.status(cfgDir)
    console.log(`${go ? 'Applying' : 'Dry run — would apply'}: ${sub === 'renew' ? 'new certificate, ' : ''}Claude Code uses ${url} as its HTTPS proxy and keeps api.anthropic.com as its API address.`)
    console.log(`  settings.json env: set HTTPS_PROXY, NODE_EXTRA_CA_CERTS=${ca}, NO_PROXY=${noProxy}; remove ANTHROPIC_BASE_URL`)
    console.log(`  ${path.basename(resolveActiveCfgPath())}: set proxy.enabled to true (the router refuses proxy connections otherwise)`)
    console.log(`  certificate: ${sub === 'renew' || !st.complete || st.renewDue ? 'a new CA (limited to api.anthropic.com) and leaf are created' : `kept (valid until ${day(st.leafExpires)})`}`)
    console.log('  effect: new Claude Code sessions use the proxy; running sessions keep their current setting until restarted')
    console.log('  undo:   node tools/setup.mjs proxy disable --go')
    if (!go) {
      console.log('Add --go to apply.')
      process.exit(0)
    }
    const issued = PKI.ensure(cfgDir, { hosts: [L.PROXY_MITM_HOST], force: sub === 'renew' })
    const wasEnabled = setProxyEnabled(true)
    let h = await fetchHealth(port)
    if (h && !h.proxy && h.pid) {
      console.log(`Restarting the router (pid ${h.pid}) so it runs the proxy code; requests in flight are retried by Claude Code.`)
      try {
        process.kill(h.pid)
      } catch {}
      for (let i = 0; i < 25 && (await fetchHealth(port)); i++) await sleep(200)
    }
    if (!(await ensureRouter(port))) {
      console.error('The router did not start; settings.json was NOT changed.')
      if (!wasEnabled) setProxyEnabled(false)
      process.exit(1)
    }
    const probe = await probeProxy(port, issued.ca)
    if (!probe.ok) {
      console.error(`Self-test failed (${probe.why}); settings.json was NOT changed.`)
      if (!wasEnabled) setProxyEnabled(false)
      process.exit(1)
    }
    const backup = writeSettings(next)
    console.log(`✓ settings.json updated${backup ? ` (previous copy: ${backup})` : ''}; certificate valid until ${day(issued.leafExpires)}.`)
    console.log('Start a new Claude Code session, then use /remote-control, or run: node tools/setup.mjs rc')
    process.exit(0)
  }

  if (sub === 'disable') {
    const env = { ...(settings.env || {}) }
    const next = { ...settings, env }
    if (env.HTTPS_PROXY === url) delete env.HTTPS_PROXY
    if (env.NODE_EXTRA_CA_CERTS === ca) delete env.NODE_EXTRA_CA_CERTS
    if (env.NO_PROXY === NO_PROXY_LOCAL) delete env.NO_PROXY
    env.ANTHROPIC_BASE_URL = url
    console.log(`${go ? 'Applying' : 'Dry run — would apply'}: Claude Code uses ${url} as its API address again (Remote Control will refuse to start) and the router stops accepting proxy connections.`)
    console.log('  sessions already running in proxy mode lose their connection until restarted')
    if (!go) {
      console.log('Add --go to apply.')
      process.exit(0)
    }
    const backup = writeSettings(next)
    setProxyEnabled(false)
    console.log(`✓ settings.json updated${backup ? ` (previous copy: ${backup})` : ''}. The certificate files are kept in ${pki.dir}.`)
    process.exit(0)
  }

  console.error('Usage: node tools/setup.mjs proxy [status|enable|disable|renew] [--go]')
  process.exit(2)
}

if (cmd === 'rc') {
  const port = relayPort()
  let mode = 'none'
  try {
    mode = wiringMode(readSettings(), port)
  } catch {}
  if (mode !== 'proxy') {
    console.error('Remote Control needs the HTTPS proxy wiring. Run: node tools/setup.mjs proxy enable --go')
    process.exit(1)
  }
  if (!(await ensureRouter(port))) {
    console.error(`The router could not be started on 127.0.0.1:${port}; check ${path.join(cfgDir, 'custom-agent-router.log')}`)
    process.exit(1)
  }
  const child = spawn(process.env.CLAUDE_CODE_EXECPATH || 'claude', ['remote-control', ...args.slice(1)], { stdio: 'inherit' })
  child.on('error', (e) => {
    console.error(`Could not start claude: ${e.message}`)
    process.exit(1)
  })
  child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)))
} else if (cmd === 'proxy') {
  // handled above
} else if (cmd === 'check' || cmd === 'doctor') {
  const active = resolveActiveCfgPath()
  if (!fs.existsSync(active)) {
    console.error(`Missing config: ${active} (run "node tools/setup.mjs init" first)`)
    process.exit(1)
  }
  let raw
  try {
    raw = JSON.parse(fs.readFileSync(active, 'utf8'))
  } catch (e) {
    console.error(`Invalid JSON in ${active}: ${e.message}`)
    process.exit(1)
  }

  const skippedEnv = L.unresolvedEnv(raw, process.env).map((u) => `${u.provider} (${u.env ? `${u.env} is unset` : 'token "env:" names no variable'})`)

  const cfg = L.parseCfg(raw)
  if (!cfg) {
    console.error(`Config validation failed in ${active}. Ensure at least one provider has a resolved token (or set ${skippedEnv.join(', ')}).`)
    process.exit(1)
  }
  const names = Object.keys(cfg.providers)
  console.log(`Config OK (${active})`)
  console.log(`  Port: ${cfg.port}`)
  console.log(`  Providers: ${names.map((k) => `${k} -> ${cfg.providers[k].model}`).join(', ')}`)
  if (skippedEnv.length > 0) {
    console.log(`  Skipped (unset env var): ${skippedEnv.join(', ')}`)
  }
  console.log(`  Failover: ${cfg.failoverEnabled ? `${cfg.failoverChain.join(' → ')} (back to Claude after ${cfg.cooldownMs / 60000} min)` : 'disabled'}    Retry: ${cfg.retry.enabled ? 'on' : 'off'}`)

  let curSettings = {}
  try { curSettings = readSettings() } catch {}
  const curEnv = curSettings?.env || {}
  const routedAliases = L.detectAliases(cfg)
  const aliasDesc = []
  for (const [slot, envKey] of Object.entries(ALIAS_ENV_KEYS)) {
    const p = routedAliases[slot]
    const envVal = curEnv[envKey]
    if (p || envVal) {
      aliasDesc.push(`${slot} -> ${p ? `${p} (${cfg.providers[p]?.model})` : 'claude'}${envVal ? ` [${envKey}=${envVal}]` : ''}`)
    }
  }
  if (curEnv.CLAUDE_CODE_SUBAGENT_MODEL) aliasDesc.push(`subagent default -> ${curEnv.CLAUDE_CODE_SUBAGENT_MODEL}`)
  console.log(`  Aliases:  ${aliasDesc.length ? aliasDesc.join(', ') : 'none (run "node tools/setup.mjs alias haiku <provider>" to route haiku)'}`)

  // Things that work but are probably not what was meant
  const migration = L.migrateConfig(raw)
  const lint = []
  if (migration.notes.length) lint.push(`old config layout (${migration.notes.length} item${migration.notes.length > 1 ? 's' : ''}); run "node tools/setup.mjs migrate --go" to tidy it, behaviour stays the same`)
  const wanted = [...(migration.config.failover.chain || [])]
  for (const v of Object.values(migration.config.providers)) if (Array.isArray(v.fallback)) wanted.push(...v.fallback)
  const unknown = [...new Set(wanted.map((n) => String(n).trim().toLowerCase()).filter((n) => n && !names.includes(n)))]
  if (unknown.length) lint.push(`failover names ${unknown.join(', ')} but no such usable provider exists; they are skipped`)
  for (const [k, p] of Object.entries(cfg.providers)) {
    const taker = L.matchProviderByModel(cfg, p.model)
    if (taker && taker !== k) lint.push(`requests for ${p.model} go to ${taker}, not ${k}: ${taker} matches that name first (narrow its matchModels)`)
  }
  for (const [slot, envKey] of Object.entries(ALIAS_ENV_KEYS)) {
    const envVal = curEnv[envKey]
    if (envVal && !L.isClaudeModel(envVal) && !L.matchProviderByModel(cfg, envVal)) {
      lint.push(`settings.json ${envKey}="${envVal}" does not match any provider's matchModels; requests for it will go to Claude`)
    }
  }
  // Claude Code drops a subagent model missing from availableModels (a warning in its debug log only) and runs
  // CLAUDE_CODE_SUBAGENT_MODEL or the parent's model instead, so model-relay:<name> agents never reach the relay.
  // Observed on Claude Code 2.1.300 with an exact entry for a non-Claude id. Claude-named models are skipped: aliases
  // and families may admit them, which this exact match cannot tell. Only the user settings.json is read here;
  // project, local and managed settings can set availableModels too.
  if (Array.isArray(curSettings?.availableModels)) {
    const allowed = new Set(curSettings.availableModels.map((m) => String(m).toLowerCase()))
    const blocked = [...new Set(Object.values(cfg.providers).map((p) => p.model))]
      .filter((m) => !L.isClaudeModel(m) && !/claude/i.test(m) && !allowed.has(m.toLowerCase()))
    if (blocked.length) lint.push(`${settingsPath} availableModels does not list ${blocked.join(', ')}; Claude Code runs model-relay:<name> subagents on another model (CLAUDE_CODE_SUBAGENT_MODEL or the parent's) instead. Add each exactly as written here`)
  }
  for (const w of lint) console.log(`  ⚠ ${w}`)

  const wiring = ensureSettingsWiring(cfg.port, hasFlag('--fix'))
  console.log(`  Claude settings: ${wiring.ok ? '✓' : '⚠'} ${wiring.msg}`)

  await new Promise((resolve) => {
    const req = http.get(`http://127.0.0.1:${cfg.port}/__health`, { timeout: 2000 }, (res) => {
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => {
        const rawHealth = Buffer.concat(chunks).toString('utf8').trim()
        try {
          const h = JSON.parse(rawHealth)
          const foreign = foreignRouter(h, cfg.port)
          if (foreign) console.log(`  Router health: ⚠ ${foreign}`)
          else {
            if (olderRouter(h)) console.log(`  Router health: ⚠ ${olderNote(cfg.port)}`)
          const foState = h.failoverSince ? `active since ${new Date(h.failoverSince).toISOString().slice(11, 19)}Z` : 'idle'
          const pxState = h.proxy ? `proxy ${h.proxy.enabled ? 'on' : 'off'} (${h.proxy.mitm} routed / ${h.proxy.tunnel} tunnelled)` : 'no proxy'
          console.log(`  Router health: ✓ up on 127.0.0.1:${cfg.port} (pid ${h.pid}, pinned sessions: ${h.sessionsOnCustom ?? 0}, 429 failover: ${foState}, ${pxState})`)
          // the router resolves env:VAR from the environment it was started with, which may differ from this shell's
          for (const u of Array.isArray(h.unresolved) ? h.unresolved : []) {
            console.log(process.env[u.env]
              ? `  ⚠ The running router was started without ${u.env}, so provider ${u.provider} is skipped there although this shell has it. Stop the router (kill ${h.pid}) and start Claude Code from this shell so the new router inherits it`
              : `  ⚠ Provider ${u.provider} is skipped by the running router: ${u.env ? `${u.env} is unset here too` : 'its token "env:" names no variable'}`)
          }
          }
        } catch {
          console.log(`  Router health: ${rawHealth}`)
        }
        resolve()
      })
    })
    req.on('error', () => {
      console.log(`  Router status: offline on 127.0.0.1:${cfg.port} (will auto-start when Claude Code launches)`)
      resolve()
    })
    req.end()
  })

  if (hasFlag('--ping')) {
    console.log('  Upstream ping:')
    for (const [k, p] of Object.entries(cfg.providers)) {
      const r = await pingProvider(p)
      console.log(`    ${r.ok ? '✓' : '✗'} ${k.padEnd(10)} (${p.model}) -> HTTP ${r.status} in ${r.ms}ms${r.ok ? '' : ` [${r.body}]`}`)
    }
  }
} else {
  console.error('Usage: node tools/setup.mjs [init|presets|add|providers|alias|set|remove|migrate|doctor|check|proxy|rc] [--fix] [--ping] [--go]')
  process.exit(2)
}
