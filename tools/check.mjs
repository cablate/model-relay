#!/usr/bin/env node
// Runs all repository checks: syntax check, router tests, hook logic tests, the neutral-names gate, and the bilingual docs check.

import { execFileSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

function step(label, cmd, args) {
  process.stdout.write(`==> ${label} ... `)
  execFileSync(cmd, args, { cwd: root, stdio: 'inherit' })
}

// Every file is found, not listed, so a new test or tool is never skipped by forgetting to add it here
const files = (dir, re) => readdirSync(path.join(root, dir)).filter((f) => re.test(f)).sort().map((f) => `${dir}/${f}`)
for (const f of [...files('router', /^(?!.*\.test\.js$).*\.js$/), ...files('tools', /\.mjs$/)]) step(`Syntax check (${f})`, process.execPath, ['--check', f])
step('Router tests (logic, HTTPS proxy, setup CLI, install flow)', process.execPath, ['--test', ...files('router', /\.test\.js$/)])
step('Hook logic tests (plain Node)', process.execPath, ['tools/test-hooks.mjs'])
step('No provider named outside legacy blocks', process.execPath, ['tools/neutral.mjs'])
step('Bilingual docs check', process.execPath, ['tools/docs.mjs', 'check'])
console.log('All checks passed.')
