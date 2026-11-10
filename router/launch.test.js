'use strict'
// tools/launch.mjs, the launcher wrapper, against a fake launcher that records each start (argv, cwd, the variables
// that matter) and does what its plan says: write a handoff as /provider switch would, exit with a code, sleep, or die
// of a signal. No real claude is ever run; every path is inside a scratch dir.
require('./test-env')
const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawn, execFileSync } = require('node:child_process')
const http = require('node:http')
const { pathToFileURL } = require('node:url')
const { linkCmd, win } = require('./test-shell')

const LAUNCH = path.join(__dirname, '..', 'tools', 'launch.mjs')
const SID = '22222222-3333-4444-8555-666666666666'
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const AUTH = ['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN']
// what the account window must not get from this shell: another login, or an API address of its own
const DROPPED = [...AUTH, 'ANTHROPIC_BASE_URL', 'HTTP_PROXY', 'http_proxy']
// the way into the relay: kept, unless the window bypasses it
const PROXY = ['HTTPS_PROXY', 'https_proxy']

const FAKE = `#!/usr/bin/env node
'use strict'
const fs = require('fs')
const path = require('path')
const log = process.env.FAKE_LOG
const n = fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\\n').filter(Boolean).length : 0
const env = {}
for (const k of ['CLAUDE_CONFIG_DIR', 'MODEL_RELAY_WRAPPER_ID', 'MODEL_RELAY_CONFIG_DIR']) env[k] = process.env[k]
for (const k of [...${JSON.stringify(DROPPED)}, ...${JSON.stringify(PROXY)}, 'NODE_EXTRA_CA_CERTS']) env[k] = k in process.env
const hdir = path.join(process.env.FAKE_MAIN, 'model-relay-handoff')
const handoffs = fs.existsSync(hdir) ? fs.readdirSync(hdir) : []
fs.appendFileSync(log, JSON.stringify({ at: Date.now(), argv: process.argv.slice(2), cwd: process.cwd(), env, handoffs }) + '\\n')
const step = (JSON.parse(fs.readFileSync(process.env.FAKE_PLAN, 'utf8'))[n]) || {}
if (step.handoff) {
  const dir = path.join(process.env.CLAUDE_CONFIG_DIR, 'model-relay-handoff')
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, process.env.MODEL_RELAY_WRAPPER_ID + '.json')
  const text = JSON.stringify({ sid: step.handoff.sid })
  if (step.handoff.folder) fs.mkdirSync(file)
  else if (step.handoff.symlink) {
    fs.writeFileSync(file + '.target', text)
    fs.symlinkSync(file + '.target', file)
  } else fs.writeFileSync(file, text)
  if (step.handoff.stale) fs.utimesSync(file, new Date(Date.now() - 60000), new Date(Date.now() - 60000))
}
if (step.rmCfg) fs.rmSync(path.join(process.env.FAKE_MAIN, 'model-relay.json'))
if (step.trap) for (const sig of ['SIGTERM', 'SIGHUP']) process.on(sig, () => process.exit(0))
if (step.cfg) fs.writeFileSync(path.join(process.env.CLAUDE_CONFIG_DIR, 'model-relay.json'), JSON.stringify(step.cfg))
if (step.sleepMs) setTimeout(() => process.exit(step.exit || 0), step.sleepMs)
else process.exit(step.exit || 0)
`

// Every fixture has a stand-in for main's router on a port of its own, written into a config that names no port, so
// the wrapper's POST /__account lands there and never on a router of the person's: it records each request with the
// time it arrived
// main's settings.json as proxy mode writes it: the relay wiring, and keys the relaunch must not copy
const WIRED = { env: { HTTPS_PROXY: 'http://127.0.0.1:1', NO_PROXY: '127.0.0.1,localhost,::1', NODE_EXTRA_CA_CERTS: '/relay/ca.pem', OTHER_SECRET: 'not-copied' }, model: 'opus' }

