import { expect, test } from 'claude-code/testing'
import type { On } from 'claude-code'
import { base64ToBytes, bytesToBase64 } from './logic'

const PANE = { plugin: 'model-relay', component: 'Pane', requestId: 'model-relay-avatar', surface: 'terminal' } as const
const props = { title: 'model-relay avatar', isFocused: false, bodyColumns: 24, placement: 'dock', scroll: { offset: 0, bodyRows: 7 }, view: {} } as const
const config = { format: 2, port: 8950, avatars: { claude: 'pics/c.png', aaa: { image: 'pics/a.png', head: [4, 4, 6] } } }
const provider = (args: string) => ({ command: 'provider', args, origin: { kind: 'composer' as const }, presentation: { isFullscreen: true, columns: 100 } })

// White samples, but see-through over the first cell and over the upper half of every cell in the first row after it:
// the first cell has nothing to draw, the cells after it only their lower half
function seeThrough(w: number, h: number): Uint8Array {
  const rgba = new Uint8Array(w * h * 4).fill(255)
  for (let y = 0; y < 8; y++) for (let x = 0; x < w; x++) if (x < 8 || y < 4) rgba[(y * w + x) * 4 + 3] = 0
  return rgba
}

// What stands beneath the plugin: the config, a router that answers for this window, and an ffmpeg that writes the
// samples of the size its filter asks for
function beneath(on: On, state: { session: string; config: unknown; opened: string[]; columns: (number | undefined)[]; ffmpeg: string[][]; missing: boolean }) {
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
    state.columns.push(e.columns)
    return { value: { isPlaced: true } }
  })
  on('fs.write', () => ({ value: undefined }))
  on('fs.read', (_$, e) => ({ value: e.as === 'bytes' ? { base64: bytesToBase64(seeThrough(box.w, box.h)) } : JSON.stringify(state.config) }))
  on('process.run', (_$, e) => {
    if (e.argv[0] === 'ffmpeg') {
      state.ffmpeg.push([...e.argv])
      const [, w, h] = /scale=(\d+):(\d+):flags=area,unsharp/.exec(e.argv[e.argv.indexOf('-vf') + 1] ?? '') ?? []
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

const newState = () => ({ session: 'claude', config: structuredClone(config) as unknown, opened: [] as string[], columns: [] as (number | undefined)[], ffmpeg: [] as string[][], missing: false })

test('the pane draws the picture of the model this window talks to, and swaps it when the window switches', async ($, on) => {
  const state = newState()
  beneath(on, state)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  expect(state.opened).toEqual(['model-relay-avatar'])
  expect(state.columns).toEqual([80]) // a wide dock: the engine keeps it to 45% of the terminal

  const ui = await $.ui.mount({ ...PANE, props })
  const raster = await ui.find({ key: 'avatar' })
  expect(raster?.type).toBe('Raster')
  expect(raster?.props.columns).toBe(24)
  expect(raster?.props.rows).toBe(6)
  // 24 x 6 cells, a triplet of u32 each
  const cells = new DataView(base64ToBytes(String(raster?.props.cells)).buffer)
  expect(cells.byteLength).toBe(24 * 6 * 12)
  // nothing in the first cell (a blank), only the lower half in the next (a lower half block), all of it in the row below
  expect([0, 12, 24 * 12].map((at) => cells.getUint32(at, true))).toEqual([0x20, 0x2584, 0x2588])
  expect([16, 20].map((at) => cells.getUint32(at, true))).toEqual([0xffffff, 0x01000000]) // white on the terminal's own background
  expect((await ui.find({ type: 'Text', text: 'Claude' }))?.text).toBe('Claude')
  expect(await ui.find({ key: 'avatar:mode' })).toBeUndefined()
  expect(state.ffmpeg).toHaveLength(1)
  expect(state.ffmpeg[0]?.[state.ffmpeg[0].indexOf('-i') + 1]).toBe('/.claude/pics/c.png')
  // Claude has no head square: the whole picture, 10 x 20 pixels a cell, then 8 x 8 samples a cell
  expect(state.ffmpeg[0]?.[state.ffmpeg[0].indexOf('-vf') + 1]).toMatch(/^scale=240:120:.*,scale=192:48:flags=area,unsharp/)

  // /provider aaa: this window now talks to aaa, whose entry has a head square: the head, in the box's shape (24 x 6
  // cells is 240 x 120 pixels, so the 6-square flattens to its floor, 5 tall, and grows to 10 wide)
  state.session = 'aaa'
  await $.command.run(provider('aaa'))
  expect((await ui.find({ type: 'Text', text: 'aaa · aaa-9' }))?.text).toBe('aaa · aaa-9')
  expect((await ui.find({ key: 'avatar' }))?.props.rows).toBe(6)
  expect(state.ffmpeg).toHaveLength(2)
  expect(state.ffmpeg[1]?.[state.ffmpeg[1].indexOf('-i') + 1]).toBe('/.claude/pics/a.png')
  expect(state.ffmpeg[1]?.[state.ffmpeg[1].indexOf('-vf') + 1]).toMatch(/^crop=w='min\(10,iw\)':h='min\(5,ih\)':x='max\(0,min\(4-ow\/2,iw-ow\)\)':y='max\(0,min\(4-oh\/2,ih-oh\)\)',scale=240:120:/)
  expect(await ui.find({ key: 'avatar:mode' })).toBeUndefined()

  // nothing changed since: no more conversions however often the pane draws
  await $.command.run(provider('aaa'))
  await ui.unmount()
  const again = await $.ui.mount({ ...PANE, props })
  expect(await again.find({ key: 'avatar' })).toBeDefined()
  expect(state.ffmpeg).toHaveLength(2)

  // back to Claude: the picture made a moment ago is drawn again without ffmpeg
  state.session = 'claude'
  await $.command.run(provider('claude'))
  expect((await again.find({ type: 'Text', text: 'Claude' }))?.text).toBe('Claude')
  expect(await again.find({ key: 'avatar' })).toBeDefined()
  expect(state.ffmpeg).toHaveLength(2)
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

test('the engine takes every glyph the cells can hold', async ($, on) => {
  // The block glyphs glyphCells chooses from, and the ones that stand in for them when a see-through part has to be the background
  const glyphs = [0x20, ...Array.from({ length: 16 }, (_, i) => 0x2580 + i), 0x2590, 0x2594, 0x2595, ...Array.from({ length: 10 }, (_, i) => 0x2596 + i)]
  const words = new Uint32Array(glyphs.flatMap((cp) => [cp, 0xff8000, 0x01000000]))
  on('ui.render', { component: 'Pane', requestId: 'glyph-check' }, ($$, e) => {
    const ui = $$.ui.resolve(e)
    return 'Raster' in ui ? <ui.Raster key="check" columns={glyphs.length} rows={1} cells={bytesToBase64(new Uint8Array(words.buffer))} /> : <ui.Box />
  })
  const ui = await $.ui.mount({ ...PANE, requestId: 'glyph-check', props })
  expect((await ui.find({ key: 'check' }))?.type).toBe('Raster')
  await ui.unmount()
})
