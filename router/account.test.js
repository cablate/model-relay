'use strict'
// kind "anthropic", a second Claude account: how it is parsed and chosen, its keychain: token, and the one change made
// to its body (the account_uuid inside metadata.user_id). The router and CLI end to end are in account-router.test.js.
require('./test-env')
const test = require('node:test')
const assert = require('node:assert')
const cp = require('node:child_process')
const L = require('./logic')
const K = require('./keychain')

const OPUS = 'claude-opus-5-5'
// A token-shaped string built at run time, so this source never holds one (GitHub's secret scanning matches the literal)
const tokenLike = (kind, rest) => ['sk', 'ant', kind, rest].join('-')
const MAIN_UUID = '11111111-2222-4333-8444-555555555555'
const SPARE_UUID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
const SPARE_DEV = 'd'.repeat(64)
const SPARE_EMAIL = 'spare@example.test'
const KEY = { 'relay-test/spare': 'SPARE-SECRET' }
const keychain = (s, a) => KEY[`${s}/${a}`] || null
const spare = (extra = {}) => ({ kind: 'anthropic', token: 'keychain:relay-test/spare', accountUuid: SPARE_UUID, deviceId: SPARE_DEV, email: SPARE_EMAIL, ...extra })
const other = { baseUrl: 'https://other.example', token: 't', model: 'other-model', matchModels: ['^other', 'haiku'] }
const raw = (extra = {}, providers = { spare: spare(), other }) => ({ format: 2, accountFallback: { mode: 'rc-keep' }, providers, failover: { chain: ['spare', 'other'] }, ...extra })

test('a Claude account parses with Anthropic as its address and no model, and only through a keychain it was given', () => {
  const c = L.parseCfg(raw(), {}, { keychain })
  const p = c.providers.spare
  assert.strictEqual(p.kind, 'anthropic')
  assert.strictEqual(p.url, 'https://api.anthropic.com')
  assert.strictEqual(p.token, 'SPARE-SECRET')
  assert.strictEqual(p.accountUuid, SPARE_UUID)
  assert.strictEqual(p.model, null)
  assert.strictEqual(p.keychain, 'relay-test/spare')
  assert.strictEqual(L.modelLabel(p), 'anthropic-account')
  assert.strictEqual(L.modelLabel(c.providers.other), 'other-model')
  assert.deepStrictEqual(c.failoverChain, ['spare', 'other'])
  assert.strictEqual(L.parseCfg(raw(), {}).providers.spare, undefined, 'no keychain reader given: the token does not resolve')
  assert.strictEqual(L.parseCfg(raw({}, { spare: spare({ accountUuid: MAIN_UUID.toUpperCase() }) }), {}, { keychain }).providers.spare.accountUuid, MAIN_UUID)
})

test('A1: a Claude model never routes to the account by name; only a failover, the cooldown or a pin reaches it', () => {
  const c = L.parseCfg(raw(), {}, { keychain })
  assert.strictEqual(L.matchProviderByModel(c, OPUS), null)
  assert.strictEqual(L.matchProviderByModel(c, 'anthropic-account'), null)
  assert.deepStrictEqual(L.detectAliases(c), { haiku: 'other' })
  assert.strictEqual(L.decide(L.emptyState(), c, OPUS, 's', 1000), 'claude')
  assert.strictEqual(L.decide(L.onLimited(L.emptyState(), c, 1000), c, OPUS, 's', 2000), 'spare-rewrite', 'the cooldown')
  assert.strictEqual(L.decide(L.setSticky(L.emptyState(), 's', 'spare', 1000), c, OPUS, 's', 2000), 'spare-rewrite', 'a pin')
  assert.strictEqual(L.decide(L.setSticky(L.emptyState(), 's', 'spare', 1000), c, 'other-model', 's', 2000), 'other', 'a model a provider claims still goes there')
})

