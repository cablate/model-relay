'use strict'
// The setup CLI's account commands: set accountFallback.mode|account, account-fallback, account-token, the next steps
// account-add and account-sync print, and doctor's account findings. setup.mjs runs in a scratch home with a preload
// that refuses the keychain tool (no test runs it; each attempt is logged) and stands in for the OS through
// globalThis.__modelRelayTestPlatform. Ids in the titles are those of the pre-PR audit (A, B) and its security review (F).
require('./test-env')
const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const net = require('node:net')
const os = require('node:os')
const path = require('node:path')
const { execFile } = require('node:child_process')
const { sh, ps } = require('./test-shell')

const SETUP = path.join(__dirname, '..', 'tools', 'setup.mjs')
const PRELOAD = (platform) => `'use strict'
globalThis.__modelRelayTestPlatform = ${JSON.stringify(platform)}
const cp = require('child_process')
const fs = require('fs')
for (const n of ['execFile', 'execFileSync', 'spawn', 'spawnSync', 'exec', 'execSync']) {
  const orig = cp[n]
  cp[n] = function (f, ...rest) {
    if (/security/.test(String(f))) {
      fs.appendFileSync(process.env.RELAY_TEST_KEYCHAIN_LOG, n + '\\n')
      throw Object.assign(new Error('no keychain in this test'), { status: 44 })
    }
    return orig.call(this, f, ...rest)
  }
}
`
// Token-shaped strings, built here so that no source file holds one
const TOKEN = ['sk', 'ant', 'oat01', `${'Qx7'.repeat(30)}-${'Zr2'.repeat(10)}AA`].join('-')
const INLINE = ['sk', 'ant', 'oat01', 'Inline'.repeat(12)].join('-')
const UUID2 = '2b2b2b2b-aaaa-4bbb-8ccc-222222222222'
const UUID3 = '3c3c3c3c-aaaa-4bbb-8ccc-333333333333'
const MAIN_UUID = '11111111-2222-4333-8444-555555555555'

const freePort = () => new Promise((resolve) => {
  const s = net.createServer()
  s.listen(0, '127.0.0.1', () => {
    const { port } = s.address()
    s.close(() => resolve(port))
  })
})
const acct = (n, uuid, extra = {}) => ({ kind: 'anthropic', token: `env:T_${n.replace(/-/g, '_').toUpperCase()}`, accountUuid: uuid, deviceId: uuid.slice(0, 2).repeat(32), email: `${n}@example.test`, ...extra })

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
  const log = path.join(dir, 'keychain.log')
  fs.writeFileSync(log, '')
  const env = { ...process.env, HOME: dir, USERPROFILE: dir, CLAUDE_CONFIG_DIR: relayDir, RELAY_TEST_KEYCHAIN_LOG: log, ...more }
  delete env.MODEL_RELAY_CONFIG_DIR
  const run = (...args) => new Promise((resolve) => execFile(process.execPath, ['--require', preload, SETUP, ...args], { cwd: dir, env }, (e, stdout, stderr) => resolve({ code: e ? e.code : 0, stdout, stderr, out: `${stdout}${stderr}` })))
  const read = () => JSON.parse(fs.readFileSync(file, 'utf8'))
  const text = () => fs.readFileSync(file, 'utf8')
  const backup = () => (fs.existsSync(`${file}.model-relay-backup`) ? fs.readFileSync(`${file}.model-relay-backup`, 'utf8') : '')
  const login = (d, uuid, userID) => {
    fs.mkdirSync(d, { recursive: true })
    fs.writeFileSync(path.join(d, '.claude.json'), JSON.stringify({ userID, oauthAccount: { accountUuid: uuid, emailAddress: 'who@example.test' } }))
  }
  return { dir, relayDir, file, run, read, text, backup, login, keychainRuns: () => fs.readFileSync(log, 'utf8') }
}
// A printed command of this CLI, run as printed (words split on spaces; the test's paths need no quoting)
const runPrinted = (c, line) => {
  const words = line.trim().split(/\s+/)
  assert.strictEqual(words[0], 'node', line)
  assert.strictEqual(words[1].replace(/^'(.*)'$/, '$1'), SETUP, line) // quoted where the path needs it
  return c.run(...words.slice(2))
}
const lineWith = (out, needle) => out.split('\n').find((l) => l.includes(needle)) || ''
const after = (line, marker) => line.slice(line.indexOf(marker) + marker.length)

const ACCOUNTS = { own: { configDir: '~/.claude' }, 'team-1': { configDir: '~/.claude-team-1' }, 'team-2': { configDir: '~/.claude-team-2' }, 'team-3': { configDir: '~/.claude-team-3' } }

