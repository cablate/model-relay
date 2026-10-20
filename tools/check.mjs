#!/usr/bin/env node
// Runs all repository checks: syntax check, router tests, hook logic tests, the neutral-names gate, and the bilingual docs check.

import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

function step(label, cmd, args) {
  process.stdout.write(`==> ${label} ... `)
  execFileSync(cmd, args, { cwd: root, stdio: 'inherit' })
}

for (const f of ['router/logic.js', 'router/router.js', 'router/pki.js', 'router/ping.js', 'router/migrate.js']) step(`Syntax check (${f})`, process.execPath, ['--check', f])
step('Router unit tests', process.execPath, ['--test', 'router/logic.test.js', 'router/pki.test.js', 'router/failover.test.js', 'router/ping.test.js', 'router/migrate.test.js'])
step('Router end-to-end tests (HTTPS proxy, setup CLI, install flow)', process.execPath, ['--test', 'router/router-proxy.test.js', 'router/setup-proxy.test.js', 'router/setup-config.test.js', 'router/stream.test.js', 'router/router-diagnostics.test.js', 'router/install-flow.test.js'])
step('Hook logic tests (plain Node)', process.execPath, ['tools/test-hooks.mjs'])
step('No provider named outside legacy blocks', process.execPath, ['tools/neutral.mjs'])
step('Bilingual docs check', process.execPath, ['tools/docs.mjs', 'check'])
console.log('All checks passed.')
