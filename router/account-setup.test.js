'use strict'
// Mode "switch", the setup CLI: account-add, handoff, the reserved names and doctor's account findings, run in scratch
// dirs (nothing listens on the port in a config, so doctor finds the router offline).
require('./test-env')
const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const net = require('node:net')
const os = require('node:os')
const path = require('node:path')
const { execFile } = require('node:child_process')

const SETUP = path.join(__dirname, '..', 'tools', 'setup.mjs')
const MAIN_UUID = '11111111-2222-4333-8444-555555555555'
const OTHER_UUID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
const tokenLike = (kind, rest) => ['sk', 'ant', kind, rest].join('-') // built at run time, so this source never holds one

const freePort = () => new Promise((resolve) => {
  const s = net.createServer()
  s.listen(0, '127.0.0.1', () => {
    const { port } = s.address()
    s.close(() => resolve(port))
  })
})

function scratch(t, prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return { dir }
}

// The setup CLI in a scratch dir that is the config dir; nothing listens on its port, so doctor finds the router offline
async function cli(t, cfg = {}, { settings = {} } = {}) {
  const s = scratch(t, 'relay-acct-cli-')
  const file = path.join(s.dir, 'model-relay.json')
  fs.writeFileSync(file, JSON.stringify({ format: 2, port: await freePort(), providers: {}, ...cfg }))
  fs.writeFileSync(path.join(s.dir, 'settings.json'), JSON.stringify(settings))
  const env = { ...process.env, CLAUDE_CONFIG_DIR: s.dir }
  const run = (...args) => new Promise((resolve) => execFile(process.execPath, [SETUP, ...args], { cwd: s.dir, env }, (e, stdout, stderr) => resolve({ code: e ? e.code : 0, out: `${stdout}${stderr}`, stdout })))
  return { run, file, dir: s.dir }
}

// The same with a HOME: the relay dir is <home>/.claude, the default dir, whose login Claude Code keeps at <home>/.claude.json
async function homeCli(t, cfg, { settings = {} } = {}) {
  const s = scratch(t, 'relay-home-')
  const relayDir = path.join(s.dir, '.claude')
  fs.mkdirSync(relayDir)
  const file = path.join(relayDir, 'model-relay.json')
  fs.writeFileSync(file, JSON.stringify({ format: 2, port: await freePort(), ...cfg }))
  fs.writeFileSync(path.join(relayDir, 'settings.json'), JSON.stringify(settings))
  const env = { ...process.env, HOME: s.dir, USERPROFILE: s.dir, CLAUDE_CONFIG_DIR: relayDir, MODEL_RELAY_CONFIG_DIR: undefined }
  const run = (...args) => new Promise((resolve) => execFile(process.execPath, [SETUP, ...args], { cwd: s.dir, env }, (e, stdout, stderr) => resolve({ code: e ? e.code : 0, out: `${stdout}${stderr}`, stdout })))
  const login = (dir, uuid, extra = {}) => {
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, '.claude.json'), JSON.stringify({ ...extra, oauthAccount: { accountUuid: uuid, emailAddress: 'who@example.test' } }))
  }
  return { run, home: s.dir, relayDir, file, login }
}

test('setup refuses a provider named switch', async (t) => {
  const c = await cli(t)
  for (const args of [['add', 'switch', '--model', 'm', '--token', 'k', '--url', 'http://127.0.0.1:9'], ['account-add', 'switch']]) {
    const x = await c.run(...args)
    assert.strictEqual(x.code, 2, x.out)
    assert.match(x.out, /"switch" is the name of a \/provider command/)
  }
  assert.ok(!('switch' in JSON.parse(fs.readFileSync(c.file, 'utf8')).providers))
})

