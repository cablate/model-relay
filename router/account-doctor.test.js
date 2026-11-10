'use strict'
// doctor and account-add in a scratch HOME, in mode switch: what they say when an account's folder is not set up the way
// /provider switch needs (no login, the login of your own account, a projects folder of its own, a relay dir without one),
// and that accounts alone need no provider. Nothing here touches a real home or config dir.
require('./test-env')
const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const net = require('node:net')
const os = require('node:os')
const path = require('node:path')
const { execFile } = require('node:child_process')

const SETUP = path.join(__dirname, '..', 'tools', 'setup.mjs')
const MINE = '11111111-2222-4333-8444-555555555555'
const OTHER = '22222222-2222-4333-8444-555555555555'

const freePort = () => new Promise((resolve) => {
  const s = net.createServer()
  s.listen(0, '127.0.0.1', () => {
    const { port } = s.address()
    s.close(() => resolve(port))
  })
})

// <home>/.claude is the relay dir, holding model-relay.json from cfg; no provider unless cfg gives some
async function setup(t, cfg = {}, { projects = true } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-acct-doc-'))
  t.after(() => fs.rmSync(home, { recursive: true, force: true }))
  const relay = path.join(home, '.claude')
  fs.mkdirSync(relay)
  if (projects) fs.mkdirSync(path.join(relay, 'projects'))
  fs.writeFileSync(path.join(relay, 'settings.json'), '{}')
  fs.writeFileSync(path.join(relay, 'model-relay.json'), JSON.stringify({ format: 2, port: await freePort(), accountFallback: { mode: 'switch', account: 'team-2' }, accounts: { 'team-2': { configDir: '~/.claude-team-2' } }, ...cfg }))
  const env = { ...process.env, HOME: home, USERPROFILE: home, CLAUDE_CONFIG_DIR: relay }
  const run = (...args) => new Promise((resolve) => execFile(process.execPath, [SETUP, ...args], { cwd: home, env }, (e, stdout, stderr) => resolve({ code: e ? e.code : 0, out: `${stdout}${stderr}` })))
  const login = (dir, uuid) => {
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, '.claude.json'), JSON.stringify({ oauthAccount: { accountUuid: uuid, emailAddress: 'who@example.test' } }))
  }
  const findings = async () => JSON.parse((await run('doctor', '--json')).out).findings
  return { home, relay, run, login, findings, team2: path.join(home, '.claude-team-2') }
}

test('accounts alone need no provider: doctor says Config OK and does not warn about the empty list', async (t) => {
  const c = await setup(t)
  c.login(c.home, MINE)
  c.login(c.team2, OTHER)
  fs.symlinkSync(path.join(c.relay, 'projects'), path.join(c.team2, 'projects'))
  const doc = await c.run('doctor')
  assert.match(doc.out, /^Config OK \(.*\); no provider is configured, which accounts alone do not need/m)
  assert.ok(!doc.out.includes('no provider has an address'), doc.out)
  assert.deepStrictEqual((await c.findings()).filter((f) => f.id !== 'wiring').map((f) => f.id), [], 'nothing about the accounts or the missing provider')
  // a provider that is configured but unusable is still a problem
  fs.writeFileSync(path.join(c.relay, 'model-relay.json'), JSON.stringify({ format: 2, port: await freePort(), accountFallback: { mode: 'switch', account: 'team-2' }, accounts: { 'team-2': { configDir: '~/.claude-team-2' } }, providers: { mine: { token: 'env:RELAY_ACCT_DOC_UNSET', model: 'm', baseUrl: 'https://mine.example' } } }))
  const bad = await c.run('doctor')
  assert.match(bad.out, /^Config read \(.*\), but no provider is usable yet/m)
  assert.ok((await c.findings()).some((f) => f.id === 'missing-key'))
})

test('doctor warns when an account is not logged in yet, or is logged in as your own account, and says what to run', async (t) => {
  const c = await setup(t)
  const none = (await c.findings()).find((f) => f.id === 'account-not-logged-in')
  assert.ok(none && none.text.startsWith(`team-2 is not logged in yet: run CLAUDE_CONFIG_DIR=${c.team2} MODEL_RELAY_CONFIG_DIR=${c.relay} claude, then /login there`), JSON.stringify(none))
  c.login(c.home, MINE)
  c.login(c.team2, MINE) // the same account as ~/.claude.json
  const yours = (await c.findings()).find((f) => f.id === 'account-is-yours')
  assert.ok(yours && /^team-2 is logged in to your own account .*\/provider switch would move a window to the account it is on/.test(yours.text), JSON.stringify(yours))
  assert.ok(!yours.text.includes(MINE) && !yours.text.includes('who@example'), 'no uuid or email')
  c.login(c.team2, OTHER)
  const ids = (await c.findings()).map((f) => f.id)
  assert.ok(!ids.includes('account-not-logged-in') && !ids.includes('account-is-yours'), ids.join())
})