async function fixture(t, { cfg = undefined, plan = [], projects = 'shared', settings = WIRED } = {}) {
  const routerSeen = []
  const router = http.createServer((req, res) => {
    const ch = []
    req.on('data', (c) => ch.push(c))
    req.on('end', () => {
      routerSeen.push({ at: Date.now(), url: req.url, body: Buffer.concat(ch).toString('utf8') })
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('{"ok":true}')
    })
  })
  await new Promise((r) => router.listen(0, '127.0.0.1', r))
  t.after(() => router.close())
  if (cfg && typeof cfg === 'object' && cfg.port === undefined) cfg = { ...cfg, port: router.address().port }
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'relay-launch-'))) // the long form on Windows, which is also what git prints
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const home = path.join(root, 'home')
  const main = path.join(home, '.claude')
  const acct = path.join(home, '.claude-second')
  const cwd = path.join(root, 'work dir')
  for (const d of [path.join(main, 'projects'), acct, cwd]) fs.mkdirSync(d, { recursive: true })
  if (projects === 'shared') fs.symlinkSync(path.join(main, 'projects'), path.join(acct, 'projects'))
  else if (projects === 'own') fs.mkdirSync(path.join(acct, 'projects'))
  if (cfg !== undefined) fs.writeFileSync(path.join(main, 'model-relay.json'), typeof cfg === 'string' ? cfg : JSON.stringify(cfg))
  if (settings) fs.writeFileSync(path.join(main, 'settings.json'), JSON.stringify(settings))
  // Elsewhere the fake is a script with a shebang, run as the program itself. Windows cannot run a script as a program,
  // and the wrapper starts no shell, so there the launcher is the path of a claude.exe that does not exist, and a
  // preload (--require) has the wrapper's spawn of exactly that path start node on the script instead: the wrapper
  // still resolves the launcher, passes the argv and environment, and reads the exit code the way it would for a real one
  const fake = path.join(root, win ? 'fake-claude.exe' : 'fake-claude')
  const script = win ? path.join(root, 'fake-claude.js') : fake
  fs.writeFileSync(script, FAKE, { mode: 0o755 })
  const preload = path.join(root, 'fake-spawn.cjs')
  fs.writeFileSync(preload, `'use strict'
const cp = require('node:child_process')
const spawn = cp.spawn
cp.spawn = (file, args, options) => (file === ${JSON.stringify(fake)} ? spawn(process.execPath, [${JSON.stringify(script)}, ...args], options) : spawn(file, args, options))
require('node:module').syncBuiltinESMExports()
`)
  const wrapperArgv = (args) => [...(win ? ['--require', preload] : []), LAUNCH, '--', fake, ...args]
  const log = path.join(root, 'starts.log')
  const planFile = path.join(root, 'plan.json')
  fs.writeFileSync(planFile, JSON.stringify(plan))
  const env = { ...process.env, HOME: home, CLAUDE_CONFIG_DIR: main, FAKE_LOG: log, FAKE_PLAN: planFile, FAKE_MAIN: main }
  for (const k of [...DROPPED, ...PROXY, 'NODE_EXTRA_CA_CERTS', 'USERPROFILE', 'MODEL_RELAY_WRAPPER_ID', 'MODEL_RELAY_CONFIG_DIR']) delete env[k]
  const starts = () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [])
  // Starts the wrapper: { child, done } where done resolves { code, signal, stderr }
  const start = (args, extraEnv = {}) => {
    const child = spawn(process.execPath, wrapperArgv(args), { cwd, env: { ...env, ...extraEnv }, stdio: ['ignore', 'ignore', 'pipe'] })
    let stderr = ''
    child.stderr.on('data', (c) => (stderr += c))
    const done = new Promise((resolve) => child.on('exit', (code, signal) => resolve({ code, signal, stderr })))
    return { child, done }
  }
  const run = (args, extraEnv) => start(args, extraEnv).done
  return { root, home, main, acct, cwd, fake, env, wrapperArgv, starts, start, run, routerSeen, handoffDir: path.join(main, 'model-relay-handoff') }
}

