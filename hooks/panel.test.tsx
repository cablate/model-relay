import { expect, test } from 'claude-code/testing'
import { buildPanelData, parseHealth } from './logic'
import { panelTree } from './panel'

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

// The panel of an account window and of a main window served by the relay's own account's fallback, drawn from router answers
const accountHealth = (extra: object) => parseHealth(JSON.stringify({
  ok: true, session: 'claude', providers: { aaa: 'aaa-9', 'team-2': 'anthropic-account' }, kinds: { 'team-2': 'anthropic' }, aliases: {}, failoverChain: ['aaa'],
  config: { failoverEnabled: true, retryEnabled: true, proxyEnabled: false }, proxy: { enabled: false, certificate: false }, ...extra,
}))!

test('B5, B6: the panel labels a second account as Claude under its name, shows what serves the window, and hides your failover in an account window', async ($, on) => {
  let view: Parameters<typeof panelTree>[1]
  const ui = { open: true, confirmingClaude: false, pinging: false, showSettings: true }
  const act = { switchTo: () => undefined, askClaude: () => undefined, ping: () => undefined, probe: () => undefined, settings: () => undefined, toggle: () => undefined, askProxy: () => undefined, close: () => undefined }
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => panelTree($.ui.resolve(e), view, act))
  const draw = async (data: ReturnType<typeof buildPanelData>) => {
    view = { ...data, ...ui, columns: 100 }
    return $.ui.mount({ plugin: 'model-relay', surface: 'terminal', component: 'AbovePrompt', props })
  }
  // team-1's window, its limit moved it to team-2
  const a = await draw(buildPanelData(accountHealth({ account: 'team-1', accountServing: 'team-2', failoverSince: 5, failoverProvider: 'aaa' }), 8950, false, 'en', 0, false, 'team-1'))
  expect(await a.find({ type: 'Text', text: 'team-1 is at its usage limit: requests go to Claude (team-2)' })).toBeDefined()
  expect(await a.find({ type: 'Text', text: 'Claude (team-1)' })).toBeDefined()
  expect(await a.find({ type: 'Text', text: 'Claude (team-2)' })).toBeDefined()
  expect(await a.find({ type: 'Text', text: /anthropic-account/ })).toBeUndefined()
  expect(await a.find({ type: 'Text', text: /Claude limit reached/ })).toBeUndefined()
  expect(await a.find({ key: 'switch:failover' })).toBeUndefined()
  expect(await a.find({ key: 'switch:retry' })).toBeDefined()
  await a.unmount()
  // team-1's window at its limit with nobody to go to
  const stuck = await draw(buildPanelData(accountHealth({ account: 'team-1', accountLimited: true }), 8950, false, 'en', 0, false, 'team-1'))
  expect(await stuck.find({ type: 'Text', text: 'team-1 is at its usage limit and has no fallback account to move to' })).toBeDefined()
  await stuck.unmount()
  // a main window served by the relay's own account's fallback
  const m = await draw(buildPanelData(accountHealth({ selfServing: 'team-2' }), 8950, false, 'en', 0))
  expect(await m.find({ type: 'Text', text: 'Your account is at its usage limit: requests go to Claude (team-2)' })).toBeDefined()
  expect(await m.find({ type: 'Text', text: 'Anthropic Claude' })).toBeDefined()
  expect(await m.find({ key: 'switch:failover' })).toBeDefined()
  expect(await m.find({ type: 'Text', text: 'Claude (team-2)' })).toBeDefined()
  await m.unmount()
})
