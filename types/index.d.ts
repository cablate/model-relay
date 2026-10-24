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

// One persona's picture from the config's "avatars": the image path as written, and the square of it that is the head
// (centre x, centre y, side, in source pixels) when the config gives one
export type AvatarEntry = { image: string; head: [number, number, number] | null }

// full: the whole image fitted into the box; head: the head square fitted into it
export type AvatarMode = 'full' | 'head'

// unset: the persona has no entry in "avatars"; failed: ffmpeg or the image did not give pixels
export type AvatarError = 'unset' | 'failed'

// What the avatar pane draws: the last finished conversion, with everything it was made from, so what is drawn always
// belongs together. cells (cols x rows, packed as a Raster's) is null while there is none or when it could not be made.
export type AvatarView = {
  name: string // 'claude' or a provider name
  label: string // provider name and model id
  entry: AvatarEntry | null
  mode: AvatarMode
  cols: number
  rows: number
  cells: string | null
  error: AvatarError | null
}

declare module 'claude-code' {
  interface PluginState {
    'model-relay': {
      panelUi: PanelUi
      panelData: PanelData | null
      avatarView: Shaped<AvatarView>
    }
  }
}