test('A13: a Claude account is skipped unless claudeUrl is Anthropic itself, and doctor gets the reason', () => {
  for (const url of ['https://proxy.example', 'http://api.anthropic.com', 'https://api.anthropic.com:8443', 'https://u@api.anthropic.com', 'https://api.anthropic.com/v2']) {
    const r = raw({ claudeUrl: url })
    assert.strictEqual(L.parseCfg(r, {}, { keychain }).providers.spare, undefined, url)
    assert.match(L.accountProblems(r)[0].why, /sends its account token to https:\/\/api\.anthropic\.com only/, url)
  }
  for (const url of [undefined, 'https://api.anthropic.com', 'https://api.anthropic.com/', 'https://API.anthropic.com:443']) {
    assert.ok(L.parseCfg(raw({ claudeUrl: url }), {}, { keychain }).providers.spare, String(url))
    assert.deepStrictEqual(L.accountProblems(raw({ claudeUrl: url })), [], String(url))
  }
  assert.ok(L.parseCfg(raw({ claudeUrl: 'http://127.0.0.1:9' }), {}, { keychain, anyClaudeUrl: true }).providers.spare, 'the test-only override')
})

test('a Claude account takes no address, model or patterns, and needs its account UUID', () => {
  for (const extra of [{ baseUrl: 'https://x.example' }, { url: 'https://x.example' }, { model: OPUS }, { matchModels: ['^claude'] }, { preset: 'zai' }]) {
    const r = raw({}, { spare: spare(extra), other })
    assert.strictEqual(L.parseCfg(r, {}, { keychain }).providers.spare, undefined, JSON.stringify(extra))
    assert.match(L.accountProblems(r)[0].why, /takes no/)
  }
  for (const accountUuid of [undefined, '', 'nope', `${SPARE_UUID}x`]) {
    const r = raw({}, { spare: spare({ accountUuid }), other })
    assert.strictEqual(L.parseCfg(r, {}, { keychain }).providers.spare, undefined, String(accountUuid))
    assert.match(L.accountProblems(r)[0].why, /accountUuid/)
  }
})

test('keychain: tokens name a service and an account, and only an injected reader resolves them', () => {
  const calls = []
  const reader = (s, a) => (calls.push(`${s}/${a}`), 'tok')
  assert.strictEqual(L.resolveToken('keychain:svc/acct', {}, reader), 'tok')
  for (const bad of ['keychain:', 'keychain:svc', 'keychain:/acct', 'keychain:svc/', 'keychain:-w/acct', 'keychain:svc/-x', 'keychain:a b/c', 'keychain:a/b/c']) {
    assert.strictEqual(L.resolveToken(bad, {}, reader), null, bad)
  }
  assert.deepStrictEqual(calls, ['svc/acct'], 'a malformed reference never reaches the reader')
  assert.strictEqual(L.resolveToken('keychain:svc/acct', {}), null)
  const p = { baseUrl: 'https://x.example', model: 'm' }
  assert.strictEqual(L.parseCfg({ format: 2, providers: { x: { ...p, token: 'keychain:svc/acct' } } }, {}, { keychain: reader }).providers.x.keychain, 'svc/acct', 'any provider may keep its token there')
})

test('A7: parseShape and a parseCfg without a reader start no process', () => {
  const names = ['execFileSync', 'execFile', 'spawn', 'spawnSync', 'execSync', 'exec']
  const real = Object.fromEntries(names.map((n) => [n, cp[n]]))
  let spawned = 0
  for (const n of names) cp[n] = () => { spawned++; throw new Error('no process may start here') }
  try {
    assert.ok(L.parseShape(raw()).providers.spare, 'the shape counts the item as there')
    assert.strictEqual(L.parseCfg(raw(), {}).providers.spare, undefined)
    assert.deepStrictEqual(L.unresolvedEnv(raw(), {}), [{ provider: 'spare', keychain: 'relay-test/spare' }])
  } finally {
    Object.assign(cp, real)
  }
  assert.strictEqual(spawned, 0)
})