test('A1/B1 (CLI): set accountFallback.mode and accountFallback.account write the keys; any other value is refused with a fixed text', async (t) => {
  const c = await home(t, { accounts: ACCOUNTS, providers: {} })
  for (const m of ['switch', 'rc-keep', 'api-only', 'off']) {
    const x = await c.run('set', 'accountFallback.mode', m)
    assert.strictEqual(x.code, 0, x.out)
    assert.strictEqual(c.read().accountFallback.mode, m)
  }
  const before = c.text()
  for (const [k, v] of [['accountFallback.mode', 'rc_keep'], ['accountFallback.mode', 'nobody-here'], ['accountFallback.account', 'nobody-here'], ['accountFallback.account', '../x'], ['accountFallback.account', 'own']]) {
    const x = await c.run('set', k, v)
    assert.strictEqual(x.code, 2, `${k} ${v}: ${x.out}`)
    assert.ok(!x.out.includes('nobody-here') && !x.out.includes('../x'), `${k}: the value is not echoed`)
    assert.strictEqual(c.text(), before, `${k} ${v}: nothing written`)
  }
  assert.match((await c.run('set', 'accountFallback.mode', 'rc_keep')).out, /accountFallback\.mode: expected off, switch, rc-keep, api-only/)
  assert.match((await c.run('set', 'accountFallback.account', 'own')).out, /the relay's own account/)
  const ok = await c.run('set', 'accountFallback.account', ' Team-2 ')
  assert.strictEqual(ok.code, 0, ok.out)
  assert.deepStrictEqual(c.read().accountFallback, { mode: 'off', account: 'team-2' })
  assert.strictEqual(JSON.parse(c.backup()).accountFallback.account, undefined, 'the previous file kept as the backup')
  const none = await c.run('set', 'accountFallback.account', 'none')
  assert.strictEqual(none.code, 0, none.out)
  assert.deepStrictEqual(c.read().accountFallback, { mode: 'off' })
  assert.strictEqual(c.keychainRuns(), '')
})

test('F12: set accountFallback.mode rc-keep or api-only prints the terms line; switch and off do not', async (t) => {
  const c = await home(t, { providers: {} })
  for (const [m, said] of [['rc-keep', true], ['switch', false], ['api-only', true], ['off', false]]) {
    const x = await c.run('set', 'accountFallback.mode', m)
    assert.strictEqual(x.code, 0, x.out)
    assert.strictEqual(/Anthropic's terms govern how accounts and their credentials may be used/.test(x.out), said, `${m}: ${x.out}`)
    if (said) assert.match(x.out, /another Claude account's token and that account's ids \(account_uuid, device_id, the email sentence\) and a session id of its own for each window\./)
  }
})

test('A1 (CLI): account-fallback writes a string for one target, a list otherwise, {account, allowCrossOrg: true} for opted-in ones; none removes it; refusals change nothing', async (t) => {
  const c = await home(t, { accountFallback: { mode: 'switch' }, accounts: ACCOUNTS, providers: { 'team-2': acct('team-2', UUID2), 'team-3': acct('team-3', UUID3) } })
  const one = await c.run('account-fallback', 'Team-1', 'team-2')
  assert.strictEqual(one.code, 0, one.out)
  assert.strictEqual(c.read().accounts['team-1'].fallback, 'team-2')
  assert.ok(!one.out.includes('⚠'), `a clean list warns of nothing: ${one.out}`)
  assert.strictEqual(JSON.parse(c.backup()).accounts['team-1'].fallback, undefined, 'backup made')
  const two = await c.run('account-fallback', 'team-1', 'team-3, team-2')
  assert.strictEqual(two.code, 0, two.out)
  assert.deepStrictEqual(c.read().accounts['team-1'], { configDir: '~/.claude-team-1', fallback: ['team-3', 'team-2'] })
  const crossed = await c.run('account-fallback', 'team-1', 'team-2,team-3', '--allow-cross-org', 'team-3')
  assert.strictEqual(crossed.code, 0, crossed.out)
  assert.deepStrictEqual(c.read().accounts['team-1'].fallback, ['team-2', { account: 'team-3', allowCrossOrg: true }])
  const crossedOne = await c.run('account-fallback', 'own', 'team-3', '--allow-cross-org', 'team-3')
  assert.strictEqual(crossedOne.code, 0, crossedOne.out)
  assert.deepStrictEqual(c.read().accounts.own.fallback, [{ account: 'team-3', allowCrossOrg: true }], 'an opted-in single target stays a list')

  const before = c.text()
  const refusals = [
    [['nobody', 'team-2'], /the first <account> is not the name of an account/],
    [['team-1', 'nobody'], /every target must be the name of an account/],
    [['team-1', 'team-2,../x'], /every target must be the name of an account/],
    [['team-1', 'team-1'], /an account cannot be its own fallback/],
    [['team-1', 'own'], /the relay's own account \(its configDir is this config dir\) is never a fallback/],
    [['team-1', 'team-2,Team-2'], /a target is named twice/],
    [['team-1', ' , '], /give at least one target account/],
    [['team-1', 'team-2', '--allow-cross-org'], /usage: account-fallback/],
    [['team-1', 'team-2', '--allow-cross-org', 'team-3'], /every --allow-cross-org account must also be in the target list/],
    [['team-1', 'none', '--allow-cross-org', 'team-2'], /--allow-cross-org goes with a target list/],
    [['team-1', 'team-2', 'team-3'], /usage: account-fallback/],
    [['team-1'], /usage: account-fallback/],
  ]
  for (const [args, re] of refusals) {
    const x = await c.run('account-fallback', ...args)
    assert.strictEqual(x.code, 2, `${args.join(' ')}: ${x.out}`)
    assert.match(x.stderr, re, args.join(' '))
    assert.match(x.stderr, /Nothing was changed\./)
    assert.ok(!x.out.includes('nobody') && !x.out.includes('../x'), `${args.join(' ')}: no argument echoed`)
    assert.strictEqual(c.text(), before, `${args.join(' ')}: nothing written`)
  }
  const none = await c.run('account-fallback', 'team-1', 'none')
  assert.strictEqual(none.code, 0, none.out)
  assert.deepStrictEqual(c.read().accounts['team-1'], { configDir: '~/.claude-team-1' })
  const again = await c.run('account-fallback', 'team-1', 'none')
  assert.strictEqual(again.code, 0)
  assert.match(again.out, /accounts\.team-1 has no fallback list; nothing to change/)
  assert.strictEqual(c.keychainRuns(), '')
})

test('F3: --allow-cross-org warns of the organization boundary; a target with no kind entry, or a mode other than switch, is a warning that names the next command', async (t) => {
  const c = await home(t, { accountFallback: { mode: 'rc-keep' }, accounts: ACCOUNTS, providers: { 'team-2': acct('team-2', UUID2) } })
  const x = await c.run('account-fallback', 'team-1', 'team-2,team-3', '--allow-cross-org', 'team-2')
  assert.strictEqual(x.code, 0, x.out)
  assert.deepStrictEqual(c.read().accounts['team-1'].fallback, [{ account: 'team-2', allowCrossOrg: true }, 'team-3'], 'written although team-3 has no entry yet')
  assert.match(x.out, /⚠ allowCrossOrg: at team-1's usage limit its conversation can go on with team-2 in another organization, so the conversation crosses that organization's boundary/)
  assert.match(x.out, /⚠ accounts\.team-1\.fallback names team-3, which has no kind "anthropic" entry in providers; until that is fixed the router skips that entry/)
  assert.match(x.out, /Each target needs a Claude account entry with a token: node \S+ account-sync <account>, then node \S+ account-token <account> keychain:<service>\/<account>/)
  // B3 here too: the list is read only in mode switch, and the command that sets it
  const modeLine = lineWith(x.out, 'is read only when accountFallback.mode is "switch"')
  assert.match(modeLine, /⚠ accounts\.team-1\.fallback is read only when accountFallback\.mode is "switch" \(now "rc-keep"\): node \S+ set accountFallback\.mode switch$/)
  assert.strictEqual((await runPrinted(c, after(modeLine, ': '))).code, 0, 'the printed command runs')
  assert.strictEqual(c.read().accountFallback.mode, 'switch')
  // in switch with every entry usable: no warning but the boundary one
  const clean = await c.run('account-fallback', 'team-1', 'team-2', '--allow-cross-org', 'team-2')
  assert.deepStrictEqual(clean.out.split('\n').filter((l) => l.includes('⚠')).length, 1, clean.out)
  const plain = await c.run('account-fallback', 'team-1', 'team-2')
  assert.ok(!plain.out.includes('⚠') && !plain.out.includes('organization'), plain.out)
})

test('F1: account-token writes only an env: or keychain: reference on a kind "anthropic" entry; every other form is refused with a fixed text and the config untouched', async (t) => {
  const c = await home(t, { accountFallback: { mode: 'rc-keep' }, providers: { other: { baseUrl: 'http://127.0.0.1:9', token: 'k', model: 'm' }, 'team-2': acct('team-2', UUID2) } })
  const made = await c.run('account-token', 'Team-3', 'env:MODEL_RELAY_TOKEN_TEAM_3')
  assert.strictEqual(made.code, 0, made.out)
  assert.deepStrictEqual(c.read().providers['team-3'], { kind: 'anthropic', token: 'env:MODEL_RELAY_TOKEN_TEAM_3' })
  assert.match(made.out, /✓ providers\.team-3\.token is env:MODEL_RELAY_TOKEN_TEAM_3 \(a new Claude account entry, kind "anthropic"\)/)
  assert.match(made.out, /Next: node \S+ account-sync team-3/)
  const kept = await c.run('account-token', 'team-2', 'keychain:model-relay.team_2/team-2@x')
  assert.strictEqual(kept.code, 0, kept.out)
  assert.deepStrictEqual(c.read().providers['team-2'], { ...acct('team-2', UUID2), token: 'keychain:model-relay.team_2/team-2@x' }, 'the rest of the entry kept')
  assert.ok(!kept.out.includes('Next:'), 'ids already there: no account-sync step')
  assert.match((await c.run('account-token', 'team-2', 'keychain:model-relay.team_2/team-2@x')).out, /is already keychain:model-relay\.team_2\/team-2@x/)

  const before = c.text()
  const long = 'a'.repeat(65)
  const refusals = [
    [[], /usage: account-token <name> env:<VAR> or keychain:<service>\/<account>/],
    [['team-2'], /usage: account-token/],
    [['team-2', 'env:X', 'extra'], /usage: account-token/],
    [['team 2', 'env:X'], /<name> must be a provider name/],
    [['../x', 'env:X'], /<name> must be a provider name/],
    [['claude', 'env:X'], /<name> must be a provider name/],
    [[long, 'env:X'], /<name> must be a provider name/],
    [['team-2', 'env:'], /env:<VAR> must name a variable/],
    [['team-2', 'env:1BAD'], /env:<VAR> must name a variable/],
    [['team-2', 'env:BAD-NAME'], /env:<VAR> must name a variable/],
    [['team-2', 'env: X'], /env:<VAR> must name a variable/],
    [['team-2', `env:${'A'.repeat(65)}`], /env:<VAR> must name a variable/],
    [['team-2', 'env:CLAUDE_CODE_OAUTH_TOKEN'], /env: cannot name CLAUDE_CODE_OAUTH_TOKEN, ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN/],
    [['team-2', 'env:anthropic_api_key'], /env: cannot name/],
    [['team-2', 'env:ANTHROPIC_AUTH_TOKEN'], /env: cannot name/],
    [['team-2', 'keychain:'], /keychain: must be keychain:<service>\/<account>/],
    [['team-2', 'keychain:svc'], /keychain: must be/],
    [['team-2', 'keychain:-w/acct'], /keychain: must be/],
    [['team-2', 'keychain:svc/-x'], /keychain: must be/],
    [['team-2', 'keychain:a/b/c'], /keychain: must be/],
    [['team-2', 'keychain: svc/acct'], /keychain: must be/],
    [['team-2', `keychain:${long}/acct`], /keychain: must be/],
    [['team-2', `keychain:svc/${long}`], /keychain: must be/],
    // F1 (verifier): token-looking text anywhere in a part, not only at its start
    [['team-2', `keychain:svc/x-${TOKEN}`], /keychain: must be keychain:<service>\/<account>, each a word/],
    [['team-2', `keychain:x-${TOKEN.slice(0, 20)}/acct`], /keychain: must be keychain:<service>\/<account>, each a word/],
    [['team-2', `keychain:svc/a${TOKEN.slice(0, 12).toUpperCase()}`], /keychain: must be/],
    [['team-2', `env:X-${TOKEN.slice(0, 20)}`], /env:<VAR> must name a variable/],
    [['team-2', 'some-value'], /the token must be a reference, env:<VAR> or keychain:<service>\/<account>, never the token itself/],
    [['other', 'env:X'], /providers\.<name> exists and is not a Claude account/],
  ]
  for (const [args, re] of refusals) {
    const x = await c.run('account-token', ...args)
    assert.strictEqual(x.code, 2, `${args.join(' ')}: ${x.out}`)
    assert.match(x.stderr, re, args.join(' '))
    assert.match(x.stderr, /Nothing was changed\./)
    assert.strictEqual(x.stdout, '', args.join(' '))
    for (const a of args.filter((s) => !['team-2', 'other', 'claude'].includes(s))) assert.ok(!x.stderr.includes(a) || /^(env:|keychain:)$/.test(a), `${args.join(' ')}: echoed ${a}`)
    assert.strictEqual(c.text(), before, `${args.join(' ')}: nothing written`)
  }
  assert.match((await c.run('account-token', 'team-2', 'some-value')).stderr, /If you pasted a token here, treat it as exposed/)
  assert.ok(!(await c.run('account-token', 'team-2', 'env:ANTHROPIC_API_KEY')).stderr.includes('exposed'), 'a variable name is no token')
  assert.match((await c.run('account-token', 'switch', 'env:X')).stderr, /"switch" is the name of a \/provider command/)
  // tokenSource: an env: token that names no variable is shown by a marker, never as written
  const s = await home(t, { providers: { odd: { baseUrl: 'http://127.0.0.1:9', model: 'm', token: `env:${INLINE}` } } })
  const list = await s.run('providers')
  assert.match(list.out, /✗ odd: not usable \(token env:\(malformed\) did not resolve/)
  assert.ok(!list.out.includes(INLINE))
  assert.strictEqual(c.keychainRuns() + s.keychainRuns(), '')
})

test('acceptance 2 (F1): a runtime-built token in every argument position is absent from stdout, stderr, the config and its backup', async (t) => {
  const cfg = { accountFallback: { mode: 'switch' }, accounts: ACCOUNTS, providers: { 'team-2': acct('team-2', UUID2) } }
  const forms = [TOKEN, TOKEN.toLowerCase(), TOKEN.replace(/-/g, '_'), TOKEN.slice(0, 60)]
  const calls = []
  for (const tok of [TOKEN, TOKEN.replace(/-/g, '_')]) {
    calls.push(
      ['account-token', tok],
      ['account-token', tok, 'env:X'],
      ['account-token', 'team-2', tok],
      ['account-token', 'team-2', `env:${tok}`],
      ['account-token', 'team-2', `keychain:${tok}`],
      ['account-token', 'team-2', `keychain:${tok}/acct`],
      ['account-token', 'team-2', `keychain:svc/${tok}`],
      ['account-token', 'team-2', `keychain: ${tok}`],
      ['account-token', 'team-2', 'env:X', tok],
      ['account-token', tok, tok, tok],
      ['account-fallback', tok, 'team-2'],
      ['account-fallback', 'team-1', tok],
      ['account-fallback', 'team-1', `team-2,${tok}`],
      ['account-fallback', 'team-1', 'team-2', '--allow-cross-org', tok],
      ['account-fallback', 'team-1', 'team-2', tok],
      ['set', 'accountFallback.account', tok],
      ['set', 'accountFallback.mode', tok],
      ['account-sync', tok],
    )
  }
  for (const platform of ['darwin', 'linux']) {
    const c = await home(t, cfg, { platform })
    for (const args of calls) {
      const x = await c.run(...args)
      assert.notStrictEqual(x.code, 0, `${platform} ${args[0]} #${args.indexOf(TOKEN)}: refused`)
      for (const f of forms) {
        for (const [where, text] of [['stdout', x.stdout], ['stderr', x.stderr], ['config', c.text()], ['backup', c.backup()]]) {
          assert.ok(!text.includes(f), `${platform} ${args[0]} (${args.map((a) => (a.includes(TOKEN.slice(0, 12)) || a.includes(TOKEN.slice(0, 12).replace(/-/g, '_')) ? '<token>' : a)).join(' ')}): in ${where}`)
        }
      }
    }
    assert.strictEqual(c.keychainRuns(), '', 'the keychain tool never ran')
  }
})

test('F2: account-token over a token written as a value says the backup still holds it, and to delete that file', async (t) => {
  const c = await home(t, { providers: { 'team-2': acct('team-2', UUID2, { token: INLINE }), 'team-3': acct('team-3', UUID3, { token: 'keychain:has space/x' }) } })
  const x = await c.run('account-token', 'team-2', 'env:T2')
  assert.strictEqual(x.code, 0, x.out)
  assert.ok(c.backup().includes(INLINE), 'the backup holds the old value, as the line says')
  assert.ok(!c.text().includes(INLINE))
  assert.ok(x.out.includes(`⚠ ${c.file}.model-relay-backup still holds the token that was written there as a value before; delete that file`), x.out)
  assert.ok(!x.out.includes(INLINE))
  assert.match((await c.run('account-token', 'team-3', 'env:T3')).out, /still holds the token that was written there as a value before/, 'a malformed reference may be a pasted token too')
  assert.ok(!(await c.run('account-token', 'team-3', 'env:T4')).out.includes('still holds'), 'an env: reference before: no warning')
})

test('B1, W-1, W-11: account-add and account-sync print the exact commands for the mode the config is in, put a new account first in the chain or after the Claude accounts already there, and say what a switch-only setup skips', async (t) => {
  const base = { accounts: { 'team-2': { configDir: '~/.claude-team-2' } }, failover: { enabled: true, chain: ['other'] }, providers: { other: { baseUrl: 'http://127.0.0.1:9', token: 'k', model: 'm' } } }
  const off = await home(t, base)
  const a = await off.run('account-add', 'team-3')
  assert.strictEqual(a.code, 0, a.out)
  assert.match(a.out, /For windows that \/provider switch moves to team-3 \(mode "switch", each account on its own login\), that is all; then:/)
  assert.match(a.out, /^ {2}1\. node \S+ set accountFallback\.mode switch {3}\(first: /m, 'the mode before the login')
  assert.match(a.out, /^ {5}node \S+ set accountFallback\.account team-3$/m)
  assert.match(a.out, /The rest only when the relay itself sends with team-3's token \(rc-keep, api-only, or a fallback list in switch\):/)
  assert.match(a.out, /6\. node \S+ account-sync team-3, then node \S+ account-token team-3 keychain:model-relay-team-3\/team-3/)
  assert.match(a.out, /7\. accountFallback\.mode is "off" in the file now and "switch" once step 1 is done, where the router never sends with team-3 yet\. To use it, either:/)
  const rcLine = lineWith(a.out, 'rc-keep (your windows')
  assert.match(rcLine, /node \S+ set accountFallback\.mode rc-keep, then node \S+ set failover\.chain team-3,other$/)
  assert.match(lineWith(a.out, 'switch (an account'), /: node \S+ account-fallback <account> team-3$/, 'step 1 set the mode already')
  // the printed commands run as printed
  const [setMode, setChain] = after(rcLine, ': ').split(', then ')
  // in the order printed: step 6's token (which makes the provider), then step 7
  for (const cmd of [after(lineWith(a.out, 'account-token team-3'), ', then '), setMode, setChain]) {
    const x = await runPrinted(off, cmd)
    assert.strictEqual(x.code, 0, `${cmd}: ${x.out}`)
  }
  assert.deepStrictEqual([off.read().accountFallback.mode, off.read().failover.chain, off.read().providers['team-3'].token], ['rc-keep', ['team-3', 'other'], 'keychain:model-relay-team-3/team-3'])

  const sw = await home(t, { ...base, accountFallback: { mode: 'switch' } })
  const b = await sw.run('account-add', 'team-3')
  assert.match(b.out, /7\. accountFallback\.mode is "switch": to let team-3's own windows go on with other accounts at its limit: node \S+ account-fallback team-3 <account>\[,\.\.\.\]$/m)
  assert.match(b.out, /^ {5}and the router sends with team-3 only for the windows of an account whose fallback list names it: node \S+ account-fallback <account> team-3$/m)
  assert.ok(!b.out.includes('failover.chain'), b.out)
  const rc = await home(t, { ...base, accountFallback: { mode: 'api-only' } })
  const d = await rc.run('account-add', 'team-3')
  assert.match(d.out, /7\. accountFallback\.mode is "api-only": to take over at your usage limit, team-3 needs a place in failover\.chain, which is tried in order: node \S+ set failover\.chain team-3,other$/m)
  assert.ok(!d.out.includes('account-fallback'), d.out)
  // a mode that is on already is not turned down to "switch" by the first printed step
  assert.match(d.out, /^ {2}1\. accountFallback\.mode stays "api-only": the login window of step 2 is not registered, and the router passes on as sent a request that carries another login$/m)
  assert.ok(!d.out.includes('set accountFallback.mode switch'), d.out)

  // account-sync: no token yet -> the account-token command; then the mode's step
  const s = await home(t, { ...base, accounts: { 'team-1': { configDir: '~/.claude-team-1' }, 'team-3': { configDir: '~/.claude-team-3' } } })
  s.login(s.dir, MAIN_UUID, 'a'.repeat(64)) // <home>/.claude.json: the default dir's login
  s.login(path.join(s.dir, '.claude-team-3'), UUID3, '3'.repeat(64))
  const y = await s.run('account-sync', 'team-3')
  assert.strictEqual(y.code, 0, y.out)
  assert.match(y.out, /It has no token yet: a setup-token of that account, kept in the keychain \(account-add printed the steps\), then: node \S+ account-token team-3 keychain:model-relay-team-3\/team-3/)
  // W-6: the variable is offered too on macOS, as the other way, not only "where there is no keychain"
  assert.match(y.out, /^ {2}Or keep it in the variable MODEL_RELAY_TOKEN_TEAM_3 instead \(set permanently for your OS, then restart Claude Code\): node \S+ account-token team-3 env:MODEL_RELAY_TOKEN_TEAM_3$/m)
  assert.match(y.out, /accountFallback\.mode is "off", so the router never sends with team-3/)
  assert.strictEqual((await s.run('set', 'accountFallback.mode', 'switch')).code, 0)
  assert.match((await s.run('account-sync', 'team-3')).out, /accountFallback\.mode is "switch": the router sends with team-3 only for the windows of an account whose fallback list names it: node \S+ account-fallback <account> team-3/)
  assert.strictEqual((await s.run('account-fallback', 'team-1', 'team-3')).code, 0)
  const z = await s.run('account-sync', 'team-3')
  assert.match(z.out, /The windows of team-1 go on with it at their usage limit/)
  assert.ok(!z.out.includes('account-fallback <account>'), z.out)
})

test('F14: account-sync refuses a name that is not a plain word, and printed steps quote paths for the shell they are pasted into', async (t) => {
  const c = await home(t, { providers: {} })
  for (const n of ['a b', 'team!', '../x', '-x', 'x/y']) {
    const x = await c.run('account-sync', n)
    assert.strictEqual(x.code, 2, `${n}: ${x.out}`)
    assert.match(x.stderr, /Usage: node tools\/setup\.mjs account-sync <name>/)
  }
  const add = await c.run('account-add', 'team-3', '--dir', "~/it's here")
  assert.strictEqual(add.code, 0, add.out)
  const dir = path.join(c.dir, "it's here")
  assert.ok(add.out.includes(`2. CLAUDE_CONFIG_DIR='${dir.replace(/'/g, "'\\''")}' MODEL_RELAY_CONFIG_DIR=${sh(c.relayDir)} claude, then /login as that account`), add.out)
  const w = await home(t, { providers: {} }, { platform: 'win32' })
  const win = await w.run('account-add', 'team-3', '--dir', "~/it's here")
  assert.strictEqual(win.code, 0, win.out)
  assert.ok(win.out.includes(`2. $env:CLAUDE_CONFIG_DIR='${path.join(w.dir, "it's here").replace(/'/g, "''")}'; $env:MODEL_RELAY_CONFIG_DIR=${ps(w.relayDir)}; claude   (in a new PowerShell window: the variables stay set in it), then /login`), win.out)
})

test('A9/B8: off macOS, keychain: is refused with the env: hint, account-add and account-sync print env: steps, and doctor says keychain: works on macOS only without running anything', async (t) => {
  const c = await home(t, { accountFallback: { mode: 'rc-keep' }, failover: { enabled: true, chain: ['team-2'] }, accounts: { 'team-3': { configDir: '~/.claude-team-3' } }, providers: { 'team-2': acct('team-2', UUID2, { token: 'keychain:svc/acct' }) } }, { platform: 'linux' })
  const before = c.text()
  const k = await c.run('account-token', 'team-2', 'keychain:svc/acct')
  assert.strictEqual(k.code, 2, k.out)
  assert.match(k.stderr, /keychain: tokens work on macOS only; here keep the token in a variable and use env:<VAR>/)
  assert.match((await c.run('account-token')).stderr, /usage: account-token <name> env:<VAR>\. /, 'no keychain: in the usage off macOS')
  assert.strictEqual(c.text(), before)
  const add = await c.run('account-add', 'team-4')
  assert.strictEqual(add.code, 0, add.out)
  assert.ok(!add.out.includes('security '), add.out)
  assert.match(add.out, /4\. keep the token in the variable MODEL_RELAY_TOKEN_TEAM_4, set permanently for your OS so Claude Code starts with it \(keychain: tokens work on macOS only\)/)
  assert.match(add.out, /5\. node \S+ account-sync team-4, then node \S+ account-token team-4 env:MODEL_RELAY_TOKEN_TEAM_4/)
  assert.match(add.out, /6\. accountFallback\.mode is "rc-keep": to take over at your usage limit, team-4 needs a place in failover\.chain/)
  c.login(c.dir, MAIN_UUID, 'a'.repeat(64))
  c.login(path.join(c.dir, '.claude-team-3'), UUID3, '3'.repeat(64))
  assert.match((await c.run('account-sync', 'team-3')).out, /kept in the variable MODEL_RELAY_TOKEN_TEAM_3 \(keychain: tokens work on macOS only\), then: node \S+ account-token team-3 env:MODEL_RELAY_TOKEN_TEAM_3/)
  const doc = await c.run('doctor')
  assert.match(doc.out, /⚠ provider team-2 is skipped: keychain: tokens work on macOS only; here keep the token in a variable and use node \S+ account-token team-2 env:<VAR>/)
  assert.ok(!doc.out.includes('login keychain'), doc.out)
  assert.strictEqual(c.keychainRuns(), '', 'nothing run off macOS')
  // on macOS the same config gets the keychain hint, as before
  const mac = await home(t, { accountFallback: { mode: 'rc-keep' }, providers: { 'team-2': acct('team-2', UUID2, { token: 'keychain:svc/acct' }) } })
  assert.match((await mac.run('doctor')).out, /provider team-2 is skipped: keychain item svc\/acct \(service\/account\) is not in the login keychain/)
})

test('B3: doctor flags accounts.<n>.fallback outside mode switch, naming the mode and the set command, and asks before it is run', async (t) => {
  const accounts = { 'team-1': { configDir: '~/.claude-team-1', fallback: ['team-2'] }, 'team-2': { configDir: '~/.claude-team-2', fallback: 'team-1' }, 'team-3': { configDir: '~/.claude-team-3' } }
  for (const mode of ['rc-keep', 'off', 'api-only']) {
    const c = await home(t, { accountFallback: { mode }, accounts, providers: { 'team-2': acct('team-2', UUID2) } })
    const doc = await c.run('doctor')
    assert.match(doc.out, new RegExp(`⚠ accounts\\.team-1\\.fallback, accounts\\.team-2\\.fallback are read only when accountFallback\\.mode is "switch" \\(now "${mode}"\\), so no window falls back to another account; to use them: node \\S+ set accountFallback\\.mode switch`))
    const f = JSON.parse((await c.run('doctor', '--json')).stdout).findings.find((x) => x.id === 'account-fallback-mode')
    assert.deepStrictEqual([f.fix, f.needsConsent], ['set accountFallback.mode switch', true])
  }
  const sw = await home(t, { accountFallback: { mode: 'switch' }, accounts, providers: {} })
  assert.ok(!JSON.parse((await sw.run('doctor', '--json')).stdout).findings.some((x) => x.id === 'account-fallback-mode'))
  const none = await home(t, { accountFallback: { mode: 'rc-keep' }, accounts: { 'team-3': { configDir: '~/.claude-team-3' } }, providers: {} })
  assert.ok(!JSON.parse((await none.run('doctor', '--json')).stdout).findings.some((x) => x.id === 'account-fallback-mode'))
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

test('B11 (usage half): the usage line lists the account commands and handoff', async (t) => {
  const c = await home(t, { providers: {} })
  const x = await c.run('no-such-command')
  assert.strictEqual(x.code, 2)
  for (const w of ['account-add', 'account-sync', 'account-fallback', 'account-token', 'handoff']) assert.ok(x.stderr.includes(`|${w}`), w)
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

test('W-1: a new account goes after the Claude accounts already in failover.chain, before the providers of another kind, and the printed command runs as printed', async (t) => {
  const c = await home(t, {
    accountFallback: { mode: 'rc-keep' },
    accounts: { 'team-2': { configDir: '~/.claude-team-2' }, 'team-3': { configDir: '~/.claude-team-3' } },
    failover: { enabled: true, chain: ['team-2', 'other'] },
    providers: { other: { baseUrl: 'http://127.0.0.1:9', token: 'k', model: 'm' }, 'team-2': acct('team-2', UUID2) },
  })
  c.login(c.dir, MAIN_UUID, 'a'.repeat(64))
  c.login(path.join(c.dir, '.claude-team-3'), UUID3, '3'.repeat(64))
  const x = await c.run('account-sync', 'team-3')
  assert.strictEqual(x.code, 0, x.out)
  const line = lineWith(x.out, 'needs a place in failover.chain')
  assert.match(line, /which is tried in order: node \S+ set failover\.chain team-2,team-3,other$/)
  const r = await runPrinted(c, after(line, 'tried in order: '))
  assert.strictEqual(r.code, 0, r.out)
  assert.deepStrictEqual(c.read().failover.chain, ['team-2', 'team-3', 'other'])
})

test('W-3: account-add prints the terms note that fits the mode: a plain note in off and switch, the warning in rc-keep and api-only', async (t) => {
  const note = /Terms: moving a window to team-3 \(mode "switch"\) uses team-3's own login and replaces nothing\. Only the token steps below/
  for (const mode of [undefined, 'switch']) {
    const c = await home(t, { ...(mode ? { accountFallback: { mode } } : {}), accounts: {}, providers: {} })
    const x = await c.run('account-add', 'team-3')
    assert.match(x.out, note, mode)
    assert.ok(!x.out.includes('⚠ accountFallback.mode'), x.out)
  }
  for (const mode of ['rc-keep', 'api-only']) {
    const c = await home(t, { accountFallback: { mode }, accounts: {}, providers: {} })
    const x = await c.run('account-add', 'team-3')
    assert.match(x.out, new RegExp(`⚠ accountFallback\\.mode is "${mode}": once team-3 is in failover\\.chain, your requests go on with team-3's token and its identity values in place of yours`), mode)
    assert.ok(!note.test(x.out), x.out)
  }
})

test('W-1, W-10: doctor says what the mode does now: where /provider switch goes (switch), or which Claude accounts in failover.chain can send (rc-keep, api-only)', async (t) => {
  const providers = { other: { baseUrl: 'http://127.0.0.1:9', token: 'k', model: 'm' }, 'team-2': acct('team-2', UUID2) }
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
  const chain = { failover: { enabled: true, chain: ['team-2', 'other'] } }
  for (const mode of ['rc-keep', 'api-only']) {
    const ready = await home(t, { accountFallback: { mode }, accounts, providers, ...chain }, { env: { T_TEAM_2: 'x' } })
    assert.strictEqual(lineOf((await ready.run('doctor')).out), `  Accounts: mode "${mode}"; at your usage limit failover.chain goes on with ✓ team-2 (Claude accounts whose token resolves)`)
  }
  const unset = await home(t, { accountFallback: { mode: 'rc-keep' }, accounts, providers, ...chain })
  const u = await unset.run('doctor')
  assert.strictEqual(lineOf(u.out), '  Accounts: mode "rc-keep"; no Claude account in failover.chain that can send yet, so nothing sends with a token')
  assert.match(u.out, /⚠ provider team-2 is skipped: its key variable T_TEAM_2 is unset/)
})

test('W-7: doctor does not say "no chain" when the chain names only entries that are skipped', async (t) => {
  const providers = { other: { baseUrl: 'http://127.0.0.1:9', token: 'k', model: 'm' }, 'team-2': acct('team-2', UUID2) }
  const accounts = { 'team-2': { configDir: '~/.claude-team-2' } }
  const skipped = await home(t, { accountFallback: { mode: 'switch' }, accounts, providers, failover: { enabled: true, chain: ['team-2'] } })
  const x = await skipped.run('doctor')
  assert.match(x.out, /Failover: on, but no usable entry in the chain/)
  assert.match(x.out, /⚠ failover is on but none of the names in its chain is usable, so a usage-limit 429 from Claude is passed back as it is; the lines about those names say why each is skipped/)
  assert.match(x.out, /⚠ failover names team-2, a Claude account that accountFallback\.mode "switch" leaves unused/)
  assert.ok(!x.out.includes('has no chain'), x.out)
  const empty = await home(t, { accountFallback: { mode: 'switch' }, accounts, providers, failover: { enabled: true, chain: [] } })
  const y = await empty.run('doctor')
  assert.match(y.out, /Failover: on, but no chain/)
  assert.match(y.out, /⚠ failover is on but has no chain/)
})

test('doctor does not ask for a chain because of an account that only a fallback list uses', async (t) => {
  const accounts = { 'team-1': { configDir: '~/.claude-team-1', fallback: 'team-2' }, 'team-2': { configDir: '~/.claude-team-2' } }
  const providers = { 'team-2': acct('team-2', UUID2) }
  const only = await home(t, { accountFallback: { mode: 'switch' }, accounts, providers, failover: { enabled: true, chain: [] } }, { env: { T_TEAM_2: 'x' } })
  const x = await only.run('doctor')
  assert.ok(!x.out.includes('failover is on but'), x.out)
  // an ordinary provider beside it still earns the finding
  const both = await home(t, { accountFallback: { mode: 'switch' }, accounts, providers: { ...providers, other: { baseUrl: 'http://127.0.0.1:9', token: 'k', model: 'm' } }, failover: { enabled: true, chain: [] } }, { env: { T_TEAM_2: 'x' } })
  assert.match((await both.run('doctor')).out, /⚠ failover is on but has no chain/)
})

test('A7 (docs audit): an account nobody has made yet is sent to account-add first, by account-sync, account-fallback and set accountFallback.account', async (t) => {
  const c = await home(t, { accounts: {}, providers: {} })
  const before = c.text()
  const sync = await c.run('account-sync', 'team-2')
  assert.strictEqual(sync.code, 1, sync.out)
  assert.match(sync.stderr, /accounts\.team-2\.configDir is not set; node \S+ account-add team-2 makes that account's folder and writes it/)
  assert.match((await c.run('account-fallback', 'team-2', 'team-3')).stderr, /make one with account-add <name>/)
  assert.match((await c.run('set', 'accountFallback.account', 'team-2')).stderr, /make one with account-add <name>/)
  assert.strictEqual(c.text(), before, 'nothing written')
})

test('Windows: the commands doctor and account-add print are PowerShell commands there and POSIX ones elsewhere, whatever this machine is', async (t) => {
  const cfg = { accountFallback: { mode: 'switch', account: 'team-2' }, accounts: { 'team-2': { configDir: '~/.claude-team-2' } }, providers: {} }
  const projects = (out) => lineWith(out, "projects folder is not this config dir's")
  const w = await home(t, cfg, { platform: 'win32' })
  assert.match(projects((await w.run('doctor')).out), /: New-Item -ItemType SymbolicLink -Path '.*projects' -Target '.*projects'$/)
  const added = (await w.run('account-add', 'team-3')).out
  assert.match(lineWith(added, '2. '), /^ +2\. \$env:CLAUDE_CONFIG_DIR='?[^';]*\.claude-team-3'?; \$env:MODEL_RELAY_CONFIG_DIR='?[^';]*\.claude'?; claude {3}\(in a new PowerShell window: the variables stay set in it\), then \/login as that account$/m)
  // the stand-in darwin quotes a path that has a backslash, as sh does, so on a Windows machine each path ends in a quote
  const q = process.platform === 'win32' ? "'?" : ''
  const p = await home(t, cfg, { platform: 'darwin' })
  assert.match(projects((await p.run('doctor')).out), new RegExp(`: ln -s .* .*projects${q}$`))
  assert.match(lineWith((await p.run('account-add', 'team-3')).out, '2. '), new RegExp(`2\\. CLAUDE_CONFIG_DIR=\\S*\\.claude-team-3${q} MODEL_RELAY_CONFIG_DIR=\\S*\\.claude${q} claude, then \\/login as that account$`))
})

test('Windows spells its variables without regard to case: dropVars takes a differently spelled name too, once, and elsewhere only the exact one', async () => {
  const { dropVars, DROPPED_VARS } = await launchModule()
  const vars = () => ({ Path: 'x', Anthropic_Api_Key: 'a', http_proxy: 'p', HTTP_PROXY: 'q', claude_code_oauth_token: 'o', ANTHROPIC_BASE_URL: 'u' })
  const w = vars()
  assert.deepStrictEqual(dropVars(w, DROPPED_VARS, true), ['claude_code_oauth_token', 'Anthropic_Api_Key', 'ANTHROPIC_BASE_URL', 'http_proxy', 'HTTP_PROXY'], 'each once, in the order of the names asked for')
  assert.deepStrictEqual(w, { Path: 'x' })
  const p = vars()
  assert.deepStrictEqual(dropVars(p, DROPPED_VARS, false), ['ANTHROPIC_BASE_URL', 'HTTP_PROXY', 'http_proxy'])
  assert.deepStrictEqual(Object.keys(p), ['Path', 'Anthropic_Api_Key', 'claude_code_oauth_token'], 'another spelling is another variable there')
})
