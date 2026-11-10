'use strict'
// Tokens written as `keychain:<service>/<account>` live in the macOS login keychain. The router reads them in the
// background (readSecretAsync, kept by cachedReader), so no request ever waits on the keychain; the setup CLI only
// checks that an item exists (exists) and never reads a secret. The tool is named by its absolute path and run without
// a shell; the login keychain is named explicitly, and a keychain that would ask for a password fails after TIMEOUT_MS.
const os = require('os')
const path = require('path')
const cp = require('child_process')

const SECURITY = '/usr/bin/security'
const TIMEOUT_MS = 5000
const TOKEN_RE = /^[\x21-\x7e]+$/ // one line of printable ASCII, the only thing that can go into a header

const loginKeychain = () => path.join(os.homedir(), 'Library', 'Keychains', 'login.keychain-db')
const argv = (service, account, secret) => ['find-generic-password', '-s', service, '-a', account, ...(secret ? ['-w'] : []), loginKeychain()]
const OPTS = { timeout: TIMEOUT_MS, encoding: 'utf8', windowsHide: true }

// Resolves { token } or { why }; never rejects. The reason never quotes what the tool printed, which could be the secret.
function readSecretAsync(service, account) {
  return new Promise((resolve) => {
    const done = (e, stdout) => {
      if (e) {
        if (e.killed || e.signal) return resolve({ why: `no answer within ${TIMEOUT_MS / 1000}s (does the keychain ask for a password?)` })
        if (typeof e.code === 'number') return resolve({ why: `${SECURITY} exited ${e.code}${e.code === 44 ? ' (no such item)' : ''}` })
        return resolve({ why: (typeof e.code === 'string' && e.code) || 'could not run the keychain tool' })
      }
      const token = String(stdout).trim()
      resolve(TOKEN_RE.test(token) ? { token } : { why: 'the item does not hold a one-line token' })
    }
    try {
      cp.execFile(SECURITY, argv(service, account, true), OPTS, done)
    } catch (e) {
      done(e)
    }
  })
}

function exists(service, account) {
  try {
    cp.execFileSync(SECURITY, argv(service, account, false), { ...OPTS, stdio: 'pipe' })
    return true
  } catch {
    return false
  }
}

// The router's keychain resolver. get(service, account) never waits: it gives the token once a read has landed, else
// null. The first ask for an item starts its read and asks while it runs start nothing. A failed item is never read on a
// timer (a locked keychain would raise an unlock dialog every few minutes): it is read again on the first ask after
// stamp() has changed, which the router makes the state of model-relay.json, so editing the config retries it, and a
// restart starts over. log gets the item's name and the reason, never a token. reportable(u) keeps an unresolvedEnv entry
// unless its item is being read right now.
// ponytail: a rotated token that still reads ok needs a restart
function cachedReader(read = readSecretAsync, log = () => {}, stamp = () => '') {
  const items = new Map() // "service/account" -> {} while reading, { token }, or { failed: true, stamp }
  const get = (service, account) => {
    const ref = `${service}/${account}`
    const it = items.get(ref)
    if (it && it.token) return it.token
    if (!it || (it.failed && stamp() !== it.stamp)) {
      const at = stamp()
      items.set(ref, {})
      const land = (x) => {
        if (x && x.token) return items.set(ref, { token: x.token })
        log(`keychain item ${ref} could not be read (${(x && x.why) || 'no reason given'}); providers using it are skipped, and it is read again when model-relay.json changes or the router restarts`)
        items.set(ref, { failed: true, stamp: at })
      }
      read(service, account).then(land, () => land({ why: 'could not run the keychain tool' }))
    }
    return null
  }
  const reportable = (u) => u.keychain === undefined || !items.get(u.keychain) || Boolean(items.get(u.keychain).failed)
  return { get, reportable }
}

module.exports = { SECURITY, TIMEOUT_MS, readSecretAsync, exists, cachedReader }