test('A7: the router\'s keychain reader never waits, reads an item once while it runs, and a failed one again only when the config has changed', async () => {
  let stamp = 'cfg-1' // model-relay.json as the router saw it (mtime and size)
  const reads = []
  const pending = []
  const read = (s, a) => new Promise((resolve) => (reads.push(`${s}/${a}`), pending.push(resolve)))
  const lines = []
  const r = K.cachedReader(read, (l) => lines.push(l), () => stamp)
  const land = async (x) => {
    pending.shift()(x)
    await new Promise((done) => setImmediate(done))
  }
  const u = { provider: 'spare', keychain: 'svc/acct' }
  assert.strictEqual(r.get('svc', 'acct'), null, 'the first ask only starts the read')
  assert.strictEqual(r.get('svc', 'acct'), null)
  assert.deepStrictEqual(reads, ['svc/acct'], 'one read while it runs')
  assert.strictEqual(r.reportable(u), false, 'an item being read is not reported as missing')
  await land({ why: '/usr/bin/security exited 44 (no such item)' })
  assert.strictEqual(r.reportable(u), true)
  // no timer: asking again and again, however long after, starts nothing while the config is as it was
  for (let i = 0; i < 50; i++) assert.strictEqual(r.get('svc', 'acct'), null)
  assert.strictEqual(reads.length, 1, 'a failed item is not read on a timer, so a locked keychain raises no dialog')
  assert.strictEqual(r.reportable(u), true)
  // the config changes (setup.mjs rewrote it, or the person saved it): the next ask reads the item again
  stamp = 'cfg-2'
  assert.strictEqual(r.get('svc', 'acct'), null)
  assert.strictEqual(reads.length, 2, 'then the item is read again')
  assert.strictEqual(r.get('svc', 'acct'), null)
  assert.strictEqual(reads.length, 2, 'once, while that read runs')
  assert.strictEqual(r.reportable(u), false)
  // it fails again under the new config: again no timer, and the next change retries
  await land({ why: '/usr/bin/security exited 44 (no such item)' })
  for (let i = 0; i < 5; i++) r.get('svc', 'acct')
  assert.strictEqual(reads.length, 2)
  stamp = 'cfg-3'
  r.get('svc', 'acct')
  assert.strictEqual(reads.length, 3)
  await land({ token: 'TOKEN-OK' })
  assert.strictEqual(r.get('svc', 'acct'), 'TOKEN-OK')
  stamp = 'cfg-4'
  assert.strictEqual(r.get('svc', 'acct'), 'TOKEN-OK', 'a token that was read is kept through config changes')
  assert.strictEqual(reads.length, 3)
  assert.strictEqual(K.RETRY_AFTER_MS, undefined, 'no retry interval is left')
  // A reader that rejects counts as a failure instead of leaving the item "being read" for ever
  const r2 = K.cachedReader(() => Promise.reject(new Error('TOKEN-OK')), (l) => lines.push(l), () => stamp)
  r2.get('svc', 'acct')
  await new Promise((done) => setImmediate(done))
  assert.strictEqual(r2.reportable(u), true)
  assert.deepStrictEqual(lines.map((l) => l.replace(/ \(.*\);/, ' (…);')), Array(3).fill('keychain item svc/acct could not be read (…); providers using it are skipped, and it is read again when model-relay.json changes or the router restarts'))
  assert.ok(lines.every((l) => !l.includes('TOKEN-OK')), 'no token and no error text in the log')
  // Entries the reader knows nothing about are reported as before: an env var, a bare "keychain:", a malformed item
  for (const x of [{ provider: 'p', env: 'X' }, { provider: 'p', keychain: '' }, { provider: 'p', keychain: 'nope' }]) assert.strictEqual(r.reportable(x), true)
})

test('a provider without an address or a model never has its keychain item read', () => {
  const calls = []
  const reader = (s, a) => (calls.push(`${s}/${a}`), 'tok')
  const noModel = { baseUrl: 'https://x.example', token: 'keychain:svc/nomodel' }
  const noUrl = { model: 'm', token: 'keychain:svc/nourl' }
  const r = { format: 2, providers: { a: noModel, b: noUrl, c: { ...noModel, model: 'm', token: 'keychain:svc/ok' }, d: { baseUrl: 'https://x.example', token: 'env:UNSET_X' } } }
  assert.deepStrictEqual(Object.keys(L.parseCfg(r, {}, { keychain: reader }).providers), ['c'])
  assert.deepStrictEqual(L.unresolvedEnv(r, {}, () => (calls.push('unresolved'), null)), [{ provider: 'c', keychain: 'svc/ok' }, { provider: 'd', env: 'UNSET_X' }], 'an env: token is still reported as in 0.7.5')
  assert.deepStrictEqual(calls, ['svc/ok', 'unresolved'], 'only the provider that can be used was read')
  assert.strictEqual(L.parseProvider('zai', { token: 'keychain:svc/p', model: 'glm-5' }, {}, undefined, undefined, reader).url, 'https://api.z.ai/api/anthropic', 'a preset address counts')
})

