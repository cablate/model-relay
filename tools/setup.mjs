#!/usr/bin/env node
// Setup, preset management, and doctor CLI for model-relay.
// Usage:
//   node tools/setup.mjs init [--fix]                                   an empty config (and, with --fix, the settings.json wiring)
//   node tools/setup.mjs presets
//   node tools/setup.mjs add <name> --model <m> --token <token|env:VAR> (--preset <p> | --url <u>)
//   node tools/setup.mjs providers                                    list providers, routes, aliases, failover and retry
//   node tools/setup.mjs alias [haiku|sonnet|opus|subagent] [target]  inspect or point a Claude model alias at a provider (or back to claude)
//   node tools/setup.mjs set <key> <value>                            failover.enabled|chain|cooldownMs, retry.enabled|failover|..., providers.<name>.fallback|retry|matchModels
//   node tools/setup.mjs remove <name> [--go]
//   node tools/setup.mjs migrate [--go]                               bring an older config to format 2 (same behaviour, tokens untouched)
//   node tools/setup.mjs doctor [--fix] [--ping] [--json]   (alias: check)
//   node tools/setup.mjs restart [--if-stale] [--if-idle]             run the router shipped with this copy of the tool
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
const P = require('../router/ping.js')
const M = require('../router/migrate.js')

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const home = process.env.USERPROFILE || process.env.HOME || ''
const cfgDir = process.env.CLAUDE_CONFIG_DIR || path.join(home, '.claude')
const relayCfgPath = path.join(cfgDir, 'model-relay.json')
const settingsPath = path.join(cfgDir, 'settings.json')
const BACKUP = 'model-relay-backup'
// an older config under its older name: never read, only pointed at and moved by "migrate --go"
const oldCfgPath = path.join(cfgDir, M.OLD_FILES[0][0])

const args = process.argv.slice(2)
const cmd = args[0] || 'doctor'
const hasFlag = (f) => args.includes(f)
const isObj = (v) => typeof v === 'object' && v !== null && !Array.isArray(v)
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

// Every command but migrate and doctor stops at an older config: this version's router does not read it, so editing
// it changes nothing, and starting that router would drop what an older router still does with it
function refuseOutdated(file) {
  console.error(`${file} is from an older version of model-relay, which this version does not read. Run "migrate" to see what it becomes, then "migrate --go".`)
  process.exit(1)
}
function refuseIfOutdated() {
  if (!fs.existsSync(relayCfgPath)) {
    if (fs.existsSync(oldCfgPath)) refuseOutdated(oldCfgPath)
    return
  }
  try {
    const raw = JSON.parse(fs.readFileSync(relayCfgPath, 'utf8'))
    if (isObj(raw) && !L.isFormat2(raw)) refuseOutdated(relayCfgPath)
  } catch {} // a file that does not parse is doctor's to report
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
    backup = `${settingsPath}.${BACKUP}`
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
    writeSettings({ env: { ANTHROPIC_BASE_URL: expectedUrl } })
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
  // Another gateway (LiteLLM, a company proxy) is someone's choice: say so, and never replace it. A loopback address
  // on another port is most likely this relay before "set port", so --fix still moves that one
  const ours = !cur || /^http:\/\/(127\.0\.0\.1|localhost):\d+\/?$/i.test(cur)
  if (!ours) {
    return { ok: false, msg: `settings.json env.ANTHROPIC_BASE_URL is "${cur}", which is not this relay; Claude Code talks to that address, not to ${expectedUrl}. Nothing was changed: remove it yourself if model-relay should take over` }
  }
  if (!fix) {
    return {
      ok: false,
      msg: `settings.json env.ANTHROPIC_BASE_URL is ${cur ? `"${cur}"` : 'unset'} (expected "${expectedUrl}" — run "node tools/setup.mjs doctor --fix" to set it)`,
    }
  }
  s.env = { ...(s.env || {}), ANTHROPIC_BASE_URL: expectedUrl }
  writeSettings(s)
  return { ok: true, msg: `Updated settings.json env.ANTHROPIC_BASE_URL=${expectedUrl}` }
}

// A new config: format 2, no provider yet, port 8950
const starterConfig = () => ({ format: 2, port: 8950, failover: { enabled: true, chain: [], cooldownMs: 600000 }, providers: {} })

