'use strict'
// The setup CLI's account commands: set accountFallback.mode|account, launcher, and doctor's account findings.
// setup.mjs runs in a scratch home with a preload that stands in for the OS through globalThis.__modelRelayTestPlatform.
// Ids in the titles are those of the pre-PR audit (A, B) and its security review (F).
require('./test-env')
const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const net = require('node:net')
const os = require('node:os')
const path = require('node:path')
const { execFile } = require('node:child_process')

const SETUP = path.join(__dirname, '..', 'tools', 'setup.mjs')
const PRELOAD = (platform) => `'use strict'
globalThis.__modelRelayTestPlatform = ${JSON.stringify(platform)}
`
const freePort = () => new Promise((resolve) => {
  const s = net.createServer()
  s.listen(0, '127.0.0.1', () => {
    const { port } = s.address()
    s.close(() => resolve(port))
  })
})

// setup.mjs in a scratch home: <home>/.claude is the relay dir (CLAUDE_CONFIG_DIR) holding model-relay.json from cfg
async function home(t, cfg, { platform = 'darwin', settings = {}, env: more = {} } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-cli-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const relayDir = path.join(dir, '.claude')
  fs.mkdirSync(relayDir)
  const file = path.join(relayDir, 'model-relay.json')
  fs.writeFileSync(file, JSON.stringify({ format: 2, port: await freePort(), ...cfg }, null, 2))
  fs.writeFileSync(path.join(relayDir, 'settings.json'), JSON.stringify(settings))
  const preload = path.join(dir, 'preload.cjs')
  fs.writeFileSync(preload, PRELOAD(platform))
  const env = { ...process.env, HOME: dir, USERPROFILE: dir, CLAUDE_CONFIG_DIR: relayDir, ...more }
  delete env.MODEL_RELAY_CONFIG_DIR
  const run = (...args) => new Promise((resolve) => execFile(process.execPath, ['--require', preload, SETUP, ...args], { cwd: dir, env }, (e, stdout, stderr) => resolve({ code: e ? e.code : 0, stdout, stderr, out: `${stdout}${stderr}` })))
  const read = () => JSON.parse(fs.readFileSync(file, 'utf8'))
  const text = () => fs.readFileSync(file, 'utf8')
  const backup = () => (fs.existsSync(`${file}.model-relay-backup`) ? fs.readFileSync(`${file}.model-relay-backup`, 'utf8') : '')
  return { dir, relayDir, file, run, read, text, backup }
}
const lineWith = (out, needle) => out.split('\n').find((l) => l.includes(needle)) || ''

const ACCOUNTS = { 'team-1': { configDir: '~/.claude-team-1' }, 'team-2': { configDir: '~/.claude-team-2' }, 'team-3': { configDir: '~/.claude-team-3' } }

test('A1/B1 (CLI): set accountFallback.mode and accountFallback.account write the keys; any other value is refused with a fixed text', async (t) => {
  const c = await home(t, { accounts: ACCOUNTS, providers: {} })
  for (const m of ['switch', 'off']) {
    const x = await c.run('set', 'accountFallback.mode', m)
    assert.strictEqual(x.code, 0, x.out)
    assert.strictEqual(c.read().accountFallback.mode, m)
  }
  const before = c.text()
  for (const [k, v] of [['accountFallback.mode', 'later'], ['accountFallback.mode', 'nobody-here'], ['accountFallback.account', 'nobody-here'], ['accountFallback.account', '../x']]) {
    const x = await c.run('set', k, v)
    assert.strictEqual(x.code, 2, `${k} ${v}: ${x.out}`)
    assert.ok(!x.out.includes('nobody-here') && !x.out.includes('../x'), `${k}: the value is not echoed`)
    assert.strictEqual(c.text(), before, `${k} ${v}: nothing written`)
  }
  assert.match((await c.run('set', 'accountFallback.mode', 'later')).out, /accountFallback\.mode: expected off, switch/)
  const ok = await c.run('set', 'accountFallback.account', ' Team-2 ')
  assert.strictEqual(ok.code, 0, ok.out)
  assert.deepStrictEqual(c.read().accountFallback, { mode: 'off', account: 'team-2' })
  assert.strictEqual(JSON.parse(c.backup()).accountFallback.account, undefined, 'the previous file kept as the backup')
  const none = await c.run('set', 'accountFallback.account', 'none')
  assert.strictEqual(none.code, 0, none.out)
  assert.deepStrictEqual(c.read().accountFallback, { mode: 'off' })
})

