// The avatar pane of model-relay: the picture of the model this window talks to, drawn as a Raster, with its name and a
// switch between the whole picture and the head. Pure view function, like panel.tsx: resolved elements, the view, actions.
import type { EngineInterface } from 'claude-code'
import type { AvatarView } from '../types'
import { fit } from './logic'

type Elements = ReturnType<EngineInterface['ui']['resolve']>

export type AvatarActions = {
  toggleMode: () => void
}

// Under the picture: the label, one row, and the mode switch, one more row, when the persona has a head square
// (avatarLabelRows in logic.ts is what the picture's box leaves for them)
export function avatarTree(ui: Elements, v: AvatarView, columns: number, lang: 'zh' | 'en', act: AvatarActions) {
  const { Box, Text, Button } = ui
  // Only the terminal draws a Raster; elsewhere the pane is the label alone
  const Raster = 'Raster' in ui ? ui.Raster : null
  const en = lang === 'en'
  if (!v.name) return <Box />

  const note =
    v.error === 'unset'
      ? (en
          ? `No picture for ${v.name} yet: add avatars.${v.name} to model-relay.json (see the README)`
          : `${v.name} 還沒有頭像：在 model-relay.json 加上 avatars.${v.name}（見 README）`)
      : v.error === 'failed'
        ? (en
            ? 'No picture: is ffmpeg on PATH, and does the image file exist?'
            : '做不出頭像：ffmpeg 在 PATH 上嗎？圖片檔存在嗎？')
        : null
  const modeLabel = v.mode === 'full' ? (en ? 'Head only' : '只看頭部') : (en ? 'Whole picture' : '看整張圖')

  return (
    <Box flexDirection="column">
      {Raster && v.cells && v.cols > 0 ? <Raster key="avatar" columns={v.cols} rows={v.rows} cells={v.cells} /> : null}
      {note ? <Text dimColor>{note}</Text> : null}
      <Text bold>{fit(v.label, columns)}</Text>
      {v.entry?.head
        ? <Box><Button key="avatar:mode" label={modeLabel} onPress={act.toggleMode} /></Box>
        : null}
    </Box>
  )
}