test('a Claude account refused for its shape or claudeUrl never has its keychain item read', () => {
  const calls = []
  const reader = (s, a) => (calls.push(`${s}/${a}`), null)
  const bad = raw({}, { bad: spare({ token: 'keychain:relay-test/bad', model: OPUS }), other })
  assert.deepStrictEqual(L.unresolvedEnv(bad, {}, reader), [])
  assert.deepStrictEqual(L.unresolvedEnv(raw({ claudeUrl: 'https://proxy.example' }), {}, reader), [])
  assert.deepStrictEqual(calls, [], 'no read for an entry parseCfg throws away')
  assert.strictEqual(L.parseCfg(bad, {}, { keychain: reader }).providers.bad, undefined)
  assert.deepStrictEqual(calls, [])
  // the test-only override counts as for parseCfg: a usable account is still read and reported
  assert.deepStrictEqual(L.unresolvedEnv(raw({ claudeUrl: 'http://127.0.0.1:9' }), {}, reader, true), [{ provider: 'spare', keychain: 'relay-test/spare' }])
  assert.deepStrictEqual(calls, ['relay-test/spare'])
})

test('an unreadable keychain item is reported by its name, never its value', () => {
  const r = raw({}, { spare: spare(), broken: spare({ token: 'keychain:nope' }), other })
  assert.deepStrictEqual(L.unresolvedEnv(r, {}, keychain), [{ provider: 'broken', keychain: '(malformed)', malformed: true }])
  assert.deepStrictEqual(L.unresolvedEnv(r, {}, () => null), [{ provider: 'spare', keychain: 'relay-test/spare' }, { provider: 'broken', keychain: '(malformed)', malformed: true }])
  // The text after "keychain:" may be a pasted secret: never echoed, in the entry or the message built from it
  const pasted = L.unresolvedEnv(raw({}, { spare: spare({ token: `keychain:${tokenLike('oat01', 'FAKESECRET')}` }), other }), {}, keychain)
  assert.deepStrictEqual(pasted, [{ provider: 'spare', keychain: '(malformed)', malformed: true }])
  assert.ok(!L.cfgMissingMessage(pasted).includes('FAKESECRET'))
  // A malformed reference is a config fix: its own reason, and no promise that the router reads it again
  const bad = L.cfgMissingMessage([{ provider: 'broken', keychain: '(malformed)', malformed: true }])
  assert.match(bad, /broken \(its keychain: reference is malformed\)\. Write a keychain: token as keychain:<service>\/<account> \(the config is read again on every request\)$/)
  assert.ok(!/read again when|Export/.test(bad), bad)
  // Each remedy appears only for a reason in the list; env vars alone read exactly as in 0.7.5
  assert.strictEqual(L.cfgMissingMessage([{ provider: 'x', env: 'K1' }]), 'no provider is usable; skipped x (K1 is unset in the router process). Export the variable(s), then restart the router (it keeps the environment it was started with)')
  const kc = L.cfgMissingMessage([{ provider: 'spare', keychain: 'relay-test/spare' }])
  assert.match(kc, /\. A fixed keychain item is read again when model-relay\.json changes, or after a restart$/)
  assert.ok(!kc.includes('Export'), kc)
  assert.match(L.cfgMissingMessage([{ provider: 'x', env: 'K1' }, { provider: 'spare', keychain: 'relay-test/spare' }]), /it was started with\); a fixed keychain item is read again when model-relay\.json changes, or after a restart/)
  const bare = L.cfgMissingMessage([{ provider: 'odd', keychain: '' }])
  assert.ok(!/read again when|Export/.test(bare), 'a bare keychain: needs neither')
  assert.match(bare, /\. Write a keychain: token as keychain:<service>\/<account>/, 'but says how to write it')
  assert.match(L.cfgMissingMessage([{ provider: 'x', env: 'K1' }, { provider: 'odd', keychain: '' }]), /it was started with\); write a keychain: token as keychain:<service>\/<account>/)
  assert.ok(!kc.includes('Write a keychain'), 'a named item needs no rewrite advice')
  assert.match(L.cfgMissingMessage([{ provider: 'spare', keychain: 'relay-test/spare' }]), /spare \(keychain item relay-test\/spare could not be read\).*read again when model-relay\.json changes, or after a restart/)
  // A bare "keychain:", spaces included, names no item, and says so as the hook does
  for (const token of ['keychain:', 'keychain: ', 'keychain:\t ']) {
    assert.deepStrictEqual(L.unresolvedEnv(raw({}, { odd: spare({ token }), other }), {}, keychain), [{ provider: 'odd', keychain: '' }], JSON.stringify(token))
  }
  assert.match(L.cfgMissingMessage([{ provider: 'odd', keychain: '' }]), /odd \(its token "keychain:" names no item\)/)
  assert.strictEqual(L.keychainRef('keychain: relay-test/spare ').ref, 'relay-test/spare', 'the reference is trimmed')
  assert.strictEqual(L.parseCfg(raw({}, { spare: spare({ token: 'keychain: relay-test/spare' }), other }), {}, { keychain }).providers.spare.token, 'SPARE-SECRET')
})

