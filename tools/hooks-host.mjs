// hooks/register.ts against a stand-in host, under plain Node. Each noun the module calls answers from `host`, and
// every call is recorded. A fresh copy of register.ts is loaded per case since session state lives in module variables.
import { register as registerLoader } from 'node:module'
import { test } from 'node:test'
import assert from 'node:assert'

const ENGINE_URL = `data:text/javascript,${encodeURIComponent([
  'const values = new Map()',
  'export const atom = (ref, initial) => ({ ref, initial })',
  'export const read = async (_$, a) => (values.has(a) ? values.get(a) : a.initial)',
  'export const update = async (_$, a, fn) => { values.set(a, fn(values.has(a) ? values.get(a) : a.initial)) }',
].join('\n'))}`

const LOADER_URL = `data:text/javascript,${encodeURIComponent([
  `const ENGINE = ${JSON.stringify(ENGINE_URL)}`,
  `const DRAWINGS = { './avatar': 'avatarTree', './panel': 'panelTree' }`,
  'export async function resolve(specifier, context, next) {',
  "  if (specifier === 'claude-code') return { url: ENGINE, shortCircuit: true }",
  '  if (Object.hasOwn(DRAWINGS, specifier)) return { url: `data:text/javascript,export const ${DRAWINGS[specifier]} = () => null`, shortCircuit: true }',
  '  if (/^\\.\\.?\\//.test(specifier) && !/\\.[cm]?[jt]sx?$/.test(specifier)) return next(`${specifier}.ts`, context)',
  '  return next(specifier, context)',
  '}',
].join('\n'))}`

registerLoader(LOADER_URL)

const SID = '11111111-2222-4333-8444-555555555555'
const REGISTER = new URL('../hooks/register.ts', import.meta.url).href

let copies = 0
async function load(host) {
  const mod = await import(`${REGISTER}?copy=${++copies}`)
  const hooks = {}
  mod.register((event, a, b) => {
    hooks[event] = typeof a === 'function' ? a : b
    return { catch: () => undefined }
  })
  const files = {
    ...(host.files ?? {}),
    [`${host.relay}/model-relay.json`]: JSON.stringify(host.cfg),
    '/plugin/.claude-plugin/plugin.json': '{"version":"9.9.9"}',
  }
  const $ = {
    plugin: { root: '/plugin' },
    env: {
      get: async (k) => host.env[k],
      set: async () => ({}),
    },
    settings: { read: async () => ({ language: 'English' }) },
    fs: {
      read: async (p) => {
        host.fsReads.push(p)
        if (Object.hasOwn(files, p)) return files[p]
        throw new Error('ENOENT')
      },
      write: async (p, text) => {
        host.writes.push({ path: p, text })
      },
    },
    session: { id: async () => SID },
    process: {
      run: async (argv, init) => {
        host.runs.push({ argv, init })
        const url = argv.at(-1) ?? ''
        if (url.endsWith('/__session')) {
          const payload = JSON.parse(argv[argv.indexOf('-d') + 1])
          host.sessionCalls.push(payload)
          host.health = {
            ...host.health,
            session: payload.on,
            ...(payload.on === 'claude' ? { sessionModel: undefined } : {}),
          }
          return { exitCode: 0, stdout: JSON.stringify({ ok: true, session: payload.on }), stderr: '' }
        }
        const answer = url.includes('/__health') && !host.down ? host.health : null
        return { exitCode: answer ? 0 : 1, stdout: answer ? JSON.stringify(answer) : '', stderr: '' }
      },
    },
    ui: {
      toast: (t) => host.toasts.push(t),
      status: () => undefined,
      panes: async () => [],
      open: async () => ({ isPlaced: false }),
      close: async () => undefined,
    },
    command: { register: async () => undefined },
    agent: { register: async () => undefined },
    clock: { every: () => undefined },
    prompt: { submit: async () => undefined },
  }
  const start = (isInteractive) => hooks['session.start']($, { cwd: '/w', surface: isInteractive ? 'terminal' : null, isInteractive }, async (e) => e)
  const command = (args, kind) => hooks['command.run']($, { command: 'provider', args, origin: { kind }, presentation: { isFullscreen: false, columns: 100 } })
  const spawn = (e) => hooks['agent.spawn']($, { cwd: '/w', ...e }, async (ev) => ({ ...ev, agentId: `agent-${host.spawns.push(ev)}` }))
  return { start, command, spawn }
}

const health = (extra = {}) => ({
  ok: true,
  version: '9.9.9',
  inflight: 0,
  configDir: '/cfg',
  session: 'claude',
  providers: {},
  aliases: {},
  failoverChain: [],
  unresolved: [],
  ...extra,
})

const makeHost = (h = health(), { relay = '/cfg', files = {}, cfg = {} } = {}) => ({
  env: { CLAUDE_CONFIG_DIR: '/cfg', HOME: '/home/me' },
  cfg: { format: 2, port: 59999, ...cfg },
  health: h,
  relay,
  files,
  down: false,
  runs: [],
  sessionCalls: [],
  writes: [],
  toasts: [],
  fsReads: [],
  spawns: [],
})

