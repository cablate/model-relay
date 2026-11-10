'use strict'
// Required first by every test file that starts setup.mjs, the router or the launcher wrapper. Run from a second
// account's window, these variables name the real relay dir, and what such a test starts would write there; a test
// that needs one of them sets it itself.
for (const k of ['MODEL_RELAY_CONFIG_DIR', 'CLAUDE_CONFIG_DIR', 'MODEL_RELAY_WRAPPER_ID']) delete process.env[k]
