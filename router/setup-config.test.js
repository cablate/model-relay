'use strict'
// The config-editing commands of tools/setup.mjs: migrate, set, providers, remove, and the doctor lint.
const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const SETUP = path.join(__dirname, '..', 'tools', 'setup.mjs')

const LEGACY = {
  port: 8950,
  failover: { enabled: true, provider: 'glm', cooldownMs: 600000 },
  providers: {
    glm: { baseUrl: 'https://api.z.ai/api/anthropic', token: 'SECRET-GLM', model: 'glm-5.3[1m]', matchModels: ['^glm', 'haiku'] },
    gemini: { baseUrl: 'http://127.0.0.1:3425', token: 'env:RELAY_TEST_GEMINI', model: 'gemini-4-argon' },
  },
  baseUrl: 'https://api.z.ai/api/anthropic',
  token: 'SECRET-GLM',
  model: 'glm-5.3[1m]',
  failoverEnabled: true,
  probeEveryMin: 10,
}

function fixture(t, raw = LEGACY) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-cfg-'))
  const file = path.join(dir, 'model-relay.json')
  fs.writeFileSync(file, JSON.stringify(raw, null, 2))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const run = (...args) => {
    const r = spawnSync(process.execPath, [SETUP, ...args], {
      env: { ...process.env, CLAUDE_CONFIG_DIR: dir, RELAY_TEST_GEMINI: 'SECRET-GEM' },
      encoding: 'utf8',
    })
    return { code: r.status, out: `${r.stdout}${r.stderr}` }
  }
  const read = () => JSON.parse(fs.readFileSync(file, 'utf8'))
  return { dir, file, run, read }
}

test('migrate is a dry run until --go, and then keeps a copy and never prints a token', (t) => {
  const f = fixture(t)
  const dry = f.run('migrate')
  assert.strictEqual(dry.code, 0, dry.out)
  assert.match(dry.out, /Dry run/)
  assert.strictEqual('baseUrl' in f.read(), true, 'a dry run changes nothing')
  const go = f.run('migrate', '--go')
  assert.strictEqual(go.code, 0, go.out)
  assert.ok(!go.out.includes('SECRET'), 'tokens are never printed')
  const after = f.read()
  assert.ok(!('baseUrl' in after) && !('probeEveryMin' in after))
  assert.deepStrictEqual(after.failover, { enabled: true, chain: ['glm'], cooldownMs: 600000 })
  assert.strictEqual(after.providers.glm.token, 'SECRET-GLM')
  assert.ok(fs.existsSync(`${f.file}.pre-migrate`))
  assert.match(f.run('migrate', '--go').out, /nothing to do/)
})

test('set changes one switch, validates the value, and moves an old file to the new layout on the way', (t) => {
  const f = fixture(t)
  const r = f.run('set', 'failover.enabled', 'off')
  assert.strictEqual(r.code, 0, r.out)
  assert.strictEqual(f.read().failover.enabled, false)
  assert.ok(!('failoverEnabled' in f.read()), 'the old duplicate would otherwise fight the new value')
  assert.strictEqual(f.run('set', 'retry.enabled', 'off').code, 0)
  assert.strictEqual(f.read().retry.enabled, false)
  assert.strictEqual(f.run('set', 'failover.cooldownMs', '15m').code, 0)
  assert.strictEqual(f.read().failover.cooldownMs, 900000)
  assert.strictEqual(f.run('set', 'failover.chain', 'gemini,glm').code, 0)
  assert.deepStrictEqual(f.read().failover.chain, ['gemini', 'glm'])
})

test('set refuses bad values and names, and leaves the file alone', (t) => {
  const f = fixture(t)
  const before = fs.readFileSync(f.file, 'utf8')
  assert.notStrictEqual(f.run('set', 'failover.chain', 'glm,nope').code, 0)
  assert.notStrictEqual(f.run('set', 'failover.cooldownMs', '5s').code, 0)
  assert.notStrictEqual(f.run('set', 'retry.enabled', 'maybe').code, 0)
  assert.notStrictEqual(f.run('set', 'nothing.here', 'on').code, 0)
  const proxy = f.run('set', 'proxy.enabled', 'on')
  assert.notStrictEqual(proxy.code, 0)
  assert.match(proxy.out, /proxy enable/)
  assert.strictEqual(fs.readFileSync(f.file, 'utf8'), before)
})

test('per-provider fallback and retry can be set and reset', (t) => {
  const f = fixture(t)
  assert.strictEqual(f.run('set', 'providers.gemini.fallback', 'none').code, 0)
  assert.strictEqual(f.read().providers.gemini.fallback, false)
  assert.strictEqual(f.run('set', 'providers.gemini.fallback', 'glm').code, 0)
  assert.deepStrictEqual(f.read().providers.gemini.fallback, ['glm'])
  assert.strictEqual(f.run('set', 'providers.gemini.fallback', 'default').code, 0)
  assert.ok(!('fallback' in f.read().providers.gemini))
  assert.strictEqual(f.run('set', 'providers.glm.retry', 'off').code, 0)
  assert.strictEqual(f.read().providers.glm.retry, false)
  assert.notStrictEqual(f.run('set', 'providers.ghost.retry', 'off').code, 0)
})