test('A3: handoff writes {sid} 0600 in a 0700 folder, exclusively and atomically; bad ids and a symlinked folder are refused', async (t) => {
  const s = scratch(t, 'relay-handoff-')
  // the config dir sits one level down, so a path that climbs out of it still lands inside the scratch dir
  const cfgDir = path.join(s.dir, 'cfg')
  fs.mkdirSync(cfgDir)
  const env = { ...process.env, CLAUDE_CONFIG_DIR: cfgDir }
  const run = (...args) => new Promise((resolve) => execFile(process.execPath, [SETUP, ...args], { cwd: s.dir, env }, (e, so, se) => resolve({ code: e ? e.code : 0, out: `${so}${se}` })))
  const ID = '0f1e2d3c-4b5a-4968-8776-5a4b3c2d1e0f'
  const SID = '22222222-3333-4444-8555-666666666666'
  const dir = path.join(cfgDir, 'model-relay-handoff')
  const file = path.join(dir, `${ID}.json`)
  fs.mkdirSync(dir, { mode: 0o755 }) // a folder already there, too open: tightened
  fs.chmodSync(dir, 0o755)
  const ok = await run('handoff', ID.toUpperCase(), SID)
  assert.strictEqual(ok.code, 0, ok.out)
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { sid: SID })
  if (process.platform !== 'win32') {
    assert.strictEqual(fs.statSync(dir).mode & 0o777, 0o700)
    assert.strictEqual(fs.statSync(file).mode & 0o777, 0o600)
  }
  // A second handoff replaces the file whole (a new inode), never writing into the old one, and leaves no temp file
  const ino = fs.statSync(file).ino
  const SID2 = '33333333-4444-4555-8666-777777777777'
  assert.strictEqual((await run('handoff', ID, SID2)).code, 0)
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { sid: SID2 })
  assert.notStrictEqual(fs.statSync(file).ino, ino)
  assert.deepStrictEqual(fs.readdirSync(dir), [`${ID}.json`])
  // a symlink where the file goes is replaced, not followed
  const outside = path.join(s.dir, 'outside.txt')
  fs.writeFileSync(outside, 'keep')
  fs.rmSync(file)
  fs.symlinkSync(outside, file)
  assert.strictEqual((await run('handoff', ID, SID)).code, 0)
  assert.strictEqual(fs.readFileSync(outside, 'utf8'), 'keep')
  assert.ok(!fs.lstatSync(file).isSymbolicLink())
  // ids that are no UUID never name a path
  for (const [id, sid] of [['../../x', SID], [ID, '--dangerously-skip-permissions'], [ID, '../x'], ['', SID]]) {
    const x = await run('handoff', id, sid)
    assert.strictEqual(x.code, 2, `${id} ${sid}`)
  }
  assert.ok(!fs.existsSync(path.join(s.dir, 'x.json')) && !fs.existsSync(path.join(cfgDir, 'x.json')), 'nothing written outside the folder')
  // a folder that is a symlink is refused, and nothing is written through it
  const s2 = scratch(t, 'relay-handoff-link-')
  const elsewhere = path.join(s2.dir, 'elsewhere')
  fs.mkdirSync(elsewhere)
  fs.rmSync(dir, { recursive: true })
  fs.symlinkSync(elsewhere, dir)
  const linked = await run('handoff', ID, SID)
  assert.strictEqual(linked.code, 1, linked.out)
  assert.match(linked.out, /is not a folder \(a symlink is refused\)\. Nothing was written\./)
  assert.deepStrictEqual(fs.readdirSync(elsewhere), [])
})

test('account-add and add refuse the name __proto__ instead of reporting a write that never lands', async (t) => {
  const c = await cli(t)
  const cfg = JSON.parse(fs.readFileSync(c.file, 'utf8'))
  fs.writeFileSync(c.file, JSON.stringify(cfg).replace('"providers":{', '"accounts":{},"providers":{'))
  const before = fs.readFileSync(c.file, 'utf8')
  for (const args of [['account-add', '__proto__'], ['add', '__proto__', '--model', 'm', '--token', 'k', '--url', 'http://127.0.0.1:9']]) {
    const x = await c.run(...args)
    assert.strictEqual(x.code, 2, x.out)
    assert.match(x.out, /"__proto__" cannot be a name in model-relay\.json/)
    assert.ok(!x.out.includes('✓'))
  }
  assert.strictEqual(fs.readFileSync(c.file, 'utf8'), before, 'the file is untouched')
})