if (cmd === 'presets') {
  console.log('Built-in providers: the address and compatibility settings of each service. You choose the model.')
  for (const [k, v] of Object.entries(L.PRESETS)) console.log(`  - ${k.padEnd(10)} ${v.baseUrl}`)
  console.log('Add one with: add <name> --preset <preset> --model <model id> --token env:<VAR>  (or "/provider setup" in Claude Code)')
  process.exit(0)
}

if (cmd === 'init') {
  refuseIfOutdated() // a new file next to an older one would hide it from migrate
  fs.mkdirSync(cfgDir, { recursive: true })
  if (fs.existsSync(relayCfgPath)) {
    console.log(`Config already exists at: ${relayCfgPath}`)
  } else {
    writeFileAtomic(relayCfgPath, JSON.stringify(starterConfig(), null, 2) + '\n')
    console.log(`Created ${relayCfgPath} with no provider yet; until you add one, every request goes to Claude.`)
  }
  if (hasFlag('--fix')) {
    const w = ensureSettingsWiring(relayPort(), true)
    console.log(`  ${w.msg}`)
  }
  console.log('Next: add a provider ("presets" lists the built-in ones), set its API key variable, restart Claude Code, then run "/provider doctor --ping". "/provider setup" lets Claude walk you through it.')
  process.exit(0)
}

if (cmd === 'add') {
  const name = (args[1] || '').trim().toLowerCase()
  const token = getOpt('--token')
  const model = getOpt('--model')
  const presetKey = (getOpt('--preset') || '').toLowerCase()
  const url = getOpt('--url')
  const usage = 'Usage: node tools/setup.mjs add <name> --model <model id> --token <token|env:VAR> (--preset <preset> | --url <address>)'
  if (!name || name.startsWith('--') || name === 'claude' || !token || !model) {
    console.error(usage)
    process.exit(2)
  }
  if (presetKey && !Object.hasOwn(L.PRESETS, presetKey)) {
    console.error(`Unknown preset "${presetKey}" (built-in: ${Object.keys(L.PRESETS).join(', ')}). Use --url for any other Anthropic-compatible address.`)
    process.exit(2)
  }
  if (!presetKey && !url) {
    console.error(`${usage}\nGive --preset (built-in: ${Object.keys(L.PRESETS).join(', ')}) or --url with the service's Anthropic-compatible address.`)
    process.exit(2)
  }
  if (url && !/^https?:\/\//.test(url)) {
    console.error(`--url must start with http:// or https:// (got "${url}")`)
    process.exit(2)
  }
  fs.mkdirSync(cfgDir, { recursive: true })
  const active = relayCfgPath
  const raw = fs.existsSync(relayCfgPath) || fs.existsSync(oldCfgPath) ? loadRaw().raw : starterConfig()
  raw.providers = isObj(raw.providers) ? raw.providers : {}
  const existing = Object.keys(raw.providers).find((k) => k.trim().toLowerCase() === name)
  // An update replaces the address, key and model only; launch, matchModels, fallback and the rest stay as they were
  const { preset: _oldPreset, ...kept } = existing && isObj(raw.providers[existing]) ? raw.providers[existing] : {}
  raw.providers[existing || name] = {
    ...kept,
    ...(presetKey ? { preset: presetKey } : {}),
    baseUrl: url || L.PRESETS[presetKey].baseUrl,
    token,
    model,
  }
  // The first provider of a new config takes over on Claude's usage-limit 429; later ones are added with "set failover.chain"
  if (isObj(raw.failover) && Array.isArray(raw.failover.chain) && raw.failover.chain.length === 0) raw.failover.chain = [name]
  if (fs.existsSync(active)) fs.copyFileSync(active, `${active}.${BACKUP}`)
  writeFileAtomic(active, JSON.stringify(raw, null, 2) + '\n')
  console.log(existing
    ? `Updated provider "${name}" (${model}) in ${active}: address, key and model replaced, its other settings kept`
    : `Saved provider "${name}" (${model}) in ${active}`)
  process.exit(0)
}

// ---------- editing the config: migrate / set / providers / remove ----------

const LF = String.fromCharCode(10)