test('providers lists what the router will use without showing a token', (t) => {
  const f = fixture(t)
  const r = f.run('providers')
  assert.strictEqual(r.code, 0, r.out)
  assert.match(r.out, /glm/)
  assert.match(r.out, /gemini/)
  assert.match(r.out, /env:RELAY_TEST_GEMINI/)
  assert.ok(!r.out.includes('SECRET'))
})

test('remove drops the provider everywhere it is mentioned, after a dry run', (t) => {
  const f = fixture(t, {
    providers: {
      glm: { baseUrl: 'https://a.example', token: 't1', model: 'glm-5.3' },
      gemini: { baseUrl: 'https://b.example', token: 't2', model: 'gemini-4', fallback: ['glm'] },
    },
    failover: { enabled: true, chain: ['gemini', 'glm'], cooldownMs: 600000 },
  })
  assert.match(f.run('remove', 'glm').out, /Dry run/)
  assert.ok(f.read().providers.glm)
  assert.strictEqual(f.run('remove', 'glm', '--go').code, 0)
  const after = f.read()
  assert.ok(!after.providers.glm)
  assert.deepStrictEqual(after.failover.chain, ['gemini'])
  assert.deepStrictEqual(after.providers.gemini.fallback, [])
  assert.notStrictEqual(f.run('remove', 'gemini', '--go').code, 0, 'the last provider stays')
})

test('doctor points out an old layout, an unknown failover name and a model another provider steals', (t) => {
  const f = fixture(t, {
    port: 8999, // nothing listens here, so doctor does not talk to a real router
    providers: {
      aaa: { baseUrl: 'https://a.example', token: 't1', model: 'glm-5.3', matchModels: ['^glm'] },
      bbb: { baseUrl: 'https://b.example', token: 't2', model: 'glm-9', matchModels: ['^zzz'] },
    },
    failover: { enabled: true, chain: ['aaa', 'ghost'], cooldownMs: 600000 },
    probeEveryMin: 3,
  })
  const r = f.run('doctor')
  assert.match(r.out, /old config layout/)
  assert.match(r.out, /ghost/)
  assert.match(r.out, /glm-9 go to aaa, not bbb/)
})

test('doctor warns when settings.json availableModels would drop a provider subagent model', (t) => {
  const f = fixture(t, {
    port: 8999,
    providers: {
      aaa: { baseUrl: 'https://a.example', token: 't1', model: 'glm-5.3[1m]', matchModels: ['^glm'] },
      bbb: { baseUrl: 'https://b.example', token: 't2', model: 'gemini-4-argon', matchModels: ['^gemini'] },
    },
  })
  const settingsFile = path.join(f.dir, 'settings.json')
  fs.writeFileSync(settingsFile, JSON.stringify({ availableModels: ['opus', 'glm-5.3[1m]'] }))
  const r = f.run('doctor')
  assert.match(r.out, /availableModels does not list gemini-4-argon;/, 'a missing model is named')
  assert.doesNotMatch(r.out, /does not list[^\n]*glm/, 'a listed model is not named')
  fs.writeFileSync(settingsFile, JSON.stringify({ availableModels: ['glm-5.3[1m]', 'GEMINI-4-ARGON'] }))
  assert.doesNotMatch(f.run('doctor').out, /availableModels/, 'every model listed, no warning')
  fs.writeFileSync(settingsFile, JSON.stringify({}))
  assert.doesNotMatch(f.run('doctor').out, /availableModels/, 'no allowlist, no warning')
})

test('alias points haiku at a provider in both settings.json and matchModels, and resets back to claude', (t) => {
  const f = fixture(t, {
    providers: {
      glm: { token: 't1' }, // preset has ['^glm', 'haiku']
      gemini: { token: 't2' },
    },
    failover: { enabled: true, chain: ['glm'], cooldownMs: 600000 },
  })
  const settingsFile = path.join(f.dir, 'settings.json')
  const readSettings = () => JSON.parse(fs.readFileSync(settingsFile, 'utf8'))

  // Move haiku from glm to gemini
  const toGem = f.run('alias', 'haiku', 'gemini')
  assert.strictEqual(toGem.code, 0, toGem.out)
  assert.strictEqual(readSettings().env.ANTHROPIC_DEFAULT_HAIKU_MODEL, 'gemini-4-argon')
  assert.deepStrictEqual(f.read().providers.glm.matchModels, ['^glm'], 'glm preset no longer claims haiku')
  assert.ok(f.read().providers.gemini.matchModels.includes('haiku'))

  // Reset haiku back to Anthropic Claude
  const toClaude = f.run('alias', 'haiku', 'claude')
  assert.strictEqual(toClaude.code, 0, toClaude.out)
  assert.strictEqual(readSettings().env.ANTHROPIC_DEFAULT_HAIKU_MODEL, undefined)
  assert.ok(!f.read().providers.gemini.matchModels.includes('haiku'))

  // Custom matchModels via set
  assert.strictEqual(f.run('set', 'providers.gemini.matchModels', '^gemini,sonnet').code, 0)
  assert.deepStrictEqual(f.read().providers.gemini.matchModels, ['^gemini', 'sonnet'])
})

