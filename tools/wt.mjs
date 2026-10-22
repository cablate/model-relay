#!/usr/bin/env node
// 改正在被熱重載的 mod：在暫存 worktree 改完、驗完，再 fast-forward 回主資料夾（合併那一刻所有 session 才換新版）。
// 用法：
//   node tools/wt.mjs new <分支>     建 worktree（系統暫存資料夾），複製型別檔，印出路徑
//   node tools/wt.mjs land <分支>    worktree 必須已 commit；跑 tools/check.mjs，通過才 ff-merge 回主資料夾並清掉 worktree
//   node tools/wt.mjs drop <分支>    不合併，直接丟掉 worktree 與分支
import { execFileSync, spawnSync } from 'node:child_process'
import { cpSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const [cmd, branch] = process.argv.slice(2)
if (!['new', 'land', 'drop'].includes(cmd) || !branch) { console.error('用法：node tools/wt.mjs new|land|drop <分支>'); process.exit(2) }
const here = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
const main = dirname(resolve(here, git(here, 'rev-parse', '--git-common-dir')))
const path = join(tmpdir(), 'model-relay-wt', branch).replace(/\\/g, '/')

if (cmd === 'new') {
  if (existsSync(path)) { console.error(`已存在：${path}`); process.exit(1) }
  git(main, 'worktree', 'add', '-b', branch, path)
  const types = join(main, '.claude-plugin', 'types')
  if (existsSync(types)) cpSync(types, join(path, '.claude-plugin', 'types'), { recursive: true })
  else console.log('注意：主資料夾沒有 .claude-plugin/types（mod 還沒載入過），tsc 會略過')
  console.log(`worktree：${path}\n改完 commit 後：node tools/wt.mjs land ${branch}（不合併就 node tools/wt.mjs drop ${branch}）`)
} else if (cmd === 'land') {
  if (!existsSync(path)) { console.error(`沒有這個 worktree：${path}`); process.exit(1) }
  const dirty = git(path, 'status', '--porcelain').split('\n').filter(l => l && !l.includes('.claude-plugin/types'))
  if (dirty.length) { console.error(`worktree 還有沒 commit 的變更：\n${dirty.join('\n')}`); process.exit(1) }
  const mainDirty = git(main, 'status', '--porcelain')
  if (mainDirty) { console.error(`主資料夾有未提交的變更，先處理：\n${mainDirty}`); process.exit(1) }
  const mainHead = git(main, 'rev-parse', 'HEAD')
  if (git(path, 'merge-base', mainHead, branch) !== mainHead) {
    console.log('主分支已前進，先在 worktree 自動 rebase…')
    git(path, 'rebase', mainHead)
  }
  const check = spawnSync(process.execPath, [join(path, 'tools', 'check.mjs')], { stdio: 'inherit' })
  if (check.status !== 0) { console.error('檢查沒過，不合併'); process.exit(1) }
  git(main, 'merge', '--ff-only', branch)
  git(main, 'worktree', 'remove', '--force', path)
  git(main, 'branch', '-d', branch)
  console.log(`已 fast-forward 到 ${git(main, 'log', '--oneline', '-1')}；開著的 session 會在下一刻熱重載`)
} else {
  if (!existsSync(path)) { console.error(`沒有這個 worktree：${path}`); process.exit(1) }
  git(main, 'worktree', 'remove', '--force', path)
  git(main, 'branch', '-D', branch)
  console.log(`已丟掉 ${branch} 與它的 worktree（沒有合併）`)
}
