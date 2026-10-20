'use strict'
// One upstream test shared by the router's /__ping and "setup.mjs doctor --ping": can this provider answer, and how
// soon does its answer start. It sends a 1-token streaming request and stops at the first byte, within 15 seconds.
const http = require('http')
const https = require('https')
const net = require('net')
const L = require('./logic')

const LIMIT_MS = 15000

// The headers a provider authenticates with; whatever Claude Code sent for Anthropic is dropped
function authHeaders(provider, base = {}) {
  const headers = { ...base }
  delete headers['x-api-key']
  delete headers['authorization']
  if (provider.authHeader === 'bearer' || provider.authHeader === 'both') headers['authorization'] = `Bearer ${provider.token}`
  if (provider.authHeader === 'x-api-key' || provider.authHeader === 'both') headers['x-api-key'] = provider.token
  return headers
}

// What an answer means for the person: ok | key | model | quota | not-running | unreachable | timeout | error
function verdict(status, bodyText, errCode) {
  if (errCode === 'timeout') return 'timeout'
  if (errCode) return errCode === 'ECONNREFUSED' ? 'not-running' : 'unreachable'
  if (status >= 200 && status < 300) return 'ok'
  if (status === 401 || status === 403) return 'key'
  if (status === 402 || status === 429) return 'quota'
  if (status === 404 || ((status === 400 || status === 422) && /model/i.test(bodyText))) return 'model'
  return 'error'
}

// The upstream's own error message, short, with the provider's token masked in case the upstream echoes it
function detailOf(bodyText, token) {
  let msg = bodyText
  try {
    const j = JSON.parse(bodyText)
    msg = (j && j.error && (j.error.message || j.error.type)) || j.message || bodyText
  } catch {}
  msg = String(msg).replace(/\s+/g, ' ').trim()
  if (token) msg = msg.split(token).join('***')
  return msg.slice(0, 160)
}

const isLocal = (url) => /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?(\/|$)/i.test(url)

function portOpen(host, port, timeoutMs = 1000) {
  return new Promise((resolve) => {
    const sock = net.connect({ host, port, timeout: timeoutMs })
    sock.on('connect', () => (sock.destroy(), resolve(true)))
    sock.on('error', () => resolve(false))
    sock.on('timeout', () => (sock.destroy(), resolve(false)))
  })
}

// Resolves { verdict, status, firstByteMs, at, detail }; never rejects
function ping(provider, limitMs = LIMIT_MS) {
  return new Promise((resolve) => {
    const t0 = Date.now()
    let settled = false
    let up = null
    let timer = null
    const done = (status, v, detail = '') => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (up) up.destroy()
      resolve({ verdict: v, status, firstByteMs: Date.now() - t0, at: Date.now(), detail })
    }
    try {
      const u = new URL(provider.url)
      const lib = u.protocol === 'http:' ? http : https
      const payload = Buffer.from(JSON.stringify({ model: L.wireModel(provider.model), max_tokens: 1, stream: true, messages: [{ role: 'user', content: 'hi' }] }))
      const headers = authHeaders(provider, { 'content-type': 'application/json', 'anthropic-version': '2023-06-01', 'content-length': payload.length, host: u.host })
      up = lib.request({ hostname: u.hostname, port: u.port || (u.protocol === 'http:' ? 80 : 443), path: L.upstreamPath(provider.url, '/v1/messages'), method: 'POST', headers }, (res) => {
        const status = res.statusCode || 0
        res.on('error', () => done(status, verdict(status, ''))) // also the reset that destroying it below causes
        if (status >= 200 && status < 300) return res.once('data', () => done(status, 'ok'))
        const ch = []
        res.on('data', (c) => ch.push(c))
        res.on('end', () => {
          const text = Buffer.concat(ch).toString('utf8')
          done(status, verdict(status, text), detailOf(text, provider.token))
        })
      })
      timer = setTimeout(() => done(0, 'timeout', `no answer within ${Math.round(limitMs / 1000)}s`), limitMs)
      up.on('error', (e) => done(0, verdict(0, '', e.code || 'error'), e.code || e.message))
      up.end(payload)
    } catch (e) {
      // the request could not even be built: a key with a line break, an address Node cannot parse. The message is
      // left out, as it may quote the header it refused.
      done(0, 'error', `the request could not be sent (${e.code || 'invalid address or header'})`)
    }
  })
}

module.exports = { LIMIT_MS, authHeaders, verdict, detailOf, ping, portOpen, isLocal }