test('A4: a failing provider hands a Claude account only a request for a Claude model', () => {
  const c = L.parseCfg(raw({ failover: { chain: ['other', 'spare'] } }), {}, { keychain })
  assert.strictEqual(L.nextFallback(c, 'other', [], 'other-model'), null)
  assert.strictEqual(L.nextFallback(c, 'other', []), null, 'a body without a model is not a Claude request')
  assert.strictEqual(L.nextFallback(c, 'other', [], `${OPUS}[1m]`).name, 'spare')
  assert.strictEqual(L.nextFallback(c, 'spare', [], OPUS).name, 'other', 'the account hands over like any provider')
  assert.strictEqual(L.requestModel(Buffer.from('{"model":"x"}')), 'x')
  assert.strictEqual(L.requestModel(Buffer.from('nope')), null)
})

// ---------- M2: the account_uuid splice ----------

const ACCT = { accountUuid: SPARE_UUID, deviceId: SPARE_DEV, email: SPARE_EMAIL }
const uid = (account, device = 'dev-1') => JSON.stringify({ account_uuid: account, device_id: device, session_id: 'sess-1' })
const bodyWith = (text) => [
  '{"model":"claude-opus-5-5","max_tokens":5,',
  `"metadata":{"user_id":${JSON.stringify(uid(MAIN_UUID))}},`,
  '"tools":[{"name":"ToolSearch","defer_loading":true,"input_schema":{"type":"object"}}],',
  `"messages":[{"role":"user","content":[{"type":"text","text":${JSON.stringify(text)}}]},`,
  '{"role":"assistant","content":[{"type":"tool_use","id":"t1","name":"calc","input":{"2":"b","1":"a","n":12345678901234567890123,"f":1.10}}]}]}',
].join('')

test('A11: the splice changes that one account_uuid and leaves every other byte as Claude Code wrote it', () => {
  const quoted = `my id is "${uid(MAIN_UUID)}" and ${JSON.stringify(uid(MAIN_UUID))}`
  const before = Buffer.from(bodyWith(quoted), 'utf8')
  const r = L.spliceAccount(before, ACCT)
  assert.strictEqual(r.why, null)
  const old = JSON.stringify(uid(MAIN_UUID))
  assert.strictEqual(before.toString().split(old).length, 2, 'the quotes in the message do not spell the metadata text')
  const expected = before.toString().replace(old, JSON.stringify(uid(SPARE_UUID, SPARE_DEV)))
  assert.strictEqual(r.body.toString('utf8'), expected)
  assert.ok(r.body.toString().includes('12345678901234567890123') && r.body.toString().includes('"2":"b","1":"a"') && r.body.toString().includes('1.10'))
  assert.strictEqual(r.body.toString().split(MAIN_UUID).length - 1, 2, 'the two quotes in the message keep the old id')
  assert.strictEqual(JSON.parse(JSON.parse(r.body.toString()).metadata.user_id).account_uuid, SPARE_UUID)
  assert.ok(r.body.toString().includes('"name":"ToolSearch"') && !r.body.toString().includes('load_deferred_tools'), 'no ToolSearch alias')
})

