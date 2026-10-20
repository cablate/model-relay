export type ProviderStat = {
  status: number
  ms: number
  at: number
}

// The last test of a provider (/provider ping): ok | key | model | quota | not-running | unreachable | timeout | error
export type PingStat = {
  verdict: string
  status: number
  firstByteMs: number
  at: number
  detail: string
}

export type PanelData = {
  online: boolean
  direct: boolean
  port: number
  session: string // 'claude' or provider name
  failoverProvider: string | null // null when failover has nobody to hand over to
  failoverSince: number
  nextClaudeTry: number
  sessionsOnCustom: number
  providers: Record<string, string>
  aliases: Record<string, string>
  failoverChain: string[]
  // The router's own view of its switches; null when it is offline or too old to report them
  switches: { failover: boolean; retry: boolean; proxy: boolean; proxyReady: boolean } | null
  stats: Record<string, ProviderStat>
  ping: Record<string, PingStat>
  hints: string[] // things to act on: an older config, a provider the router skips
  lang: 'zh' | 'en'
  now: number
}

// What the last panel action came to: green when it did what was asked, yellow when it did not
export type PanelNote = { text: string; ok: boolean }

export type PanelUi = {
  open: boolean
  confirmingClaude: boolean
  confirmingProxy?: boolean
  pinging: boolean
  // The switches every window shares stay folded away until asked for: the panel is for this window's model
  showSettings?: boolean
  note?: PanelNote
}

declare module 'claude-code' {
  interface PluginState {
    'model-relay': {
      panelUi: PanelUi
      panelData: PanelData | null
    }
  }
}
