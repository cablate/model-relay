'use strict'
// Run from a second account's window, MODEL_RELAY_CONFIG_DIR and CLAUDE_CONFIG_DIR name the real relay dir, and a
// test that starts setup.mjs, the router or the launcher wrapper would write there (a backup, a rewritten settings.json,
// a handoff file) or leave a router running on it. Each such test file clears the variables itself (./test-env.js).
// This runs three of them as children with the variables pointing at a scratch "real" dir, and that dir must come
// out byte for byte as it went in, with no process left that was started on it.
require('./test-env')
const test = require('node:test')
const assert = require('node:assert')
const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

// the setup CLI (config, settings), a router started through setup.mjs, and the handoff written for the wrapper id
const FILES = ['setup-config.test.js', 'install-flow.test.js', 'account-router.test.js']

const snapshot = (dir) => {
  const out = []
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const p = path.join(d, e.name)
      if (e.isDirectory()) {
        out.push(`${path.relative(dir, p)}/`)
        walk(p)
      } else out.push(`${path.relative(dir, p)} ${crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex')}`)
    }
  }
  walk(dir)
  return out
}

test('a test file run with the real relay dir in the environment leaves that dir untouched and no router behind', () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'relay-envleak-')))
  try {
    const real = path.join(root, 'real')
    const [relay, ccd, home] = ['relay', 'ccd', 'home'].map((n) => path.join(real, n))
    for (const d of [relay, ccd, home]) fs.mkdirSync(d, { recursive: true })
    fs.writeFileSync(path.join(relay, 'model-relay.json'), JSON.stringify({ format: 2, port: 58941, providers: { mine: { token: 'env:ENVLEAK_KEY', model: 'm', baseUrl: 'https://mine.example' } }, failover: { chain: ['mine'] } }))
    fs.writeFileSync(path.join(relay, 'settings.json'), '{"permissions":{"allow":["ORIGINAL"]}}\n')
    fs.writeFileSync(path.join(ccd, 'settings.json'), '{}\n')
    const before = snapshot(real)
    const env = { ...process.env, HOME: home, USERPROFILE: home, MODEL_RELAY_CONFIG_DIR: relay, CLAUDE_CONFIG_DIR: ccd, MODEL_RELAY_WRAPPER_ID: '0f1e2d3c-4b5a-4968-8776-5a4b3c2d1e0f' }
    delete env.NODE_TEST_CONTEXT // else the child's node --test would report to this runner instead of running
    for (const f of FILES) {
      const r = spawnSync(process.execPath, ['--test', path.join(__dirname, f)], { env, encoding: 'utf8', timeout: 240000 })
      assert.strictEqual(r.status, 0, `${f} did not pass:\n${`${r.stdout}${r.stderr}`.slice(-1500)}`)
      assert.deepStrictEqual(snapshot(real), before, `${f} changed the dir the variables name`)
    }
    if (process.platform !== 'win32') {
      const ps = spawnSync('ps', ['-A', '-o', 'command='], { encoding: 'utf8' }).stdout
      const left = ps.split('\n').filter((l) => l.includes(path.basename(root)))
      assert.deepStrictEqual(left, [], 'a process started on the scratch dir is still running')
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})
