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
  on('env.get', () => ({ value: undefined }))
  on('ui.toast', (_$, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.status', () => ({ value: undefined }))
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
})