test('A11: a body the splice cannot be sure of is sent unchanged, with the reason', () => {
  const same = (body, why) => {
    const b = Buffer.from(body, 'utf8')
    const r = L.spliceAccount(b, ACCT)
    assert.strictEqual(r.body, b, why.source)
    assert.match(r.why, why)
    assert.ok(!r.why.includes(MAIN_UUID) && !r.why.includes(SPARE_UUID), 'the reason quotes no id')
  }
  same(bodyWith(`"${uid(MAIN_UUID)}`), /more than once/) // a leading quote makes the message spell the metadata text too
  same('nope', /not JSON/)
  same('{"metadata":{"user_id":5}}', /no metadata.user_id string/)
  same('{"metadata":{"user_id":"plain-id"}}', /not JSON/)
  same(`{"metadata":{"user_id":${JSON.stringify('{"account_uuid":"x"}')}}}`, /no account_uuid UUID/)
  same(`{"metadata":{"user_id":${JSON.stringify(`{ "account_uuid": "${MAIN_UUID}" }`)}}}`, /form JSON.stringify writes/)
  same(`{"metadata":{"user_id":"{\\u0022account_uuid\\u0022:\\u0022${MAIN_UUID}\\u0022}"}}`, /not written in the body/)
  // metadata written with " escapes, and a message that spells the metadata text once: the one match is not it
  const lookAlike = JSON.stringify(`"${JSON.stringify({ account_uuid: MAIN_UUID })}`)
  same(`{"metadata":{"user_id":"{\\u0022account_uuid\\u0022:\\u0022${MAIN_UUID}\\u0022}"},"messages":[{"role":"user","content":${lookAlike}}]}`, /the change was not exactly metadata.user_id/)
  assert.match(L.spliceAccount(Buffer.from(bodyWith('hi')), { ...ACCT, accountUuid: 'not-a-uuid' }).why, /configured accountUuid/)
  // A request that carries no user_id at all (count_tokens) has nothing to replace: not a refusal, nothing to log
  for (const body of ['{"model":"m"}', '{"model":"m","metadata":{}}']) {
    const b = Buffer.from(body)
    assert.deepStrictEqual(L.spliceAccount(b, ACCT), { body: b, why: null }, body)
  }
})

// ---------- accountFallback.mode: only rc-keep and api-only use a Claude account ----------

test('A1: off, switch, no mode or an unknown one drop the account before its token is read; rc-keep and api-only keep it', () => {
  let reads = 0
  const counted = (s, a) => (reads++, keychain(s, a))
  const without = { format: 2, providers: { other }, failover: { chain: ['spare', 'other'] } }
  for (const mode of [undefined, 'off', 'switch', 'rc_keep', 'RC-KEEP']) {
    const r = raw({ accountFallback: mode === undefined ? undefined : { mode } })
    const c = L.parseCfg(r, {}, { keychain: counted })
    assert.deepStrictEqual(c, L.parseCfg(without, {}, { keychain: counted }), `${mode}: the same config as with no account at all`)
    assert.deepStrictEqual(L.unresolvedEnv(r, {}, counted), [], String(mode))
    assert.deepStrictEqual(L.unresolvedEnv(raw({ accountFallback: { mode }, claudeUrl: 'http://127.0.0.1:9' }), {}, counted, true), [], String(mode))
    assert.deepStrictEqual(L.accountProblems(raw({ accountFallback: { mode } }, { spare: spare({ model: OPUS }), other })), [], `${mode}: nothing to report`)
    assert.strictEqual(L.parseShape(r).providers.spare, undefined, String(mode))
    assert.strictEqual(L.accountActive(r), false)
  }
  assert.strictEqual(reads, 0, 'no keychain read in any of them')
  for (const mode of ['rc-keep', 'api-only']) {
    const c = L.parseCfg(raw({ accountFallback: { mode } }), {}, { keychain: counted })
    assert.strictEqual(c.providers.spare.token, 'SPARE-SECRET', mode)
    assert.deepStrictEqual(c.failoverChain, ['spare', 'other'], mode)
    assert.strictEqual(L.accountActive(raw({ accountFallback: { mode } })), true)
  }
  assert.strictEqual(reads, 2)
})