// the refusal for a projects folder that is not shared, up to the command that links it (ln -s, New-Item on Windows)
const NOT_SHARED = new RegExp(`projects folder is not this config dir's projects folder, so --resume could not find this conversation\\. Make \\S+ a link to \\S+ \\(move or remove \\S+ first\\): ${win ? 'New-Item -ItemType SymbolicLink -Path ' : 'ln -s '}`)
const cfgOf = (mode, extra = {}) => ({ format: 2, accountFallback: { mode, account: 'second' }, accounts: { second: { configDir: '~/.claude-second' } }, providers: {}, ...extra })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const handoffLeft = (f) => (fs.existsSync(f.handoffDir) ? fs.readdirSync(f.handoffDir).filter((n) => !n.endsWith('.target')) : [])

test('A4: no model-relay.json, a file that is not JSON, or mode off: a pure pass-through, the person\'s --settings untouched', async (t) => {
  const userArgs = ['--settings', '{"autoMemoryDirectory":"/Users/x/.claude/projects/-Users-x-repo/memory"}', '--model', 'opus', '"do X"', '--', '-p']
  for (const cfg of [undefined, '{oops', cfgOf('off'), cfgOf('rc_keep'), { format: 2 }]) {
    const f = await fixture(t, { cfg, plan: [{ handoff: { sid: SID } }] })
    const r = await f.run(userArgs, { ANTHROPIC_API_KEY: 'k' })
    assert.strictEqual(r.code, 0, r.stderr)
    const s = f.starts()
    assert.strictEqual(s.length, 1, `${JSON.stringify(cfg)}: one start, no relaunch`)
    assert.deepStrictEqual(s[0].argv, userArgs, 'byte-identical argv')
    assert.strictEqual(s[0].env.MODEL_RELAY_WRAPPER_ID, undefined, 'nothing added')
    assert.strictEqual(s[0].env.ANTHROPIC_API_KEY, true, 'nothing removed')
    assert.strictEqual(s[0].env.CLAUDE_CONFIG_DIR, f.main)
    assert.strictEqual(r.stderr, '', 'silent')
  }
  // keyed on the child's config dir: a config dir of its own (the other-org window) without model-relay.json passes through
  // even when ~/.claude has one in mode switch
  const f = await fixture(t, { cfg: cfgOf('switch'), plan: [{ handoff: { sid: SID } }] })
  const r = await f.run(userArgs, { CLAUDE_CONFIG_DIR: f.acct })
  assert.strictEqual(r.code, 0)
  assert.deepStrictEqual(f.starts().map((s) => s.argv), [userArgs])
  assert.strictEqual(f.starts()[0].env.MODEL_RELAY_WRAPPER_ID, undefined)
})

const SHELL = { ANTHROPIC_API_KEY: 'k', CLAUDE_CODE_OAUTH_TOKEN: 'o', HTTPS_PROXY: 'http://127.0.0.1:1', https_proxy: 'p', HTTP_PROXY: 'p', http_proxy: 'p', ANTHROPIC_BASE_URL: 'http://127.0.0.1:1', NODE_EXTRA_CA_CERTS: '/ca.pem' }

test('a relaunch with nothing but the kept options says nothing of dropped ones', async (t) => {
  const f = await fixture(t, { cfg: cfgOf('switch'), plan: [{ handoff: { sid: SID } }] })
  const r = await f.run(['--model=opus', '--effort', 'high'])
  assert.strictEqual(r.code, 0, r.stderr)
  assert.strictEqual(f.starts().length, 2)
  assert.ok(!r.stderr.includes('not passed on'), r.stderr)
})

