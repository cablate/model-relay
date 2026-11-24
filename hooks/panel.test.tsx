import { expect, test } from 'claude-code/testing'

// A config and a router that answers, beneath the plugin: the hook reads the one and asks the other
const routerHealth = {
  ok: true, session: 'aaa', providers: { aaa: 'aaa-9' }, aliases: { haiku: 'aaa' }, failoverChain: ['aaa'],
  config: { failoverEnabled: true, retryEnabled: true, proxyEnabled: false }, proxy: { enabled: false, certificate: false },
}
const props = { hasSurvey: false, isWorking: false, maxRows: 40, bodyColumns: 100, scroll: { offset: 0, bodyRows: 39 }, view: {} }
const provider = (args: string) => ({ command: 'provider', args, origin: { kind: 'composer' as const }, presentation: { isFullscreen: false, columns: 100 } })

test('/provider opens the panel in one line; the panel offers this window\'s routes, and the shared switches only when asked', async ($, on) => {
  const toasts: string[] = []
  const written: Array<{ path: string; text: string }> = []
  on('env.get', () => ({ value: undefined }))
  on('ui.toast', (_$, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.status', () => ({ value: undefined }))
  on('fs.write', (_$, e) => {
    written.push({ path: e.path, text: e.text })
    return { value: undefined }
  })
  // A closed panel passes to the engine's own drawing, which this stands for
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Box } = $.ui.resolve(e)
    return <Box key="engine" />
  })
  on('session.id', () => ({ value: 's1' }))
  on('fs.read', () => ({ value: JSON.stringify({ format: 2, port: 8950 }) }))
  on('process.run', (_$, e) => {
    const url = e.argv.at(-1) ?? ''
    const stdout = url.includes('/__health') ? JSON.stringify(routerHealth) : url.includes('/__session') ? '{"ok":true}' : ''
    return { value: { exitCode: stdout ? 0 : 1, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })

  const r = await $.command.run(provider(''))
  expect(r.text?.includes('\n')).toBe(false)
  expect(r.text).toContain('/provider help')

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'model-relay', surface, component: 'AbovePrompt', props })
    expect(await ui.find({ key: 'btn:claude' })).toBeDefined()
    expect(await ui.find({ key: 'btn:aaa' })).toBeUndefined()
    for (const key of ['btn:failover', 'btn:retry', 'btn:proxy']) expect(await ui.find({ key })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: /haiku/ })).toBeUndefined()

    await ui.press({ key: 'settings' })
    for (const key of ['btn:failover', 'btn:retry', 'btn:proxy']) expect(await ui.find({ key })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /haiku → aaa/ })).toBeDefined()
    await ui.press({ key: 'settings' })
    expect(await ui.find({ key: 'btn:failover' })).toBeUndefined()

    // Back to Claude rebuilds a long chat's cache, so it takes a second press
    await ui.press({ key: 'btn:claude' })
    expect(await ui.find({ key: 'confirm-claude' })).toBeDefined()
    await ui.press({ key: 'cancel-claude' })
    expect(await ui.find({ key: 'confirm-claude' })).toBeUndefined()
    await ui.unmount()
  }

  // A switch that took closes the panel
  const ui = await $.ui.mount({ plugin: 'model-relay', surface: 'terminal', component: 'AbovePrompt', props })
  await ui.press({ key: 'btn:claude' })
  await ui.press({ key: 'confirm-claude' })
  expect(await ui.find({ key: 'settings' })).toBeUndefined()
  expect(await ui.find({ key: 'engine' })).toBeDefined()
  expect(toasts.length === 1 && !toasts[0]!.includes('\n') && toasts[0]!.includes('Claude')).toBe(true)
  await ui.unmount()

  const sw = await $.command.run(provider('aaa'))
  expect(sw.text?.includes('\n')).toBe(false)
  expect(sw.text).toContain('aaa-9')
  expect(written.at(-1)?.path.replace(/\\/g, '/')).toContain('/.claude/model-relay-status/s1')
  expect(written.at(-1)?.text).toBe('pinned\taaa-9\n')
})