const pluginFiles = {
  '/cfg/plugins/installed_plugins.json': JSON.stringify({
    version: 2,
    plugins: {
      'pilotfish@pilotfish': [{ scope: 'user', installPath: '/plugins/pilotfish' }],
    },
  }),
  '/plugins/pilotfish/agents/scout.md': '---\nname: scout\nmodel: haiku\neffort: low\n---\nScout prompt\n',
  '/plugins/pilotfish/agents/executor.md': '---\nname: executor\nmodel: sonnet\neffort: medium\n---\nExecutor prompt\n',
  '/plugins/pilotfish/agents/verifier.md': '---\nname: verifier\nmodel: opus\neffort: high\n---\nVerifier prompt\n',
}

test('tierModels (stand-in host): claude session is untouched; /provider <name> maps plugin/Explore tiers immediately while model-relay:*, explicit non-Claude, and fork stay untouched', async () => {
  const h = makeHost(
    health({
      session: 'claude',
      providers: {
        backup: 'main-model[1m]',
        other: 'alt-model[1m]',
      },
    }),
    {
      files: pluginFiles,
      cfg: {
        providers: {
          backup: {
            tierModels: {
              haiku: 'fast-model[1m]',
              sonnet: 'fast-model[1m]',
              opus: 'inherit',
            },
          },
        },
      },
    },
  )

  const r = await load(h)
  await r.start(true)

  // On session: 'claude', spawning pilotfish:scout leaves e untouched and does NOT read installed_plugins.json
  const claudeScout = await r.spawn({ subagentType: 'pilotfish:scout' })
  assert.strictEqual(claudeScout.model, undefined, 'claude session leaves pilotfish:scout untouched')
  assert.ok(!h.fsReads.some((p) => p.includes('installed_plugins.json')), 'claude session does not read installed_plugins.json')

  // Immediately after /provider backup (no 10s tick required)
  const sw = await r.command('backup', 'composer')
  assert.ok(sw.text.includes('main-model[1m]'), sw.text)

  const scout = await r.spawn({ subagentType: 'pilotfish:scout' })
  assert.strictEqual(scout.model, 'fast-model[1m]', 'haiku tier maps to fast-model')

  const executor = await r.spawn({ subagentType: 'pilotfish:executor' })
  assert.strictEqual(executor.model, 'fast-model[1m]', 'sonnet tier maps to fast-model')

  const verifier = await r.spawn({ subagentType: 'pilotfish:verifier' })
  assert.strictEqual(verifier.model, 'main-model[1m]', 'opus tier inherits active backup model')

  const explore = await r.spawn({ subagentType: 'Explore' })
  assert.strictEqual(explore.model, 'fast-model[1m]', 'built-in Explore defaults to haiku -> fast-model')

  const relayOther = await r.spawn({ subagentType: 'model-relay:other' })
  assert.strictEqual(relayOther.model, 'alt-model[1m]', 'model-relay:other stays locked to alt-model')

  const relayBackupExplicit = await r.spawn({ subagentType: 'model-relay:backup', model: 'sonnet' })
  assert.strictEqual(relayBackupExplicit.model, 'main-model[1m]', 'model-relay:backup stays locked to backup model')

  // Explicit non-Claude model is respected untouched; fork/resume untouched
  const custom = await r.spawn({ subagentType: 'pilotfish:scout', model: 'alt-model[1m]' })
  assert.strictEqual(custom.model, 'alt-model[1m]', 'explicit non-Claude model untouched')
  const forked = await r.spawn({ subagentType: 'pilotfish:scout', fork: true })
  assert.strictEqual(forked.model, undefined, 'forked spawn untouched')
  const resumed = await r.spawn({ subagentType: 'pilotfish:scout', resume: 'agent-1' })
  assert.strictEqual(resumed.model, undefined, 'resumed spawn untouched')

  // Switching to a provider without tierModels leaves plugin tiers untouched
  await r.command('other', 'composer')
  const onOther = await r.spawn({ subagentType: 'pilotfish:scout' })
  assert.strictEqual(onOther.model, undefined, 'provider without tierModels leaves scout untouched')

  // Switching back to claude stops tier mapping immediately
  await r.command('backup', 'composer')
  assert.strictEqual((await r.spawn({ subagentType: 'pilotfish:scout' })).model, 'fast-model[1m]')
  await r.command('claude', 'composer')
  const backClaude = await r.spawn({ subagentType: 'pilotfish:verifier' })
  assert.strictEqual(backClaude.model, undefined, 'back on claude: verifier untouched')
})

test('tierModels (stand-in host): "inherit" prefers optional health.sessionModel when provided by a router', async () => {
  const h = makeHost(
    health({
      session: 'backup',
      sessionModel: 'override-model[1m]',
      providers: { backup: 'main-model[1m]' },
    }),
    {
      files: pluginFiles,
      cfg: {
        providers: {
          backup: {
            tierModels: {
              opus: 'inherit',
            },
          },
        },
      },
    },
  )

  const r = await load(h)
  await r.start(true)
  const verifier = await r.spawn({ subagentType: 'pilotfish:verifier' })
  assert.strictEqual(verifier.model, 'override-model[1m]', 'inherit uses sessionModel when present')
})
