#!/usr/bin/env node
// The code that runs for every user names no provider of its own: no built-in model, no private gateway, no older file
// name. What migrate has to know about older configs sits between "legacy:begin" and "legacy:end" lines, so it stays in
// one place and can be deleted whole. This gate fails on any such word outside them, and on a block never closed.

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const self = path.basename(fileURLToPath(import.meta.url))

const RULES = [
  [/custom-agent/, 'the older file name'],
  [/['"`](glm|gemini|magpie)['"`]/, 'a provider name used as a built-in default'],
  [/[a-z0-9](Glm|Gemini|Magpie)/, 'a provider name inside an identifier'],
  [/127\.0\.0\.1:3425/, 'a private gateway address'],
]

// Returns [{ line, why, text }] for one file's text
export function scan(text) {
  const found = []
  let open = 0 // line number of the "legacy:begin" being inside, or 0
  text.split(/\r?\n/).forEach((t, i) => {
    const line = i + 1
    if (/legacy:begin/.test(t)) {
      if (open) found.push({ line, why: `a legacy block opened inside the one from line ${open}`, text: t })
      open = line
      return
    }
    if (/legacy:end/.test(t)) {
      if (!open) found.push({ line, why: 'legacy:end without legacy:begin', text: t })
      open = 0
      return
    }
    if (open) return
    for (const [re, why] of RULES) if (re.test(t)) found.push({ line, why, text: t })
  })
  if (open) found.push({ line: open, why: 'legacy:begin is never closed, which would exempt the rest of the file', text: '' })
  return found
}

// The gate proves it still catches what it is for before it is trusted with the repository
const planted = ["const a = 'glm'", 'n = j.sessionsOnGlm', '// legacy:begin', "const b = 'glm'", '// legacy:end', '// legacy:begin', 'custom-agent'].join('\n')
const caught = scan(planted).map((f) => f.line).join()
if (caught !== '1,2,6') {
  console.error(`neutral.mjs is broken: on the planted sample it reported lines [${caught}], not [1,2,6]`)
  process.exit(1)
}

const files = [
  ...['router', 'hooks', 'types'].flatMap((d) => fs.readdirSync(path.join(root, d)).map((f) => path.join(d, f))),
  ...fs.readdirSync(path.join(root, 'tools')).map((f) => path.join('tools', f)),
].filter((f) => /\.(js|mjs|ts|tsx)$/.test(f) && !/\.test\.(js|ts)$/.test(f) && path.basename(f) !== self)

let bad = 0
for (const f of files) {
  for (const x of scan(fs.readFileSync(path.join(root, f), 'utf8'))) {
    bad++
    console.error(`${f.replace(/\\/g, '/')}:${x.line}: ${x.why}${x.text ? `: ${x.text.trim()}` : ''}`)
  }
}
if (bad) {
  console.error(`${bad} line(s) above name a provider outside a legacy block; move the value into the config, or mark it legacy.`)
  process.exit(1)
}
console.log(`neutral: ${files.length} files, nothing outside legacy blocks`)
