#!/usr/bin/env node
// Runs the hook logic tests (hooks/*.test.ts, and tools/hooks-host.mjs) with plain Node, so CI checks them without Claude Code installed.
// Node strips the TypeScript types itself; tools/hooks-loader.mjs resolves the engine's imports. The panel (.tsx) is
// not loaded here: JSX needs the engine, and "claude plugin test" covers it.

import '../router/test-env.js'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const loader = pathToFileURL(path.join(root, 'tools', 'hooks-loader.mjs')).href
const hook = `data:text/javascript,import { register } from "node:module"; register(${JSON.stringify(loader)})`
const tests = fs.readdirSync(path.join(root, 'hooks')).filter((f) => f.endsWith('.test.ts')).map((f) => path.join('hooks', f))
// register.ts against a stand-in host: plain Node only (it builds its own `$`), so it lives outside hooks/, where
// "claude plugin test" would take it for one of its own tests
tests.push(path.join('tools', 'hooks-host.mjs'))

execFileSync(process.execPath, ['--experimental-strip-types', '--disable-warning=ExperimentalWarning', '--import', hook, '--test', ...tests], { cwd: root, stdio: 'inherit' })
