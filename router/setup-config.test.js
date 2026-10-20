'use strict'
// The config-editing commands of tools/setup.mjs: migrate, set, providers, remove, and the doctor lint.
const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const SETUP = path.join(__dirname, '..', 'tools', 'setup.mjs')

// The format 2 file most tests edit
const CFG = {
  format: 2,
  port: 8950,
  failover: { enabled: true, chain: ['glm'], cooldownMs: 600000 },
  providers: {
    glm: { baseUrl: 'https://api.z.ai/api/anthropic', token: 'SECRET-GLM', model: 'glm-5.3[1m]', matchModels: ['^glm', 'haiku'] },
    gemini: { baseUrl: 'http://127.0.0.1:3425', token: 'env:RELAY_TEST_GEMINI', model: 'gemini-4-argon' },
  },
}

// A file from an older version, which only migrate and doctor read
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

function fixture(t, raw = CFG, name = 'model-relay.json') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-cfg-'))
  const file = path.join(dir, name)
  fs.writeFileSync(file, JSON.stringify(raw, null, 2))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const run = (...args) => {
    const r = spawnSync(process.execPath, [SETUP, ...args], {
      cwd: dir,
      env: { ...process.env, CLAUDE_CONFIG_DIR: dir, RELAY_TEST_GEMINI: 'SECRET-GEM' },
      encoding: 'utf8',
    })
    return { code: r.status, out: `${r.stdout}${r.stderr}`, stdout: r.stdout }
  }
  const read = () => JSON.parse(fs.readFileSync(file, 'utf8'))
  return { dir, file, run, read }
}

test('migrate is a dry run until --go, and then keeps a copy and never prints a token', (t) => {
  const f = fixture(t, LEGACY)
  const dry = f.run('migrate')
  assert.strictEqual(dry.code, 0, dry.out)
  assert.match(dry.out, /Dry run/)
  assert.strictEqual('baseUrl' in f.read(), true, 'a dry run changes nothing')
  const go = f.run('migrate', '--go')
  assert.strictEqual(go.code, 0, go.out)
  assert.ok(!go.out.includes('SECRET'), 'tokens are never printed')
  const after = f.read()
  assert.ok(!('baseUrl' in after) && !('probeEveryMin' in after))
  assert.strictEqual(after.format, 2)
  assert.deepStrictEqual(after.failover, { enabled: true, chain: ['glm'], cooldownMs: 600000 })
  assert.strictEqual(after.providers.glm.token, 'SECRET-GLM')
  assert.ok(fs.existsSync(`${f.file}.model-relay-backup`))
  assert.match(f.run('migrate', '--go').out, /nothing to do/)
})