// The config file as an object. Only migrate (allowOld) reads an older config, under its older name too.
function loadRaw(allowOld = false) {
  const file = fs.existsSync(relayCfgPath) || !fs.existsSync(oldCfgPath) ? relayCfgPath : oldCfgPath
  if (!fs.existsSync(file)) {
    console.error(`Missing config: ${file} (run "node tools/setup.mjs init" first)`)
    process.exit(1)
  }
  if (file === oldCfgPath && !allowOld) refuseOutdated(file)
  let raw
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch (e) {
    console.error(`Invalid JSON in ${file}: ${e.message}`)
    process.exit(1)
  }
  if (!isObj(raw)) {
    console.error(`${file} is not a JSON object ({ ... })`)
    process.exit(1)
  }
  if (!allowOld && !L.isFormat2(raw)) refuseOutdated(file)
  if (!allowOld && !isObj(raw.providers)) raw.providers = {}
  return { file, raw }
}

// The config holds tokens, so a backup sits right next to it and is never printed
function saveRaw(file, raw, suffix) {
  fs.copyFileSync(file, `${file}.${suffix}`)
  writeFileAtomic(file, JSON.stringify(raw, null, 2) + LF)
}

// Files with an older name that migrate would move: [from, to] for each one whose new name is still free
const filesToMove = () => M.OLD_FILES
  .map(([from, to]) => [path.join(cfgDir, from), path.join(cfgDir, to)])
  .filter(([from, to]) => fs.existsSync(from) && !fs.existsSync(to))

if (cmd === 'migrate') {
  const { file, raw } = loadRaw(true)
  const next = L.isFormat2(raw) ? null : M.toFormat2(raw)
  const moves = filesToMove()
  if (!next && !moves.length) {
    console.log(`${file} already uses format 2; nothing to do.`)
    process.exit(0)
  }
  if (next && !M.sameRouting(raw, next.config)) {
    console.error('Refusing to migrate: format 2 would change what the router does. Please report this.')
    process.exit(1)
  }
  const go = hasFlag('--go')
  console.log(`${go ? 'Migrating' : 'Dry run — would migrate'} ${file} (it routes exactly as the older version did):`)
  for (const n of next ? next.notes : []) console.log(`  - ${n}`)
  if (next) console.log('  - mark the file "format": 2, the only format the router reads')
  for (const [from, to] of moves) console.log(`  - rename ${path.basename(from)} to ${path.basename(to)}`)
  // An older file without a chain handed Claude's 429 to the first provider whose key was set; format 2 names it, so
  // while that one's key is unset there is no failover (judged with the keys this shell has)
  const chainBefore = M.oldCfg(raw, process.env)?.failoverChain || []
  const chainAfter = next ? L.parseCfg(next.config, process.env)?.failoverChain || [] : chainBefore
  if (chainBefore.join() !== chainAfter.join()) {
    const unset = L.unresolvedEnv(next.config, process.env).map((u) => u.env || `${u.provider}'s token`).join(', ')
    console.log(`  ! with the keys set in this shell, failover went to ${chainBefore.join(' → ') || 'nobody'} before but goes to ${chainAfter.join(' → ') || 'nobody'} afterwards, because ${unset} is unset; set it, or name the chain with "set failover.chain <a,b>"`)
  }
  if (!go) {
    console.log(`Add --go to apply (the previous config is kept as <name>.${BACKUP} next to it; tokens are copied untouched).`)
    process.exit(0)
  }
  // The config is written under its new name first, so the router and the plugin read the new file from then on
  const target = new Map(moves).get(file) || file
  if (next) {
    fs.copyFileSync(file, `${file}.${BACKUP}`)
    writeFileAtomic(target, JSON.stringify(next.config, null, 2) + LF)
  }
  for (const [from, to] of moves) {
    if (from === file && next) fs.rmSync(from) // its content is in the backup and in the new file
    else fs.renameSync(from, to)
  }
  console.log(`✓ Done. Config: ${target}${next ? `; previous copy: ${file}.${BACKUP}` : ''}`)
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
    hint: 'default | ^my-model,haiku — regexes matched against the request model',
  },
}

