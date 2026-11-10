#!/usr/bin/env node
// Setup, preset management, and doctor CLI for model-relay.
// Usage:
//   node tools/setup.mjs init [--fix]                                   an empty config (and, with --fix, the settings.json wiring)
//   node tools/setup.mjs presets
//   node tools/setup.mjs add <name> --model <m> --token <token|env:VAR> (--preset <p> | --url <u>)
//   node tools/setup.mjs providers                                    list providers, routes, aliases, failover and retry
//   node tools/setup.mjs alias [haiku|sonnet|opus|subagent] [target]  inspect or point a Claude model alias at a provider (or back to claude)
//   node tools/setup.mjs set <key> <value>                            failover.enabled|chain|cooldownMs, retry.enabled|failover|..., accountFallback.mode|account, providers.<name>.fallback|retry|matchModels
//   node tools/setup.mjs remove <name> [--go]
//   node tools/setup.mjs handoff <wrapper id> <session id>                for /provider switch: hand the launcher wrapper this session
//   node tools/setup.mjs launcher                                     write <config dir>/model-relay-launch.mjs and print the alias for it
//   node tools/setup.mjs account-sync <name>                          copy a second account's accountUuid, deviceId and email from accounts.<name>.configDir
//   node tools/setup.mjs account-add <name> [--dir <path>] [--link <entry>]...  make a login dir for another account and its accounts entry
//   node tools/setup.mjs account-fallback <name> <account>[,...] [--allow-cross-org <account>[,...]] | none   the accounts <name>'s windows go on with
//   node tools/setup.mjs account-token <name> env:<VAR> | keychain:<service>/<account>   where a second account's token is kept (never the token)
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
const K = require('../router/keychain.js')

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const home = process.env.USERPROFILE || process.env.HOME || ''
// The relay's config dir, the one place it is decided: MODEL_RELAY_CONFIG_DIR (a second account's window pointed at
// main's dir) when it is absolute and exists, else CLAUDE_CONFIG_DIR, else ~/.claude
const relayDirGiven = process.env.MODEL_RELAY_CONFIG_DIR || ''
const relayDir = path.isAbsolute(relayDirGiven) && fs.existsSync(relayDirGiven) ? relayDirGiven : '' // '' when it does not count
const cfgDir = relayDir || process.env.CLAUDE_CONFIG_DIR || path.join(home, '.claude')
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

// The OS the keychain checks and the printed commands are for. Only macOS has the login keychain that keychain: tokens
// name; elsewhere a token is kept in an env: variable. A test preload stands in for an OS through
// globalThis.__modelRelayTestPlatform, as it stands in for the keychain tool itself.
const platform = globalThis.__modelRelayTestPlatform || process.platform
const hasKeychain = platform === 'darwin'
// One word of a printed command, quoted for the shell it is pasted into (PowerShell on Windows, else POSIX sh); a
// <placeholder> is left as it is, for the person to fill in
const shWord = (s) => (/^[A-Za-z0-9_./:=@%+,-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`)
const psWord = (s) => (/^[A-Za-z0-9_./\\:-]+$/.test(s) && !s.startsWith('-') ? s : `'${s.replace(/'/g, "''")}'`)
const word = (s) => (/[<>]/.test(s) ? s : platform === 'win32' ? psWord(s) : shWord(s))
// This CLI as a command to paste anywhere: node and this file's absolute path
const cliCmd = (...words) => ['node', ...[path.join(root, 'tools', 'setup.mjs'), ...words].map(word)].join(' ')
// A variable name for a token kept off the keychain: MODEL_RELAY_TOKEN_<NAME>, the name upper case with "_" for the rest
const tokenVar = (name) => `MODEL_RELAY_TOKEN_${name.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`
// What account-token takes as env:<VAR>, and what tokenSource prints as a name
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/
// The window's own credentials: never a second account's token source
const OWN_CREDENTIALS = ['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN']
// The token command for account <name> on this OS: a keychain item on macOS, a variable elsewhere
const tokenCmd = (name) => cliCmd('account-token', name, hasKeychain ? `keychain:model-relay-${name}/${name}` : `env:${tokenVar(name)}`)
// The account's own Claude Code, started in its folder and pointed at this relay (MODEL_RELAY_CONFIG_DIR), so the plugin
// registers that window with the router: without it a window's usage-limit 429 would count as the main account's. In
// PowerShell $env: stays set, so a window of its own
const loginCmd = (dir, rest = '') => platform === 'win32'
  ? `$env:CLAUDE_CONFIG_DIR=${psWord(dir)}; $env:MODEL_RELAY_CONFIG_DIR=${psWord(path.resolve(cfgDir))}; claude${rest}   (in a new PowerShell window: the variables stay set in it)`
  : `CLAUDE_CONFIG_DIR=${shWord(dir)} MODEL_RELAY_CONFIG_DIR=${shWord(path.resolve(cfgDir))} claude${rest}`
// A name for an account or its provider: a plain word (L.SAFE_NAME) that cannot be a pasted token, since the commands
// that take one print it back and write it to the config
const plainName = (n) => L.SAFE_NAME.test(n) && n.length <= 64 && !/^sk-ant-/i.test(n)
// accountFallback.mode as printed: one of the known modes, never whatever else the file holds
const modeName = (raw) => (L.ACCOUNT_MODES.includes(L.accountMode(raw)) ? L.accountMode(raw) : 'off')

// keychain: tokens, as this CLI sees them: it never reads a secret, it only checks that the item exists, once per item.
// An item that exists stands in for its token, which nothing here sends (doctor --ping skips such providers). Off macOS
// there is no such keychain, and nothing is run.
const keychainSeen = new Map()
const keychainExists = (service, account) => {
  if (!hasKeychain) return null
  const ref = `${service}/${account}`
  if (!keychainSeen.has(ref)) keychainSeen.set(ref, K.exists(service, account))
  return keychainSeen.get(ref) ? 'keychain-item-exists' : null
}
// The relay dir, as the router names it to tell its own account (an accounts entry whose configDir is this dir)
const where = { relayDir: cfgDir, home }
const parseCfg = (raw) => L.parseCfg(raw, process.env, { keychain: keychainExists, ...where })
// accounts.<name>.fallback as the router reads it (L.fallbackLists, every entry): fallback account -> the accounts naming it
const fallbackOwners = (raw) => {
  const out = new Map()
  for (const [a, list] of L.fallbackLists(raw, false, L.selfOf(raw, where))) for (const { name } of list) out.set(name, [...(out.get(name) || []), a])
  return out
}
// settings.json keys that make Claude Code send with something other than its own login; an account dir that links this
// settings.json would carry them too. Key names only, never a value.
const loginOverrides = () => {
  let s = {}
  try {
    s = readSettings()
  } catch {}
  const env = isObj(s?.env) ? s.env : {}
  return [...['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN'].filter((k) => env[k] !== undefined).map((k) => `env.${k}`), ...(s?.apiKeyHelper !== undefined ? ['apiKeyHelper'] : [])]
}
const overrideText = (keys) => `${settingsPath} sets ${keys.join(', ')}: an account dir that links this settings.json sends with that instead of its own login`
// How a token is written, for printing: the env:VAR or keychain item it names, never a literal token. A keychain: token
// that names no <service>/<account> is shown by a marker only: its text may be a pasted secret.
const tokenSource = (token) => {
  const k = L.keychainRef(token)
  if (k) return `keychain:${k.ref}`
  if (typeof token !== 'string') return 'inline'
  if (token.startsWith('keychain:')) return 'keychain:(malformed)'
  if (!token.startsWith('env:')) return 'inline'
  return ENV_NAME.test(token.slice(4).trim()) ? `env:${token.slice(4).trim()}` : 'env:(malformed)'
}

// The running router re-reads these files on every request, so never leave one half written
function writeFileAtomic(file, text) {
  const tmp = `${file}.tmp-${process.pid}`
  fs.writeFileSync(tmp, text)
  renameOver(tmp, file)
}

// A private file written whole: text goes to tmp, a fresh name opened exclusively and never through a symlink (O_EXCL,
// O_NOFOLLOW) with mode 0600, which is then renamed over file, so a reader sees the old file or the new one and a link
// planted at either name is never followed. tmp is removed on any failure, and the error is thrown.
function writeExclusive(tmp, file, text) {
  const flags = fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW || 0)
  try {
    const fd = fs.openSync(tmp, flags, 0o600)
    try {
      fs.writeSync(fd, text)
    } finally {
      fs.closeSync(fd)
    }
    renameOver(tmp, file) // retried while Windows holds the target open, as for the config
  } catch (e) {
    fs.rmSync(tmp, { force: true })
    throw e
  }
}

