#!/usr/bin/env node
// Runs the hook logic tests (hooks/*.test.ts) with plain Node, so CI checks them without Claude Code installed.
// Node strips the TypeScript types itself; tools/hooks-loader.mjs resolves the engine's imports. The panel (.tsx) is
// not loaded here: JSX needs the engine, and "claude plugin test" covers it.

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const loader = pathToFileURL(path.join(root, 'tools', 'hooks-loader.mjs')).href
const hook = `data:text/javascript,import { register } from "node:module"; register(${JSON.stringify(loader)})`
const tests = fs.readdirSync(path.join(root, 'hooks')).filter((f) => f.endsWith('.test.ts')).map((f) => path.join('hooks', f))

execFileSync(process.execPath, ['--experimental-strip-types', '--disable-warning=ExperimentalWarning', '--import', hook, '--test', ...tests], { cwd: root, stdio: 'inherit' })