test('an active account needs the deviceId and email account-sync writes, each in its strict form', () => {
  for (const [extra, why] of [
    [{ deviceId: undefined }, /deviceId/], [{ deviceId: 'D'.repeat(64) }, /deviceId/], [{ deviceId: 'd'.repeat(63) }, /deviceId/],
    [{ email: undefined }, /email/], [{ email: 'a b@x.test' }, /email/], [{ email: 'a"b@x.test' }, /email/],
    [{ email: 'a\\b@x.test' }, /email/], [{ email: 'a\nb@x.test' }, /email/], [{ email: 'nobody' }, /email/], [{ email: `${'a'.repeat(250)}@x.test` }, /email/],
  ]) {
    const r = raw({}, { spare: spare(extra), other })
    assert.strictEqual(L.parseCfg(r, {}, { keychain }).providers.spare, undefined, JSON.stringify(extra))
    assert.match(L.accountProblems(r)[0].why, why, JSON.stringify(extra))
  }
  const p = L.parseCfg(raw(), {}, { keychain }).providers.spare
  assert.deepStrictEqual([p.deviceId, p.email], [SPARE_DEV, SPARE_EMAIL])
})

// ---------- the email sentence and device_id (rc-keep, api-only) ----------

const MAIN_DEV = 'a'.repeat(64)
const MAIN_EMAIL = 'main@example.test'
const sentence = (email) => `The user's email address is ${email}. Use it only to identify the user, such as for authorship.`
const REMINDER = `<system-reminder>\n# userEmail\n${sentence(MAIN_EMAIL)}\n</system-reminder>`
const mainBody = (blocks, user = uid(MAIN_UUID, MAIN_DEV)) => [
  '{"model":"claude-opus-5-5","max_tokens":5,',
  `"metadata":{"user_id":${JSON.stringify(user)}},`,
  `"messages":[{"role":"user","content":[${blocks.map((text) => `{"type":"text","text":${JSON.stringify(text)}}`).join(',')}]},`,
  '{"role":"assistant","content":[{"type":"text","text":"n","n":12345678901234567890123,"f":1.10}]}]}',
].join('')
// The byte ranges in which two buffers differ, as [start, end in a, end in b]
function diffRegions(a, b) {
  let pre = 0
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++
  let suf = 0
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++
  return a.equals(b) ? [] : [pre, a.length - suf, b.length - suf]
}

test('A2: the splice changes exactly the account_uuid, device_id and email regions', () => {
  const before = Buffer.from(mainBody([REMINDER, 'hello']), 'utf8')
  const r = L.spliceAccount(before, ACCT)
  assert.strictEqual(r.why, null)
  const text = before.toString()
  const regions = [text.indexOf(MAIN_UUID), text.indexOf(MAIN_DEV), text.indexOf(MAIN_EMAIL)]
  const lengths = [MAIN_UUID.length, MAIN_DEV.length, MAIN_EMAIL.length]
  const values = [SPARE_UUID, SPARE_DEV, SPARE_EMAIL]
  let expected = text
  for (let i = 2; i >= 0; i--) expected = expected.slice(0, regions[i]) + values[i] + expected.slice(regions[i] + lengths[i])
  assert.strictEqual(r.body.toString('utf8'), expected, 'only the three regions differ')
  // and between the regions every byte is the caller's, in the caller's order
  const out = r.body.toString('utf8')
  assert.strictEqual(out.slice(0, regions[0]), text.slice(0, regions[0]))
  assert.ok(out.endsWith(text.slice(regions[2] + MAIN_EMAIL.length)))
  assert.ok(out.includes('12345678901234567890123') && out.includes('1.10'))
  // an address with replacement patterns in it goes in literally
  const odd = L.spliceAccount(before, { ...ACCT, email: "o$&$'x@example.test" })
  assert.ok(odd.body.toString().includes(sentence("o$&$'x@example.test")), odd.why)
})

