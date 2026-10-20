#!/usr/bin/env node
// Real-client smoke test: runs this checkout's router on a free port with a throwaway config directory and sends one
// real Claude Code request (`claude -p`) through it. Run it before a release and after every Claude Code update: the
// unit and end-to-end tests use stub upstreams, so a change in what Claude Code sends (headers, env handling) only
// shows up here. Needs a logged-in `claude` on PATH, so it is not part of tools/check.mjs or CI.
//
//   node tools/smoke.mjs                    main conversation on Claude, through the router
//   node tools/smoke.mjs --provider <name>  also a request on that provider (uses your config and its env:VAR keys)
//
// The throwaway directory holds a copy of your config (tokens included) only for --provider, and is deleted at the end.
import fs from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const cfgDir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude')
const args = process.argv.slice(2)
const providerArg = args.includes('--provider') ? String(args[args.indexOf('--provider') + 1] || '').toLowerCase() : ''
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const version = JSON.parse(fs.readFileSync(path.join(root, '.claude-plugin', 'plugin.json'), 'utf8')).version

const freePort = () => new Promise((resolve) => {
  const s = net.createServer().listen(0, '127.0.0.1', () => {
    const p = s.address().port
    s.close(() => resolve(p))
  })
})
const health = (port) => new Promise((resolve) => {
  http.get(`http://127.0.0.1:${port}/__health`, (res) => {
    const ch = []
    res.on('data', (c) => ch.push(c))
    res.on('end', () => {
      try {
        const j = JSON.parse(Buffer.concat(ch).toString('utf8'))
        resolve(j && j.ok === true ? j : null) // a 403 refusal is JSON too, but not a health answer
      } catch {
        resolve(null)
      }
    })
  }).on('error', () => resolve(null))
})

let failed = 0
const check = (ok, what, detail = '') => {
  console.log(`${ok ? '✓' : '✗'} ${what}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failed++
}

// Config for the throwaway router: a stub provider that is never called, or your config for --provider
const port = await freePort()
let config = { format: 2, port, failover: { enabled: false }, providers: { smoke: { baseUrl: 'http://127.0.0.1:9', token: 'unused', model: 'smoke-stub' } } }
let providerModel = ''
if (providerArg) {
  const file = path.join(cfgDir, 'model-relay.json')
  const mine = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null
  if (mine && mine.format !== 2) {
    console.error(`${file} is from an older version of model-relay; run "node tools/setup.mjs migrate --go" first.`)
    process.exit(2)
  }
  const key = Object.keys(mine?.providers || {}).find((k) => k.trim().toLowerCase() === providerArg)
  if (!key || !mine.providers[key].model) {
    console.error(`No provider "${providerArg}" with a model in ${file}.`)
    process.exit(2)
  }
  providerModel = String(mine.providers[key].model).replace(/\[[^\]]*\]$/, '')
  // Only the provider under test, without `launch`: the throwaway router must not start your local gateways
  const { launch: _launch, ...tested } = mine.providers[key]
  config = { ...mine, port, providers: { [key]: tested }, failover: { enabled: false }, proxy: { enabled: false } }
}
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'model-relay-smoke-'))
fs.writeFileSync(path.join(dir, 'model-relay.json'), JSON.stringify(config), { mode: 0o600 })
const url = `http://127.0.0.1:${port}`
// Only this run is pointed at the throwaway router; HTTPS_PROXY and the CA are cleared in case you use proxy mode
const settingsFile = path.join(dir, 'smoke-settings.json')
// The alias overrides are cleared too, so "sonnet" means Claude's own Sonnet even when you point it at a provider
fs.writeFileSync(settingsFile, JSON.stringify({
  env: { ANTHROPIC_BASE_URL: url, HTTPS_PROXY: '', NODE_EXTRA_CA_CERTS: '', ANTHROPIC_DEFAULT_SONNET_MODEL: '', ANTHROPIC_DEFAULT_HAIKU_MODEL: '', ANTHROPIC_DEFAULT_OPUS_MODEL: '' },
}))

const router = spawn(process.execPath, [path.join(root, 'router', 'router.js'), dir], { stdio: 'ignore' })
let cleaned = false
const cleanup = () => {
  if (cleaned) return
  cleaned = true
  router.kill()
  try {
    // Windows keeps the folder busy for a moment after the router and claude exit
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
  } catch (e) {
    console.error(`Could not delete ${dir} (${e.message}); it may hold a copy of your config, delete it by hand.`)
  }
}
process.on('exit', cleanup)
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => process.exit(130))

// `claude` is an .exe or, from npm, a .cmd that only a shell finds; through the shell every argument is quoted
const quote = (a) => (/[\s"]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a)
function runClaude(argv, opts = {}) {
  const r = spawnSync('claude', argv, { encoding: 'utf8', ...opts })
  if (!(r.error && r.error.code === 'ENOENT' && process.platform === 'win32')) return r
  return spawnSync('claude', argv.map(quote), { encoding: 'utf8', shell: true, ...opts })
}

try {
  let h = null
  for (let i = 0; i < 50 && !h; i++) {
    await sleep(100)
    h = await health(port)
  }
  check(Boolean(h), `router from this checkout is up on ${port}`)
  if (!h) process.exit(1)
  check(h.version === version, 'it reports this checkout\'s version', `${h.version} (plugin.json ${version})`)

  const cv = runClaude(['--version'])
  console.log(`  Claude Code ${String(cv.stdout || cv.stderr).trim() || '(not found on PATH)'}`)

  const ask = (model) => {
    const r = runClaude(['-p', '--model', model, '--settings', settingsFile], { input: 'Reply with exactly one word: pong', timeout: 180000, cwd: dir })
    return `${r.stdout || ''}${r.stderr || ''}`.trim()
  }
  const requests = () => {
    try {
      return fs.readFileSync(path.join(dir, 'model-relay-requests.log'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
    } catch {
      return []
    }
  }

  const out = ask('sonnet')
  const claudeHits = requests().filter((r) => r.route === 'claude' && /^claude-/.test(String(r.model || '')))
  check(/pong/i.test(out), 'Claude Code answered through the router', out.slice(0, 120))
  check(claudeHits.length > 0, 'the router saw the main conversation and sent it to Claude', `${claudeHits.length} request(s)`)

  if (providerArg) {
    const before = requests().length
    const pout = ask(providerModel)
    const mine = requests().slice(before)
    const routed = mine.filter((r) => r.route && r.route !== 'claude')
    const replied = mine.filter((r) => /-reply$/.test(String(r.to || '')) && r.status >= 200 && r.status < 300)
    check(/pong/i.test(pout), `${providerArg} (${providerModel}) answered through the router`, pout.slice(0, 120))
    check(routed.length > 0 && replied.length > 0, `the router sent it to ${providerArg} and got a 2xx`, `${routed.length} routed, ${replied.length} replied`)
  }
} finally {
  cleanup()
}
console.log(failed ? `${failed} check(s) failed.` : 'Smoke test passed.')
process.exit(failed ? 1 : 0)