test('panel renders model and effort buttons for active multi-model provider, sends opts to /__session, and skips hook status writes when router owns status (SEC-01)', async ($, on) => {
  const sessionPayloads: Array<Record<string, unknown>> = []
  const toasts: string[] = []
  const written: Array<{ path: string; text: string }> = []
  let currentModel = 'alt-pro[1m]'
  let currentEffort: string | null = 'high'
  const multiHealth = () => ({
    ok: true,
    session: 'alt',
    sessionModel: currentModel,
    sessionEffort: currentEffort,
    statusWriter: 'router',
    providers: { alt: 'alt-pro[1m]' },
    providerModels: {
      alt: [
        { model: 'alt-pro[1m]', efforts: ['low', 'high'] },
        { model: 'alt-neon[1m]', efforts: ['high', 'xhigh'] },
      ],
    },
    aliases: {},
    failoverChain: [],
    config: { failoverEnabled: true, retryEnabled: true, proxyEnabled: false },
    proxy: { enabled: false, certificate: false },
  })
  on('env.get', () => ({ value: undefined }))
  on('ui.toast', (_$, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.status', () => ({ value: undefined }))
  on('fs.write', (_$, e) => {
    written.push({ path: e.path, text: e.text })
    return { value: undefined }
  })
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Box } = $.ui.resolve(e)
    return <Box key="engine" />
  })
  on('session.id', () => ({ value: 's2' }))
  on('fs.read', () => ({ value: JSON.stringify({ format: 2, port: 8950 }) }))
  on('process.run', (_$, e) => {
    const url = e.argv.at(-1) ?? ''
    if (url.includes('/__health')) {
      return { value: { exitCode: 0, stdout: JSON.stringify(multiHealth()), stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    }
    if (url.includes('/__session')) {
      const payload = JSON.parse(e.argv[e.argv.indexOf('-d') + 1] ?? '{}') as Record<string, unknown>
      sessionPayloads.push(payload)
      if (typeof payload.model === 'string') currentModel = payload.model
      if (typeof payload.effort === 'string') currentEffort = payload.effort === 'auto' ? null : payload.effort
      return {
        value: {
          exitCode: 0,
          stdout: JSON.stringify({ ok: true, session: 'alt', model: currentModel, effort: currentEffort }),
          stderr: '',
          isStdoutTruncated: false,
          isStderrTruncated: false,
        },
      }
    }
    return { value: { exitCode: 1, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })

  await $.command.run(provider(''))
  const ui = await $.ui.mount({ plugin: 'model-relay', surface: 'terminal', component: 'AbovePrompt', props })
  expect(await ui.find({ type: 'Text', text: /\[high\]/ })).toBeDefined()
  expect(await ui.find({ key: 'btn:alt:model:alt-pro[1m]' })).toBeDefined()
  expect(await ui.find({ key: 'btn:alt:model:alt-neon[1m]' })).toBeDefined()
  expect(await ui.find({ key: 'btn:alt:effort:auto' })).toBeDefined()
  expect(await ui.find({ key: 'btn:alt:effort:low' })).toBeDefined()
  expect(await ui.find({ key: 'btn:alt:effort:high' })).toBeDefined()

  // Switch model via button
  await ui.press({ key: 'btn:alt:model:alt-neon[1m]' })
  expect(sessionPayloads.at(-1)).toEqual({ sid: 's2', on: 'alt', model: 'alt-neon[1m]' })
  await ui.unmount()

  // Reopen panel: now alt-neon[1m] is active and offers xhigh effort button
  await $.command.run(provider(''))
  const ui2 = await $.ui.mount({ plugin: 'model-relay', surface: 'terminal', component: 'AbovePrompt', props })
  expect(await ui2.find({ key: 'btn:alt:effort:xhigh' })).toBeDefined()
  await ui2.press({ key: 'btn:alt:effort:xhigh' })
  expect(sessionPayloads.at(-1)).toEqual({ sid: 's2', on: 'alt', model: 'alt-neon[1m]', effort: 'xhigh' })
  expect(toasts.at(-1)).toContain('xhigh')
  await ui2.unmount()

  // Command form `/provider alt auto` clears effort and skips hook status file write because statusWriter === 'router'
  const cleared = await $.command.run(provider('alt auto'))
  expect(sessionPayloads.at(-1)).toEqual({ sid: 's2', on: 'alt', effort: 'auto' })
  expect(cleared.text).toContain('alt-neon[1m]')
  expect(written.filter((w) => w.path.includes('model-relay-status'))).toEqual([])
})