test('set changes one switch and validates the value', (t) => {
  const f = fixture(t)
  const r = f.run('set', 'failover.enabled', 'off')
  assert.strictEqual(r.code, 0, r.out)
  assert.strictEqual(f.read().failover.enabled, false)
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
    format: 2,
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

test('doctor points out an unknown failover name and a model another provider steals', (t) => {
  const f = fixture(t, {
    format: 2,
    port: 8999, // nothing listens here, so doctor does not talk to a real router
    providers: {
      aaa: { baseUrl: 'https://a.example', token: 't1', model: 'glm-5.3', matchModels: ['^glm'] },
      bbb: { baseUrl: 'https://b.example', token: 't2', model: 'glm-9', matchModels: ['^zzz'] },
    },
    failover: { enabled: true, chain: ['aaa', 'ghost'], cooldownMs: 600000 },
  })
  const r = f.run('doctor')
  assert.match(r.out, /ghost/)
  assert.match(r.out, /glm-9 go to aaa, not bbb/)
})

test('doctor warns when settings.json availableModels would drop a provider subagent model', (t) => {
  const f = fixture(t, {
    format: 2,
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

test('doctor --json on an older config reads its port only, and its one finding is to migrate', (t) => {
  for (const [raw, name] of [[{ port: 8999, providers: { glm: { token: 'SECRET-T' } } }, 'custom-agent.json'], [{ ...LEGACY, port: 8999 }, 'model-relay.json']]) {
    const f = fixture(t, raw, name)
    const r = f.run('doctor', '--json')
    assert.strictEqual(r.code, 0, r.out)
    assert.ok(!r.out.includes('SECRET'), 'tokens are never printed')
    const j = JSON.parse(r.stdout)
    assert.ok(j.ok === true && j.outdated === true && j.port === 8999, r.stdout)
    assert.deepStrictEqual(j.providers, {}, 'nothing in it is used, so nothing is shown as used')
    const found = j.findings.filter((x) => x.id !== 'wiring').map((x) => [x.id, x.fix, x.needsConsent])
    assert.deepStrictEqual(found, [['outdated', 'migrate --go', true]], r.stdout)
    assert.strictEqual(j.router.up, false)
    assert.match(f.run('doctor').out, /older version of model-relay/)
  }
})

test('every command but migrate and doctor turns an older config away and changes nothing', (t) => {
  const commands = [
    ['set', 'failover.enabled', 'off'],
    ['providers'],
    ['remove', 'gemini', '--go'],
    ['alias', 'haiku', 'claude'],
    ['add', 'zzz', '--url', 'https://z.example', '--model', 'z-1', '--token', 'env:Z'],
    ['init'],
    ['restart'],
    ['proxy', 'enable', '--go'],
  ]
  for (const name of ['model-relay.json', 'custom-agent.json']) {
    const f = fixture(t, { ...LEGACY, port: 8999 }, name)
    const before = fs.readFileSync(f.file, 'utf8')
    for (const args of commands) {
      const r = f.run(...args)
      assert.strictEqual(r.code, 1, `${name} ${args.join(' ')}: ${r.out}`)
      assert.match(r.out, /older version of model-relay, which this version does not read\. Run "migrate"/, `${name} ${args.join(' ')}`)
    }
    assert.strictEqual(fs.readFileSync(f.file, 'utf8'), before)
    assert.deepStrictEqual(fs.readdirSync(f.dir), [name], `${name}: no other file was written`)
  }
})

test('doctor on a new config with no provider yet says every request goes to Claude, and does not fail', (t) => {
  const f = fixture(t, { format: 2, port: 8999, failover: { enabled: true, chain: [], cooldownMs: 600000 }, providers: {} })
  const r = f.run('doctor')
  assert.strictEqual(r.code, 0, r.out)
  assert.match(r.out, /every request goes to Claude/)
  assert.match(r.out, /no provider has an address, a model and a token yet/)
  assert.doesNotMatch(r.out, /older version/, 'a format 2 file is not an older config')
})

test('migrate --go moves a file with the old name, so no second copy of the token is left under it', (t) => {
  const f = fixture(t, { port: 8999, providers: { glm: { token: 'SECRET-T' } } }, 'custom-agent.json')
  assert.match(f.run('migrate').out, /rename custom-agent\.json to model-relay\.json/)
  const go = f.run('migrate', '--go')
  assert.strictEqual(go.code, 0, go.out)
  assert.ok(!go.out.includes('SECRET'), 'tokens are never printed')
  assert.ok(!fs.existsSync(f.file), 'custom-agent.json is gone')
  const after = JSON.parse(fs.readFileSync(path.join(f.dir, 'model-relay.json'), 'utf8'))
  assert.strictEqual(after.format, 2)
  assert.strictEqual(after.providers.glm.token, 'SECRET-T')
  assert.ok(fs.existsSync(`${f.file}.model-relay-backup`))
  assert.match(f.run('migrate').out, /nothing to do/)

  // already format 2, only the name is old: renamed as it is
  const g = fixture(t, { format: 2, port: 8999, failover: { enabled: true, chain: [], cooldownMs: 600000 }, providers: {} }, 'custom-agent.json')
  assert.strictEqual(g.run('migrate', '--go').code, 0)
  assert.ok(!fs.existsSync(g.file) && fs.existsSync(path.join(g.dir, 'model-relay.json')))
})

test('migrate says when, with the keys this shell has, failover would go somewhere else afterwards', (t) => {
  const f = fixture(t, {
    port: 8999,
    providers: { aaa: { baseUrl: 'https://a.example/x', token: 'SECRET-A', model: 'aaa-1' }, glm: { token: 'env:RELAY_TEST_UNSET_KEY' } },
  })
  const r = f.run('migrate')
  assert.strictEqual(r.code, 0, r.out)
  assert.match(r.out, /failover went to aaa before but goes to nobody afterwards, because RELAY_TEST_UNSET_KEY is unset/)
})

test('add on an existing provider replaces its address, key and model and keeps the rest', (t) => {
  const launch = { command: 'my-gateway', args: ['serve'] }
  const f = fixture(t, {
    format: 2,
    port: 8999,
    failover: { enabled: true, chain: ['loc'], cooldownMs: 600000 },
    providers: { loc: { baseUrl: 'http://127.0.0.1:4000', token: 'SECRET-OLD', model: 'old-1', matchModels: ['^loc'], launch, fallback: false } },
  })
  const r = f.run('add', 'loc', '--url', 'http://127.0.0.1:4001', '--model', 'new-1', '--token', 'env:LOC_KEY')
  assert.strictEqual(r.code, 0, r.out)
  assert.match(r.out, /other settings kept/)
  assert.deepStrictEqual(f.read().providers.loc, { baseUrl: 'http://127.0.0.1:4001', token: 'env:LOC_KEY', model: 'new-1', matchModels: ['^loc'], launch, fallback: false })
})

test('doctor --json names an unset key variable, never a value, and each fix is arguments to this CLI', (t) => {
  const f = fixture(t, { format: 2, port: 8999, failover: { enabled: true, chain: ['aaa'], cooldownMs: 600000 }, providers: { aaa: { baseUrl: 'https://a.example/x', token: 'env:RELAY_TEST_UNSET_KEY', model: 'aaa-1' } } })
  const r = f.run('doctor', '--json')
  assert.strictEqual(r.code, 0, r.out)
  const j = JSON.parse(r.stdout)
  const miss = j.findings.find((x) => x.id === 'missing-key')
  assert.ok(miss && miss.provider === 'aaa' && miss.env === 'RELAY_TEST_UNSET_KEY', JSON.stringify(j.findings))
  assert.ok(j.findings.every((x) => !x.fix || !/^node /.test(x.fix)), JSON.stringify(j.findings))
})

test('doctor and migrate turn away a config that is valid JSON but not an object', (t) => {
  const f = fixture(t, [])
  for (const args of [['doctor'], ['doctor', '--json'], ['migrate']]) {
    const r = f.run(...args)
    assert.strictEqual(r.code, 1, `${args.join(' ')}: ${r.out}`)
    assert.match(r.out, /not a JSON object/)
  }
})

test('alias points haiku at a provider in both settings.json and matchModels, and resets back to claude', (t) => {
  const f = fixture(t, {
    format: 2,
    providers: {
      glm: { baseUrl: 'https://a.example', token: 't1', model: 'glm-5.3[1m]', matchModels: ['^glm', 'haiku'] },
      gemini: { baseUrl: 'https://b.example', token: 't2', model: 'gemini-4-argon' },
    },
    failover: { enabled: true, chain: ['glm'], cooldownMs: 600000 },
  })
  const settingsFile = path.join(f.dir, 'settings.json')
  const readSettings = () => JSON.parse(fs.readFileSync(settingsFile, 'utf8'))

  // Move haiku from glm to gemini
  const toGem = f.run('alias', 'haiku', 'gemini')
  assert.strictEqual(toGem.code, 0, toGem.out)
  assert.strictEqual(readSettings().env.ANTHROPIC_DEFAULT_HAIKU_MODEL, 'gemini-4-argon')
  assert.deepStrictEqual(f.read().providers.glm.matchModels, ['^glm'], 'glm no longer claims haiku')
  assert.ok(f.read().providers.gemini.matchModels.includes('haiku'))

  // Reset haiku back to Anthropic Claude
  const toClaude = f.run('alias', 'haiku', 'claude')
  assert.strictEqual(toClaude.code, 0, toClaude.out)
  assert.strictEqual(readSettings().env.ANTHROPIC_DEFAULT_HAIKU_MODEL, undefined)
  assert.deepStrictEqual(f.read().providers.gemini.matchModels, ['^gemini'])

  // Custom matchModels via set
  assert.strictEqual(f.run('set', 'providers.gemini.matchModels', '^gemini,sonnet').code, 0)
  assert.deepStrictEqual(f.read().providers.gemini.matchModels, ['^gemini', 'sonnet'])
})