test('doctor warns, with the ln -s command, when the switch target has a projects folder of its own or the relay dir has none', async (t) => {
  const c = await setup(t)
  c.login(c.home, MINE)
  c.login(c.team2, OTHER)
  fs.mkdirSync(path.join(c.team2, 'projects'))
  const apart = (await c.findings()).find((f) => f.id === 'account-projects')
  assert.ok(apart && apart.text.includes(`ln -s ${path.join(c.relay, 'projects')} ${path.join(c.team2, 'projects')}`) && apart.text.includes('/provider switch refuses'), JSON.stringify(apart))
  fs.rmSync(path.join(c.team2, 'projects'), { recursive: true })
  fs.symlinkSync(path.join(c.relay, 'projects'), path.join(c.team2, 'projects'))
  assert.ok(!(await c.findings()).some((f) => f.id === 'account-projects'), 'linked: nothing to say')
  // no projects folder in the relay dir yet: the same warning, since nothing is shared
  const bare = await setup(t, {}, { projects: false })
  bare.login(bare.home, MINE)
  bare.login(bare.team2, OTHER)
  assert.ok((await bare.findings()).some((f) => f.id === 'account-projects'))
})

test('account-add warns for each of projects, settings.json and plugins that the relay dir lacks, with what the window loses', async (t) => {
  const c = await setup(t, { accounts: {}, accountFallback: undefined }, { projects: false })
  fs.rmSync(path.join(c.relay, 'settings.json'))
  const bare = await c.run('account-add', 'team-3')
  assert.strictEqual(bare.code, 0, bare.out)
  for (const n of ['projects', 'settings.json', 'plugins']) assert.ok(bare.out.includes(`⚠ ${path.join(c.relay, n)} does not exist, so it is not linked: `), `${n}: ${bare.out}`)
  assert.match(bare.out, /\/provider switch refuses until .*team-3\/projects and .*\.claude\/projects are one folder/)
  assert.match(bare.out, /the plugin does not run in team-3's window, so it is never registered with the router/)
  fs.mkdirSync(path.join(c.relay, 'projects'))
  fs.mkdirSync(path.join(c.relay, 'plugins'))
  fs.writeFileSync(path.join(c.relay, 'settings.json'), '{}')
  const full = await c.run('account-add', 'team-4')
  assert.strictEqual(full.code, 0, full.out)
  assert.ok(!/does not exist, so it is not linked/.test(full.out), full.out)
})

test('doctor puts the account lines together, and ends with a line that says so when it found an error', async (t) => {
  const c = await setup(t, { accounts: { 'team-2': { configDir: '~/.claude-team-2' }, 'team-3': { configDir: '~/.claude-team-3' } } })
  c.login(c.home, MINE)
  c.login(c.team2, OTHER)
  c.login(path.join(c.home, '.claude-team-3'), OTHER) // one account twice: an error
  const doc = await c.run('doctor')
  assert.strictEqual(doc.code, 1, doc.out)
  const lines = doc.out.split('\n')
  const at = (re) => lines.findIndex((l) => re.test(l))
  assert.ok(at(/Accounts:/) < at(/Login of team-2/) && at(/Login of team-3/) < at(/Aliases:/), 'Accounts and Login lines before Aliases')
  assert.match(doc.out, /^Config OK/m)
  assert.ok(lines.some((l) => l.startsWith('Not OK after all: fix the ✗ lines above')), doc.out)
  const fine = await setup(t)
  fine.login(fine.home, MINE)
  fine.login(fine.team2, OTHER)
  fs.symlinkSync(path.join(fine.relay, 'projects'), path.join(fine.team2, 'projects'))
  const ok = await fine.run('doctor')
  assert.strictEqual(ok.code, 0, ok.out)
  assert.ok(!ok.out.includes('Not OK after all'), ok.out)
})