test('A2: a sentence outside the reminder, or more than one, refuses the splice; no sentence at all does not', () => {
  const refused = (body, why) => {
    const b = Buffer.from(body, 'utf8')
    const r = L.spliceAccount(b, ACCT)
    assert.strictEqual(r.body, b, why)
    assert.deepStrictEqual(diffRegions(b, r.body), [], why)
    assert.match(r.why, /email sentence/, why)
    assert.ok(!r.why.includes(MAIN_EMAIL))
  }
  refused(mainBody(['<system-reminder>\nnothing\n</system-reminder>', sentence(MAIN_EMAIL)]), 'only in the user prompt')
  refused(mainBody([`<system-reminder>\nContents of CLAUDE.md: ${sentence(MAIN_EMAIL)}\n</system-reminder>`, REMINDER]), 'in CLAUDE.md content and the reminder')
  refused(mainBody([`<system-reminder>\nCLAUDE.md: ${sentence('x@y.test')}\n${sentence(MAIN_EMAIL)}\n</system-reminder>`]), 'twice in one reminder')
  refused(mainBody([`<system-reminder>\nThe user's email address is ${'a'.repeat(260)}@x.test. Use it\n</system-reminder>`]), 'an address past 254 characters')
  refused(mainBody(['hello']).replace('"text":"n"', `"text":${JSON.stringify(REMINDER)}`), 'a reminder in a later message')
  // a side call with no reminder: only account_uuid and device_id change
  const side = Buffer.from(mainBody(['Write a title for this chat']), 'utf8')
  const r = L.spliceAccount(side, ACCT)
  assert.strictEqual(r.why, null)
  assert.strictEqual(r.body.toString(), side.toString().replace(JSON.stringify(uid(MAIN_UUID, MAIN_DEV)), JSON.stringify(uid(SPARE_UUID, SPARE_DEV))))
})

test('A2: a user_id without device_id gets none added; invalid configured values refuse the splice', () => {
  const noDevice = JSON.stringify({ account_uuid: MAIN_UUID, session_id: 'sess-1' })
  const b = Buffer.from(mainBody([REMINDER], noDevice), 'utf8')
  const r = L.spliceAccount(b, ACCT)
  assert.strictEqual(r.why, null)
  assert.deepStrictEqual(JSON.parse(JSON.parse(r.body.toString()).metadata.user_id), { account_uuid: SPARE_UUID, session_id: 'sess-1' })
  assert.ok(!r.body.toString().includes(SPARE_DEV), 'no device_id added')
  for (const bad of [{ accountUuid: 'x' }, { deviceId: 'D'.repeat(64) }, { deviceId: '' }, { email: 'a b@x.test' }, { email: 'a"b@x.test' }, { email: 'a\\b@x.test' }, { email: 'a\u0001@x.test' }, { email: undefined }]) {
    const x = L.spliceAccount(b, { ...ACCT, ...bad })
    assert.strictEqual(x.body, b, JSON.stringify(bad))
    assert.match(x.why, /configured accountUuid, deviceId or email is not valid/)
  }
})

test('A2: without a user_id the email rule still holds; the sentence may run into markup', () => {
  const noUid = (blocks) => Buffer.from(JSON.stringify({ model: OPUS, messages: [{ role: 'user', content: blocks.map((text) => ({ type: 'text', text })) }] }), 'utf8')
  const b = noUid([REMINDER, 'hi'])
  const r = L.spliceAccount(b, ACCT)
  assert.strictEqual(r.why, null)
  assert.strictEqual(r.body.toString(), b.toString().replace(MAIN_EMAIL, SPARE_EMAIL), 'only the address changes')
  const outside = noUid(['hi', sentence(MAIN_EMAIL)])
  const x = L.spliceAccount(outside, ACCT)
  assert.strictEqual(x.body, outside)
  assert.match(x.why, /email sentence/)
  const plain = noUid(['Write a title'])
  assert.deepStrictEqual(L.spliceAccount(plain, ACCT), { body: plain, why: null }, 'neither a user_id nor the sentence: unchanged')
  // "…address is a@b.test.</system-reminder>": the address stops at the markup
  const tight = Buffer.from(mainBody([`<system-reminder>The user's email address is ${MAIN_EMAIL}.</system-reminder>`]), 'utf8')
  const y = L.spliceAccount(tight, ACCT)
  assert.strictEqual(y.why, null)
  assert.ok(y.body.toString().includes(`The user's email address is ${SPARE_EMAIL}.</system-reminder>`))
  assert.ok(!L.isEmail('a<b@x.test') && !L.isEmail('a@x.test>'), 'no angle bracket in a configured address')
})