// Moves a finished temp file over its target; tmp is removed when that keeps failing
function renameOver(tmp, file) {
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

// For the commands that write settings.json back: a file that does not parse is refused, never rewritten from an empty one
function readSettingsOrExit() {
  try {
    return readSettings()
  } catch (e) {
    console.error(`Invalid JSON in ${settingsPath}: ${e.message}`)
    process.exit(1)
  }
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
    if (!fix) return { ok: false, fixable: true, msg: `Missing ${settingsPath} (run with --fix to wire ANTHROPIC_BASE_URL=${expectedUrl})` }
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
  // Another gateway (LiteLLM, a company proxy, your own on localhost:4000) is someone's choice: say so, and never replace
  // it. Only an unset value, or this relay's own port spelled with localhost or a slash, is ours to set; "set port" already
  // moves the wiring, so an address on some other port is not guessed to be this relay's
  const own = /^http:\/\/(127\.0\.0\.1|localhost):(\d+)\/?$/i.exec(cur || '')
  const ours = !cur || (own !== null && Number(own[2]) === port)
  if (!ours) {
    return { ok: false, msg: `settings.json env.ANTHROPIC_BASE_URL is "${cur}", which is not this relay; Claude Code talks to that address, not to ${expectedUrl}. Nothing was changed: remove it yourself if model-relay should take over` }
  }
  if (!fix) {
    return {
      ok: false,
      fixable: true,
      msg: `settings.json env.ANTHROPIC_BASE_URL is ${cur ? `"${cur}"` : 'unset'} (expected "${expectedUrl}" — run "node tools/setup.mjs doctor --fix" to set it)`,
    }
  }
  s.env = { ...(s.env || {}), ANTHROPIC_BASE_URL: expectedUrl }
  writeSettings(s)
  return { ok: true, msg: `Updated settings.json env.ANTHROPIC_BASE_URL=${expectedUrl}` }
}

// "/provider switch" is a command word of the plugin, so no provider can take that name; and "__proto__" is no own key of
// a plain object: written as one it would replace the object's prototype and vanish from the saved file
function refuseReservedName(name) {
  if (name === '__proto__') {
    console.error('"__proto__" cannot be a name in model-relay.json; pick another name. Nothing was changed.')
    process.exit(2)
  }
  if (name !== 'switch') return
  console.error('"switch" is the name of a /provider command, so a provider cannot be called that; pick another name. Nothing was changed.')
  process.exit(2)
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
  refuseReservedName(name)
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
  statusBar: { parse: bool, hint: 'on|off — also show the relay state in Claude Code\'s plugin status line' },
  avatarPane: { parse: bool, hint: 'on|off — experimental: open the avatar pane in every window (needs "avatars")' },
  'failover.enabled': { parse: bool, hint: 'on|off — switch to the failover chain when Claude hits its usage limit' },
  'failover.chain': { parse: names, hint: 'a,b,c — who takes over, in order (provider names)' },
  'failover.cooldownMs': { parse: wholeNumber(60000), hint: 'how long to stay off Claude after a 429, e.g. 10m (minimum 1m)' },
  'retry.enabled': { parse: bool, hint: 'on|off — retry a failing provider before giving up' },
  'retry.failover': { parse: bool, hint: 'on|off — after retries run out, hand the request to the next provider' },
  'retry.attempts': { parse: count, hint: 'retries per provider (0 = until it answers)' },
  'retry.delayMs': { parse: wholeNumber(0), hint: 'first wait between retries, e.g. 2s' },
  'retry.maxDelayMs': { parse: wholeNumber(0), hint: 'longest single wait, e.g. 30s' },
  'accountFallback.mode': {
    parse: (v) => {
      if (!L.ACCOUNT_MODES.includes(v)) throw new Error(`expected ${L.ACCOUNT_MODES.join(', ')}`)
      return v
    },
    hint: `${L.ACCOUNT_MODES.join('|')} — how a second Claude account is used (README: more than one Claude account)`,
  },
  // checked against accounts below, where the config is read; "none" removes it
  'accountFallback.account': { parse: (v) => (v === 'none' ? undefined : v.trim().toLowerCase()), hint: 'name|none — the account /provider switch moves a window to (an accounts entry with a configDir)' },
}
// What "set accountFallback.mode" says when it turns on a mode in which the relay sends with another account's token
const TERMS_LINE = 'Note: in this mode the relay sends your requests with another Claude account\'s token and that account\'s ids (account_uuid, device_id, the email sentence) and a session id of its own for each window. Anthropic\'s terms govern how accounts and their credentials may be used, and enforcement can reach either account; the README\'s account section quotes them. That risk is yours.'
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
  const cfg = parseCfg(config)
  // matchModels and models as the router reads them, whether or not a key is exported here
  const shape = L.parseShape(config)
  const settings = readSettingsOrExit()
  const env = settings?.env || {}

  if (!slot || slot === 'status' || slot === 'list') {
    const routed = cfg ? L.detectAliases(cfg) : {}
    console.log('Claude Code model aliases (settings.json env + model-relay matchModels):')
    for (const [s, envKey] of Object.entries(ALIAS_ENV_KEYS)) {
      const pName = routed[s]
      const pModel = pName && cfg?.providers?.[pName] ? L.modelLabel(cfg.providers[pName]) : null
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
  // Read from the file, not the parsed shape: an account refused for its shape or claudeUrl is still a Claude account
  const targetRaw = Object.entries(config.providers).find(([k]) => k.trim().toLowerCase() === target)?.[1]
  if (!resetToClaude && isObj(targetRaw) && targetRaw.kind === 'anthropic') {
    console.error(`Provider ${target} is a Claude account (kind "anthropic"): it has no model of its own to point an alias at, and takes over only through failover or /provider ${target}. Nothing was changed.`)
    process.exit(1)
  }
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
    // a fixed text: the value given may be anything, a pasted secret included
    if (key === 'accountFallback.account' && next !== undefined) {
      const view = L.accountView(config, false, where)
      if (!L.SAFE_NAME.test(next) || !view.names.has(next)) throw new Error('not the name of an account in accounts (with a configDir); make one with account-add <name>')
      if (next === view.self) throw new Error('that is the relay\'s own account (its configDir is this config dir), whose windows are already yours')
    }
  } catch (e) {
    console.error(`${key}: ${e.message}`)
    process.exit(2)
  }
  let holder, field, before
  if (pk) {
    const name = Object.keys(config.providers).find((k) => k.trim().toLowerCase() === pk[1].toLowerCase())
    holder = config.providers[name] = { ...config.providers[name] }
    field = pk[2]
  } else if (!key.includes('.')) {
    holder = config
    field = key
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
  if (key === 'accountFallback.mode' && (next === 'rc-keep' || next === 'api-only')) console.log(`  ${TERMS_LINE}`)
  process.exit(0)
}

if (cmd === 'providers') {
  const { raw: config } = loadRaw()
  const cfg = parseCfg(config)
  const live = cfg ? cfg.providers : {}
  const accountWhy = new Map(L.accountProblems(config).map((x) => [x.provider, x.why]))
  const windowsOf = fallbackOwners(config) // fallback account -> the accounts whose windows use it
  const routed = cfg ? L.detectAliases(cfg) : {}
  const aliasPairs = Object.entries(routed).map(([s, p]) => `${s} → ${p} (${live[p] ? L.modelLabel(live[p]) : p})`)
  console.log(`Failover: ${cfg && cfg.failoverEnabled ? `on, chain ${cfg.failoverChain.join(' → ')}, back to Claude after ${cfg.cooldownMs / 60000} min` : 'off'}    Retry: ${cfg && cfg.retry.enabled ? 'on' : 'off'}`)
  console.log(`Aliases:  ${aliasPairs.length ? aliasPairs.join(', ') : 'none (all Claude tiers go to Anthropic unless session is pinned)'}`)
  for (const [k, v] of Object.entries(config.providers)) {
    const key = k.trim().toLowerCase()
    const p = live[key]
    const tokenSrc = tokenSource(v?.token)
    const skipped = accountWhy.get(key) // a Claude account refused for its shape or claudeUrl, not its token
    if (!p && isObj(v) && v.kind === 'anthropic' && !L.accountActive(config) && !windowsOf.has(key)) {
      console.log(`  - ${key}: a Claude account, not used: accountFallback.mode is "${L.accountMode(config)}" (only rc-keep and api-only send with its token)`)
      continue
    }
    if (!p && skipped) {
      console.log(`  ✗ ${key}: skipped: ${skipped}`)
      continue
    }
    if (!p) {
      console.log(`  ✗ ${key}: not usable (token ${tokenSrc} did not resolve, or incomplete)`)
      continue
    }
    const retryDesc = p.retryCfg
      ? `on (${p.retryCfg.attempts === 0 ? 'unlimited' : `${p.retryCfg.attempts}x`}, max ${Math.round(p.retryCfg.maxDelayMs / 1000)}s)`
      : 'off'
    let to = !p.retryCfg || !p.retryCfg.failover || !cfg.failoverEnabled
      ? (p.fallback === null ? 'nobody' : 'off (retry.failover is off)')
      : p.fallback === null
        ? 'nobody'
        : Array.isArray(p.fallback)
          ? p.fallback.join(' → ')
          : `the chain (${cfg.failoverChain.join(' → ')})`
    // A Claude account hands a usage-limit 429 on whatever retry.failover says (failover.enabled still rules)
    if (p.fallbackOnly) to = `nobody (it answers for ${windowsOf.get(key).join(', ')} or returns its error)`
    else if (L.isAccount(p) && p.fallback !== null && !(p.retryCfg && p.retryCfg.failover && cfg.failoverEnabled)) {
      const next = Array.isArray(p.fallback) ? p.fallback.join(' → ') : `the chain (${cfg.failoverChain.join(' → ')})`
      to = cfg.failoverEnabled ? `${next} on a usage limit only (retry.failover is off)` : 'off (failover is off)'
    }
    console.log(`  ● ${key.padEnd(10)} ${L.modelLabel(p)}  ${p.url}`)
    const routes = p.fallbackOnly ? `(a Claude account: only the windows of ${windowsOf.get(key).join(', ')}, at its usage limit or by /provider)`
      : L.isAccount(p) ? '(a Claude account: only failover and /provider)' : p.matchRegexes.map((r) => r.source).join(' | ') || '(only its own model name)'
    console.log(`    routes: ${routes}   token: ${tokenSrc}   retry: ${retryDesc}   hands over to: ${to}`)
  }
  process.exit(0)
}

// The three values that name a second account in its requests, from that account's own Claude Code login: nothing else
// in its .claude.json is read, and no value is ever printed (only field names). No keychain, no network.
if (cmd === 'account-sync') {
  // It reads "your own login" from CLAUDE_CONFIG_DIR; in a window pointed elsewhere that could be the other account's
  if (relayDir) {
    console.error('account-sync does not run while MODEL_RELAY_CONFIG_DIR is set; run it from a shell of your own account. Nothing was changed.')
    process.exit(2)
  }
  const name = (args[1] || '').trim().toLowerCase()
  refuseReservedName(name)
  if (!name || name === 'claude' || !plainName(name)) {
    console.error('Usage: node tools/setup.mjs account-sync <name>   (reads accounts.<name>.configDir/.claude.json; <name> is a lower-case word of letters, digits, ".", "_", "-")')
    process.exit(2)
  }
  const stop = (text) => {
    console.error(`${text}. Nothing was changed.`)
    process.exit(1)
  }
  const { file, raw: config } = loadRaw()
  // found as providers.<name> is: trimmed and in any case, own keys only
  const acctKey = isObj(config.accounts) ? Object.keys(config.accounts).find((k) => k.trim().toLowerCase() === name) : undefined
  const acct = acctKey === undefined ? null : config.accounts[acctKey]
  const given = isObj(acct) && typeof acct.configDir === 'string' ? acct.configDir.trim() : ''
  if (!given) stop(`accounts.${name}.configDir is not set; ${cliCmd('account-add', name)} makes that account's folder and writes it (or write the config directory that account's Claude Code uses there)`)
  const dir = path.resolve(given === '~' || given.startsWith('~/') ? path.join(home, given.slice(1)) : given)
  if (L.sameDir(dir, cfgDir)) stop(`accounts.${name}.configDir is this router's own config directory, whose login is yours`)
  // The login file by path, never by environment (L.loginFile): <home>/.claude.json for the default dir ~/.claude, else
  // <dir>/.claude.json; only a regular file is read
  const readLogin = L.readLoginJson
  const src = L.loginFile(dir, home)
  const j = readLogin(src)
  if (!j) stop(`${src} could not be read as a JSON object`)
  const got = {
    accountUuid: isObj(j.oauthAccount) ? j.oauthAccount.accountUuid : undefined,
    email: isObj(j.oauthAccount) ? j.oauthAccount.emailAddress : undefined,
    deviceId: j.userID,
  }
  const bad = [
    !L.UUID_RE.test(String(got.accountUuid || '')) && 'oauthAccount.accountUuid (a UUID)',
    !L.isEmail(got.email) && 'oauthAccount.emailAddress (an address with no quote, backslash, angle bracket or space)',
    !L.DEVICE_ID_RE.test(String(got.deviceId || '')) && 'userID (64 hex digits)',
  ].filter(Boolean)
  if (bad.length) stop(`${src} has no usable ${bad.join(', ')}; is that account logged in there?`)
  const mainFile = L.loginFile(cfgDir, home)
  const main = readLogin(mainFile)
  const mainUuid = main && isObj(main.oauthAccount) ? String(main.oauthAccount.accountUuid || '') : ''
  if (!L.UUID_RE.test(mainUuid)) stop(`${mainFile} has no oauthAccount.accountUuid to compare with, so it cannot be told apart from your own login`)
  if (mainUuid.toLowerCase() === got.accountUuid.toLowerCase()) stop(`${src} is logged in to your own account (the same oauthAccount.accountUuid)`)
  if (main.userID === got.deviceId) stop(`${src} has the same userID as your own login, so its requests would carry your device id`)
  const existing = Object.keys(config.providers).find((k) => k.trim().toLowerCase() === name)
  const entry = existing ? config.providers[existing] : { kind: 'anthropic' }
  if (!isObj(entry) || entry.kind !== 'anthropic') stop(`providers.${name} is not a Claude account (kind "anthropic")`)
  config.providers[existing || name] = { ...entry, accountUuid: got.accountUuid.toLowerCase(), deviceId: got.deviceId, email: got.email }
  saveRaw(file, config, BACKUP)
  console.log(`✓ providers.${name}: accountUuid, deviceId and email written from ${src}`)
  if (typeof entry.token !== 'string') {
    console.log(`  It has no token yet: a setup-token of that account, kept ${hasKeychain ? 'in the keychain (account-add printed the steps)' : `in the variable ${tokenVar(name)} (keychain: tokens work on macOS only)`}, then: ${tokenCmd(name)}`)
    // env: works on macOS too: the keychain is the default there, not the only way
    if (hasKeychain) console.log(`  Or keep it in the variable ${tokenVar(name)} instead (set permanently for your OS, then restart Claude Code): ${cliCmd('account-token', name, `env:${tokenVar(name)}`)}`)
  }
  const owners = fallbackOwners(config).get(name)
  if (owners) console.log(`  The windows of ${owners.join(', ')} go on with it at their usage limit (accounts.<name>.fallback).`)
  else for (const line of modeSteps(config, name)) console.log(`  ${line}`)
  process.exit(0)
}

// What makes the router send with account <name>, for the mode the config is in now, as commands to run: in rc-keep or
// api-only a place in failover.chain, in switch a place in another account's fallback list, in off a mode first. []
// when nothing is missing. Only names already in the config are printed.
function modeSteps(config, name, added = false) {
  const mode = modeName(config)
  const chain = L.lowerNames(isObj(config.failover) ? config.failover.chain : []).filter((n) => L.SAFE_NAME.test(n))
  // The chain is tried in order: the account goes after the Claude accounts already in it (the first one is tried
  // first), or first when there is none, so it takes over before a provider of another kind
  const acct = (n) => Object.entries(isObj(config.providers) ? config.providers : {}).some(([k, v]) => k.trim().toLowerCase() === n && isObj(v) && v.kind === 'anthropic')
  const at = chain.map(acct).lastIndexOf(true) + 1
  const chainStep = chain.includes(name) ? '' : cliCmd('set', 'failover.chain', [...chain.slice(0, at), name, ...chain.slice(at)].join(','))
  const listStep = cliCmd('account-fallback', '<account>', name)
  // account-add: the account is new, so it may be a window of its own with a fallback list as well as a fallback itself
  if (mode === 'switch') {
    return [
      ...(added ? [`accountFallback.mode is "switch": to let ${name}'s own windows go on with other accounts at its limit: ${cliCmd('account-fallback', name, '<account>[,...]')}`] : []),
      `${added ? 'and ' : `accountFallback.mode is "switch": `}the router sends with ${name} only for the windows of an account whose fallback list names it: ${listStep}`,
    ]
  }
  if (mode !== 'off') return chainStep ? [`accountFallback.mode is "${mode}": to take over at your usage limit, ${name} needs a place in failover.chain, which is tried in order: ${chainStep}`] : []
  return [
    added
      ? `accountFallback.mode is "off" in the file now and "switch" once step 1 is done, where the router never sends with ${name} yet. To use it, either:`
      : `accountFallback.mode is "off", so the router never sends with ${name}. To use it, either:`,
    `  rc-keep (your windows go on with ${name} at your usage limit): ${cliCmd('set', 'accountFallback.mode', 'rc-keep')}${chainStep ? `, then ${chainStep}` : ''}`,
    `  switch (an account's windows go on with ${name} at that account's limit): ${added ? '' : `${cliCmd('set', 'accountFallback.mode', 'switch')}, then `}${listStep}`,
  ]
}

// A login dir for another Claude account: <dir> (default ~/.claude-<name>) made 0700, with symlinks back into the relay
// dir for what that window shares with yours, then accounts.<name>.configDir written (last, with a backup). It refuses
// rather than reuse anything that is not an empty dir of its own, never touches the keychain, a shell profile or another
// dir, and prints the steps only a person can do (the login, the setup-token and the keychain item).
const ACCOUNT_LINKS = ['settings.json', 'CLAUDE.md', 'agents', 'commands', 'skills', 'hooks', 'plugins', 'projects', 'output-styles']
// Never linked, whatever --link says: logins, the relay's own files, and state each login keeps for itself
const NEVER_LINKED = /^(ide|history\.jsonl|shell-snapshots|session-env|backups|model-relay.*|\.claude\.json|\.config\.json|\.credentials.*)$/i
if (cmd === 'account-add') {
  const usage = 'Usage: node tools/setup.mjs account-add <name> [--dir <absolute path or ~/path>] [--link <entry of the relay dir>]...'
  const name = (args[1] || '').trim().toLowerCase()
  refuseReservedName(name)
  if (!name || name.startsWith('--') || name === 'claude' || !plainName(name)) {
    console.error(`${usage}\n<name> is a lower-case word (letters, digits, ".", "_", "-"). Nothing was changed.`)
    process.exit(2)
  }
  const stop = (text, code = 1) => {
    console.error(`${text}. Nothing was changed.`)
    process.exit(code)
  }
  const { file, raw: config } = loadRaw()
  const accounts = isObj(config.accounts) ? config.accounts : {}
  if (Object.keys(accounts).some((k) => k.trim().toLowerCase() === name)) stop(`accounts.${name} already exists`)
  const given = getOpt('--dir') ?? `~/.claude-${name}`
  if (!(path.isAbsolute(given) || given.startsWith('~/')) || given.includes('\0')) stop('--dir must be an absolute path or start with ~/', 2)
  const dir = L.expandHome(given, home)
  // Where a path really points, though its last parts do not exist yet: the realpath of its nearest existing ancestor
  const real = (p) => {
    const rest = []
    let cur = path.resolve(p)
    while (!fs.existsSync(cur) && path.dirname(cur) !== cur) {
      rest.unshift(path.basename(cur))
      cur = path.dirname(cur)
    }
    return path.join(L.realDir(cur), ...rest)
  }
  const within = (a, b) => a === b || a.startsWith(b.endsWith(path.sep) ? b : b + path.sep)
  const target = real(dir)
  const others = [['the relay dir', cfgDir], ...Object.entries(accounts).filter(([, v]) => isObj(v) && typeof v.configDir === 'string' && v.configDir.trim()).map(([k, v]) => [`the dir of accounts.${k.trim().toLowerCase()}`, L.expandHome(v.configDir.trim(), home)])]
  for (const [what, d] of others) if (within(target, real(d)) || within(real(d), target)) stop(`${dir} is, holds or lies inside ${what}`)
  let st = null
  try {
    st = fs.lstatSync(dir)
  } catch {}
  if (st && st.isSymbolicLink()) stop(`${dir} is a symlink`)
  if (st && !st.isDirectory()) stop(`${dir} exists and is not a folder`)
  if (st && fs.readdirSync(dir).length) stop(`${dir} exists and is not empty`)
  if (!st && !fs.existsSync(path.dirname(dir))) stop(`${path.dirname(dir)} does not exist`)
  // What to link: the default entries the relay dir has, then each --link (a plain name of an entry it has)
  const extra = args.flatMap((a, i) => (a === '--link' ? [args[i + 1] ?? ''] : []))
  for (const n of extra) {
    if (!n || n.startsWith('.') || n === '..' || /[\\/\0]/.test(n) || path.basename(n) !== n || NEVER_LINKED.test(n)) stop(`--link ${JSON.stringify(n)} is refused: only a plain name in the relay dir, never a login file, the relay's own files, ide, history.jsonl, shell-snapshots, session-env or backups`, 2)
    if (!fs.existsSync(path.join(cfgDir, n))) stop(`--link ${n}: the relay dir ${cfgDir} has no such entry`, 2)
  }
  const links = [...new Set([...ACCOUNT_LINKS.filter((n) => fs.existsSync(path.join(cfgDir, n))), ...extra])]
  const made = []
  try {
    if (st) fs.chmodSync(dir, 0o700)
    else {
      fs.mkdirSync(dir, { mode: 0o700 }) // not recursive: its parent must already be there
      made.push(`the folder ${dir}`)
      fs.chmodSync(dir, 0o700)
    }
    for (const n of links) {
      fs.symlinkSync(path.join(cfgDir, n), path.join(dir, n)) // no force: an entry already there stops it
      made.push(`the link ${path.join(dir, n)}`)
    }
  } catch (e) {
    console.error(`account-add stopped (${e.code || e.message}); model-relay.json was not changed. ${made.length ? `Already made: ${made.join(', ')}.` : 'Nothing was made.'}`)
    process.exit(1)
  }
  config.accounts = { ...accounts, [name]: { configDir: given } }
  saveRaw(file, config, BACKUP)
  console.log(`✓ accounts.${name}.configDir is ${given}, in ${file} (the previous file is kept as ${path.basename(file)}.${BACKUP})`)
  console.log(`  ${st ? 'Used the empty folder' : 'Made the folder'} ${dir} (0700)${links.length ? `, linking from the relay dir: ${links.join(', ')}` : ''}`)
  // What the account's window loses for each of these that the relay dir does not have (so nothing was linked)
  const unlinked = { projects: `/provider switch refuses until ${path.join(dir, 'projects')} and ${path.join(cfgDir, 'projects')} are one folder (doctor prints the command once yours exists)`, 'settings.json': `${name}'s window has no relay wiring from your settings.json`, plugins: `the plugin does not run in ${name}'s window, so it is never registered with the router` }
  for (const [n, cost] of Object.entries(unlinked)) if (!links.includes(n)) console.log(`  ⚠ ${path.join(cfgDir, n)} does not exist, so it is not linked: ${cost}`)
  const overrides = loginOverrides()
  if (overrides.length) console.log(`  ⚠ ${overrideText(overrides)}`)
  // A10: the two ways of using a second account carry different risk, and only the second has substitution. The note
  // fits the mode the config is in: a warning where the relay is already set to send with a token, else a plain note
  const mode = modeName(config)
  console.log(mode === 'rc-keep' || mode === 'api-only'
    ? `  ⚠ accountFallback.mode is "${mode}": once ${name} is in failover.chain, your requests go on with ${name}'s token and its identity values in place of yours, which can conflict with Anthropic's terms of use; that risk is yours.`
    : `  Terms: moving a window to ${name} (mode "switch") uses ${name}'s own login and replaces nothing. Only the token steps below (rc-keep, api-only, fallback lists) send your requests with ${name}'s token and its identity values in place of yours, which can conflict with Anthropic's terms of use; that risk is yours.`)
  const inDir = (rest) => loginCmd(dir, rest)
  const tokenSteps = hasKeychain
    ? [
        '  4. step 5 adds to your default keychain, and the router reads only login.keychain-db: `security default-keychain` must print it (if it does not, run `security default-keychain -s ~/Library/Keychains/login.keychain-db` first)',
        `  5. security add-generic-password -s model-relay-${name} -a ${name} -w   (-w last, so it asks for the token instead of taking it on the command line)`,
        `  6. ${cliCmd('account-sync', name)}, then ${tokenCmd(name)}`,
      ]
    : [
        `  4. keep the token in the variable ${tokenVar(name)}, set permanently for your OS so Claude Code starts with it (keychain: tokens work on macOS only), then restart Claude Code`,
        `  5. ${cliCmd('account-sync', name)}, then ${tokenCmd(name)}`,
      ]
  console.log([
    'Next, by hand (nothing here touches the keychain):',
    // a mode that is on already (rc-keep, api-only) is not turned down to "switch": the login window is then not registered,
    // and the router passes a request that carries another login on as sent
    `  1. ${mode === 'rc-keep' || mode === 'api-only' ? `accountFallback.mode stays "${mode}": the login window of step 2 is not registered, and the router passes on as sent a request that carries another login` : `${cliCmd('set', 'accountFallback.mode', 'switch')}   (first: the plugin registers a window only in this mode, and the login window of step 2 should be registered)`}`,
    `  2. ${inDir('')}, then /login as that account`,
    `  For windows that /provider switch moves to ${name} (mode "switch", each account on its own login), that is all; then:`,
    `     ${cliCmd('set', 'accountFallback.account', name)}`,
    `     ${cliCmd('launcher')}   (prints the command to start Claude Code with in place of claude)`,
    `  The rest only when the relay itself sends with ${name}'s token (rc-keep, api-only, or a fallback list in switch):`,
    `  3. ${inDir(' setup-token')}, then clear the terminal scrollback: it printed the token`,
    ...tokenSteps,
    ...modeSteps(config, name, true).map((l, i) => `  ${i ? '   ' : `${tokenSteps.length + 4}. `}${l}`),
  ].join(LF))
  process.exit(0)
}

// accounts.<name>.fallback from the command line: the accounts whose providers entry <name>'s windows go on with at its
// usage limit, in order. Every target must be another account in accounts (with a configDir), not the relay's own
// account, and named once; the rest of the router's rule (a kind "anthropic" providers entry it accepts) is checked by
// fallbackScan on a copy in mode "switch" and told as warnings, so account-add, account-sync, account-token and this
// command can come in any order. A refusal is a fixed text: a word given here may be a pasted secret, so none is echoed.
if (cmd === 'account-fallback') {
  const refuse = (text) => {
    console.error(`account-fallback: ${text}. Nothing was changed.`)
    process.exit(2)
  }
  const rest = args.slice(1)
  const at = rest.indexOf('--allow-cross-org')
  const cross = at >= 0 ? rest.splice(at, 2)[1] : null
  if (rest.length !== 2 || (at >= 0 && !cross) || rest.includes('--allow-cross-org')) refuse('usage: account-fallback <account> <account>[,<account>...] [--allow-cross-org <account>[,<account>...]], or account-fallback <account> none')
  const { file, raw: config } = loadRaw()
  const view = L.accountView(config, false, where)
  const name = rest[0].trim().toLowerCase()
  if (!L.SAFE_NAME.test(name) || !view.names.has(name)) refuse('the first <account> is not the name of an account in accounts (with a configDir); make one with account-add <name>')
  const key = Object.keys(config.accounts).find((k) => k.trim().toLowerCase() === name)
  const { fallback: old, ...entry } = config.accounts[key]
  let written
  if (rest[1] === 'none') {
    if (cross) refuse('--allow-cross-org goes with a target list, not with none')
    if (old === undefined) {
      console.log(`accounts.${name} has no fallback list; nothing to change`)
      process.exit(0)
    }
    config.accounts[key] = entry
  } else {
    const targets = names(rest[1])
    if (!targets.length) refuse('give at least one target account, or none')
    for (const t of targets) if (!L.SAFE_NAME.test(t) || !view.names.has(t)) refuse('every target must be the name of an account in accounts (with a configDir)')
    if (targets.includes(name)) refuse('an account cannot be its own fallback')
    if (view.self && targets.includes(view.self)) refuse('the relay\'s own account (its configDir is this config dir) is never a fallback')
    if (new Set(targets).size !== targets.length) refuse('a target is named twice')
    const crossed = new Set(cross ? names(cross) : [])
    if (cross && !crossed.size) refuse('--allow-cross-org needs at least one account')
    for (const t of crossed) if (!targets.includes(t)) refuse('every --allow-cross-org account must also be in the target list')
    const list = targets.map((t) => (crossed.has(t) ? { account: t, allowCrossOrg: true } : t))
    written = list.length === 1 && typeof list[0] === 'string' ? list[0] : list
    config.accounts[key] = { ...entry, fallback: written }
  }
  saveRaw(file, config, BACKUP)
  console.log(written === undefined
    ? `✓ accounts.${name}.fallback removed, in ${file} (the previous file is kept as ${path.basename(file)}.${BACKUP})`
    : `✓ accounts.${name}.fallback is ${JSON.stringify(written)}, in ${file} (the previous file is kept as ${path.basename(file)}.${BACKUP})`)
  if (written === undefined) process.exit(0)
  const crossNames = (Array.isArray(written) ? written : []).filter((e) => isObj(e)).map((e) => e.account)
  if (crossNames.length) console.log(`  ⚠ allowCrossOrg: at ${name}'s usage limit its conversation can go on with ${crossNames.join(', ')} in another organization, so the conversation crosses that organization's boundary`)
  // the router's whole rule, as if the mode were switch already
  const asSwitch = { ...config, accountFallback: { ...(isObj(config.accountFallback) ? config.accountFallback : {}), mode: 'switch' } }
  const problems = L.fallbackProblems(asSwitch, view.self).filter((p) => p.account === name)
  for (const p of problems) console.log(`  ⚠ ${p.why}; until that is fixed the router skips that entry`)
  if (problems.length) console.log(`  Each target needs a Claude account entry with a token: ${cliCmd('account-sync', '<account>')}, then ${cliCmd('account-token', '<account>', hasKeychain ? 'keychain:<service>/<account>' : 'env:<VAR>')}`)
  if (modeName(config) !== 'switch') console.log(`  ⚠ accounts.${name}.fallback is read only when accountFallback.mode is "switch" (now "${modeName(config)}"): ${cliCmd('set', 'accountFallback.mode', 'switch')}`)
  process.exit(0)
}

// providers.<name>.token as a reference, never a value: env:<VAR>, or keychain:<service>/<account> on macOS. Anything
// else is refused before the config is read, and no refusal echoes what was given: it may be a pasted secret, already in
// the shell history. The window's own credential variables are refused as env: names. The entry is a Claude account
// (kind "anthropic"), made when there is none; any other kind of provider is refused.
if (cmd === 'account-token') {
  const refuse = (text, exposed = true) => {
    console.error(`account-token: ${text}. Nothing was changed.${exposed ? ' If you pasted a token here, treat it as exposed: revoke it and make a new one with claude setup-token.' : ''}`)
    process.exit(2)
  }
  const refs = `env:<VAR>${hasKeychain ? ' or keychain:<service>/<account>' : ''}`
  if (args.length !== 3) refuse(`usage: account-token <name> ${refs}`)
  // a part of a reference is never long, and never holds token-looking text, at the start or anywhere in it
  const tooLong = (s) => s.length > 64 || /sk-ant-/i.test(s)
  const name = args[1].trim().toLowerCase()
  if (!plainName(name) || name === 'claude') refuse('<name> must be a provider name: a lower-case word of letters, digits, ".", "_" or "-"')
  refuseReservedName(name)
  const given = args[2]
  let token = ''
  if (given.startsWith('env:')) {
    const v = given.slice(4)
    if (tooLong(v) || !ENV_NAME.test(v)) refuse('env:<VAR> must name a variable: a letter or "_", then letters, digits or "_", 64 characters at most')
    if (OWN_CREDENTIALS.includes(v.toUpperCase())) refuse(`env: cannot name ${OWN_CREDENTIALS.join(', ')}: those are the window's own credentials, not another account's`, false)
    token = `env:${v}`
  } else if (given.startsWith('keychain:')) {
    if (!hasKeychain) refuse('keychain: tokens work on macOS only; here keep the token in a variable and use env:<VAR>')
    const k = L.keychainRef(given)
    if (!k || given !== `keychain:${k.ref}` || tooLong(k.service) || tooLong(k.account)) refuse('keychain: must be keychain:<service>/<account>, each a word of letters, digits, ".", "_", "@" or "-" that does not start with "-", 64 characters at most')
    token = `keychain:${k.ref}`
  } else refuse(`the token must be a reference, ${refs}, never the token itself`)
  const { file, raw: config } = loadRaw()
  const existing = Object.keys(config.providers).find((k) => k.trim().toLowerCase() === name)
  const entry = existing === undefined ? { kind: 'anthropic' } : config.providers[existing]
  if (!isObj(entry) || entry.kind !== 'anthropic') refuse('providers.<name> exists and is not a Claude account (kind "anthropic"); account-token sets only an account\'s token', false)
  if (entry.token === token) {
    console.log(`providers.${name}.token is already ${token}`)
    process.exit(0)
  }
  // a token written as a value before: the backup made now keeps it
  const was = entry.token === undefined ? '' : tokenSource(entry.token)
  config.providers[existing ?? name] = { ...entry, token }
  saveRaw(file, config, BACKUP)
  console.log(`✓ providers.${name}.token is ${token}${existing === undefined ? ' (a new Claude account entry, kind "anthropic")' : ''}, in ${file}`)
  if (was === 'inline' || was.endsWith('(malformed)')) console.log(`  ⚠ ${file}.${BACKUP} still holds the token that was written there as a value before; delete that file`)
  if (token.startsWith('env:')) console.log(`  ${token.slice(4)} must be set where Claude Code starts, since the router reads it from there; restart Claude Code after setting it`)
  if (!L.UUID_RE.test(String(entry.accountUuid || ''))) console.log(`  Next: ${cliCmd('account-sync', name)} (copies that account's ids from its login; needs accounts.${name}.configDir)`)
  process.exit(0)
}

// /provider switch, in a window the launcher wrapper started: <config dir>/model-relay-handoff/<wrapper id>.json =
// {"sid": "<session id>"}, read by the wrapper once this window exits. The folder is 0700 and never a symlink; the file
// is written 0600 under a fresh name opened exclusively (O_EXCL, O_NOFOLLOW), then renamed over the old one, so the
// wrapper reads a whole file or none. Both ids must be UUIDs, so neither can name another path.
if (cmd === 'handoff') {
  const [id, sid] = [args[1], args[2]]
  const isUuid = (v) => typeof v === 'string' && L.UUID_RE.test(v)
  if (!isUuid(id) || !isUuid(sid)) {
    console.error('Usage: node tools/setup.mjs handoff <wrapper id> <session id> (both UUIDs). Nothing was written.')
    process.exit(2)
  }
  const dir = path.join(cfgDir, 'model-relay-handoff')
  const fail = (text) => {
    console.error(`${text}. Nothing was written.`)
    process.exit(1)
  }
  let isDir = false
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
    isDir = fs.lstatSync(dir).isDirectory()
    if (isDir && process.platform !== 'win32') fs.chmodSync(dir, 0o700)
  } catch {
    fail(`${dir} could not be created or made private`)
  }
  if (!isDir) fail(`${dir} is not a folder (a symlink is refused)`)
  const file = path.join(dir, `${id.toLowerCase()}.json`)
  const tmp = path.join(dir, `.${id.toLowerCase()}.${process.pid}.${Date.now()}.tmp`)
  try {
    writeExclusive(tmp, file, JSON.stringify({ sid: sid.toLowerCase() }) + LF)
  } catch {
    fail(`${file} could not be written`)
  }
  console.log(`✓ Handed this session to the launcher wrapper (${file})`)
  process.exit(0)
}

// launcher: <config dir>/model-relay-launch.mjs, a few lines that run tools/launch.mjs of this copy of the plugin (root,
// from this file's own location), so one alias in place of claude keeps working across plugin updates: the plugin runs
// this command at every session start, which points the file at the version running. This is the one place that file
// is written (writeExclusive: 0600, never through a link); a symlink at its path is refused, and a file that already
// holds the same text with mode 0600 is left alone. It reads no config and prints the command and the aliases.
if (cmd === 'launcher') {
  const { launcherSource } = await import('./launch.mjs')
  const file = path.join(cfgDir, 'model-relay-launch.mjs')
  const text = launcherSource(root)
  const fail = (t) => {
    console.error(`${t}. Nothing was written.`)
    process.exit(1)
  }
  let st = null
  try {
    st = fs.lstatSync(file)
  } catch {}
  if (st && st.isSymbolicLink()) fail(`${file} is a symlink; remove it, then run launcher again`)
  if (st && !st.isFile()) fail(`${file} is not a regular file`)
  const same = Boolean(st) && fs.readFileSync(file, 'utf8') === text && (process.platform === 'win32' || (st.mode & 0o777) === 0o600)
  if (!same) {
    try {
      fs.mkdirSync(cfgDir, { recursive: true })
      writeExclusive(path.join(cfgDir, `.model-relay-launch.${process.pid}.${Date.now()}.tmp`), file, text)
    } catch {
      fail(`${file} could not be written`)
    }
  }
  const run = `node ${shWord(file)}`
  console.log(same ? `${file} already runs ${path.join(root, 'tools', 'launch.mjs')}` : `✓ wrote ${file}, which runs ${path.join(root, 'tools', 'launch.mjs')}`)
  console.log([
    'Start Claude Code with this in place of claude, from your project folder (claude starts there, through the launcher wrapper):',
    `  ${run} [claude options]`,
    'zsh or bash (in ~/.zshrc or ~/.bashrc):',
    `  alias claude=${shWord(run)}`,
    'PowerShell (in $PROFILE):',
    `  function claude { node '${file.replace(/'/g, "''")}' @args }`,
    'Use an alias or a function like these, never a script named claude on PATH: the wrapper starts claude from PATH and would start itself.',
    'While accountFallback.mode is not "off", each Claude Code session start points this file at the plugin version running, so the alias survives plugin updates.',
  ].join(LF))
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

// Whether a /__health answer is a model-relay router's, whose pid may be killed; any other JSON on the port is not
const isRouter = (h) => h.ok === true && Number.isInteger(h.pid) && h.pid > 1

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
  if (h && !isRouter(h)) {
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
  const settings = readSettingsOrExit()
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
    if (h && isRouter(h) && !h.proxy) {
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

// doctor, mode switch: each account's login file (path only, and whether it names an account), the relay's own account,
// and each fallback list entry by entry with why it is or is not used now (the router's own rules: L.fallbackEntries and
// L.fallbackRefusal). Names, paths and fixed texts only: never a uuid, an email or a value that names no account.
async function accountReport(raw, cfg, say, find, error) {
  const view = L.accountView(raw, false, where)
  const selves = L.selfAccounts(raw, where)
  if (selves.length > 1) error('account-self', `accounts ${selves.join(', ')} all have this relay's own config directory as configDir; at most one may (the relay's own account), so none counts`)
  const names = [...view.names].filter((n) => L.SAFE_NAME.test(n))
  const fileOf = (n) => L.loginFile(L.expandHome(view.dirs.get(n), home), home)
  const ids = (n) => (view.dirs.has(n) ? L.loginIds(fileOf(n)) : null)
  const byFile = new Map()
  const byUuid = new Map()
  const mine = L.loginIds(L.loginFile(cfgDir, home)) // your own login: the account a window leaves when it switches
  for (const n of names) {
    const file = fileOf(n)
    const got = L.loginIds(file)
    say(`  Login of ${n}${n === view.self ? ' (the relay\'s own account)' : ''}: ${file} (${got ? (got.accountUuid ? 'an accountUuid found' : 'no accountUuid in it') : 'not readable'})`)
    const key = L.realDir(file)
    byFile.set(key, [...(byFile.get(key) || []), n])
    if (got && got.accountUuid) byUuid.set(got.accountUuid, [...(byUuid.get(got.accountUuid) || []), n])
    const dir = L.expandHome(view.dirs.get(n), home)
    if (!(got && got.accountUuid)) find('account-not-logged-in', `${n} is not logged in yet: run ${loginCmd(dir)}, then /login there`, { account: n })
    else if (n !== view.self && mine && mine.accountUuid === got.accountUuid) find('account-is-yours', `${n} is logged in to your own account (the login of ${cfgDir}), so /provider switch would move a window to the account it is on; run ${loginCmd(dir)}, then /logout and /login as another account there`, { account: n })
    if (fs.existsSync(path.join(dir, '.config.json'))) find('account-config-json', `${path.join(dir, '.config.json')} exists; the relay reads ${file} only for ${n}'s login. If ${n}'s windows show another account than that file names, move ${path.join(dir, '.config.json')} aside and /login there again`, { account: n })
  }
  for (const same of byFile.values()) if (same.length > 1) error('account-same-login', `accounts ${same.join(', ')} read one login file; each account needs a login of its own`)
  for (const same of byUuid.values()) if (same.length > 1) error('account-same-login', `accounts ${same.join(', ')} are logged in to one account; each needs a login of its own`)
  // the default dir keeps its login beside it; a stale copy inside it is not what Claude Code or the relay read
  const outer = L.sameDir(cfgDir, path.join(home, '.claude')) ? L.loginIds(path.join(home, '.claude.json')) : null
  const inner = outer ? L.loginIds(path.join(home, '.claude', '.claude.json')) : null
  if (outer && inner && outer.accountUuid && inner.accountUuid && outer.accountUuid !== inner.accountUuid) {
    find('account-stale-login', `${path.join(home, '.claude', '.claude.json')} names another account than ${path.join(home, '.claude.json')}; the relay and Claude Code read ${path.join(home, '.claude.json')} for ${cfgDir}`)
  }
  for (const [a, entries] of L.fallbackEntries(raw, view.self)) {
    const parts = entries.map((e) => {
      const label = e.name || '(an entry that names no account)'
      if (e.why) return `✗ ${label} (${e.why})`
      const p = cfg.providers[e.name]
      if (!p) return `✗ ${label} (its token does not resolve, see above)`
      // a login that is not there yet is not an organization mismatch: say to log in, with the command
      const missing = [a, e.name].filter((n) => view.dirs.has(n) && !(ids(n) || {}).accountUuid)
      const refusal = L.fallbackRefusal(a, p, e.allowCrossOrg, ids)
      const why = refusal && (missing.map((n) => `${n} is not logged in yet: run ${loginCmd(L.expandHome(view.dirs.get(n), home))}, then /login there`).join('; ') || refusal)
      if (why) {
        find('account-fallback-skipped', `${a}'s fallback ${e.name} is skipped: ${why}`, { account: a, provider: e.name })
        return `✗ ${label} (${why})`
      }
      return `✓ ${label} (${e.allowCrossOrg ? 'allowCrossOrg' : 'same organization'})`
    })
    say(`  Fallback of ${a}${a === view.self ? ' (the relay\'s own account)' : ''}: ${parts.join(', ')}`)
  }
  // /provider switch and the wrapper refuse unless the target's projects/ is yours, since --resume needs the transcript
  const to = isObj(raw.accountFallback) && typeof raw.accountFallback.account === 'string' ? raw.accountFallback.account.trim().toLowerCase() : ''
  if (names.includes(to)) {
    const [from, at] = [path.join(cfgDir, 'projects'), path.join(L.expandHome(view.dirs.get(to), home), 'projects')]
    if (!L.sameDir(at, from)) {
      const { linkCommand } = await import('./launch.mjs')
      find('account-projects', `${to}'s projects folder is not this config dir's, so /provider switch refuses (--resume could not find the conversation). Make ${at} a link to ${from} (move or remove ${at} first): ${linkCommand(from, at, platform === 'win32')}`, { account: to })
    }
  }
  const overrides = loginOverrides()
  if (overrides.length) find('account-login-override', overrideText(overrides))
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
  // a config the router reads in a way you did not mean: doctor ends with exit code 1
  const error = (id, text, extra = {}) => {
    findings.push({ id, level: 'error', text, ...extra })
    say(`  ✗ ${text}`)
    report.ok = false
    process.exitCode = 1
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
  const cfg = (!outdated && parseCfg(raw)) || L.bareCfg(raw)
  const names = Object.keys(cfg.providers)
  const rawChain = outdated ? [] : L.lowerNames(isObj(raw.failover) ? raw.failover.chain : [])
  report.port = cfg.port
  report.providers = Object.fromEntries(names.map((k) => [k, L.modelLabel(cfg.providers[k])]))
  report.failover = { enabled: cfg.failoverEnabled, chain: cfg.failoverChain, cooldownMs: cfg.cooldownMs }
  report.retry = { enabled: cfg.retry.enabled }
  // An older config is not judged: only a router of that older version, if one still runs, routes with it
  const notRead = 'not read (older config)'
  // Accounts alone need no provider: with none configured and accounts to switch to, the empty list is not a problem
  const accountsOnly = !outdated && !names.length && (!isObj(raw.providers) || !Object.keys(raw.providers).length) && L.accountMode(raw) === 'switch' && L.accountView(raw).names.size > 0
  say(outdated
    ? `Config from an older version (${active}): this version reads its port only, so until "migrate --go" only an older router still running routes with it; with none running, every request goes to Claude`
    : names.length ? `Config OK (${active})` : accountsOnly ? `Config OK (${active}); no provider is configured, which accounts alone do not need, so every request goes to Claude` : `Config read (${active}), but no provider is usable yet; every request goes to Claude`)
  say(`  Port: ${cfg.port}`)
  say(`  Providers: ${outdated ? notRead : names.length ? names.map((k) => `${k} -> ${L.modelLabel(cfg.providers[k])}`).join(', ') : 'none usable'}`)
  // fix: the arguments to run this CLI with, so the caller supplies its own path to it
  if (outdated) find('outdated', `${active} is from an older version of model-relay, which this version does not read; "migrate" shows what it becomes and "migrate --go" applies it`, { fix: 'migrate --go', needsConsent: true })
  for (const u of outdated ? [] : L.unresolvedEnv(raw, process.env, keychainExists, false, where)) {
    if (u.keychain !== undefined && !hasKeychain) {
      find('missing-key', `provider ${u.provider} is skipped: keychain: tokens work on macOS only; here keep the token in a variable and use ${cliCmd('account-token', u.provider, 'env:<VAR>')}`, { provider: u.provider, keychain: u.keychain })
      continue
    }
    if (u.keychain === '') {
      find('missing-key', `provider ${u.provider} is skipped: its token "keychain:" names no item; write it as keychain:<service>/<account>`, { provider: u.provider, keychain: '' })
      continue
    }
    if (u.malformed) {
      find('missing-key', `provider ${u.provider} is skipped: its keychain: reference is malformed; write it as keychain:<service>/<account>`, { provider: u.provider, keychain: u.keychain })
      continue
    }
    if (u.keychain !== undefined) {
      find('missing-key', `provider ${u.provider} is skipped: keychain item ${u.keychain} (service/account) is not in the login keychain, or is not written as keychain:<service>/<account>`, { provider: u.provider, keychain: u.keychain })
      continue
    }
    find('missing-key', u.env
      ? `provider ${u.provider} is skipped: its key variable ${u.env} is unset in this shell. Set it permanently for your OS, then restart Claude Code so the router starts with it`
      : `provider ${u.provider} is skipped: its token "env:" names no variable`, { provider: u.provider, env: u.env || null })
  }
  for (const a of outdated ? [] : L.accountProblems(raw)) find('account-skipped', `provider ${a.provider} is skipped: ${a.why}`, { provider: a.provider })
  if (!outdated && isObj(raw.accountFallback) && raw.accountFallback.mode !== undefined && !L.ACCOUNT_MODES.includes(raw.accountFallback.mode)) {
    find('account-mode', `accountFallback.mode is not one of ${L.ACCOUNT_MODES.join(', ')}, so it counts as "off": no second account is used`)
  }
  if (!shape && !outdated && !accountsOnly) find('no-provider', 'no provider has an address, a model and a token yet; add one with "add <name> --preset <p> --model <id> --token env:<VAR>"', { fix: 'add <name> --preset <preset> --model <model id> --token env:<VAR>' })
  say(outdated
    ? `  Failover, retry: ${notRead}`
    : `  Failover: ${cfg.failoverEnabled ? (cfg.failoverChain.length ? `${cfg.failoverChain.join(' → ')} (back to Claude after ${cfg.cooldownMs / 60000} min)` : rawChain.length ? 'on, but no usable entry in the chain' : 'on, but no chain') : 'disabled'}    Retry: ${cfg.retry.enabled ? 'on' : 'off'}`)
  // What accountFallback.mode does now, in one line: where a window goes (switch) or which Claude accounts take over
  // from your usage limit (rc-keep, api-only). Names only; "off" prints nothing, as without this feature.
  if (!outdated && L.accountMode(raw) !== 'off' && L.ACCOUNT_MODES.includes(L.accountMode(raw))) {
    const m = L.accountMode(raw)
    if (m === 'switch') {
      const to = isObj(raw.accountFallback) && typeof raw.accountFallback.account === 'string' ? raw.accountFallback.account.trim().toLowerCase() : ''
      const known = L.SAFE_NAME.test(to) && L.accountView(raw, false, where).dirs.has(to)
      say(`  Accounts: mode "switch"; ${known ? `/provider switch moves a window to ${to}` : to ? 'accountFallback.account names no account in accounts (with a configDir), so /provider switch has nowhere to go' : 'accountFallback.account is not set, so /provider switch has nowhere to go'}`)
      if (isObj(raw.accounts)) await accountReport(raw, cfg, say, find, error)
    } else {
      const ready = cfg.failoverChain.filter((n) => L.isAccount(cfg.providers[n]))
      say(`  Accounts: mode "${m}"; ${ready.length ? `at your usage limit failover.chain goes on with ${ready.map((n) => `✓ ${n}`).join(', ')} (Claude accounts whose token resolves)` : 'no Claude account in failover.chain that can send yet, so nothing sends with a token'}`)
    }
  }

  let curSettings = {}
  try { curSettings = readSettings() } catch {}
  const curEnv = curSettings?.env || {}
  const routedAliases = L.detectAliases(cfg)
  const aliasDesc = []
  for (const [slot, envKey] of Object.entries(ALIAS_ENV_KEYS)) {
    const p = routedAliases[slot]
    const envVal = curEnv[envKey]
    if (p || envVal) {
      aliasDesc.push(`${slot} -> ${p ? `${p} (${cfg.providers[p] ? L.modelLabel(cfg.providers[p]) : p})` : 'claude'}${envVal ? ` [${envKey}=${envVal}]` : ''}`)
    }
  }
  if (curEnv.CLAUDE_CODE_SUBAGENT_MODEL) aliasDesc.push(`subagent default -> ${curEnv.CLAUDE_CODE_SUBAGENT_MODEL}`)
  say(`  Aliases:  ${outdated ? notRead : aliasDesc.length ? aliasDesc.join(', ') : 'none (run "node tools/setup.mjs alias haiku <provider>" to route haiku)'}`)

  // ---- the config itself: names that go nowhere, a model another provider claims first ----
  // a fallbackOnly account serves a fallback list and never the chain, so it is no reason to ask for a chain
  if (cfg.failoverEnabled && names.some((n) => !cfg.providers[n].fallbackOnly) && !cfg.failoverChain.length) {
    if (rawChain.length) find('no-chain', 'failover is on but none of the names in its chain is usable, so a usage-limit 429 from Claude is passed back as it is; the lines about those names say why each is skipped')
    else find('no-chain', 'failover is on but has no chain, so a usage-limit 429 from Claude is passed back as it is; name who takes over with "set failover.chain <a,b>"', { fix: 'set failover.chain <a,b>' })
  }
  const wanted = outdated ? [] : L.lowerNames(raw.failover?.chain)
  for (const v of outdated || !isObj(raw.providers) ? [] : Object.values(raw.providers)) if (Array.isArray(v?.fallback)) wanted.push(...L.lowerNames(v.fallback))
  // A Claude account the mode leaves unused is not an unknown name: say which mode drops it
  // nor is a fallback account (accounts.<name>.fallback): only its accounts' windows use it, never main's failover
  const owners = outdated ? new Map() : fallbackOwners(raw)
  const idle = new Set(L.accountActive(raw) || !isObj(raw.providers) ? [] : Object.entries(raw.providers).filter(([, v]) => isObj(v) && v.kind === 'anthropic').map(([k]) => k.trim().toLowerCase()).filter((k) => !owners.has(k)))
  const idleNamed = [...new Set(wanted.filter((n) => idle.has(n)))]
  if (idleNamed.length) find('account-unused', `failover names ${idleNamed.join(', ')}, a Claude account that accountFallback.mode "${L.accountMode(raw)}" leaves unused (only rc-keep and api-only use it); it is skipped`, { mode: L.accountMode(raw) })
  for (const n of new Set(wanted.filter((x) => owners.has(x)))) {
    find('account-fallback-only', `failover names ${n}, the fallback account of ${owners.get(n).join(', ')}'s windows (accounts.<name>.fallback); your failover skips it`, { provider: n })
  }
  for (const f of outdated ? [] : L.fallbackProblems(raw, L.selfOf(raw, where))) find('account-fallback', `${f.why}; that account's windows get its usage-limit 429 as it comes`, { account: f.account })
  // the router reads fallback lists in mode switch only (L.fallbackScan): elsewhere they do nothing, silently
  const unread = outdated || L.accountMode(raw) === 'switch' || !isObj(raw.accounts) ? []
    : Object.entries(raw.accounts).filter(([k, v]) => isObj(v) && v.fallback !== undefined && L.SAFE_NAME.test(k.trim().toLowerCase())).map(([k]) => `accounts.${k.trim().toLowerCase()}.fallback`)
  if (unread.length) find('account-fallback-mode', `${unread.join(', ')} ${unread.length > 1 ? 'are' : 'is'} read only when accountFallback.mode is "switch" (now "${modeName(raw)}"), so no window falls back to another account; to use ${unread.length > 1 ? 'them' : 'it'}: ${cliCmd('set', 'accountFallback.mode', 'switch')}`, { fix: 'set accountFallback.mode switch', needsConsent: true })
  const unknown = [...new Set(wanted.filter((n) => n && !names.includes(n) && !idle.has(n) && !owners.has(n)))]
  if (unknown.length) find('unknown-name', `failover names ${unknown.join(', ')} but no such usable provider exists; they are skipped`)
  for (const [k, p] of Object.entries(cfg.providers)) {
    const taker = L.matchProviderByModel(cfg, p.model)
    if (taker && taker !== k) find('model-claimed', `requests for ${p.model} go to ${taker}, not ${k}: ${taker} matches that name first (narrow its matchModels)`)
  }
  for (const [, envKey] of outdated ? [] : Object.entries(ALIAS_ENV_KEYS)) {
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
    const blocked = [...new Set(Object.values(shape?.providers || {}).filter((p) => !L.isAccount(p)).map((p) => p.model))]
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
      // restart refuses an older config, and this version's router could not read it: migrate comes first
      if (olderRouter(h) && outdated) say(`  Router health: ⚠ an older model-relay router (no configDir) answers on 127.0.0.1:${cfg.port} and keeps routing with the older config; restart it once "migrate --go" is done`)
      else if (olderRouter(h)) {
        say(`  Router health: ⚠ ${olderNote(cfg.port)}`)
        findings.push({ id: 'router-older', level: 'warn', text: olderNote(cfg.port), fix: 'restart --if-idle' })
      }
      const foState = h.failoverSince ? `active since ${new Date(h.failoverSince).toISOString().slice(11, 19)}Z` : 'idle'
      const pxState = h.proxy ? `proxy ${h.proxy.enabled ? 'on' : 'off'} (${h.proxy.mitm} routed / ${h.proxy.tunnel} tunnelled)` : 'no proxy'
      say(`  Router health: ✓ up on 127.0.0.1:${cfg.port} (pid ${h.pid}${h.version ? `, ${h.version}` : ''}, pinned sessions: ${h.sessionsOnCustom ?? 0}, 429 failover: ${foState}, ${pxState})`)
      const mine = pluginVersion()
      if (!outdated && h.version && mine && compareVersions(h.version, mine) < 0) {
        find('router-older', `the running router is ${h.version} and this tool is ${mine}, so the router still runs the older code; run "/provider restart" (or "restart") when no reply is in progress`, { fix: 'restart --if-idle' })
      }
      // the router resolves env:VAR from the environment it was started with, which may differ from this shell's;
      // a variable unset here as well is already a missing-key finding
      // (a keychain item it could not read needs no finding: the router reads a failed item again when model-relay.json changes)
      for (const u of Array.isArray(h.unresolved) ? h.unresolved : []) {
        if (u.env && process.env[u.env]) {
          find('router-env', `The running router was started without ${u.env}, so provider ${u.provider} is skipped there although this shell has it. Stop the router (kill ${h.pid}) and start Claude Code from this shell so the new router inherits it`, { provider: u.provider, env: u.env })
        }
      }
    }
  }

  if (hasFlag('--ping') && outdated) say(`  Upstream ping: skipped, the config is ${notRead}`)
  else if (hasFlag('--ping')) {
    say('  Upstream ping:')
    report.ping = {}
    for (const [k, p] of Object.entries(cfg.providers)) {
      // This CLI holds no keychain secret, and a test request would spend a Claude account's subscription
      const skip = L.isAccount(p) ? 'anthropic account' : p.keychain ? 'token in the keychain; /provider ping tests it through the router' : ''
      if (skip) {
        report.ping[k] = { verdict: 'not-pinged', detail: skip }
        say(`    - ${k.padEnd(10)} (${L.modelLabel(p)}) -> not pinged (${skip})`)
        continue
      }
      const r = await P.ping(p)
      report.ping[k] = r
      say(`    ${r.verdict === 'ok' ? '✓' : '✗'} ${k.padEnd(10)} (${p.model}) -> ${pingWords(r, p)}`)
    }
  }
  if (!json && !report.ok) console.log('Not OK after all: fix the ✗ lines above ("Config OK" only says the file was read).')
  if (json) console.log(JSON.stringify(report, null, 2))
  else if (wiring.fixable) console.log('The settings.json fix above is not applied yet: run "/provider doctor --fix" (or "node tools/setup.mjs doctor --fix").')
} else {
  console.error('Usage: node tools/setup.mjs [init|presets|add|providers|alias|set|remove|migrate|doctor|check|restart|proxy|rc|account-add|account-sync|account-fallback|account-token|handoff|launcher] [--fix] [--ping] [--json] [--go]')
  process.exit(2)
}
