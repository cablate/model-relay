// Interactive AbovePrompt panel for model-relay (/provider or /provider panel).
// Pure view function: receives resolved UI elements, snapshot data, and action callbacks.
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
  const aliases = v.aliases ?? {}
  const aliasPairs = Object.entries(aliases)
    .filter(([, p]) => v.providers[p])
    .map(([slot, p]) => `${slot} → ${p} (${v.providers[p]})`)
  const aliasText = aliasPairs.length > 0
    ? aliasPairs.join(en ? ', ' : '、')
    : (en ? 'none (all tiers on main)' : '無（全走主線）')

  const subtitle = !v.online
    ? (en
        ? (v.direct ? 'Relay offline · Temporarily connected directly to Claude' : 'Relay offline · Auto-restarting every 10s…')
        : (v.direct ? '轉發站離線・主線暫時直連 Claude' : '轉發站離線・每 10 秒自動重啟中…'))
    : v.failoverSince
      ? (en
          ? `Claude 429 limit active · Failover → ${foText} · Retry in ~${mins}m`
          : `Claude 429 額度冷卻中・自動備援 → ${foText}・約 ${mins} 分鐘後重試`)
      : (en
          ? `Aliases: ${aliasText} · Pinned chats: ${v.sessionsOnCustom}`
          : `別名分流：${aliasText}・固定中對話：${v.sessionsOnCustom}`)

  const isClaudeActive = v.session === 'claude'
  const claudeRow = (
    <Box key="route:claude">
      <Box flexGrow={1}>
        <Text>
          <Text color={isClaudeActive ? 'green' : 'gray'} bold>
            {isClaudeActive ? (en ? '● Active ' : '● 使用中') : (en ? '○ Ready  ' : '○ 待命  ')}
          </Text>{' '}
          <Text bold={isClaudeActive}>claude</Text>{' '}
          <Text dimColor>
            {en ? '· Anthropic Claude (main subscription / OAuth)' : '· Anthropic Claude（預設主線）'}
          </Text>
        </Text>
      </Box>
      {isClaudeActive
        ? <Text dimColor>{en ? 'Current' : '目前路由'}</Text>
        : v.confirmingClaude
          ? [
              <Button
                key="confirm-claude"
                label={en ? 'Confirm (rebuilds cache)' : '確定切回（重建快取）'}
                variant="primary"
                onPress={() => act.switchTo('claude')}
              />,
              <Button
                key="cancel-claude"
                label={en ? 'Cancel' : '取消'}
                onPress={() => act.askClaude(false)}
              />,
            ]
          : (
            <Button
              key="btn:claude"
              label={en ? 'Switch [1]' : '切換 [1]'}
              hotkey="1"
              onPress={() => act.askClaude(true)}
            />
          )}
    </Box>
  )

  const providerEntries = Object.entries(v.providers)

  // One row per switch: what it is, whether it is on, and what flipping it does. failover and retry apply on the
  // router's next request; the proxy rewrites settings.json, so it asks first and only reaches new sessions.
  const sw = v.switches
  const chainText = v.failoverChain.length ? v.failoverChain.join(' → ') : (en ? 'nobody to hand over to' : '沒有接手者')
  const switchRow = (
    id: 'failover' | 'retry' | 'proxy',
    name: string,
    on: boolean,
    detail: string,
    button: ReturnType<typeof Button> | ReturnType<typeof Button>[] | null,
  ) => (
    <Box key={`switch:${id}`}>
      <Box flexGrow={1}>
        <Text>
          <Text color={on ? 'green' : 'gray'} bold>{on ? '● ' : '○ '}</Text>
          <Text bold>{name}</Text>{' '}
          <Text dimColor>{fit(`· ${detail}`, Math.max(20, inner - 30))}</Text>
        </Text>
      </Box>
      {button}
    </Box>
  )
  const flipLabel = (on: boolean, key: string) => (on ? (en ? `Turn off [${key}]` : `關閉 [${key}]`) : (en ? `Turn on [${key}]` : `開啟 [${key}]`))
  const proxyButton = !sw
    ? null
    : v.confirmingProxy
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
      : <Button key="btn:proxy" label={flipLabel(sw.proxy, 'x')} hotkey="x" onPress={() => act.askProxy(true)} />
  const switchRows = sw
    ? (
      <Box flexDirection="column" marginTop={1}>
        {switchRow(
          'failover',
          en ? '429 failover' : '429 備援',
          sw.failover,
          sw.failover
            ? (en ? `on (${chainText})` : `開啟（${chainText}）`)
            : (en ? 'off (429 returns error)' : '關閉（額度用完直接回報）'),
          <Button key="btn:failover" label={flipLabel(sw.failover, 'f')} hotkey="f" onPress={() => act.toggle('failover', !sw.failover)} />,
        )}
        {switchRow(
          'retry',
          en ? 'Retry' : '失敗重試',
          sw.retry,
          sw.retry
            ? (en ? 'on (backoff on 429/5xx)' : '開啟（429/5xx 自動退避重試）')
            : (en ? 'off (fail immediately)' : '關閉（出錯立即回報）'),
          <Button key="btn:retry" label={flipLabel(sw.retry, 't')} hotkey="t" onPress={() => act.toggle('retry', !sw.retry)} />,
        )}
        {switchRow(
          'proxy',
          en ? 'Remote Control' : '手機遙控',
          sw.proxy,
          sw.proxy
            ? (en ? 'on (HTTPS proxy · new sessions)' : '開啟（HTTPS 代理・新對話生效）')
            : (en ? 'off (base-URL mode)' : '關閉（一般 API 位址模式）'),
          proxyButton,
        )}
      </Box>
    )
    : null

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={ACCENT} paddingX={1}>
      <Box>
        <Box flexGrow={1}>
          <Text color={ACCENT} bold>model-relay</Text>
          <Text dimColor>
            {en ? ` · Model Router & 429 Failover (127.0.0.1:${v.port})` : `・模型路由與自動備援 (127.0.0.1:${v.port})`}
          </Text>
        </Box>
        <Button
          key="ping"
          label={v.pinging ? (en ? 'Pinging…' : '測速中…') : (en ? 'Ping [p]' : '測速 [p]')}
          hotkey="p"
          onPress={act.ping}
        />
        {v.failoverSince > 0
          ? (
            <Button
              key="probe"
              label={en ? 'Retry Claude [r]' : '重試 Claude [r]'}
              hotkey="r"
              onPress={act.probe}
            />
          )
          : null}
        <Button
          key="close"
          label={en ? 'Close' : '關閉'}
          role="dismiss"
          dimColor
          onPress={act.close}
        />
      </Box>

      <Box marginBottom={1}>
        <Text dimColor>{fit(subtitle, inner)}</Text>
      </Box>

      {v.note ? (
        <Box marginBottom={1}>
          <Text color="yellow">{fit(v.note, inner)}</Text>
        </Box>
      ) : null}

      {(v.hints ?? []).slice(0, 2).map((hint, i) => (
        <Box key={`hint:${i}`}>
          <Text color="yellow">{fit(`⚠ ${hint}`, inner)}</Text>
        </Box>
      ))}
      {providerEntries.length === 0 && v.online ? (
        <Box>
          <Text dimColor>{fit(en ? 'No provider is usable yet: every request goes to Claude; /provider setup adds one' : '還沒有可用的供應商：所有請求都走 Claude；/provider setup 可以新增', inner)}</Text>
        </Box>
      ) : null}

      <Box flexDirection="column">
        {claudeRow}
        {providerEntries.map(([name, model], idx) => {
          const active = v.session === name
          const foOn = sw ? sw.failover : true
          const foIdx = foOn ? v.failoverChain.indexOf(name) : -1
          const foBadge = foIdx === 0 && v.failoverChain.length === 1
            ? (en ? ' [429 failover]' : ' [429 備援]')
            : foIdx >= 0
              ? (en ? ` [429 failover #${foIdx + 1}]` : ` [429 備援 #${foIdx + 1}]`)
              : null
          const myAliases = Object.entries(aliases)
            .filter(([, target]) => target === name)
            .map(([slot]) => (en ? `${slot} alias` : `${slot} 別名`))
          const aliasBadge = myAliases.length > 0 ? ` [${myAliases.join(' · ')}]` : null
          // the last real request and the last test are shown apart: a long reply is not a slow provider
          const notes = [statText(v.stats[name], v.lang), pingText(v.ping?.[name], v.lang)].filter((x) => x !== null)
          const hk = String(idx + 2)
          return (
            <Box key={`route:${name}`}>
              <Box flexGrow={1}>
                <Text>
                  <Text color={active ? 'green' : 'gray'} bold>
                    {active ? (en ? '● Pinned ' : '● 固定中') : (en ? '○ Ready  ' : '○ 待命  ')}
                  </Text>{' '}
                  <Text bold={active}>{name.padEnd(8)}</Text>{' '}
                  <Text color={active ? ACCENT : undefined}>{model}</Text>
                  {aliasBadge ? <Text color="cyan">{aliasBadge}</Text> : null}
                  {foBadge ? <Text color="magenta">{foBadge}</Text> : null}
                  {notes.map((n, i) => <Text key={`note:${i}`} color={n.color}>{` · ${n.text}`}</Text>)}
                </Text>
              </Box>
              {active
                ? <Text dimColor>{en ? 'Pinned' : '目前固定'}</Text>
                : (
                  <Button
                    key={`btn:${name}`}
                    label={en ? `Use [${hk}]` : `切換 [${hk}]`}
                    hotkey={hk}
                    variant="primary"
                    onPress={() => act.switchTo(name)}
                  />
                )}
            </Box>
          )
        })}
      </Box>

      {switchRows}

      <Box marginTop={1}>
        <Text dimColor>
          {fit(
            en
              ? 'Tip: click a button, or ctrl+x tab then 1-9 to switch · p ping · f 429 failover · t retry · x Remote Control'
              : '提示：直接點按鈕，或按 ctrl+x tab 後按 1–9 切換・p 測速・f 429 備援・t 重試・x 手機遙控',
            inner,
          )}
        </Text>
      </Box>
    </Box>
  )
}