test('the dropped options are named by their \"--\" names only: never a value, even one that starts with \"-\", and not the ones the relaunch sets itself', async (t) => {
  const f = await fixture(t, { cfg: cfgOf('switch'), plan: [{ handoff: { sid: SID } }] })
  const r = await f.run(['--append-system-prompt', '-secret-value', '--model', 'opus', '--settings', '/x/s.json', '--resume', 'abc', '--resume=def', '--permission-mode=plan', '--effort', 'high', '-p', '-short-secret', '--add-dir=/x/y', '--add-dir=/x/z'])
  assert.strictEqual(r.code, 0, r.stderr)
  assert.match(r.stderr, /not passed on to second's window \(only --model, --permission-mode, --effort are\): --append-system-prompt, --add-dir\n/)
  assert.ok(!/secret|abc|def|\/x\//.test(r.stderr), r.stderr)
  const only = await fixture(t, { cfg: cfgOf('switch'), plan: [{ handoff: { sid: SID } }] })
  const r2 = await only.run(['--append-system-prompt', '-secret-value'])
  assert.match(r2.stderr, /\): --append-system-prompt\n/)
  assert.ok(!r2.stderr.includes('secret-value'), r2.stderr)
})

test('A4, A11: a handoff makes exactly one relaunch on the account, through main\'s relay, with only the allowlisted flags, the resume and the memory settings', async (t) => {
  const f = await fixture(t, { cfg: cfgOf('switch'), plan: [{ handoff: { sid: SID.toUpperCase() } }, { handoff: { sid: SID } }] })
  const user = ['--model', 'opus', '--permission-mode=plan', '--add-dir', 'a', 'b', '"do X"', '--effort', 'high', '--dangerously-skip-permissions', '--', '--model', 'evil', 'do X']
  const r = await f.run(user, { MODEL_RELAY_WRAPPER_ID: '../../x', ...SHELL })
  assert.strictEqual(r.code, 0, r.stderr)
  const [first, second, ...more] = f.starts()
  assert.strictEqual(more.length, 0, 'one hop only, though the relaunched window wrote a handoff too')
  assert.deepStrictEqual(first.argv, user, 'the first launch gets the argv as given')
  assert.match(first.env.MODEL_RELAY_WRAPPER_ID, UUID, 'its own fresh id, not the one in the environment')
  assert.strictEqual(second.env.CLAUDE_CONFIG_DIR, f.acct)
  assert.strictEqual(second.env.MODEL_RELAY_WRAPPER_ID, undefined)
  for (const k of DROPPED) assert.strictEqual(second.env[k], false, k)
  for (const k of [...PROXY, 'NODE_EXTRA_CA_CERTS']) assert.strictEqual(second.env[k], true, `the relay's way in is kept: ${k}`)
  assert.strictEqual(second.env.MODEL_RELAY_CONFIG_DIR, f.main, 'the window uses main\'s relay config')
  for (const k of DROPPED.filter((k) => k !== 'ANTHROPIC_AUTH_TOKEN')) assert.strictEqual(first.env[k], true, `the first launch keeps ${k}`)
  assert.strictEqual(first.env.MODEL_RELAY_CONFIG_DIR, undefined)
  // Windows has one variable for HTTP_PROXY and http_proxy (node starts a child with the first of the two), so it is named once
  assert.match(r.stderr, new RegExp(`not passed to second's window: CLAUDE_CODE_OAUTH_TOKEN, ANTHROPIC_API_KEY, ANTHROPIC_BASE_URL, ${win ? 'HTTP_PROXY(, http_proxy)?' : 'HTTP_PROXY, http_proxy'}\\n`))
  assert.ok(!r.stderr.includes('127.0.0.1'), 'names only')
  assert.ok(!r.stderr.includes('=k') && !/\bk\b.*\bo\b/.test(r.stderr), 'names only')
  // the options the relaunch leaves out are named, not their values or the prompt (--model and the rest of the kept ones are not)
  assert.match(r.stderr, /not passed on to second's window \(only --model, --permission-mode, --effort are\): --add-dir, --dangerously-skip-permissions\n/)
  assert.ok(!/ a,| b\b|do X/.test(r.stderr), 'names only')
  const key = f.cwd.replace(/[^A-Za-z0-9]/g, '-')
  assert.deepStrictEqual(second.argv, [
    '--model', 'opus', '--permission-mode', 'plan', '--effort', 'high', `--resume=${SID}`,
    '--settings', JSON.stringify({ autoMemoryDirectory: path.join(f.main, 'projects', key, 'memory'), env: { HTTPS_PROXY: 'http://127.0.0.1:1', NO_PROXY: '127.0.0.1,localhost,::1', NODE_EXTRA_CA_CERTS: '/relay/ca.pem' } }),
  ])
  assert.ok(!second.argv.join(' ').includes('not-copied'), 'only the relay wiring keys are copied')
  assert.match(r.stderr, /second's window gets your relay wiring: HTTPS_PROXY, NO_PROXY, NODE_EXTRA_CA_CERTS\n/)
  assert.ok(!r.stderr.includes('/relay/ca.pem') && !r.stderr.includes('localhost'), 'names only')
  // A11-F7: main's router heard of the sid before the window started
  assert.deepStrictEqual(f.routerSeen.map((q) => [q.url, JSON.parse(q.body)]), [['/__account', { sid: SID, account: 'second' }]])
  assert.ok(f.routerSeen[0].at <= second.at, `registered at ${f.routerSeen[0].at}, the window started at ${second.at}`)
  for (const bad of ['"do X"', 'do X', 'a', 'b', '--add-dir', '--dangerously-skip-permissions', 'evil']) assert.ok(!second.argv.includes(bad), bad)
  assert.strictEqual(second.cwd, f.cwd)
  assert.deepStrictEqual(second.handoffs, [], 'the handoff was deleted before the relaunch started')
  assert.deepStrictEqual(handoffLeft(f), [], 'the handoff is gone')
})

test('A4: the project key follows the main repository root through git, so a worktree shares its memory', async (t) => {
  const f = await fixture(t, { cfg: cfgOf('switch'), plan: [{ handoff: { sid: SID } }, {}] })
  const repo = path.join(f.root, 'repo.x')
  fs.mkdirSync(repo)
  const git = (...a) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd: repo, stdio: 'ignore' })
  git('init', '-q')
  git('commit', '-q', '--allow-empty', '-m', 'x')
  git('worktree', 'add', '-q', path.join(f.root, 'wt'), '-b', 'wt')
  const child = spawn(process.execPath, f.wrapperArgv([]), { cwd: path.join(f.root, 'wt'), env: f.env, stdio: 'ignore' })
  await new Promise((r) => child.on('exit', r))
  assert.strictEqual(f.starts().length, 2, 'the switch went on')
  const settings = JSON.parse(f.starts()[1].argv.at(-1))
  const want = path.join(f.main, 'projects', repo.replace(/[^A-Za-z0-9]/g, '-'), 'memory')
  // git prints the drive letter as the folder was given to it, which can differ in case from node's on Windows
  assert.strictEqual(win ? settings.autoMemoryDirectory.toLowerCase() : settings.autoMemoryDirectory, win ? want.toLowerCase() : want)
})

test('A4: refused handoffs: a sid that is an option, a symlink, a stale file, account __proto__, a projects folder of its own', async (t) => {
  const cases = [
    ['a sid that is an option', { plan: [{ handoff: { sid: '--dangerously-skip-permissions' } }] }, /the handoff holds no session id/],
    ['a symlinked handoff', { plan: [{ handoff: { sid: SID, symlink: true } }] }, /not a regular file/],
    ['a stale handoff', { plan: [{ handoff: { sid: SID, stale: true } }] }, /older than this window/],
    ['account __proto__', { cfg: JSON.parse('{"format":2,"accountFallback":{"mode":"switch","account":"__proto__"},"accounts":{"__proto__":{"configDir":"~/.claude-second"}}}'), plan: [{ handoff: { sid: SID } }] }, /accountFallback\.account is not set to a plain account name/],
    ['an inherited account name', { cfg: cfgOf('switch', { accountFallback: { mode: 'switch', account: 'constructor' } }), plan: [{ handoff: { sid: SID } }] }, /accounts\.constructor\.configDir is not set/],
    ['the mode changed while the window ran', { plan: [{ handoff: { sid: SID }, cfg: cfgOf('off') }] }, /no longer "switch"/],
    ['projects not shared', { projects: 'own', plan: [{ handoff: { sid: SID } }] }, NOT_SHARED],
    ['no projects folder at all', { projects: 'none', plan: [{ handoff: { sid: SID } }] }, NOT_SHARED],
    ['the account dir is this window\'s own', { cfg: cfgOf('switch', { accounts: { second: { configDir: '~/.claude' } } }), plan: [{ handoff: { sid: SID } }] }, /is this window's own config dir/],
    ['a folder where the handoff goes (it cannot be removed)', { plan: [{ handoff: { sid: SID, folder: true } }] }, /not a regular file/],
  ]
  for (const [why, opts, msg] of cases) {
    const f = await fixture(t, { cfg: cfgOf('switch'), ...opts })
    const r = await f.run(['--model', 'opus'])
    assert.strictEqual(r.code, 0, `${why}: the child's own exit code`)
    assert.strictEqual(f.starts().length, 1, `${why}: no relaunch`)
    assert.match(r.stderr, msg, why)
    // a folder is not removed (rm without recursion), and that failure stops nothing: the wrapper still ends cleanly
    if (!why.startsWith('a folder')) assert.deepStrictEqual(handoffLeft(f), [], `${why}: the handoff is gone`)
  }
})

test('A4: accounts.<name> is found as providers.<name> is: own keys, trimmed, any case', async (t) => {
  const f = await fixture(t, { cfg: cfgOf('switch', { accountFallback: { mode: 'switch', account: ' Second ' }, accounts: { ' SECOND ': { configDir: '~/.claude-second' } } }), plan: [{ handoff: { sid: SID } }] })
  const r = await f.run([])
  assert.strictEqual(r.code, 0, r.stderr)
  assert.strictEqual(f.starts().length, 2)
  assert.strictEqual(f.starts()[1].env.CLAUDE_CONFIG_DIR, f.acct)
})

test('A4: a non-zero exit gives no relaunch, and no handoff is left behind', async (t) => {
  const f = await fixture(t, { cfg: cfgOf('switch'), plan: [{ handoff: { sid: SID }, exit: 3 }] })
  const r = await f.run([])
  assert.strictEqual(r.code, 3)
  assert.strictEqual(f.starts().length, 1)
  assert.deepStrictEqual(handoffLeft(f), [], 'deleted on this way out too')
})

// Node cannot deliver SIGINT, SIGTERM or SIGHUP to a process on Windows: child.kill() there ends it outright, so a test
// cannot tell the wrapper's handling of them from its being killed. Windows runs the slow child only.
test('A4: SIGINT leaves the wrapper alive; a child killed by SIGTERM gives 143; SIGHUP is passed on', async (t) => {
  const f = await fixture(t, { cfg: cfgOf('switch'), plan: [{ sleepMs: 1500, handoff: { sid: SID } }, {}] })
  const a = f.start([])
  if (!win) {
    await sleep(400)
    a.child.kill('SIGINT')
    a.child.kill('SIGQUIT')
    await sleep(200)
    assert.strictEqual(a.child.exitCode, null, 'still running')
  }
  const ra = await a.done
  assert.strictEqual(ra.code, 0, ra.stderr)
  assert.strictEqual(f.starts().length, 2, 'the child finished, wrote its handoff, and the switch went on')
  if (win) return

  for (const [sig, code] of [['SIGTERM', 143], ['SIGHUP', 129]]) {
    const g = await fixture(t, { cfg: cfgOf('switch'), plan: [{ sleepMs: 5000, handoff: { sid: SID } }] })
    const b = g.start([])
    await sleep(400)
    b.child.kill(sig)
    const rb = await b.done
    assert.strictEqual(rb.code, code, `${sig}: ${rb.stderr}`)
    assert.strictEqual(g.starts().length, 1, `${sig}: no relaunch`)
    assert.deepStrictEqual(handoffLeft(g), [], `${sig}: the handoff is gone`)
  }
  // the same in a pass-through
  const p = await fixture(t, { plan: [{ sleepMs: 5000 }] })
  const c = p.start([])
  await sleep(400)
  c.child.kill('SIGTERM')
  assert.strictEqual((await c.done).code, 143)
})

test('A4: only --model, --permission-mode and --effort with a real value are kept, before a lone --', async () => {
  const { keptFlags, splitArgv } = await import(pathToFileURL(LAUNCH).href) // a Windows path is no module URL as it is
  assert.deepStrictEqual(keptFlags(['--model', '--dangerously-skip-permissions', '--effort=', '--permission-mode', 'plan']), ['--permission-mode', 'plan'])
  assert.deepStrictEqual(keptFlags(['--model=opus', '--', '--effort', 'high']), ['--model', 'opus'])
  assert.deepStrictEqual(keptFlags(['--modelx', 'y', '--model']), [])
  assert.deepStrictEqual(splitArgv([]), { launcher: 'claude', args: [] })
  assert.deepStrictEqual(splitArgv(['--model', 'x']), { launcher: 'claude', args: ['--model', 'x'] })
  assert.deepStrictEqual(splitArgv(['fake-claude', '-c']), { launcher: 'claude', args: ['fake-claude', '-c'] }, 'without --, every word is an argument of claude')
  assert.deepStrictEqual(splitArgv(['do X']), { launcher: 'claude', args: ['do X'] })
  assert.deepStrictEqual(splitArgv(['--', 'fake-claude', '-c']), { launcher: 'fake-claude', args: ['-c'] }, 'with --, the next word is the launcher')
  assert.deepStrictEqual(splitArgv(['--']), { launcher: 'claude', args: [] })
})

test('A4: a window the wrapper passed SIGTERM or SIGHUP to is never relaunched, even when it exits 0 after writing a handoff', { skip: win && 'node cannot deliver SIGTERM or SIGHUP on Windows: child.kill() ends the wrapper outright' }, async (t) => {
  for (const sig of ['SIGTERM', 'SIGHUP']) {
    const f = await fixture(t, { cfg: cfgOf('switch'), plan: [{ handoff: { sid: SID }, trap: true, sleepMs: 5000 }, {}] })
    const a = f.start([])
    await sleep(400)
    a.child.kill(sig)
    const r = await a.done
    assert.strictEqual(r.code, 0, `${sig}: the child's own exit code (${r.stderr})`)
    assert.strictEqual(f.starts().length, 1, `${sig}: no relaunch`)
    assert.match(r.stderr, /asked to stop \(SIGTERM or SIGHUP\); not switching/)
    assert.deepStrictEqual(handoffLeft(f), [], `${sig}: the handoff is gone`)
  }
})

test('A11-F1, A11: a custom claudeUrl, or main\'s config gone by the relaunch: the S3 bypass, no MODEL_RELAY_CONFIG_DIR, no registration', async (t) => {
  for (const [why, opts] of [
    ['claudeUrl elsewhere', { cfg: cfgOf('switch', { claudeUrl: 'https://gateway.example' }), plan: [{ handoff: { sid: SID } }] }],
    ['main\'s model-relay.json removed meanwhile', { cfg: cfgOf('switch'), plan: [{ handoff: { sid: SID }, rmCfg: true }] }],
    ['main\'s settings.json has no relay wiring', { cfg: cfgOf('switch'), settings: { env: { OTHER_SECRET: 'x' } }, plan: [{ handoff: { sid: SID } }] }],
    ['no settings.json in main\'s dir', { cfg: cfgOf('switch'), settings: null, plan: [{ handoff: { sid: SID } }] }],
  ]) {
    const f = await fixture(t, opts)
    const r = await f.run([], SHELL)
    assert.strictEqual(r.code, 0, `${why}: ${r.stderr}`)
    const second = f.starts()[1]
    assert.ok(second, `${why}: relaunched`)
    for (const k of [...DROPPED, ...PROXY]) assert.strictEqual(second.env[k], false, `${why}: ${k}`)
    assert.strictEqual(second.env.MODEL_RELAY_CONFIG_DIR, undefined, why)
    assert.deepStrictEqual(JSON.parse(second.argv.at(-1)).env, { ANTHROPIC_BASE_URL: 'https://api.anthropic.com', HTTPS_PROXY: '', https_proxy: '' }, why)
    assert.deepStrictEqual(f.routerSeen, [], `${why}: no registration`)
    assert.match(r.stderr, /talks to Anthropic without the relay/, why)
  }
})

test('A11: a window on an account\'s config dir passes through byte-identical in every mode, its own --settings included', async (t) => {
  const own = ['--settings', '{"autoMemoryDirectory":"/Users/x/.claude/projects/-k/memory"}', '--model', 'opus', 'do X']
  for (const mode of ['switch', 'off']) {
    const f = await fixture(t, { cfg: cfgOf(mode), plan: [{ handoff: { sid: SID } }] })
    // even with a model-relay.json of its own that would wrap it
    fs.writeFileSync(path.join(f.acct, 'model-relay.json'), JSON.stringify(cfgOf('switch')))
    const r = await f.run(own, { CLAUDE_CONFIG_DIR: f.acct, MODEL_RELAY_CONFIG_DIR: f.main, ...SHELL })
    assert.strictEqual(r.code, 0, `${mode}: ${r.stderr}`)
    const s = f.starts()
    assert.strictEqual(s.length, 1, mode)
    assert.deepStrictEqual(s[0].argv, own, `${mode}: byte-identical`)
    assert.strictEqual(s[0].env.MODEL_RELAY_WRAPPER_ID, undefined)
    for (const k of Object.keys(SHELL)) assert.strictEqual(s[0].env[k], true, `${mode}: ${k} untouched`)
    assert.deepStrictEqual(f.routerSeen, [])
    assert.ok(!r.stderr.includes('model-relay launch'), `${mode}: the wrapper said nothing`)
  }
})

test('fix 3: main in base-url mode: the relaunch gets main\'s ANTHROPIC_BASE_URL through --settings, though the shell\'s is dropped', async (t) => {
  const f = await fixture(t, { cfg: cfgOf('switch'), settings: { env: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:2' } }, plan: [{ handoff: { sid: SID } }] })
  const r = await f.run([], { ANTHROPIC_BASE_URL: 'http://127.0.0.1:3' })
  assert.strictEqual(r.code, 0, r.stderr)
  const second = f.starts()[1]
  assert.strictEqual(second.env.ANTHROPIC_BASE_URL, false, 'the shell\'s value is not passed on')
  assert.deepStrictEqual(JSON.parse(second.argv.at(-1)).env, { ANTHROPIC_BASE_URL: 'http://127.0.0.1:2' })
  assert.strictEqual(second.env.MODEL_RELAY_CONFIG_DIR, f.main)
  assert.ok(!r.stderr.includes('127.0.0.1'), 'names only')
})

test('B14: a projects folder that is not shared is refused with the command that links it, from the account\'s folder to this window\'s', async (t) => {
  for (const projects of ['own', 'none']) {
    const f = await fixture(t, { cfg: cfgOf('switch'), projects, plan: [{ handoff: { sid: SID } }] })
    const r = await f.run([])
    assert.strictEqual(r.code, 0, r.stderr)
    assert.strictEqual(f.starts().length, 1, `${projects}: no relaunch`)
    const [from, to] = [path.join(f.main, 'projects'), path.join(f.acct, 'projects')]
    const want = `Make ${to} a link to ${from} (move or remove ${to} first): ${linkCmd(from, to)}; not switching`
    assert.ok(r.stderr.includes(want), `${projects}: ${r.stderr}`)
  }
})

test('B13: the wrapper\'s messages say your account\'s files, not "main\'s"', async (t) => {
  const seen = []
  for (const opts of [
    { cfg: cfgOf('switch'), plan: [{ handoff: { sid: SID } }] },
    { cfg: cfgOf('switch'), plan: [{ handoff: { sid: SID }, rmCfg: true }] },
    { cfg: cfgOf('switch', { claudeUrl: 'https://gateway.example' }), plan: [{ handoff: { sid: SID } }] },
    { cfg: cfgOf('switch'), settings: { env: { OTHER_SECRET: 'x' } }, plan: [{ handoff: { sid: SID } }] },
  ]) {
    const f = await fixture(t, opts)
    seen.push((await f.run([], SHELL)).stderr)
  }
  assert.match(seen[0], /second's window gets your relay wiring:/)
  assert.match(seen[1], /your model-relay\.json is gone, so second's window talks to Anthropic without the relay/)
  assert.match(seen[2], /your claudeUrl is not https:\/\/api\.anthropic\.com, so second's window talks to Anthropic without the relay/)
  assert.match(seen[3], /your settings\.json has no relay wiring, so second's window talks to Anthropic without the relay/)
  for (const text of seen) assert.ok(!/\bmain\b/.test(text), text)
})
