import { expect, test } from 'claude-code/testing'
import type { On } from 'claude-code'
import { base64ToBytes, bytesToBase64 } from './logic'

const PANE = { plugin: 'model-relay', component: 'Pane', requestId: 'model-relay-avatar', surface: 'terminal' } as const
const props = { title: 'model-relay avatar', isFocused: false, bodyColumns: 24, placement: 'dock', scroll: { offset: 0, bodyRows: 7 }, view: {} } as const
const config = { format: 2, port: 8950, avatars: { claude: 'pics/c.png', aaa: { image: 'pics/a.png', head: [4, 4, 6] } } }
const provider = (args: string) => ({ command: 'provider', args, origin: { kind: 'composer' as const }, presentation: { isFullscreen: true, columns: 100 } })

// White pixels, but see-through along the top pixel row and at the start of the second: the first cell has nothing in
// either half, the cells after it only a lower pixel
function seeThrough(w: number, h: number): Uint8Array {
  const rgba = new Uint8Array(w * h * 4).fill(255)
  for (let x = 0; x < w; x++) rgba[x * 4 + 3] = 0
  rgba[w * 4 + 3] = 0
  return rgba
}

// What stands beneath the plugin: the config, a router that answers for this window, and an ffmpeg that writes the
// pixels of the size its filter asks for
function beneath(on: On, state: { session: string; config: unknown; opened: string[]; ffmpeg: string[][]; missing: boolean }) {
  let box = { w: 0, h: 0 }
  on('env.get', () => ({ value: undefined }))
  on('settings.read', () => ({ value: { language: 'en' } }))
  on('session.id', () => ({ value: 's1' }))
  on('ui.toast', () => ({ value: undefined }))
  on('ui.status', () => ({ value: undefined }))
  on('clock.every', () => ({ value: undefined }))
  on('command.register', () => ({ value: { command: 'provider' } }))
  on('agent.register', () => ({ value: { agent: 'model-relay:aaa' } }))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('ui.open', (_$, e) => {
    state.opened.push(e.id)
    return { value: { isPlaced: true } }
  })
  on('fs.write', () => ({ value: undefined }))
  on('fs.read', (_$, e) => ({ value: e.as === 'bytes' ? { base64: bytesToBase64(seeThrough(box.w, box.h)) } : JSON.stringify(state.config) }))
  on('process.run', (_$, e) => {
    if (e.argv[0] === 'ffmpeg') {
      state.ffmpeg.push([...e.argv])
      const [, w, h] = /pad=(\d+):(\d+)/.exec(e.argv[e.argv.indexOf('-vf') + 1] ?? '') ?? []
      box = { w: Number(w), h: Number(h) }
      return { value: { exitCode: state.missing ? 1 : 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    }
    const url = e.argv.at(-1) ?? ''
    const stdout = url.includes('/__health')
      ? JSON.stringify({ ok: true, session: state.session, providers: { aaa: 'aaa-9' }, aliases: {}, failoverChain: [] })
      : url.includes('/__session') ? '{"ok":true}' : ''
    return { value: { exitCode: stdout ? 0 : 1, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
}

const newState = () => ({ session: 'claude', config: structuredClone(config) as unknown, opened: [] as string[], ffmpeg: [] as string[][], missing: false })

test('the pane draws the picture of the model this window talks to, and swaps it when the window switches', async ($, on) => {
  const state = newState()
  beneath(on, state)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  expect(state.opened).toEqual(['model-relay-avatar'])

  const ui = await $.ui.mount({ ...PANE, props })
  const raster = await ui.find({ key: 'avatar' })
  expect(raster?.type).toBe('Raster')
  expect(raster?.props.columns).toBe(24)
  expect(raster?.props.rows).toBe(6)
  // 24 x 6 cells, a triplet of u32 each
  const cells = new DataView(base64ToBytes(String(raster?.props.cells)).buffer)
  expect(cells.byteLength).toBe(24 * 6 * 12)
  // nothing in the first cell (a blank), only the lower pixel in the next (a lower half block), both in the row below
  expect([0, 12, 24 * 12].map((at) => cells.getUint32(at, true))).toEqual([0x20, 0x2584, 0x2580])
  expect((await ui.find({ type: 'Text', text: 'Claude' }))?.text).toBe('Claude')
  expect(await ui.find({ key: 'avatar:mode' })).toBeUndefined()
  expect(state.ffmpeg).toHaveLength(1)
  expect(state.ffmpeg[0]?.[state.ffmpeg[0].indexOf('-i') + 1]).toBe('/.claude/pics/c.png')
  expect(state.ffmpeg[0]?.[state.ffmpeg[0].indexOf('-vf') + 1]).toContain('scale=24:12:')

  // /provider aaa: this window now talks to aaa, whose entry has a head square, so a row goes to the mode switch
  state.session = 'aaa'
  await $.command.run(provider('aaa'))
  expect((await ui.find({ type: 'Text', text: 'aaa · aaa-9' }))?.text).toBe('aaa · aaa-9')
  expect((await ui.find({ key: 'avatar' }))?.props.rows).toBe(5)
  expect(state.ffmpeg).toHaveLength(2)
  expect(state.ffmpeg[1]?.[state.ffmpeg[1].indexOf('-i') + 1]).toBe('/.claude/pics/a.png')

  // the head square is the one in the config, fitted to the same box
  await ui.press({ key: 'avatar:mode' })
  expect(state.ffmpeg).toHaveLength(3)
  expect(state.ffmpeg[2]?.[state.ffmpeg[2].indexOf('-vf') + 1]).toMatch(/^crop=6:6:1:1,scale=24:10:/)
  expect((await ui.find({ key: 'avatar:mode' }))?.props.label).toBe('Whole picture')

  // nothing changed since: no more conversions however often the pane draws
  await $.command.run(provider('aaa'))
  await ui.unmount()
  const again = await $.ui.mount({ ...PANE, props })
  expect(await again.find({ key: 'avatar' })).toBeDefined()
  expect(state.ffmpeg).toHaveLength(3)
  await again.unmount()
})

test('a persona with no picture in the config says which key to add, and a failed conversion says why', async ($, on) => {
  const state = newState()
  state.config = { ...config, avatars: { aaa: 'pics/a.png' } }
  beneath(on, state)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

  const ui = await $.ui.mount({ ...PANE, props })
  expect(await ui.find({ key: 'avatar' })).toBeUndefined()
  expect((await ui.find({ type: 'Text', text: /avatars\.claude/ }))?.text).toContain('model-relay.json')
  expect((await ui.find({ type: 'Text', text: 'Claude' }))?.text).toBe('Claude')
  expect(state.ffmpeg).toHaveLength(0)

  state.session = 'aaa'
  state.missing = true
  await $.command.run(provider('aaa'))
  expect(await ui.find({ key: 'avatar' })).toBeUndefined()
  expect((await ui.find({ type: 'Text', text: /ffmpeg/ }))?.text).toContain('PATH')
  expect((await ui.find({ type: 'Text', text: 'aaa · aaa-9' }))?.text).toBe('aaa · aaa-9')
  await ui.unmount()
})

test('a config with no avatars opens no pane at the start of the session; /provider avatar opens one, and closes it only while it is drawn', async ($, on) => {
  const state = newState()
  state.config = { format: 2, port: 8950 }
  beneath(on, state)
  const closed: string[] = []
  let pane: { isPlaced: boolean } | null = null
  on('ui.panes', () => ({ value: pane ? [{ id: 'model-relay-avatar', title: 'model-relay avatar', isShown: true, isFocused: false, ...pane }] : [] }))
  on('ui.close', (_$, e) => {
    closed.push(e.id)
    return { value: undefined }
  })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  expect(state.opened).toEqual([])

  expect((await $.command.run(provider('avatar'))).text).toBe('Avatar pane open.')
  expect(state.opened).toEqual(['model-relay-avatar'])

  // open but waiting undrawn on a narrow terminal: the command asks for it again instead of closing it
  pane = { isPlaced: false }
  expect((await $.command.run(provider('avatar'))).text).toBe('Avatar pane open.')
  expect(state.opened).toHaveLength(2)
  expect(closed).toEqual([])

  pane = { isPlaced: true }
  expect((await $.command.run(provider('avatar'))).text).toBe('Avatar pane closed.')
  expect(closed).toEqual(['model-relay-avatar'])
  expect(state.opened).toHaveLength(2)
})