test('B17: doctor\'s .config.json finding says what to do instead of naming unverified behaviour', async (t) => {
  const c = await home(t, { accountFallback: { mode: 'switch' }, accounts: { 'team-2': { configDir: '~/.claude-team-2' } }, providers: {} })
  fs.mkdirSync(path.join(c.dir, '.claude-team-2'))
  fs.writeFileSync(path.join(c.dir, '.claude-team-2', '.config.json'), '{}')
  const doc = await c.run('doctor')
  const cj = path.join(c.dir, '.claude-team-2', '.config.json')
  assert.ok(doc.out.includes(`⚠ ${cj} exists; the relay reads ${path.join(c.dir, '.claude-team-2', '.claude.json')} only for team-2's login. If team-2's windows show another account than that file names, move ${cj} aside and /login there again`), doc.out)
  assert.ok(!doc.out.includes('not verified'))
})

test('B11 (usage half): the usage line lists account-add, handoff and launcher', async (t) => {
  const c = await home(t, { providers: {} })
  const x = await c.run('no-such-command')
  assert.strictEqual(x.code, 2)
  for (const w of ['account-add', 'handoff']) assert.ok(x.stderr.includes(`|${w}`), w)
})

// ---------- the stable launcher file: setup.mjs launcher writes <config dir>/model-relay-launch.mjs ----------

const LAUNCH = path.join(__dirname, '..', 'tools', 'launch.mjs')
const launchModule = () => import(require('node:url').pathToFileURL(LAUNCH).href)
const launcherFile = (c) => path.join(c.relayDir, 'model-relay-launch.mjs')

test('A2, F5, F6 (acceptance 3): setup.mjs launcher writes the stable file 0600 with the root as JSON and a file: URL import, leaves an unchanged file alone, refuses a symlink, and prints the aliases', async (t) => {
  const c = await home(t, { providers: {} })
  const file = launcherFile(c)
  const x = await c.run('launcher')
  assert.strictEqual(x.code, 0, x.out)
  const text = fs.readFileSync(file, 'utf8')
  const root = path.resolve(__dirname, '..')
  assert.strictEqual(text, (await launchModule()).launcherSource(root), 'the text launcherSource gives for this copy of the plugin')
  assert.strictEqual(JSON.parse(/^const root = (.*)$/m.exec(text)[1]), root, 'root embedded with JSON.stringify')
  assert.strictEqual(JSON.parse(/^const target = (.*)$/m.exec(text)[1]), require('node:url').pathToFileURL(LAUNCH).href, 'imported through a file: URL')
  assert.match(text, /^process\.exit\(await main\(process\.argv\.slice\(2\)\)\)$/m, 'main() called explicitly')
  if (process.platform !== 'win32') assert.strictEqual(fs.statSync(file).mode & 0o777, 0o600)
  assert.ok(x.out.includes(`✓ wrote ${file}, which runs ${LAUNCH}`), x.out)
  if (/^[A-Za-z0-9_./:=@%+,-]+$/.test(file)) { // a path that needs no quoting for sh (a Windows path is quoted)
    assert.ok(x.out.includes(`  node ${file} [claude options]`), x.out)
    assert.ok(x.out.includes(`  alias claude='node ${file}'`), x.out)
  }
  assert.ok(x.out.includes(`  function claude { node '${file}' @args }`), x.out)
  assert.match(x.out, /never a script named claude on PATH/)
  // unchanged: left alone (same inode); a stale text or a looser mode: replaced whole, never written in place
  const ino = fs.statSync(file).ino
  const same = await c.run('launcher')
  assert.strictEqual(same.code, 0)
  assert.ok(same.out.includes(`${file} already runs ${LAUNCH}`), same.out)
  assert.strictEqual(fs.statSync(file).ino, ino)
  fs.writeFileSync(file, '// an older version\n')
  if (process.platform !== 'win32') fs.chmodSync(file, 0o644)
  assert.strictEqual((await c.run('launcher')).code, 0)
  assert.strictEqual(fs.readFileSync(file, 'utf8'), text)
  if (process.platform !== 'win32') assert.strictEqual(fs.statSync(file).mode & 0o777, 0o600)
  assert.deepStrictEqual(fs.readdirSync(c.relayDir).filter((n) => n.includes('launch')), ['model-relay-launch.mjs'], 'no temp file left')
  // a symlink at the path is refused, and the file it points to is untouched
  const outside = path.join(c.dir, 'outside.mjs')
  fs.writeFileSync(outside, 'keep')
  fs.rmSync(file)
  fs.symlinkSync(outside, file)
  const linked = await c.run('launcher')
  assert.strictEqual(linked.code, 1, linked.out)
  assert.match(linked.stderr, /model-relay-launch\.mjs is a symlink; remove it, then run launcher again\. Nothing was written\./)
  assert.strictEqual(fs.readFileSync(outside, 'utf8'), 'keep')
  assert.ok(fs.lstatSync(file).isSymbolicLink())
  // the usage line names it
  assert.ok((await c.run('no-such-command')).stderr.includes('|launcher]'))
})

