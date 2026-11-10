'use strict'
// What setup.mjs and the launcher wrapper print for the shell the person pastes it into, as a test on this machine
// expects it: PowerShell on Windows, else POSIX sh. Written out here and not imported, so a test checks the printed
// text against the documented command and does not repeat the code that made it. A test that runs setup.mjs with a
// stand-in platform (globalThis.__modelRelayTestPlatform) writes its own strings.
const win = process.platform === 'win32'
const sh = (s) => (/^[A-Za-z0-9_./:=@%+,-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`)
const ps = (s) => (/^[A-Za-z0-9_./\\:-]+$/.test(s) && !s.startsWith('-') ? s : `'${s.replace(/'/g, "''")}'`)
const psq = (s) => `'${s.replace(/'/g, "''")}'` // always quoted, as the link command does

// sh and ps quote one word of a command the way setup.mjs does: left bare when it is plain, else in single quotes
// The account's own Claude Code, started in its folder and pointed at the relay
const loginCmd = (dir, relay) => (win
  ? `$env:CLAUDE_CONFIG_DIR=${ps(dir)}; $env:MODEL_RELAY_CONFIG_DIR=${ps(relay)}; claude   (in a new PowerShell window: the variables stay set in it)`
  : `CLAUDE_CONFIG_DIR=${sh(dir)} MODEL_RELAY_CONFIG_DIR=${sh(relay)} claude`)

// The command that makes folder `to` a link to folder `from`
const linkCmd = (from, to) => (win ? `New-Item -ItemType SymbolicLink -Path ${psq(to)} -Target ${psq(from)}` : `ln -s ${sh(from)} ${sh(to)}`)

module.exports = { loginCmd, linkCmd, sh, ps, win }
