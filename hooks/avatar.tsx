// The avatar pane of model-relay: the head of the model this window talks to, drawn as a Raster, with its name under it.
// Pure view function, like panel.tsx: resolved elements and the view.
import type { EngineInterface } from 'claude-code'
import type { AvatarView } from '../types'
import { fit } from './logic'

type Elements = ReturnType<EngineInterface['ui']['resolve']>

// Under the picture: the label, one row (AVATAR_LABEL_ROWS in logic.ts is what the picture's box leaves for it)
export function avatarTree(ui: Elements, v: AvatarView, columns: number, lang: 'zh' | 'en') {
  const { Box, Text } = ui
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

  return (
    <Box flexDirection="column">
      {Raster && v.cells && v.cols > 0 ? <Raster key="avatar" columns={v.cols} rows={v.rows} cells={v.cells} /> : null}
      {note ? <Text dimColor>{note}</Text> : null}
      <Text bold>{fit(v.label, columns)}</Text>
    </Box>
  )
}