test('acceptance 3 (F7): the stable file run from another folder starts the launcher child in that folder', async (t) => {
  const c = await home(t, { providers: {} })
  assert.strictEqual((await c.run('launcher')).code, 0)
  fs.rmSync(c.file) // no model-relay.json: the wrapper passes the launcher through untouched
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-project-'))
  t.after(() => fs.rmSync(project, { recursive: true, force: true }))
  const fake = path.join(c.dir, 'fake-launcher.js')
  const seen = path.join(c.dir, 'seen.json')
  fs.writeFileSync(fake, `require('fs').writeFileSync(${JSON.stringify(seen)}, JSON.stringify({ cwd: process.cwd(), argv: process.argv.slice(2) }))\n`)
  const env = { ...process.env, HOME: c.dir, USERPROFILE: c.dir, CLAUDE_CONFIG_DIR: c.relayDir }
  delete env.MODEL_RELAY_CONFIG_DIR
  const code = await new Promise((resolve) => execFile(process.execPath, [launcherFile(c), '--', process.execPath, fake, '--model', 'opus'], { cwd: project, env }, (e) => resolve(e ? e.code : 0)))
  assert.strictEqual(code, 0)
  const got = JSON.parse(fs.readFileSync(seen, 'utf8'))
  assert.strictEqual(fs.realpathSync(got.cwd), fs.realpathSync(project))
  assert.deepStrictEqual(got.argv, ['--model', 'opus'])
})

test('F5 (acceptance 3): for a Windows-style root the stable file imports file:///C:/…/tools/launch.mjs and embeds the root with JSON.stringify; a missing target prints the remedy', async (t) => {
  const { launcherSource } = await launchModule()
  const root = 'C:\\Users\\me\\plugin "x"\\model-relay'
  const text = launcherSource(root, true)
  assert.strictEqual(JSON.parse(/^const target = (.*)$/m.exec(text)[1]), 'file:///C:/Users/me/plugin%20%22x%22/model-relay/tools/launch.mjs')
  assert.strictEqual(JSON.parse(/^const root = (.*)$/m.exec(text)[1]), root)
  assert.ok(text.includes(`const root = ${JSON.stringify(root)}`))
  // a root that no longer holds tools/launch.mjs: node's import fails and the file prints the remedy
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-gone-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const file = path.join(dir, 'model-relay-launch.mjs')
  fs.writeFileSync(file, launcherSource(path.join(dir, 'removed-plugin')))
  const r = await new Promise((resolve) => execFile(process.execPath, [file], { cwd: dir }, (e, stdout, stderr) => resolve({ code: e ? e.code : 0, stderr })))
  assert.strictEqual(r.code, 1)
  assert.match(r.stderr, /model-relay launcher: the plugin folder this file names has no tools\/launch\.mjs .* Start any Claude Code window once, which points this file at the plugin again, or run setup\.mjs launcher from the installed plugin\. \(.*removed-plugin: ERR_MODULE_NOT_FOUND\)/)
})