const ALIAS_ENV_KEYS = {
  haiku: 'ANTHROPIC_DEFAULT_HAIKU_MODEL',
  sonnet: 'ANTHROPIC_DEFAULT_SONNET_MODEL',
  opus: 'ANTHROPIC_DEFAULT_OPUS_MODEL',
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
  const { file, raw: config } = loadRaw()
  const cfg = L.parseCfg(config)
  // matchModels and models as the router reads them, whether or not a key is exported here
  const shape = L.parseShape(config)
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

  // Checked before anything is written: an alias needs the model the provider answers to
  if (!resetToClaude && !shape?.providers[target]) {
    console.error(`Provider ${target} has no usable address and model yet; set them first (add ${target} --model <id> --preset <p>). Nothing was changed.`)
    process.exit(1)
  }

  // 1. Update matchModels across providers in the config file
  for (const [k, pv] of Object.entries(config.providers)) {
    const key = k.trim().toLowerCase()
    const current = shape?.providers[key]?.matchSources ?? [`^${key}`]
    const withoutSlot = current.filter((pat) => !matchesSlot(pat, slot))
    if (!resetToClaude && key === target) {
      const nextMatchers = [...withoutSlot, slot]
      config.providers[k] = { ...pv, matchModels: nextMatchers }
    } else if (withoutSlot.length !== current.length) {
      config.providers[k] = { ...pv, matchModels: withoutSlot.length ? withoutSlot : [`^${key}`] }
    }
  }
  saveRaw(file, config, BACKUP)

  // 2. Sync ANTHROPIC_DEFAULT_<SLOT>_MODEL in settings.json so Claude Code itself resolves the alias & [1m] window
  const envKey = ALIAS_ENV_KEYS[slot]
  const nextEnv = { ...env }
  let targetModel = null
  if (resetToClaude) {
    delete nextEnv[envKey]
  } else {
    targetModel = shape.providers[target].model
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
  const config = loaded.raw
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
  if (JSON.stringify(before) === JSON.stringify(next)) {
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
  saveRaw(loaded.file, config, BACKUP)
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
  const { raw: config } = loadRaw()
  const cfg = L.parseCfg(config)
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
  const { file, raw: config } = loadRaw()
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
  const was = isObj(next.failover) && Array.isArray(next.failover.chain) ? next.failover.chain : []
  const chain = was.filter((n) => String(n).toLowerCase() !== name)
  if (chain.length !== was.length) {
    touched.push('removed from failover.chain')
    next.failover = { ...next.failover, chain }
  }
  for (const [k, v] of Object.entries(next.providers)) {
    if (Array.isArray(v.fallback) && v.fallback.map((n) => String(n).toLowerCase()).includes(name)) {
      next.providers[k] = { ...v, fallback: v.fallback.filter((n) => String(n).toLowerCase() !== name) }
      touched.push(`removed from ${k}.fallback`)
    }
  }
  console.log(`${hasFlag('--go') ? 'Removing' : 'Dry run — would remove'} provider ${name}${touched.length ? ` (${touched.join('; ')})` : ''}`)
  if (!hasFlag('--go')) {
    console.log(`Add --go to apply (the previous file is kept as .${BACKUP}).`)
    process.exit(0)
  }
  saveRaw(file, next, BACKUP)
  console.log(`✓ Done. Previous copy: ${file}.${BACKUP}`)
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
    // The port is the file's even when no provider is usable yet, and an older config keeps its port too
    const file = fs.existsSync(relayCfgPath) || !fs.existsSync(oldCfgPath) ? relayCfgPath : oldCfgPath
    return L.bareCfg(JSON.parse(fs.readFileSync(file, 'utf8'))).port
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

// What one P.ping result means, in words; detail is the upstream's own message with the token masked
function pingWords(r, p) {
  const why = r.detail ? ` (${r.detail})` : ''
  switch (r.verdict) {
    case 'ok': return `answers, first byte after ${r.firstByteMs} ms`
    case 'key': return `HTTP ${r.status}: the key was refused${why}`
    case 'model': return `HTTP ${r.status}: the service does not know model ${p.model}${why}`
    case 'quota': return `HTTP ${r.status}: out of quota or rate-limited${why}`
    case 'not-running': return `nothing listens at ${p.url}; is that local service started?`
    case 'unreachable': return `cannot reach ${new URL(p.url).host}${why}`
    case 'timeout': return `no answer within ${P.LIMIT_MS / 1000} s`
    default: return `HTTP ${r.status}${why}`
  }
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
  const { file, raw } = loadRaw()
  const before = Boolean(raw.proxy && typeof raw.proxy === 'object' && raw.proxy.enabled === true)
  raw.proxy = { ...(raw.proxy && typeof raw.proxy === 'object' ? raw.proxy : {}), enabled: on }
  writeFileAtomic(file, JSON.stringify(raw, null, 2) + String.fromCharCode(10))
  return before
}

// -1, 0 or 1 for dotted numeric versions; a missing part counts as 0 (same rule as the hook's compareVersions)
function compareVersions(a, b) {
  const pa = String(a).split('.').map((n) => parseInt(n, 10) || 0)
  const pb = String(b).split('.').map((n) => parseInt(n, 10) || 0)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (d !== 0) return d < 0 ? -1 : 1
  }
  return 0
}
const pluginVersion = () => {
  try {
    return String(JSON.parse(fs.readFileSync(path.join(root, '.claude-plugin', 'plugin.json'), 'utf8')).version || '')
  } catch {
    return ''
  }
}

// restart [--if-stale] [--if-idle]: stop this config dir's router and start the one shipped with this copy of the tool.
// --if-stale: only when the router runs older code (no configDir, or a lower version); a newer one is left alone.
// --if-idle: only when it answers no request and holds no tunnel; an older router cannot say, so it is never
// idle and only a plain "restart" (a person asking) replaces it. Exit codes: 0 restarted or nothing to do, 1 failed or
// refused, 3 busy or unknown (nothing changed).
if (cmd === 'restart') {
  refuseIfOutdated()
  const port = relayPort()
  const h = await fetchHealth(port)
  if (h && !(h.ok === true && Number.isInteger(h.pid) && h.pid > 1)) {
    console.error(`Refusing to restart: something answers on 127.0.0.1:${port} but not as a model-relay router. Nothing was changed.`)
    process.exit(1)
  }
  if (!h) {
    const up = await ensureRouter(port)
    console.log(up ? `No router was running on ${port}; started one.` : `No router was running on ${port}, and it did not start; see ${path.join(cfgDir, 'model-relay.log')}.`)
    process.exit(up ? 0 : 1)
  }
  const foreign = foreignRouter(h, port)
  if (foreign) {
    console.error(`Refusing to restart: ${foreign} Nothing was changed.`)
    process.exit(1)
  }
  const mine = pluginVersion()
  const stale = olderRouter(h) || Boolean(h.version && mine && compareVersions(h.version, mine) < 0)
  if (hasFlag('--if-stale') && !stale) {
    console.log(`The router (pid ${h.pid}) already runs ${h.version || 'this'} code; not restarted.`)
    process.exit(0)
  }
  if (hasFlag('--if-idle')) {
    // A long reply logs only when it starts, and a router without configDir may even serve another config dir, so an
    // older router's log says nothing safe about whether killing it cuts someone off
    const busy = typeof h.inflight !== 'number'
      ? 'it is an older router that cannot report requests in flight'
      : h.inflight > 0 || (h.tunnels ?? 0) > 0 ? `${h.inflight} request(s) in flight, ${h.tunnels ?? 0} tunnel(s) open` : ''
    if (busy) {
      console.log(`The router (pid ${h.pid}) may be busy (${busy}); not restarted. Run "restart" without --if-idle to restart it anyway.`)
      process.exit(3)
    }
  }
  console.log(`Restarting the router (pid ${h.pid}${h.version ? `, ${h.version}` : ', an older version'}) to run ${mine || 'this'} code; anything in flight through it is cut off.`)
  try {
    process.kill(h.pid)
  } catch {}
  for (let i = 0; i < 25 && (await fetchHealth(port)); i++) await sleep(200)
  const up = await ensureRouter(port)
  const now = up ? await fetchHealth(port) : null
  if (now && now.pid === h.pid) {
    console.error(`The router (pid ${h.pid}) did not stop, so it still runs the old code. Stop that process yourself, then run "restart" again.`)
    process.exit(1)
  }
  console.log(up ? `✓ restarted: pid ${now?.pid}${now?.version ? `, ${now.version}` : ''}` : `The router did not start again; see ${path.join(cfgDir, 'model-relay.log')}.`)
  process.exit(up ? 0 : 1)
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
    loadRaw() // an older or missing config stops here, before anything is written
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
    // NODE_EXTRA_CA_CERTS names one file, and settings.json env wins over the shell's, so proxy mode would make Claude Code
    // stop trusting a certificate someone already relies on (often a company CA for its TLS-inspecting network)
    // Compared by real path (drive-letter case, symlinks). When settings.json already holds the relay CA, the shell's
    // value is already overridden and a renew changes nothing about it
    const ours = (v) => Boolean(v) && L.sameDir(v, pki.ca)
    const checks = ours(env.NODE_EXTRA_CA_CERTS)
      ? []
      : [['settings.json env', env.NODE_EXTRA_CA_CERTS], ['your environment', process.env.NODE_EXTRA_CA_CERTS]]
    for (const [where, value] of checks) {
      if (value && !ours(value)) {
        console.error(`Refusing to ${sub}: ${where} already sets NODE_EXTRA_CA_CERTS=${value}. Proxy mode points it at ${ca} instead, so Claude Code would stop trusting that certificate (often a company network's). Nothing was changed.`)
        process.exit(1)
      }
    }
    const noProxy = [...new Set([...(env.NO_PROXY || '').split(',').map((s) => s.trim()).filter(Boolean), ...NO_PROXY_LOCAL.split(',')])].join(',')
    const next = { ...settings, env: { ...env, HTTPS_PROXY: url, NODE_EXTRA_CA_CERTS: ca, NO_PROXY: noProxy } }
    delete next.env.ANTHROPIC_BASE_URL
    const st = PKI.status(cfgDir)
    console.log(`${go ? 'Applying' : 'Dry run — would apply'}: ${sub === 'renew' ? 'new certificate, ' : ''}Claude Code uses ${url} as its HTTPS proxy and keeps api.anthropic.com as its API address.`)
    console.log(`  settings.json env: set HTTPS_PROXY, NODE_EXTRA_CA_CERTS=${ca}, NO_PROXY=${noProxy}; remove ANTHROPIC_BASE_URL`)
    console.log(`  ${path.basename(relayCfgPath)}: set proxy.enabled to true (the router refuses proxy connections otherwise)`)
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
  refuseIfOutdated()
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
    console.error(`The router could not be started on 127.0.0.1:${port}; check ${path.join(cfgDir, 'model-relay.log')}`)
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
  // Everything doctor finds is a finding { id, level, text, fix?, needsConsent? }: people read the lines, and
  // "--json" gives the same list to an assistant (or a script) that wants to act on it
  const json = hasFlag('--json')
  const say = (line) => !json && console.log(line)
  const findings = []
  const find = (id, text, extra = {}) => {
    findings.push({ id, level: 'warn', text, ...extra })
    say(`  ⚠ ${text}`)
  }
  const report = { ok: true, config: null, port: null, providers: {}, failover: null, retry: null, settings: null, router: null, ping: null, findings }
  const fail = (text) => {
    if (json) console.log(JSON.stringify({ ...report, ok: false, error: text }, null, 2))
    else console.error(text)
    process.exit(1)
  }

  // An older config is read for its port only: the router uses nothing else in it
  const active = fs.existsSync(relayCfgPath) || !fs.existsSync(oldCfgPath) ? relayCfgPath : oldCfgPath
  if (!fs.existsSync(active)) fail(`Missing config: ${active} (run "node tools/setup.mjs init" first)`)
  let raw
  try {
    raw = JSON.parse(fs.readFileSync(active, 'utf8'))
  } catch (e) {
    fail(`Invalid JSON in ${active}: ${e.message}`)
  }
  if (!isObj(raw)) fail(`${active} is not a JSON object ({ ... })`)
  report.config = active
  const outdated = active === oldCfgPath || !L.isFormat2(raw)
  report.outdated = outdated

  const shape = outdated ? null : L.parseShape(raw)
  const cfg = (!outdated && L.parseCfg(raw)) || L.bareCfg(raw)
  const names = Object.keys(cfg.providers)
  report.port = cfg.port
  report.providers = Object.fromEntries(names.map((k) => [k, cfg.providers[k].model]))
  report.failover = { enabled: cfg.failoverEnabled, chain: cfg.failoverChain, cooldownMs: cfg.cooldownMs }
  report.retry = { enabled: cfg.retry.enabled }
  say(names.length ? `Config OK (${active})` : `Config read (${active}), but no provider is usable yet; every request goes to Claude`)
  say(`  Port: ${cfg.port}`)
  say(`  Providers: ${names.length ? names.map((k) => `${k} -> ${cfg.providers[k].model}`).join(', ') : 'none usable'}`)
  // fix: the arguments to run this CLI with, so the caller supplies its own path to it
  if (outdated) find('outdated', `${active} is from an older version of model-relay, which this version does not read; "migrate" shows what it becomes and "migrate --go" applies it`, { fix: 'migrate --go', needsConsent: true })
  for (const u of outdated ? [] : L.unresolvedEnv(raw, process.env)) {
    find('missing-key', u.env
      ? `provider ${u.provider} is skipped: its key variable ${u.env} is unset in this shell. Set it permanently for your OS, then restart Claude Code so the router starts with it`
      : `provider ${u.provider} is skipped: its token "env:" names no variable`, { provider: u.provider, env: u.env || null })
  }
  if (!shape && !outdated) find('no-provider', 'no provider has an address, a model and a token yet; add one with "add <name> --preset <p> --model <id> --token env:<VAR>"', { fix: 'add <name> --preset <preset> --model <model id> --token env:<VAR>' })
  say(`  Failover: ${cfg.failoverEnabled ? (cfg.failoverChain.length ? `${cfg.failoverChain.join(' → ')} (back to Claude after ${cfg.cooldownMs / 60000} min)` : 'on, but no chain') : 'disabled'}    Retry: ${cfg.retry.enabled ? 'on' : 'off'}`)

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
  say(`  Aliases:  ${aliasDesc.length ? aliasDesc.join(', ') : 'none (run "node tools/setup.mjs alias haiku <provider>" to route haiku)'}`)

  // ---- the config itself: names that go nowhere, a model another provider claims first ----
  if (cfg.failoverEnabled && names.length && !cfg.failoverChain.length) {
    find('no-chain', 'failover is on but has no chain, so a usage-limit 429 from Claude is passed back as it is; name who takes over with "set failover.chain <a,b>"', { fix: 'set failover.chain <a,b>' })
  }
  const wanted = outdated ? [] : L.lowerNames(raw.failover?.chain)
  for (const v of outdated || !isObj(raw.providers) ? [] : Object.values(raw.providers)) if (Array.isArray(v?.fallback)) wanted.push(...L.lowerNames(v.fallback))
  const unknown = [...new Set(wanted.filter((n) => n && !names.includes(n)))]
  if (unknown.length) find('unknown-name', `failover names ${unknown.join(', ')} but no such usable provider exists; they are skipped`)
  for (const [k, p] of Object.entries(cfg.providers)) {
    const taker = L.matchProviderByModel(cfg, p.model)
    if (taker && taker !== k) find('model-claimed', `requests for ${p.model} go to ${taker}, not ${k}: ${taker} matches that name first (narrow its matchModels)`)
  }
  for (const [, envKey] of Object.entries(ALIAS_ENV_KEYS)) {
    const envVal = curEnv[envKey]
    if (envVal && !L.isClaudeModel(envVal) && !L.matchProviderByModel(cfg, envVal)) {
      find('alias-unrouted', `settings.json ${envKey}="${envVal}" does not match any provider's matchModels; requests for it will go to Claude`)
    }
  }

  // ---- Claude Code's own settings that keep requests away from the relay ----
  // Claude Code drops a subagent model missing from availableModels (a warning in its debug log only) and runs
  // CLAUDE_CODE_SUBAGENT_MODEL or the parent's model instead, so model-relay:<name> agents never reach the relay.
  // Observed on Claude Code 2.1.300 with an exact entry for a non-Claude id. Claude-named models are skipped: aliases
  // and families may admit them, which this exact match cannot tell. Only the user settings.json is read here;
  // project, local and managed settings can set availableModels too.
  if (Array.isArray(curSettings?.availableModels)) {
    const allowed = new Set(curSettings.availableModels.map((m) => String(m).toLowerCase()))
    const blocked = [...new Set(Object.values(shape?.providers || {}).map((p) => p.model))]
      .filter((m) => !L.isClaudeModel(m) && !/claude/i.test(m) && !allowed.has(m.toLowerCase()))
    if (blocked.length) find('available-models', `${settingsPath} availableModels does not list ${blocked.join(', ')}; Claude Code runs model-relay:<name> subagents on another model (CLAUDE_CODE_SUBAGENT_MODEL or the parent's) instead. Add each exactly as written here`, { needsConsent: true })
  }

  const wiring = ensureSettingsWiring(cfg.port, hasFlag('--fix'))
  report.settings = wiring
  say(`  Claude settings: ${wiring.ok ? '✓' : '⚠'} ${wiring.msg}`)
  if (!wiring.ok) findings.push({ id: 'wiring', level: 'warn', text: wiring.msg, fix: 'doctor --fix', needsConsent: true })

  // ---- the running router ----
  const h = await fetchHealth(cfg.port)
  report.router = h ? { up: true, pid: h.pid, version: h.version || null, configDir: h.configDir || null } : { up: false }
  if (!h) say(`  Router status: offline on 127.0.0.1:${cfg.port} (will auto-start when Claude Code launches)`)
  else if (h.ok !== true) say(`  Router health: ${JSON.stringify(h)}`)
  else {
    const foreign = foreignRouter(h, cfg.port)
    if (foreign) {
      report.router.foreign = true
      say(`  Router health: ⚠ ${foreign}`)
      findings.push({ id: 'foreign-router', level: 'warn', text: foreign })
    } else {
      if (olderRouter(h)) {
        say(`  Router health: ⚠ ${olderNote(cfg.port)}`)
        findings.push({ id: 'router-older', level: 'warn', text: olderNote(cfg.port), fix: 'restart --if-idle' })
      }
      const foState = h.failoverSince ? `active since ${new Date(h.failoverSince).toISOString().slice(11, 19)}Z` : 'idle'
      const pxState = h.proxy ? `proxy ${h.proxy.enabled ? 'on' : 'off'} (${h.proxy.mitm} routed / ${h.proxy.tunnel} tunnelled)` : 'no proxy'
      say(`  Router health: ✓ up on 127.0.0.1:${cfg.port} (pid ${h.pid}${h.version ? `, ${h.version}` : ''}, pinned sessions: ${h.sessionsOnCustom ?? 0}, 429 failover: ${foState}, ${pxState})`)
      const mine = pluginVersion()
      if (h.version && mine && compareVersions(h.version, mine) < 0) {
        find('router-older', `the running router is ${h.version} and this tool is ${mine}, so the router still runs the older code; run "/provider restart" (or "restart") when no reply is in progress`, { fix: 'restart --if-idle' })
      }
      // the router resolves env:VAR from the environment it was started with, which may differ from this shell's;
      // a variable unset here as well is already a missing-key finding
      for (const u of Array.isArray(h.unresolved) ? h.unresolved : []) {
        if (u.env && process.env[u.env]) {
          find('router-env', `The running router was started without ${u.env}, so provider ${u.provider} is skipped there although this shell has it. Stop the router (kill ${h.pid}) and start Claude Code from this shell so the new router inherits it`, { provider: u.provider, env: u.env })
        }
      }
    }
  }

  if (hasFlag('--ping')) {
    say('  Upstream ping:')
    report.ping = {}
    for (const [k, p] of Object.entries(cfg.providers)) {
      const r = await P.ping(p)
      report.ping[k] = r
      say(`    ${r.verdict === 'ok' ? '✓' : '✗'} ${k.padEnd(10)} (${p.model}) -> ${pingWords(r, p)}`)
    }
  }
  if (json) console.log(JSON.stringify(report, null, 2))
} else {
  console.error('Usage: node tools/setup.mjs [init|presets|add|providers|alias|set|remove|migrate|doctor|check|restart|proxy|rc] [--fix] [--ping] [--json] [--go]')
  process.exit(2)
}
