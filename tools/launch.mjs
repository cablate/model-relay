#!/usr/bin/env node
// The launcher wrapper for accountFallback mode "switch".
// Usage: node tools/launch.mjs [args…]                  runs claude [args…]
//        node tools/launch.mjs -- <launcher> [args…]     runs <launcher> [args…] (a missing launcher is claude)
// CLAUDE_CONFIG_DIR, when the window uses its own config dir, must be in this wrapper's environment already.
//
// Everything is keyed on the child's config dir (CLAUDE_CONFIG_DIR, else ~/.claude): its model-relay.json and its
// model-relay-handoff folder. With no model-relay.json there, or a mode that is off (or unknown), the launcher runs with
// exactly the argv and environment it was given: nothing added, nothing read afterwards.
// Otherwise:
// - the first launch gets the same argv plus MODEL_RELAY_WRAPPER_ID (a fresh UUID);
// - in switch, after the child exits 0, <dir>/model-relay-handoff/<that id>.json (written by /provider switch) may name
//   the session to resume. It must be a regular file (lstat, no symlink) written after the child started, holding a
//   UUID sid. The account comes from accountFallback.account and its configDir from accounts.<account>, never from the
//   file. Both config dirs' projects/ must resolve to one folder, or --resume would not find the transcript.
//   The relaunch, at most one, gets only --model, --permission-mode and --effort from the original argv, --resume=<sid>
//   as one element and --settings with autoMemoryDirectory (the names of the other options are printed, never their
//   values, so a dropped --add-dir or --mcp-config is not silent); CLAUDE_CONFIG_DIR is the account's, and the auth
//   variables and ANTHROPIC_BASE_URL of this shell are removed (their names are printed, never their values). It keeps
//   the relay: MODEL_RELAY_CONFIG_DIR names main's config dir, the proxy variables stay, and the router hears of the
//   sid (POST /__account) before the window starts. Only when main's claudeUrl is not Anthropic itself, or main's
//   model-relay.json is gone by then, does the window bypass the relay instead (the proxy variables removed too, and
//   --settings sending it to https://api.anthropic.com). A window that was sent SIGTERM or SIGHUP is never relaunched,
//   whatever its exit code. A window whose config dir is one of the accounts' is passed through untouched.
// No shell anywhere. While a child runs, SIGINT and SIGQUIT are left to it (the terminal sends them to the whole
// group), SIGTERM and SIGHUP are passed on, and a child killed by signal n makes this exit 128+n. SIGTSTP is untouched.
// This wrapper's handoff file is deleted on every way out.