test('F8: on Windows a bare launcher is looked up in PATH\'s absolute entries only, so a claude.exe planted in the working folder is never chosen', async () => {
  const { resolveLauncher } = await launchModule()
  const planted = new Set(['claude.exe', '.\\claude.exe', 'bin\\claude.exe', '\\tools\\claude.exe', 'C:\\Real\\claude.exe', 'D:\\Later\\claude.exe'])
  const exists = (p) => planted.has(p)
  const env = { Path: 'bin;.;\\tools;"C:\\Real";D:\\Later' }
  assert.strictEqual(resolveLauncher('claude', env, true, exists), 'C:\\Real\\claude.exe', 'relative and drive-relative entries skipped; the first absolute hit wins')
  assert.strictEqual(resolveLauncher('claude', { PATH: 'bin;.' }, true, exists), null, 'only relative entries: not found, never the working folder')
  assert.strictEqual(resolveLauncher('claude.exe', { PATH: 'D:\\Later' }, true, exists), 'D:\\Later\\claude.exe')
  assert.strictEqual(resolveLauncher('claude', { PATH: '\\\\server\\share' }, true, (p) => p === '\\\\server\\share\\claude.exe'), '\\\\server\\share\\claude.exe', 'a UNC root counts')
  assert.strictEqual(resolveLauncher('C:\\mine\\claude.exe', env, true, exists), 'C:\\mine\\claude.exe', 'a path the person gave is started as given')
  assert.strictEqual(resolveLauncher('claude', env, false, exists), 'claude', 'elsewhere nothing changes')
})

test('A9: the start failure on Windows names claude.exe, the native installer and the -- form; elsewhere it stays the short text', async () => {
  const { startFailedText } = await launchModule()
  const win = startFailedText('claude', 'ENOENT', true)
  assert.match(win, /^could not start claude: ENOENT\. On Windows the wrapper starts claude\.exe from a folder on PATH/)
  assert.match(win, /claude\.cmd cannot be started without a shell, so install Claude Code with the native installer, or give the full path: -- C:\\path\\to\\claude\.exe$/)
  assert.strictEqual(startFailedText('claude', 'ENOENT', false), 'could not start claude: ENOENT')
  assert.strictEqual(startFailedText('claude', 'EACCES', true), 'could not start claude: EACCES')
})

test('W-1, W-10: doctor says where /provider switch goes in mode switch, and says nothing in mode off', async (t) => {
  const providers = { other: { baseUrl: 'http://127.0.0.1:9', token: 'k', model: 'm' } }
  const accounts = { 'team-2': { configDir: '~/.claude-team-2' } }
  const lineOf = (out) => lineWith(out, '  Accounts: ')
  const off = await home(t, { accounts, providers })
  assert.strictEqual(lineOf((await off.run('doctor')).out), '', 'mode off: no line')
  const sw = await home(t, { accountFallback: { mode: 'switch', account: 'team-2' }, accounts, providers })
  assert.strictEqual(lineOf((await sw.run('doctor')).out), '  Accounts: mode "switch"; /provider switch moves a window to team-2')
  const none = await home(t, { accountFallback: { mode: 'switch' }, accounts, providers })
  assert.strictEqual(lineOf((await none.run('doctor')).out), '  Accounts: mode "switch"; accountFallback.account is not set, so /provider switch has nowhere to go')
  const bad = await home(t, { accountFallback: { mode: 'switch', account: 'nobody-here' }, accounts, providers })
  const badLine = lineOf((await bad.run('doctor')).out)
  assert.match(badLine, /accountFallback\.account names no account in accounts \(with a configDir\)/)
  assert.ok(!badLine.includes('nobody-here'), 'the value is not echoed')
  // a mode this version does not know counts as off, and doctor says so
  const odd = await home(t, { accountFallback: { mode: 'later' }, accounts, providers })
  const o = await odd.run('doctor')
  assert.match(o.out, /accountFallback\.mode is not one of off, switch/)
  assert.strictEqual(lineOf(o.out), '')
})

test('A7 (docs audit): an account nobody has made yet is sent to account-add first by set accountFallback.account', async (t) => {
  const c = await home(t, { accounts: {}, providers: {} })
  const before = c.text()
  assert.match((await c.run('set', 'accountFallback.account', 'team-2')).stderr, /make one with account-add <name>/)
  assert.strictEqual(c.text(), before, 'nothing written')
})
