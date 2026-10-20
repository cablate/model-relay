// Interactive AbovePrompt panel for model-relay (/provider).
// Pure view function: receives resolved UI elements, snapshot data, and action callbacks.
// It is for one thing, picking this window's model; what every window shares stays folded behind Settings [s].
import type { EngineInterface } from 'claude-code'
import type { PanelData, PanelUi } from '../types'
import { fit, pingText, statText } from './logic'

type Elements = ReturnType<EngineInterface['ui']['resolve']>

export type PanelView = PanelData & PanelUi & { columns: number }

export type PanelActions = {
  switchTo: (target: string) => void
  askClaude: (ask: boolean) => void
  ping: () => void
  probe: () => void
  settings: (show: boolean) => void
  toggle: (which: 'failover' | 'retry' | 'proxy', on: boolean) => void
  askProxy: (ask: boolean) => void
  close: () => void
}

const ACCENT = 'cyan'
const FRAME_CELLS = 4

export function panelTree(ui: Elements, v: PanelView, act: PanelActions) {
  const { Box, Text, Button } = ui
  const inner = Math.max(32, v.columns - FRAME_CELLS)
  const en = v.lang === 'en'

  const fo = v.failoverProvider
  const foText = fo ? `${fo} (${v.providers[fo] ?? fo})` : (en ? 'nobody to hand over to' : '沒有接手者')
  const mins = v.failoverSince ? Math.max(0, Math.round((v.nextClaudeTry - v.now) / 60000)) : 0
  const aliasPairs = Object.entries(v.aliases ?? {})
    .filter(([, p]) => v.providers[p])
    .map(([slot, p]) => `${slot} → ${p} (${v.providers[p]})`)

  // Only what changes where this window's requests go gets a line of its own
  const alert = !v.online
    ? (en
        ? (v.direct ? 'Relay offline: this window talks to Claude directly' : 'Relay offline: restarting every 10s…')
        : (v.direct ? '轉發站離線：這個視窗暫時直連 Claude' : '轉發站離線：每 10 秒自動重啟中…'))
    : v.failoverSince
      ? (en
          ? `Claude limit reached: requests go to ${foText}; Claude again in ~${mins}m`
          : `Claude 額度用完：請求改走 ${foText}，約 ${mins} 分鐘後再試 Claude`)
      : null

  const inUse = <Text dimColor>{en ? 'In use' : '使用中'}</Text>
  const mark = (active: boolean) => <Text color={active ? 'green' : 'gray'} bold>{active ? '● ' : '○ '}</Text>

  const isClaudeActive = v.session === 'claude'
  const claudeRow = (
    <Box key="route:claude">
      <Box flexGrow={1}>
        <Text>
          {mark(isClaudeActive)}
          <Text bold={isClaudeActive}>{'claude'.padEnd(8)}</Text>{' '}
          <Text dimColor>Anthropic Claude</Text>
        </Text>
      </Box>
      {isClaudeActive
        ? inUse
        : v.confirmingClaude
          ? [
              <Button
                key="confirm-claude"
                label={en ? 'Confirm (rebuilds cache)' : '確定切回（重建快取）'}
                variant="primary"
                onPress={() => act.switchTo('claude')}
              />,
              <Button key="cancel-claude" label={en ? 'Cancel' : '取消'} onPress={() => act.askClaude(false)} />,
            ]
          : <Button key="btn:claude" label={en ? 'Use [1]' : '切換 [1]'} hotkey="1" onPress={() => act.askClaude(true)} />}
    </Box>
  )

  const providerRows = Object.entries(v.providers).map(([name, model], idx) => {
    const active = v.session === name
    // the last real request and the last test are shown apart: a long reply is not a slow provider
    const notes = [statText(v.stats[name], v.lang), pingText(v.ping?.[name], v.lang)].filter((x) => x !== null)
    const hk = String(idx + 2)
    return (
      <Box key={`route:${name}`}>
        <Box flexGrow={1}>
          <Text>
            {mark(active)}
            <Text bold={active}>{name.padEnd(8)}</Text>{' '}
            <Text color={active ? ACCENT : undefined}>{model}</Text>
            {notes.map((n, i) => <Text key={`note:${i}`} color={n.color}>{` · ${n.text}`}</Text>)}
          </Text>
        </Box>
        {active
          ? inUse
          : <Button key={`btn:${name}`} label={en ? `Use [${hk}]` : `切換 [${hk}]`} hotkey={hk} variant="primary" onPress={() => act.switchTo(name)} />}
      </Box>
    )
  })

  // One row per switch: what it is, whether it is on, and what flipping it does. failover and retry apply on the
  // router's next request; the proxy rewrites settings.json, so it asks first and only reaches new sessions.
  const sw = v.switches
  const chainText = v.failoverChain.length ? v.failoverChain.join(' → ') : (en ? 'nobody to hand over to' : '沒有接手者')
  const switchRow = (
    id: 'failover' | 'retry' | 'proxy',
    name: string,
    on: boolean,
    detail: string,
    button: ReturnType<typeof Button> | ReturnType<typeof Button>[],
  ) => (
    <Box key={`switch:${id}`}>
      <Box flexGrow={1}>
        <Text>
          {mark(on)}
          <Text bold>{name}</Text>{' '}
          <Text dimColor>{fit(`· ${detail}`, Math.max(20, inner - 30))}</Text>
        </Text>
      </Box>
      {button}
    </Box>
  )
  const flipLabel = (on: boolean, key: string) => (on ? (en ? `Turn off [${key}]` : `關閉 [${key}]`) : (en ? `Turn on [${key}]` : `開啟 [${key}]`))
  const hasSettings = !!sw || aliasPairs.length > 0
  const settings = v.showSettings && hasSettings
    ? (
      <Box flexDirection="column" marginTop={1}>
        <Text bold>{en ? 'Shared by every window' : '所有視窗共用'}</Text>
        {sw
          ? [
              switchRow(
                'failover',
                en ? '429 failover' : '429 備援',
                sw.failover,
                sw.failover ? (en ? `on (${chainText})` : `開啟（${chainText}）`) : (en ? 'off (429 returns error)' : '關閉（額度用完直接回報）'),
                <Button key="btn:failover" label={flipLabel(sw.failover, 'f')} hotkey="f" onPress={() => act.toggle('failover', !sw.failover)} />,
              ),
              switchRow(
                'retry',
                en ? 'Retry' : '失敗重試',
                sw.retry,
                sw.retry ? (en ? 'on (backoff on 429/5xx)' : '開啟（429/5xx 自動退避重試）') : (en ? 'off (fail immediately)' : '關閉（出錯立即回報）'),
                <Button key="btn:retry" label={flipLabel(sw.retry, 't')} hotkey="t" onPress={() => act.toggle('retry', !sw.retry)} />,
              ),
              switchRow(
                'proxy',
                en ? 'Remote Control' : '手機遙控',
                sw.proxy,
                sw.proxy ? (en ? 'on (HTTPS proxy · new sessions)' : '開啟（HTTPS 代理・新對話生效）') : (en ? 'off (base-URL mode)' : '關閉（一般 API 位址模式）'),
                v.confirmingProxy
                  ? [
                      <Button
                        key="confirm-proxy"
                        label={sw.proxy
                          ? (en ? 'Confirm (running remote sessions drop)' : '確定關閉（執行中的遙控對話會斷線）')
                          : (en ? 'Confirm (edits settings.json)' : '確定開啟（會改 settings.json）')}
                        variant="primary"
                        onPress={() => act.toggle('proxy', !sw.proxy)}
                      />,
                      <Button key="cancel-proxy" label={en ? 'Cancel' : '取消'} onPress={() => act.askProxy(false)} />,
                    ]
                  : <Button key="btn:proxy" label={flipLabel(sw.proxy, 'x')} hotkey="x" onPress={() => act.askProxy(true)} />,
              ),
            ]
          : null}
        {aliasPairs.length > 0
          ? <Text dimColor>{fit(`${en ? 'Aliases: ' : '別名分流：'}${aliasPairs.join(en ? ', ' : '、')}`, inner)}</Text>
          : null}
      </Box>
    )
    : null

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={ACCENT} paddingX={1}>
      <Box>
        <Box flexGrow={1}>
          <Text color={ACCENT} bold>model-relay</Text>
          <Text dimColor>{en ? " · this window's model" : '・這個視窗用哪個模型'}</Text>
        </Box>
        <Button key="ping" label={v.pinging ? (en ? 'Testing…' : '測速中…') : (en ? 'Ping [p]' : '測速 [p]')} hotkey="p" onPress={act.ping} />
        {v.failoverSince > 0
          ? <Button key="probe" label={en ? 'Retry Claude [r]' : '重試 Claude [r]'} hotkey="r" onPress={act.probe} />
          : null}
        {hasSettings
          ? (
            <Button
              key="settings"
              label={v.showSettings ? (en ? 'Hide settings [s]' : '收起設定 [s]') : (en ? 'Settings [s]' : '設定 [s]')}
              hotkey="s"
              onPress={() => act.settings(!v.showSettings)}
            />
          )
          : null}
        <Button key="close" label={en ? 'Close' : '關閉'} role="dismiss" dimColor onPress={act.close} />
      </Box>

      {alert ? <Text color="yellow">{fit(alert, inner)}</Text> : null}
      {v.note ? <Text color={v.note.ok ? 'green' : 'yellow'}>{fit(v.note.text, inner)}</Text> : null}
      {(v.hints ?? []).slice(0, 2).map((hint, i) => (
        <Text key={`hint:${i}`} color="yellow">{fit(`⚠ ${hint}`, inner)}</Text>
      ))}
      {providerRows.length === 0 && v.online
        ? <Text dimColor>{fit(en ? 'No provider is usable yet: every request goes to Claude; /provider setup adds one' : '還沒有可用的供應商：所有請求都走 Claude；/provider setup 可以新增', inner)}</Text>
        : null}

      <Box flexDirection="column" marginTop={1}>
        {claudeRow}
        {providerRows}
      </Box>

      {settings}

      <Box marginTop={1}>
        <Text dimColor>{fit(en ? 'Keyboard: ctrl+x tab, then the key shown on a button' : '鍵盤：先按 ctrl+x tab，再按按鈕上標的鍵', inner)}</Text>
      </Box>
    </Box>
  )
}