import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { spawn, execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'

const require = createRequire(import.meta.url)
const L = require('../router/logic.js')

// Not passed to the account's window: another login's credentials, and an API address of this shell's
export const DROPPED_VARS = ['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'HTTP_PROXY', 'http_proxy']
// also dropped when the window bypasses the relay: the way into it
const BYPASS_DROPPED_VARS = [...DROPPED_VARS, 'HTTPS_PROXY', 'https_proxy']
const WRAPPED_MODES = L.ACCOUNT_MODES.filter((m) => m !== 'off')
const KEPT_FLAGS = ['--model', '--permission-mode', '--effort'] // all the relaunch takes from the original argv

const say = (text) => process.stderr.write(`model-relay launch: ${text}\n`)

// The command that makes folder `to` a link to folder `from`, quoted for the shell it is pasted into
export function linkCommand(from, to, win = process.platform === 'win32') {
  const ps = (x) => `'${x.replace(/'/g, "''")}'`
  const sh = (x) => (/^[A-Za-z0-9_./:=@%+,-]+$/.test(x) ? x : `'${x.replace(/'/g, `'\\''`)}'`)
  return win ? `New-Item -ItemType SymbolicLink -Path ${ps(to)} -Target ${ps(from)}` : `ln -s ${sh(from)} ${sh(to)}`
}

// Without a leading "--" every word is an argument of claude; with it, the next word is the launcher
export function splitArgv(argv) {
  if (argv[0] !== '--') return { launcher: 'claude', args: argv }
  return { launcher: argv[1] || 'claude', args: argv.slice(2) }
}

const home = (env) => env.USERPROFILE || env.HOME || os.homedir()
export const childConfigDir = (env) => env.CLAUDE_CONFIG_DIR || path.join(home(env), '.claude')

function readJson(file) {
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'))
    return L.isObj(j) ? j : null
  } catch {
    return null
  }
}

// Whether dir is the configDir of an account in the config MODEL_RELAY_CONFIG_DIR names (another dir: main's): a window
// started on a second account's dir is that account's own, and the wrapper leaves it alone in every mode. (A config
// that names its own dir as an account is refused at the relaunch instead.)
export function isAccountDir(dir, env) {
  const relay = env.MODEL_RELAY_CONFIG_DIR || ''
  if (!path.isAbsolute(relay) || !fs.existsSync(relay) || L.sameDir(relay, dir)) return false
  const cfg = readJson(path.join(relay, 'model-relay.json'))
  return Boolean(cfg) && [...L.accountView(cfg).dirs.values()].some((d) => L.sameDir(L.expandHome(d, home(env)), dir))
}

// Whether main's claudeUrl is Anthropic itself, the only case in which the account window may use main's relay
export const claudeIsAnthropic = (cfg) => L.accountView(cfg).claudeIsAnthropic

// Tells main's router that sid is now a window of account (POST /__account), so its Claude requests skip main's
// failover from the first one; a router that does not answer within 2 s is left to the window's hook
export function registerAccount(port, sid, account) {
  return new Promise((resolve) => {
    const data = JSON.stringify({ sid, account })
    const req = http.request({ host: '127.0.0.1', port, path: '/__account', method: 'POST', timeout: 2000, headers: { host: `127.0.0.1:${port}`, 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } }, (res) => {
      res.resume()
      res.on('end', () => resolve(res.statusCode === 200))
    })
    req.on('timeout', () => req.destroy())
    req.on('error', () => resolve(false))
    req.end(data)
  })
}

// What the wrapper does for this config dir: 'pass' (nothing at all) or the mode
export function wrapperMode(dir) {
  const cfg = readJson(path.join(dir, 'model-relay.json'))
  if (!cfg) return { mode: 'pass', cfg: null }
  const mode = L.accountMode(cfg)
  return { mode: WRAPPED_MODES.includes(mode) ? mode : 'pass', cfg }
}

// The options before a lone "--" (after it everything is the prompt)
const optionsPart = (args) => (args.includes('--') ? args.slice(0, args.indexOf('--')) : args)

// --model, --permission-mode and --effort with their values, in either form; a value that looks like an option is dropped
export function keptFlags(args) {
  const out = []
  const opts = optionsPart(args)
  for (let i = 0; i < opts.length; i++) {
    const a = opts[i]
    const eq = a.indexOf('=')
    const name = eq > 0 ? a.slice(0, eq) : a
    if (!KEPT_FLAGS.includes(name)) continue
    const value = eq > 0 ? a.slice(eq + 1) : opts[i + 1]
    if (eq < 0) i++
    if (typeof value === 'string' && value && !value.startsWith('-')) out.push(name, value)
  }
  return out
}

// The option names (never their values) of the original command that the relaunch does not take along: --add-dir,
// --mcp-config and the like. Only a token that starts with "--" counts as a name, so a value that begins with a single "-"
// is never printed. The options the relaunch sets itself (the kept ones, --settings, --resume) are left out, and so is the
// token after them. A value that starts with "--" after a flag this code does not know cannot be told from a name.
const SET_BY_RELAUNCH = [...KEPT_FLAGS, '--settings', '--resume']
export function droppedFlags(args) {
  const opts = optionsPart(args)
  const out = new Set()
  for (let i = 0; i < opts.length; i++) {
    const a = opts[i]
    if (!a.startsWith('--')) continue
    const name = a.split('=')[0]
    if (!SET_BY_RELAUNCH.includes(name)) out.add(name)
    // --resume alone opens a picker: what follows it is an option of its own when it starts with "--"
    else if (!a.includes('=') && (name !== '--resume' || !opts[i + 1]?.startsWith('--'))) i++
  }
  return [...out]
}

// Claude Code's project key, which names the folder under projects/ that holds a project's memory (autoMemoryDirectory): the main repository's root (through
// git's common dir, so a worktree counts as its repository) or else the working directory, every character that is not
// a letter or a digit turned into "-"
export function projectKey(cwd) {
  let root = cwd
  try {
    const common = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 }).trim()
    if (common) root = common.replace(/\/\.git\/?$/, '')
  } catch {}
  return root.replace(/[^A-Za-z0-9]/g, '-')
}

// The keys of main's settings.json env that wire Claude Code to the relay, and the ones the relaunch copies from it, so
// the account window reaches the relay even when its own config dir has a settings.json of its own
export const RELAY_WIRING = ['ANTHROPIC_BASE_URL', 'HTTPS_PROXY', 'NO_PROXY', 'NODE_EXTRA_CA_CERTS']
export function relayWiring(mainDir) {
  const env = readJson(path.join(mainDir, 'settings.json'))?.env
  return Object.fromEntries(RELAY_WIRING.filter((k) => L.isObj(env) && typeof env[k] === 'string' && env[k]).map((k) => [k, env[k]]))
}

// The relaunch's --settings: memory where Claude Code's project key puts it, and the env: your relay wiring, or with
// bypass no relay in between (the account window talks to Anthropic itself, whatever its own settings.json says)
export const BYPASS_ENV = { ANTHROPIC_BASE_URL: 'https://api.anthropic.com', HTTPS_PROXY: '', https_proxy: '' }
export function relaunchSettings(mainDir, cwd, env) {
  return JSON.stringify({ autoMemoryDirectory: path.join(mainDir, 'projects', projectKey(cwd), 'memory'), env })
}

// accountFallback.account and accounts.<account>.configDir, both own keys of the config; null with the reason otherwise
export function accountDir(cfg, env) {
  const af = L.isObj(cfg.accountFallback) ? cfg.accountFallback : {}
  const account = typeof af.account === 'string' ? af.account.trim().toLowerCase() : ''
  if (!L.SAFE_NAME.test(account)) return { why: 'accountFallback.account is not set to a plain account name' }
  const dir = L.accountView(cfg).dirs.get(account)
  if (!dir) return { why: `accounts.${account}.configDir is not set` }
  return { account, dir: L.expandHome(dir, home(env)) }
}

// A file that cannot be removed (a folder in its place, a permission) is left; nothing reads it again
const rmQuiet = (file) => {
  try {
    fs.rmSync(file, { force: true })
  } catch {}
}

// The handoff /provider switch left for this wrapper: { sid } or { why }; the file is gone afterwards either way
export function takeHandoff(file, startedAt) {
  let st
  try {
    st = fs.lstatSync(file)
  } catch {
    return { why: null } // no /provider switch: the window simply ended
  }
  try {
    if (!st.isFile()) return { why: 'the handoff is not a regular file' }
    if (st.mtimeMs < startedAt) return { why: 'the handoff is older than this window' }
    if (st.size > 4096) return { why: 'the handoff is not one small file' }
    const sid = readJson(file)?.sid
    if (!L.UUID_RE.test(String(sid || ''))) return { why: 'the handoff holds no session id' }
    return { sid: String(sid).toLowerCase() }
  } finally {
    rmQuiet(file)
  }
}

const isFile = (p) => {
  try {
    return fs.statSync(p).isFile()
  } catch {
    return false
  }
}

// On Windows, starting a bare name looks in the working directory before PATH, so a claude.exe planted in a project
// folder would run. There a bare launcher is looked up in PATH's absolute entries only (a drive or UNC root; a name
// without an extension as <name>.exe) and that path is started, still without a shell. A launcher with a folder in it
// is the person's own choice and is started as given; elsewhere nothing changes. null: not found.
export function resolveLauncher(launcher, env, win = process.platform === 'win32', exists = isFile) {
  if (!win || /[\\/]/.test(launcher)) return launcher
  const key = Object.keys(env).find((k) => k.toUpperCase() === 'PATH')
  const dirs = String((key && env[key]) || '').split(';').map((d) => d.trim().replace(/^"(.*)"$/, '$1')).filter((d) => /^(?:[A-Za-z]:[\\/]|[\\/]{2}[^\\/])/.test(d))
  const file = path.win32.extname(launcher) ? launcher : `${launcher}.exe`
  for (const d of dirs) if (exists(path.win32.join(d, file))) return path.win32.join(d, file)
  return null
}

// Why a launcher did not start; on Windows a missing one most often is an npm install, whose claude.cmd needs a shell
export function startFailedText(launcher, code, win = process.platform === 'win32') {
  const hint = win && code === 'ENOENT' ? '. On Windows the wrapper starts claude.exe from a folder on PATH, where the native installer puts it; an npm install\'s claude.cmd cannot be started without a shell, so install Claude Code with the native installer, or give the full path: -- C:\\path\\to\\claude.exe' : ''
  return `could not start ${launcher}: ${code || 'error'}${hint}`
}

// The stable launcher file that setup.mjs launcher writes as <config dir>/model-relay-launch.mjs: the plugin folder
// embedded as a JSON string, this file imported through a file: URL (a Windows path is no URL as it is), and main()
// called explicitly, since this file runs itself only when it is the script node was started with. A launch.mjs that
// is gone (the plugin updated or removed) prints the remedy instead of only node's error.
export function launcherSource(root, win = process.platform === 'win32') {
  const target = pathToFileURL((win ? path.win32 : path.posix).join(root, 'tools', 'launch.mjs'), { windows: win }).href
  const remedy = 'model-relay launcher: the plugin folder this file names has no tools/launch.mjs (a plugin update or removal moves it). Start any Claude Code window once, which points this file at the plugin again, or run setup.mjs launcher from the installed plugin.'
  return [
    '// model-relay: runs the launcher wrapper (tools/launch.mjs) of the plugin folder below; use it in place of claude.',
    '// Written by tools/setup.mjs launcher and refreshed at each Claude Code session start, so edits here are overwritten.',
    '// If it fails: start any Claude Code window once, or run setup.mjs launcher.',
    `const root = ${JSON.stringify(root)}`,
    `const target = ${JSON.stringify(target)}`,
    `const remedy = ${JSON.stringify(remedy)}`,
    'let main',
    'try {',
    '  ;({ main } = await import(target))',
    '} catch (e) {',
    '  console.error(`${remedy} (${root}: ${(e && e.code) || e})`)',
    '  process.exit(1)',
    '}',
    "if (typeof main !== 'function') {",
    '  console.error(remedy)',
    '  process.exit(1)',
    '}',
    'process.exit(await main(process.argv.slice(2)))',
    '',
  ].join('\n')
}

// Runs one child; resolves { code: this wrapper's exit code for it, forwarded: whether SIGTERM or SIGHUP was passed on }
function runChild(launcher, args, env) {
  return new Promise((resolve) => {
    const file = resolveLauncher(launcher, env)
    if (!file) {
      say(startFailedText(launcher, 'ENOENT'))
      return resolve({ code: 127, forwarded: false })
    }
    let child
    try {
      child = spawn(file, args, { stdio: 'inherit', env })
    } catch (e) {
      say(startFailedText(launcher, e.code))
      return resolve({ code: 127, forwarded: false })
    }
    let forwarded = false
    const ignore = () => {}
    const pass = (sig) => () => {
      forwarded = true
      child.kill(sig)
    }
    const handlers = [['SIGINT', ignore], ['SIGQUIT', ignore], ['SIGTERM', pass('SIGTERM')], ['SIGHUP', pass('SIGHUP')]]
    for (const [sig, fn] of handlers) process.on(sig, fn)
    const done = (code) => {
      for (const [sig, fn] of handlers) process.off(sig, fn)
      resolve({ code, forwarded })
    }
    child.on('error', (e) => {
      say(startFailedText(launcher, e.code))
      done(127)
    })
    child.on('exit', (code, signal) => done(signal ? 128 + (os.constants.signals[signal] || 0) : code ?? 1))
  })
}

export async function main(argv, env = process.env, cwd = process.cwd()) {
  let code = 1 // what an unexpected failure exits with: the last child's code, or 1 before any child
  try {
    const { launcher, args } = splitArgv(argv)
    const dir = childConfigDir(env)
    const { mode, cfg } = wrapperMode(dir)
    if (mode === 'pass' || isAccountDir(dir, env)) return (await runChild(launcher, args, env)).code

    const id = randomUUID()
    const handoff = path.join(dir, 'model-relay-handoff', `${id}.json`)
    process.on('exit', () => rmQuiet(handoff))
    const startedAt = Date.now()
    const ran = await runChild(launcher, args, { ...env, MODEL_RELAY_WRAPPER_ID: id })
    code = ran.code
    if (mode !== 'switch' || code !== 0) return code // the exit handler deletes any handoff
    if (ran.forwarded) {
      say('the window was asked to stop (SIGTERM or SIGHUP); not switching')
      return code
    }
    const h = takeHandoff(handoff, startedAt)
    if (!h.sid) {
      if (h.why) say(`${h.why}; not switching`)
      return code
    }
    // read again: the switch is decided by the config as it is now; a file gone by now leaves the account window
    // without main's relay, so it bypasses it (the account as the start read it)
    const now = wrapperMode(dir)
    if (now.cfg && now.mode !== 'switch') {
      say('accountFallback.mode is no longer "switch"; not switching')
      return code
    }
    const mainCfg = now.cfg || cfg
    const wiring = now.cfg ? relayWiring(dir) : {}
    const why = !now.cfg ? 'your model-relay.json is gone' : !claudeIsAnthropic(now.cfg) ? 'your claudeUrl is not https://api.anthropic.com' : !Object.keys(wiring).length ? 'your settings.json has no relay wiring' : ''
    const bypass = Boolean(why)
    const acct = accountDir(mainCfg, env)
    if (!acct.dir) {
      say(`${acct.why}; not switching`)
      return code
    }
    if (L.sameDir(acct.dir, dir)) {
      say(`accounts.${acct.account}.configDir is this window's own config dir, whose login is yours; not switching`)
      return code
    }
    if (!L.sameDir(path.join(acct.dir, 'projects'), path.join(dir, 'projects'))) {
      // the account's projects folder becomes a link to this one's, so both read and write one set of conversations
      const [from, to] = [path.join(dir, 'projects'), path.join(acct.dir, 'projects')]
      say(`${acct.account}'s projects folder is not this config dir's projects folder, so --resume could not find this conversation. Make ${to} a link to ${from} (move or remove ${to} first): ${linkCommand(from, to)}; not switching`)
      return code
    }
    const next = { ...env, CLAUDE_CONFIG_DIR: acct.dir, ...(bypass ? {} : { MODEL_RELAY_CONFIG_DIR: dir }) }
    delete next.MODEL_RELAY_WRAPPER_ID // one hop: the relaunched window can hand nothing on
    if (bypass) delete next.MODEL_RELAY_CONFIG_DIR
    const removed = (bypass ? BYPASS_DROPPED_VARS : DROPPED_VARS).filter((k) => Object.hasOwn(next, k))
    for (const k of removed) delete next[k]
    if (removed.length) say(`not passed to ${acct.account}'s window: ${removed.join(', ')}`)
    if (bypass) say(`${why}, so ${acct.account}'s window talks to Anthropic without the relay`)
    else {
      say(`${acct.account}'s window gets your relay wiring: ${Object.keys(wiring).join(', ')}`) // names, never values
      await registerAccount(L.bareCfg(mainCfg).port, h.sid, acct.account) // the router knows the sid before the first request
    }
    const dropped = droppedFlags(args)
    if (dropped.length) say(`not passed on to ${acct.account}'s window (only ${KEPT_FLAGS.join(', ')} are): ${dropped.join(', ')}`)
    say(`resuming this conversation on ${acct.account}`)
    return (await runChild(launcher, [...keptFlags(args), `--resume=${h.sid}`, '--settings', relaunchSettings(dir, cwd, bypass ? BYPASS_ENV : wiring)], next)).code
  } catch {
    say('stopped by an unexpected error; not switching')
    return code
  }
}

// Run as a command, not when a test imports it
if (process.argv[1] && L.realDir(process.argv[1]) === L.realDir(fileURLToPath(import.meta.url))) {
  main(process.argv.slice(2)).then((code) => process.exit(code))
}