test('list 10: account-add makes a 0700 dir with exactly the links the relay dir has, writes the entry with a backup, prints the steps, and refuses everything else untouched', async (t) => {
  const c = await homeCli(t, { accountFallback: { mode: 'switch' }, accounts: { 'team-2': { configDir: '~/.claude-team-2' } }, providers: {} })
  for (const f of ['CLAUDE.md', 'history.jsonl', '.config.json', 'statusline.sh']) fs.writeFileSync(path.join(c.relayDir, f), 'x')
  for (const d of ['agents', 'projects', 'ide', 'backups', 'shell-snapshots', 'session-env']) fs.mkdirSync(path.join(c.relayDir, d))
  const tree = () => {
    const out = []
    const walk = (d) => {
      for (const e of fs.readdirSync(d).sort()) {
        const p = path.join(d, e)
        const st = fs.lstatSync(p)
        out.push(`${path.relative(c.home, p)} ${st.isSymbolicLink() ? `-> ${fs.readlinkSync(p)}` : (st.mode & 0o777).toString(8)}${st.isFile() ? ` ${fs.readFileSync(p, 'utf8')}` : ''}`)
        if (st.isDirectory() && !st.isSymbolicLink()) walk(p)
      }
    }
    walk(c.home)
    return out
  }
  const cfgText = () => fs.readFileSync(c.file, 'utf8')
  const refused = async (args, code, re) => {
    const before = tree()
    const x = await c.run('account-add', ...args)
    assert.strictEqual(x.code, code, `${args.join(' ')}: ${x.out}`)
    assert.match(x.out, re, args.join(' '))
    assert.match(x.out, /Nothing was changed\./)
    assert.deepStrictEqual(tree(), before, `${args.join(' ')}: nothing touched`)
  }
  for (const n of ['.config.json', '../x', 'ide', 'history.jsonl', 'shell-snapshots', 'session-env', 'backups', '.claude.json', '.credentials.json', 'model-relay.json', 'a/b', '']) {
    await refused(['team-3', '--link', n], 2, /--link .* is refused: only a plain name in the relay dir/)
  }
  await refused(['team-3', '--link', 'nothing-here'], 2, /the relay dir .* has no such entry/)
  await refused(['team-2'], 1, /accounts\.team-2 already exists/)
  await refused(['Team-2'], 1, /accounts\.team-2 already exists/)
  for (const n of ['claude', 'x/y', '-x']) await refused([n], 2, /Usage: node tools\/setup\.mjs account-add/)
  await refused(['__proto__'], 2, /"__proto__" cannot be a name/)
  await refused(['team-3', '--dir', 'relative/dir'], 2, /--dir must be an absolute path or start with ~\//)
  fs.mkdirSync(path.join(c.home, 'real-empty'))
  fs.symlinkSync(path.join(c.home, 'real-empty'), path.join(c.home, 'linked'))
  await refused(['team-3', '--dir', '~/linked'], 1, /is a symlink/)
  fs.mkdirSync(path.join(c.home, 'full'))
  fs.writeFileSync(path.join(c.home, 'full', 'f'), 'x')
  await refused(['team-3', '--dir', path.join(c.home, 'full')], 1, /exists and is not empty/)
  await refused(['team-3', '--dir', '~/.claude/inside'], 1, /is, holds or lies inside the relay dir/)
  await refused(['team-3', '--dir', '~/'], 1, /is, holds or lies inside the relay dir/)
  await refused(['team-3', '--dir', '~/.claude-team-2/sub'], 1, /is, holds or lies inside the dir of accounts\.team-2/)
  await refused(['team-3', '--dir', '~/no-parent/dir'], 1, /does not exist/)
  // the default dir: the four default entries the relay dir has, plus --link statusline.sh; nothing else changes
  const before = tree()
  const ok = await c.run('account-add', 'team-3', '--link', 'statusline.sh')
  assert.strictEqual(ok.code, 0, ok.out)
  const dir = path.join(c.home, '.claude-team-3')
  assert.strictEqual(fs.statSync(dir).mode & 0o777, 0o700)
  assert.deepStrictEqual(fs.readdirSync(dir).sort(), ['CLAUDE.md', 'agents', 'projects', 'settings.json', 'statusline.sh'])
  for (const n of fs.readdirSync(dir)) assert.strictEqual(fs.readlinkSync(path.join(dir, n)), path.join(c.relayDir, n))
  const changed = tree().filter((l) => !before.includes(l)).filter((l) => !l.startsWith('.claude-team-3') && !l.startsWith('.claude/model-relay.json '))
  assert.deepStrictEqual(changed.map((l) => l.split(' ')[0]), ['.claude/model-relay.json.model-relay-backup'], 'only the dir, the config and its backup')
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(`${c.file}.model-relay-backup`, 'utf8')).accounts, { 'team-2': { configDir: '~/.claude-team-2' } })
  assert.deepStrictEqual(JSON.parse(cfgText()).accounts, { 'team-2': { configDir: '~/.claude-team-2' }, 'team-3': { configDir: '~/.claude-team-3' } })
  const esc = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  // the steps: the mode first (the plugin registers a window only in mode switch), then the login (pointed at the relay, so
  // the plugin registers that window), the account and the launcher; and a plain Terms note quoting the OAuth sentence
  assert.match(ok.out, /1\. node \S+ set accountFallback\.mode switch {3}\(first: /)
  assert.match(ok.out, new RegExp(`2\\. CLAUDE_CONFIG_DIR=${esc(dir)} MODEL_RELAY_CONFIG_DIR=${esc(c.relayDir)} claude, then /login as that account`))
  assert.match(ok.out, /3\. node \S+ set accountFallback\.account team-3\n/)
  assert.match(ok.out, /4\. node \S+ launcher {3}\(prints the command to start Claude Code with in place of claude\)/)
  assert.match(ok.out, /\n {2}Terms: Anthropic's terms, not this project, decide what you may do with several accounts\. .*"OAuth authentication is intended exclusively for purchasers of Claude Free, Pro, Max, Ultra, Team, and Enterprise subscription plans and is designed to support ordinary use of Claude Code and other native Anthropic applications\."/)
  assert.ok(!ok.out.split('\n').find((l) => l.includes('Terms:')).includes('⚠'), 'a note, not a warning')
  assert.deepStrictEqual(ok.out.split('\n').filter((l) => l.includes('⚠')), [`  ⚠ ${path.join(c.relayDir, 'plugins')} does not exist, so it is not linked: the plugin does not run in team-3's window, so it is never registered with the router`], 'this relay dir has no plugins folder, and nothing else to warn about')
  // a reused empty dir ends 0700
  fs.mkdirSync(path.join(c.home, 'empty'))
  fs.chmodSync(path.join(c.home, 'empty'), 0o755)
  const reuse = await c.run('account-add', 'team-4', '--dir', '~/empty')
  assert.strictEqual(reuse.code, 0, reuse.out)
  assert.strictEqual(fs.statSync(path.join(c.home, 'empty')).mode & 0o777, 0o700)
  assert.strictEqual(JSON.parse(cfgText()).accounts['team-4'].configDir, '~/empty')
})

test('list 16: account-add and doctor name, by key only, settings.json keys that would send with something other than the login', async (t) => {
  const settings = { env: { ANTHROPIC_API_KEY: tokenLike('api03', 'FAKE-VALUE'), CLAUDE_CODE_OAUTH_TOKEN: tokenLike('oat01', 'FAKE-VALUE'), OTHER: 'x' }, apiKeyHelper: '/usr/local/bin/fake-helper' }
  const c = await homeCli(t, { accountFallback: { mode: 'switch' }, accounts: { 'team-2': { configDir: '~/.claude-team-2' } }, providers: {} }, { settings })
  const want = `${path.join(c.relayDir, 'settings.json')} sets env.ANTHROPIC_API_KEY, env.CLAUDE_CODE_OAUTH_TOKEN, apiKeyHelper: an account dir that links this settings.json sends with that instead of its own login`
  const add = await c.run('account-add', 'team-3')
  assert.strictEqual(add.code, 0, add.out)
  const doc = await c.run('doctor')
  for (const x of [add, doc]) {
    assert.ok(x.out.includes(`⚠ ${want}`), x.out)
    assert.ok(!x.out.includes('FAKE-VALUE') && !x.out.includes('fake-helper'), 'no value printed')
  }
  assert.ok(!doc.out.includes('ANTHROPIC_AUTH_TOKEN') && !doc.out.includes('env.OTHER'), 'only the keys set, and only those three')
})

test('list 9: in mode switch doctor names each account\'s login file, says where /provider switch goes, and errors on one login shared; no uuid or email printed', async (t) => {
  const c = await homeCli(t, { accountFallback: { mode: 'switch', account: 'team-2' }, accounts: { 'team-1': { configDir: '~/.claude-team-1' }, 'team-2': { configDir: '~/.claude-team-2' }, 'team-3': { configDir: '~/.claude-team-3' }, 'other-org': { configDir: '~/.claude-other-org' } }, providers: {} })
  c.login(c.home, MAIN_UUID)
  c.login(c.relayDir, OTHER_UUID) // a stale copy inside the default dir, another account
  c.login(path.join(c.home, '.claude-team-1'), '21111111-2222-4333-8444-555555555555')
  c.login(path.join(c.home, '.claude-team-2'), '22222222-2222-4333-8444-555555555555')
  c.login(path.join(c.home, '.claude-team-3'), '22222222-2222-4333-8444-555555555555')
  fs.writeFileSync(path.join(c.home, '.claude-team-2', '.config.json'), '{}')
  const doc = await c.run('doctor')
  const lines = doc.out.split('\n')
  const line = (re) => lines.find((l) => re.test(l)) || ''
  assert.strictEqual(line(/Accounts:/), '  Accounts: mode "switch"; /provider switch moves a window to team-2')
  assert.strictEqual(line(/Login of team-1/), `  Login of team-1: ${path.join(c.home, '.claude-team-1', '.claude.json')} (an accountUuid found)`)
  assert.strictEqual(line(/Login of other-org/), `  Login of other-org: ${path.join(c.home, '.claude-other-org', '.claude.json')} (not readable)`)
  assert.ok(doc.out.includes(`⚠ ${path.join(c.home, '.claude', '.claude.json')} names another account than ${path.join(c.home, '.claude.json')}`), doc.out)
  assert.ok(doc.out.includes(`⚠ ${path.join(c.home, '.claude-team-2', '.config.json')} exists; the relay reads ${path.join(c.home, '.claude-team-2', '.claude.json')} only for team-2's login`), doc.out)
  // team-2 and team-3 are logged in to one account: an error, and exit code 1
  assert.strictEqual(doc.code, 1, doc.out)
  assert.match(doc.out, /✗ accounts team-2, team-3 are logged in to one account; each needs a login of its own/)
  for (const v of [MAIN_UUID, OTHER_UUID, '22222222-2222-4333-8444-555555555555', 'who@example']) assert.ok(!doc.out.includes(v), `no ${v.slice(0, 10)}…`)
  // two accounts reading one login file (a symlinked dir)
  fs.symlinkSync(path.join(c.home, '.claude-team-1'), path.join(c.home, 'team-1-link'))
  fs.writeFileSync(c.file, JSON.stringify({ format: 2, port: 9, accountFallback: { mode: 'switch' }, accounts: { 'team-1': { configDir: '~/.claude-team-1' }, link: { configDir: '~/team-1-link' } }, providers: {} }))
  const shared = await c.run('doctor')
  assert.strictEqual(shared.code, 1, shared.out)
  assert.match(shared.out, /✗ accounts team-1, link read one login file; each account needs a login of its own/)
  assert.match(shared.out, /Accounts: mode "switch"; accountFallback\.account is not set, so \/provider switch has nowhere to go/)
})

test('A10-F4: setup.mjs works on MODEL_RELAY_CONFIG_DIR when it is absolute and exists', async (t) => {
  const { execFile } = require('node:child_process')
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-switch-setup-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const main = path.join(root, 'main')
  const acct = path.join(root, 'acct')
  for (const d of [main, acct]) fs.mkdirSync(d)
  const port = await freePort() // nothing listens there
  const cfg = (name) => JSON.stringify({ format: 2, port, accountFallback: { mode: 'switch', account: 'second' }, accounts: { second: { configDir: acct } }, providers: { [name]: { baseUrl: 'http://127.0.0.1:9', token: 'k', model: `${name}-model` } } })
  fs.writeFileSync(path.join(main, 'model-relay.json'), cfg('mainprov'))
  fs.writeFileSync(path.join(acct, 'model-relay.json'), cfg('acctprov'))
  const SETUP = path.join(__dirname, '..', 'tools', 'setup.mjs')
  const run = (env, ...args) => new Promise((resolve) => execFile(process.execPath, [SETUP, ...args], { cwd: root, env: { ...process.env, HOME: root, ...env } }, (e, so, se) => resolve({ code: e ? e.code : 0, out: `${so}${se}` })))
  const listed = await run({ CLAUDE_CONFIG_DIR: acct, MODEL_RELAY_CONFIG_DIR: main }, 'providers')
  assert.match(listed.out, /mainprov/)
  assert.ok(!listed.out.includes('acctprov'), 'main\'s config, not the window\'s own')
  for (const given of ['relative/dir', path.join(root, 'nowhere'), '']) {
    const x = await run({ CLAUDE_CONFIG_DIR: acct, MODEL_RELAY_CONFIG_DIR: given }, 'providers')
    assert.match(x.out, /acctprov/, `${given}: treated as unset`)
  }
})
