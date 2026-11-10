'use strict'
// Pure routing decisions for router.js, tested by logic.test.js (node --test).

const fs = require('fs')
const path = require('path')
const { Transform } = require('stream')
const { StringDecoder } = require('string_decoder')
const { isDeepStrictEqual } = require('util')

const isPort = (n) => Number.isInteger(n) && n > 1024 && n < 65536

// Two spellings of one directory (symlinks, `c:\x` vs `C:\X` on Windows, 8.3 short names such as RUNNER~1) compare
// equal; the router, setup.mjs and the launcher wrapper all use this to tell whether two folders are the same one.
// fs.realpathSync.native asks the OS, which expands short names and symlinks; a path that does not exist yet (a
// link that is still to be made) gets the real path of its nearest existing ancestor with the rest appended as written.
// `win` picks the path flavour, so Windows paths are also taken apart right when this runs elsewhere (as a test does).
function realDir(d, win = process.platform === 'win32') {
  const P = win ? path.win32 : path
  const rest = []
  let cur = P.resolve(d)
  for (;;) {
    try {
      return P.join(fs.realpathSync.native(cur), ...rest)
    } catch {}
    const up = P.dirname(cur)
    if (up === cur) return P.resolve(d)
    rest.unshift(P.basename(cur))
    cur = up
  }
}
const dirKey = (d, win) => (win ? d.replace(/\\/g, '/').toLowerCase() : d)
const sameDir = (a, b, win = process.platform === 'win32') => dirKey(realDir(a, win), win) === dirKey(realDir(b, win), win)

function str(v) {
  return typeof v === 'string' && v.length > 0 ? v : null
}

// "keychain:<service>/<account>": a token kept in the macOS login keychain. Both names are plain words that cannot
// start with "-", so neither can be taken for an option of the tool that reads them. Spaces around the reference are
// trimmed, as around an env: name.
const KEYCHAIN_PARTS = /^([A-Za-z0-9_.@][A-Za-z0-9_.@-]*)\/([A-Za-z0-9_.@][A-Za-z0-9_.@-]*)$/
const MALFORMED_REF = '(malformed)' // what stands for a reference that is not <service>/<account>
const keychainText = (rawToken) => String(rawToken || '').slice('keychain:'.length).trim() // what follows the prefix
function keychainRef(rawToken) {
  if (!String(rawToken || '').startsWith('keychain:')) return null
  const m = KEYCHAIN_PARTS.exec(keychainText(rawToken))
  return m ? { service: m[1], account: m[2], ref: `${m[1]}/${m[2]}` } : null
}

// keychain(service, account) returns the token or null. It is passed in, never called from here by default: this file
// starts no process, and who reads a secret (the router, once) or only checks that it exists (the CLI) is the caller's choice.
function resolveToken(rawToken, env = process.env, keychain = null) {
  const s = str(rawToken)
  if (!s) return null
  if (s.startsWith('env:')) {
    const key = s.slice(4).trim()
    return key ? str(env[key]) : null
  }
  if (s.startsWith('keychain:')) {
    const r = keychainRef(s)
    return r && keychain ? str(keychain(r.service, r.account)) : null
  }
  return s
}

// Providers whose `env:VAR` token has no value in `env`, as [{ provider, env }], and whose `keychain:` token did not
// resolve, as [{ provider, keychain: "<service>/<account>" }]; never the value itself. anyClaudeUrl: as for parseCfg.
// where: { relayDir, home }, so the relay's own account is never reserved as anybody's fallback (as parseCfg); where.view
// is the accountView of this same raw, when the caller has it already (the router keeps one per config content)
function unresolvedEnv(raw, env = process.env, keychain = null, anyClaudeUrl = false, where = null) {
  const out = []
  if (!isFormat2(raw)) return out // an older config is not used at all, so none of its keys counts as missing
  const claudeUrl = bareCfg(raw).claudeUrl
  const targets = where && where.view ? reservedIn(where.view.lists) : reservedTargets(raw, anyClaudeUrl, selfOf(raw, where))
  for (const [k, v] of Object.entries(isObj(raw.providers) ? raw.providers : {})) {
    const key = k.trim().toLowerCase()
    if (!key || key === 'claude' || !v || typeof v.token !== 'string') continue // the keys parseCfg ignores
    // A Claude account parseCfg refuses for its shape or claudeUrl never has its token resolved, so its keychain item is
    // never read for nothing; doctor names it as skipped (accountProblems)
    // nor is one in a mode that does not send with its token (accountActive), so off never touches the keychain, and
    // switch only for an account some accounts.<name>.fallback list names (reservedTargets)
    if (v.kind === ACCOUNT_KIND && ((!accountActive(raw) && !targets.has(key)) || accountProblem(v, claudeUrl, anyClaudeUrl))) continue
    if (v.token.startsWith('keychain:')) {
      // likewise any other provider without an address and a model (env: tokens are still reported, as in 0.7.5)
      if (v.kind !== ACCOUNT_KIND && !providerShape(key, v)) continue
      // keychain: "" is a bare "keychain:", which names no item; malformed: text that is no <service>/<account>. That
      // text is never echoed, only a fixed marker: it may be the secret itself, pasted after "keychain:"
      const ref = keychainRef(v.token)
      const text = keychainText(v.token)
      if (!resolveToken(v.token, env, keychain)) out.push(ref ? { provider: key, keychain: ref.ref } : text ? { provider: key, keychain: MALFORMED_REF, malformed: true } : { provider: key, keychain: '' })
      continue
    }
    if (!v.token.startsWith('env:')) continue
    const name = v.token.slice(4).trim() // empty when the token is a bare "env:"
    if (!name || !str(env[name])) out.push({ provider: key, env: name })
  }
  return out
}

// The error for "parseCfg gave nothing": names the skipped providers when unset env vars or keychain items are the reason
function cfgMissingMessage(unresolved) {
  if (!unresolved.length) return 'model-relay.json is missing or invalid, or has no usable provider'
  const why = (u) => (u.keychain !== undefined
    ? u.malformed ? 'its keychain: reference is malformed'
      : u.keychain ? `keychain item ${u.keychain} could not be read` : 'its token "keychain:" names no item'
    : u.env ? `${u.env} is unset in the router process` : 'its token "env:" names no variable')
  const list = unresolved.map((u) => `${u.provider} (${why(u)})`).join(', ')
  // Each remedy only for a reason in the list: an env var needs a restart, a named keychain item is read again
  // when model-relay.json changes, and a bare or malformed reference is fixed in the config, which is re-read on every request
  const needsExport = unresolved.some((u) => u.keychain === undefined)
  const reread = unresolved.some((u) => u.keychain && !u.malformed)
  const rewrite = unresolved.some((u) => u.keychain !== undefined && (!u.keychain || u.malformed))
  const next = [
    needsExport && 'Export the variable(s), then restart the router (it keeps the environment it was started with)',
    reread && 'a fixed keychain item is read again when model-relay.json changes, or after a restart',
    rewrite && 'write a keychain: token as keychain:<service>/<account> (the config is read again on every request)',
  ].filter(Boolean).join('; ')
  return `no provider is usable; skipped ${list}${next ? `. ${next[0].toUpperCase()}${next.slice(1)}` : ''}`
}

// null for a Claude-looking model: a default ^claude would catch every Claude request and send it to this provider
function defaultPrefixRegex(name, model) {
  const clean = wireModel(model)
  const prefix = clean.split(/[-_.:/]/)[0] || name
  if (isClaudeModel(prefix)) return null
  return `^${prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`
}

// An http(s) address that new URL() accepts, or null: anything else would throw inside a request and stop the router
function httpUrl(s) {
  if (!str(s) || !/^https?:\/\//i.test(s)) return null
  try {
    return new URL(s).hostname ? s : null
  } catch {
    return null
  }
}

// Built-in providers: each service's address and the switches it needs. The model is always the person's to name,
// because model ids go out of date.
const PRESETS = {
  zai: { baseUrl: 'https://api.z.ai/api/anthropic', matchModels: ['^glm'], stripCacheControl: false, authHeader: 'both' },
  deepseek: { baseUrl: 'https://api.deepseek.com/anthropic', matchModels: ['^deepseek'], stripCacheControl: false, authHeader: 'bearer' },
  kimi: { baseUrl: 'https://api.moonshot.ai/anthropic', matchModels: ['^kimi', '^moonshot'], stripCacheControl: false, authHeader: 'bearer' },
  minimax: { baseUrl: 'https://api.minimax.io/anthropic', matchModels: ['^minimax'], stripCacheControl: false, authHeader: 'bearer' },
  openrouter: { baseUrl: 'https://openrouter.ai/api', matchModels: ['^openrouter/'], stripCacheControl: false, authHeader: 'bearer' },
}

// Format 2 is the only layout the router reads; "setup.mjs migrate" turns an older file into it
const isFormat2 = (raw) => isObj(raw) && raw.format === 2

// presets: the table a "preset" (or the provider's own name) is looked up in; migrate passes the older one
// The preset, address and model parseProvider would use, or null: without an address and a model a provider can never
// be used, so its token is not even resolved (no keychain read for it)
function providerShape(name, raw, presets = PRESETS) {
  if (typeof raw !== 'object' || raw === null) return null
  const presetKey = (str(raw.preset) || name || '').toLowerCase()
  const preset = Object.hasOwn(presets, presetKey) ? presets[presetKey] : null
  const url = httpUrl(raw.baseUrl || raw.url || preset?.baseUrl)
  const model = str(raw.model || preset?.model)
  return url && model ? { preset, url, model } : null
}

function parseProvider(name, raw, env = process.env, baseRetry = parseRetryCfg(undefined), presets = PRESETS, keychain = null) {
  const shape = providerShape(name, raw, presets)
  if (!shape) return null
  const { preset, url, model } = shape
  const token = resolveToken(raw.token, env, keychain)
  if (!token) return null

  const stripCacheControl = raw.stripCacheControl !== undefined
    ? Boolean(raw.stripCacheControl)
    : Boolean(preset?.stripCacheControl)
  const authHeader = raw.authHeader === 'bearer' || raw.authHeader === 'x-api-key' || raw.authHeader === 'both'
    ? raw.authHeader
    : (preset?.authHeader || 'bearer')

  const rawMatchers = Array.isArray(raw.matchModels) && raw.matchModels.length > 0
    ? raw.matchModels.filter((m) => typeof m === 'string' && m.length > 0)
    : (preset?.matchModels || [defaultPrefixRegex(name, model)].filter(Boolean))

  const matchRegexes = []
  for (const pat of rawMatchers) {
    try {
      matchRegexes.push(new RegExp(pat, 'i'))
    } catch {}
  }

  let launch = null
  if (typeof raw.launch === 'object' && raw.launch !== null && str(raw.launch.command)) {
    launch = {
      command: raw.launch.command,
      args: Array.isArray(raw.launch.args) ? raw.launch.args.filter((a) => typeof a === 'string') : [],
    }
  }

  return {
    name,
    url,
    token,
    model,
    stripCacheControl,
    authHeader,
    matchSources: rawMatchers,
    matchRegexes,
    launch,
    keychain: keychainRef(raw.token)?.ref || null, // where the token came from, for the CLI to print; never the token
    ...handover(raw, baseRetry),
  }
}

function handover(raw, baseRetry) {
  return {
    // null: never retried; otherwise the effective retry settings (per-provider overrides merged over the global ones)
    retryCfg: baseRetry.enabled ? resolveProviderRetry(raw.retry, baseRetry) : null,
    // Who takes over when this provider cannot answer: undefined = the failover chain, null = nobody, or its own list
    fallback: raw.fallback === false ? null : Array.isArray(raw.fallback) ? dedupe(lowerNames(raw.fallback)) : undefined,
  }
}

// kind "anthropic": a second Claude subscription. The request goes to Anthropic as Claude Code wrote it, with that
// account's token in place of the caller's, so it has no address, model or patterns of its own: it is reached only by a
// failover, a pinned session or the cooldown, never by a model name.
const ACCOUNT_KIND = 'anthropic'
const ACCOUNT_LABEL = 'anthropic-account' // what stands where a provider's model id would be shown
const ANTHROPIC_API = 'https://api.anthropic.com/'
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
// The userID of a .claude.json, sent as device_id: Claude Code writes it as 32 random bytes in lower-case hex
const DEVICE_ID_RE = /^[0-9a-f]{64}$/
// An address that can stand in the email sentence and in JSON text as it is: no quote, backslash, angle bracket,
// control character or whitespace, one @, at most 254 characters
const EMAIL_RE = /^[^\s"\\<>\x00-\x1f\x7f@]+@[^\s"\\<>\x00-\x1f\x7f@]+$/
const isEmail = (s) => typeof s === 'string' && s.length <= 254 && EMAIL_RE.test(s)
const isAccount = (p) => Boolean(p) && p.kind === ACCOUNT_KIND
const modelLabel = (p) => (isAccount(p) ? ACCOUNT_LABEL : p.model)

// accountFallback.mode: "off" (the default: 0.7.5, no account is used), "switch" (the launcher wrapper moves the whole
// window to the other account's own login; the router sends with another account's token only for an
// accounts.<name>.fallback list, below, never through failover.chain), "rc-keep" or "api-only" (the router sends
// requests with the account's token through failover.chain; it treats the two alike, and api-only differs only in the
// launcher wrapper starting the window with Remote Control off). Only the last two let failover.chain use a kind
// "anthropic" entry; in "switch" one is parsed and read only when a fallback list names it.
const ACCOUNT_MODES = ['off', 'switch', 'rc-keep', 'api-only']
const accountMode = (raw) => (isObj(raw) && isObj(raw.accountFallback) && typeof raw.accountFallback.mode === 'string' ? raw.accountFallback.mode : 'off')
const accountActive = (raw) => accountMode(raw) === 'rc-keep' || accountMode(raw) === 'api-only'
// A name in accounts that is an ordinary own key of an object ("__proto__" and "../x" are not)
const SAFE_NAME = /^[a-z0-9][a-z0-9_.-]*$/

// accounts.<name>.configDir by name (own keys with a configDir, trimmed and lower case), as written: "~" is expanded by
// whoever reads the directory
function accountDirs(raw) {
  const accounts = isObj(raw) && isObj(raw.accounts) ? raw.accounts : {}
  return new Map(Object.entries(accounts)
    .filter(([, v]) => isObj(v) && typeof v.configDir === 'string' && v.configDir.trim())
    .map(([k, v]) => [k.trim().toLowerCase(), v.configDir.trim()]))
}

// What the router needs for windows of a second account in mode "switch" (/__account): the mode, the names in
// accounts (/__account also holds a name to SAFE_NAME), their configDir (dirs), whether claudeUrl is Anthropic itself,
// each account's fallback list (lists, from fallbackLists) and the relay's own account (self, null when there is none
// or more than one; where = { relayDir, home } names the relay dir). anyClaudeUrl is for tests only, as for
// accountProblem.
function accountView(raw, anyClaudeUrl = false, where = null) {
  const dirs = accountDirs(raw)
  let href = ''
  try {
    href = new URL(bareCfg(raw).claudeUrl).href
  } catch {}
  const self = selfOf(raw, where)
  return { mode: accountMode(raw), names: new Set(dirs.keys()), dirs, claudeIsAnthropic: anyClaudeUrl || href === ANTHROPIC_API, lists: fallbackLists(raw, anyClaudeUrl, self), self }
}

// "~" and "~/x" from the home directory; anything else resolved as it is
const expandHome = (given, home) => path.resolve(given === '~' || given.startsWith('~/') ? path.join(home, given.slice(1)) : given)

// The login file Claude Code keeps for a config dir, chosen by path and never by environment: the default dir
// <home>/.claude keeps it at <home>/.claude.json, any other dir inside itself
const loginFile = (dir, home) => (home && sameDir(dir, path.join(home, '.claude')) ? path.join(home, '.claude.json') : path.join(dir, '.claude.json'))

// A login file as a JSON object, or null. Only a regular file is read: it is opened without blocking and checked after
// opening, so a directory or a FIFO put there is never read (and never hangs the caller). cache: an optional Map
// file -> { mtimeMs, ids } kept by loginIds
function readLoginJson(file) {
  let fd
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK || 0))
    if (!fs.fstatSync(fd).isFile()) return null
    const j = JSON.parse(fs.readFileSync(fd, 'utf8'))
    return isObj(j) ? j : null
  } catch {
    return null
  } finally {
    if (fd !== undefined) fs.closeSync(fd)
  }
}
const uuidOf = (v) => (typeof v === 'string' && UUID_RE.test(v) ? v.toLowerCase() : null)
// oauthAccount's accountUuid and organizationUuid of a login file (those two fields only, lower case, null when absent),
// or null when the file cannot be read. cache (file -> { mtimeMs, ids }) skips the parse while the mtime holds.
function loginIds(file, cache = null) {
  let mtimeMs
  try {
    const st = fs.statSync(file)
    if (!st.isFile()) return null
    mtimeMs = st.mtimeMs
  } catch {
    return null
  }
  const hit = cache && cache.get(file)
  if (hit && hit.mtimeMs === mtimeMs) return hit.ids
  const j = readLoginJson(file)
  const o = j && isObj(j.oauthAccount) ? j.oauthAccount : null
  const ids = j ? { accountUuid: uuidOf(o && o.accountUuid), orgUuid: uuidOf(o && o.organizationUuid) } : null
  if (cache) cache.set(file, { mtimeMs, ids })
  return ids
}

// The accounts whose configDir is the relay dir itself (the relay's own account: its windows are main's windows), by
// realpath. where: { relayDir, home }. More than one is a config error, and then none counts (selfOf).
function selfAccounts(raw, where) {
  if (!where || !where.relayDir) return []
  return [...accountDirs(raw)].filter(([n, d]) => SAFE_NAME.test(n) && sameDir(expandHome(d, where.home || ''), where.relayDir)).map(([n]) => n)
}
const selfOf = (raw, where) => {
  const s = selfAccounts(raw, where)
  return s.length === 1 ? s[0] : null
}

// accounts.<A>.fallback: a name, or a list of names and { account, allowCrossOrg } entries, read in mode "switch" only.
// A's registered windows (and, for the relay's own account, main's windows) go to the first usable entry while A is at
// its usage limit, then to the next one when that one answers its own. { lists: Map A -> [{ name, allowCrossOrg }],
// problems: [{ account, why }] }. An entry must be another name in accounts, not the relay's own account (self, when
// known), and a kind "anthropic" provider that accountProblem accepts; whether its token resolves is parseCfg's to find
// out, so an entry refused for its shape never has its keychain item read. The first of two equal names counts. A's list
// only: an entry's own fallback means nothing for A's windows. allowCrossOrg counts only as the boolean true. A list or
// a problem names only accounts in accounts (SAFE_NAME words); any other value, which might be a pasted secret, is never
// echoed. The one predicate parseCfg, unresolvedEnv, the router and setup.mjs all use.
function fallbackScan(raw, anyClaudeUrl = false, self = null) {
  const lists = new Map()
  const problems = []
  const entries = new Map() // A -> [{ name (null when it names no account), why, allowCrossOrg }], every entry as written
  if (!isFormat2(raw) || accountMode(raw) !== 'switch' || !isObj(raw.accounts)) return { lists, problems, entries }
  const names = new Set(accountDirs(raw).keys())
  const providers = isObj(raw.providers) ? Object.entries(raw.providers) : []
  const claudeUrl = bareCfg(raw).claudeUrl
  for (const [k, v] of Object.entries(raw.accounts)) {
    const a = k.trim().toLowerCase()
    if (!isObj(v) || v.fallback === undefined || !SAFE_NAME.test(a) || !names.has(a)) continue
    const list = []
    const all = []
    for (const e of Array.isArray(v.fallback) ? v.fallback : [v.fallback]) {
      const given = typeof e === 'string' ? e : isObj(e) && typeof e.account === 'string' ? e.account : ''
      const b = given.trim().toLowerCase()
      // as parseCfg reads providers: trimmed, lower case, the last of two spellings wins
      const entry = providers.filter(([pk]) => pk.trim().toLowerCase() === b).map(([, pv]) => pv).at(-1)
      const shape = isObj(entry) && entry.kind === ACCOUNT_KIND ? accountProblem(entry, claudeUrl, anyClaudeUrl) : null
      const why = !SAFE_NAME.test(b) || b === 'claude' ? 'is not the name of an account'
        : b === a ? 'names the account itself'
          : !names.has(b) ? 'names no account in accounts (with a configDir)'
            : b === self ? `names ${b}, the relay's own account, which is never a fallback`
              : list.some((x) => x.name === b) ? `names ${b} twice; the first one counts`
                : !isObj(entry) || entry.kind !== ACCOUNT_KIND ? `names ${b}, which has no kind "anthropic" entry in providers`
                  : shape ? `names ${b}, whose providers entry is skipped: ${shape}` : null
      const allowCrossOrg = isObj(e) && e.allowCrossOrg === true
      if (why) problems.push({ account: a, why: `accounts.${a}.fallback ${why}` })
      else list.push({ name: b, allowCrossOrg })
      all.push({ name: SAFE_NAME.test(b) && names.has(b) ? b : null, why, allowCrossOrg })
    }
    if (list.length) lists.set(a, list)
    entries.set(a, all)
  }
  return { lists, problems, entries }
}
const fallbackLists = (raw, anyClaudeUrl = false, self = null) => fallbackScan(raw, anyClaudeUrl, self).lists
const fallbackProblems = (raw, self = null) => fallbackScan(raw, false, self).problems
const fallbackEntries = (raw, self = null) => fallbackScan(raw, false, self).entries
// Every account some list names, which mode switch loads (its token resolved) as fallbackOnly
const reservedIn = (lists) => new Set([...lists.values()].flat().map((x) => x.name))
const reservedTargets = (raw, anyClaudeUrl = false, self = null) => reservedIn(fallbackLists(raw, anyClaudeUrl, self))

// The providers a registered window of `account` (or main's window, for the relay's own account) may fall back to, in
// order, as [{ provider, allowCrossOrg }]: only those parseCfg loaded as fallbackOnly (token resolved) that the account's
// list still names. The org rule (fallbackRefusal) is the caller's to apply: it reads login files.
function accountFallbacks(cfg, account) {
  const list = cfg && cfg.accountView && cfg.accountView.lists ? cfg.accountView.lists.get(account) || [] : []
  return list.map((x) => ({ provider: cfg.providers ? cfg.providers[x.name] : null, allowCrossOrg: x.allowCrossOrg }))
    .filter((x) => isAccount(x.provider) && x.provider.fallbackOnly)
}

// Why `target` may not serve `account`'s windows now, or null (fail closed). ids(name) gives { accountUuid, orgUuid }
// from that account's login file, or null. The target's login must still be the account providers.<target>.accountUuid
// names (a dir logged in again elsewhere is refused until account-sync runs again), and both logins must name the same
// organization, both readable UUIDs, unless the entry says allowCrossOrg: true. Fixed texts only, never a uuid.
const RELOGGED = 'its login is not the account its providers entry names, or cannot be read; run account-sync for it again'
const OTHER_ORG = 'the two logins are not in one organization (or one cannot be read), and the entry has no allowCrossOrg: true'
function fallbackRefusal(account, target, allowCrossOrg, ids) {
  const t = ids(target.name)
  if (allowCrossOrg !== true) {
    const a = ids(account)
    if (!a || !t || !a.orgUuid || !t.orgUuid || a.orgUuid !== t.orgUuid) return OTHER_ORG
  }
  return t && t.accountUuid && t.accountUuid === String(target.accountUuid || '').toLowerCase() ? null : RELOGGED
}

// metadata.user_id's account_uuid in a request body, lower case, or null: whose request it is
function bodyAccountUuid(bodyBuf) {
  try {
    const uid = JSON.parse(bodyBuf.toString('utf8')).metadata.user_id
    const u = typeof uid === 'string' ? JSON.parse(uid).account_uuid : undefined
    return typeof u === 'string' && UUID_RE.test(u) ? u.toLowerCase() : null
  } catch {
    return null
  }
}

// Why a kind "anthropic" entry cannot be used, or null. anyClaudeUrl is for tests only (the router sets it from a
// global that only a `node --require` preload can define): the account token must never go anywhere but Anthropic.
function accountProblem(raw, claudeUrl, anyClaudeUrl = false) {
  const extra = ['baseUrl', 'url', 'preset', 'model', 'matchModels'].filter((k) => raw[k] !== undefined)
  if (extra.length) return `kind "anthropic" takes no ${extra.join(', ')}: it always goes to Anthropic with the model Claude Code asked for`
  if (!UUID_RE.test(String(raw.accountUuid || ''))) return 'accountUuid must be that account\'s UUID (the account_uuid its own Claude Code login sends)'
  // The request must carry this account's device id and email, never yours, beside its token
  if (!DEVICE_ID_RE.test(String(raw.deviceId || ''))) return 'deviceId must be that account\'s userID from its .claude.json, 64 hex digits ("setup.mjs account-sync <name>" writes it)'
  if (!isEmail(raw.email)) return 'email must be that account\'s address, with no quote, backslash, angle bracket or space ("setup.mjs account-sync <name>" writes it)'
  let href = ''
  try {
    href = new URL(claudeUrl).href
  } catch {}
  if (!anyClaudeUrl && href !== ANTHROPIC_API) return `claudeUrl is ${claudeUrl}, and kind "anthropic" sends its account token to https://api.anthropic.com only`
  return null
}

function parseAccount(name, raw, env, base, keychain) {
  const token = resolveToken(raw.token, env, keychain)
  if (!token) return null
  return {
    name,
    kind: ACCOUNT_KIND,
    url: base.claudeUrl,
    token,
    accountUuid: raw.accountUuid.toLowerCase(),
    deviceId: raw.deviceId,
    email: raw.email,
    model: null,
    stripCacheControl: false,
    authHeader: 'bearer',
    matchSources: [],
    matchRegexes: [],
    launch: null,
    keychain: keychainRef(raw.token)?.ref || null,
    ...handover(raw, base.retry),
  }
}

// [{ provider, why }] for each kind "anthropic" entry parseCfg skips over its shape; doctor reports them. In off and
// switch nothing is reported: no entry is used there, whatever its shape
function accountProblems(raw) {
  if (!isFormat2(raw) || !isObj(raw.providers) || !accountActive(raw)) return []
  const claudeUrl = bareCfg(raw).claudeUrl
  return Object.entries(raw.providers)
    .filter(([k, v]) => isObj(v) && v.kind === ACCOUNT_KIND && k.trim() && k.trim().toLowerCase() !== 'claude')
    .map(([k, v]) => ({ provider: k.trim().toLowerCase(), why: accountProblem(v, claudeUrl) }))
    .filter((x) => x.why)
}

// raw.retry: false (off) | undefined (use global) | { attempts, delayMs, backoff, maxDelayMs, failover } (partial override)
function resolveProviderRetry(raw, base) {
  if (raw === false) return null
  if (typeof raw !== 'object' || raw === null) return base
  if (raw.enabled === false) return null
  const num = (v, d) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : d)
  return {
    attempts: Math.min(30, Math.floor(num(raw.attempts, base.attempts))),
    delayMs: Math.min(300000, num(raw.delayMs, base.delayMs)),
    backoff: Math.min(4, Math.max(1, num(raw.backoff, base.backoff))),
    maxDelayMs: Math.min(300000, num(raw.maxDelayMs, base.maxDelayMs)),
    failover: typeof raw.failover === 'boolean' ? raw.failover : base.failover,
    enabled: true,
  }
}

const isObj = (v) => typeof v === 'object' && v !== null && !Array.isArray(v)
const lowerNames = (list) => (Array.isArray(list) ? list : []).map((n) => String(n).trim().toLowerCase()).filter((n) => n && n !== 'claude')
const dedupe = (list) => [...new Set(list)]
const DEFAULT_COOLDOWN_MS = 600000

// The settings that do not depend on any provider. An older config (no "format": 2) gets only these: the router keeps
// its port and sends everything to Claude until "setup.mjs migrate --go" rewrites the file.
function bareCfg(raw) {
  const r = isObj(raw) ? raw : {}
  const fo = isObj(r.failover) ? r.failover : {}
  const cooldownMs = typeof fo.cooldownMs === 'number' && fo.cooldownMs >= 0 ? fo.cooldownMs : DEFAULT_COOLDOWN_MS
  return {
    providers: Object.create(null),
    failoverChain: [],
    failoverProvider: null,
    port: isPort(r.port) ? r.port : 8950,
    claudeUrl: httpUrl(r.claudeUrl) || 'https://api.anthropic.com',
    failoverEnabled: fo.enabled !== false,
    cooldownMs: Math.min(7200000, Math.max(60000, cooldownMs)),
    // How long an upstream may stay silent (no bytes either way) before the request is treated as failed
    idleTimeoutMs: typeof r.idleTimeoutMs === 'number' && r.idleTimeoutMs > 0 ? Math.min(3600000, Math.max(1000, r.idleTimeoutMs)) : 300000,
    retry: parseRetryCfg(r.retry),
    proxy: parseProxyCfg(r.proxy),
  }
}

// opts.keychain resolves `keychain:` tokens (see resolveToken); opts.anyClaudeUrl is for tests only (see accountProblem);
// opts.relayDir and opts.home name the relay dir, whose own account is never reserved as a fallback (selfOf); opts.view is
// the accountView of this same raw, when the caller has it already
function parseCfg(raw, env = process.env, { keychain = null, anyClaudeUrl = false, relayDir = null, home = '', view = null } = {}) {
  if (!isFormat2(raw)) return null
  const base = bareCfg(raw)
  // No prototype: names arrive from config files, sticky state and /__session, and "constructor" or "toString"
  // must never look up an inherited Object.prototype member as if it were a provider.
  const providers = Object.create(null)
  const active = accountActive(raw) // off and switch drop every Claude account, and with it its place in the chain
  // but switch keeps every one an accounts.<name>.fallback list names, for that account's windows only (fallbackOnly)
  const reserved = view ? reservedIn(view.lists) : reservedTargets(raw, anyClaudeUrl, selfOf(raw, { relayDir, home }))
  for (const [k, v] of Object.entries(isObj(raw.providers) ? raw.providers : {})) {
    const key = k.trim().toLowerCase()
    if (!key || key === 'claude') continue
    const p = isObj(v) && v.kind === ACCOUNT_KIND
      ? (!active && !reserved.has(key)) || accountProblem(v, base.claudeUrl, anyClaudeUrl) ? null : parseAccount(key, v, env, base, keychain)
      : parseProvider(key, v, env, base.retry, PRESETS, keychain)
    if (p && isAccount(p) && reserved.has(key)) p.fallbackOnly = true
    if (p) providers[key] = p
  }
  if (Object.keys(providers).length === 0) return null
  // A fallbackOnly account is never a link: not in the chain, not in any provider's own fallback list
  const reachable = (n) => providers[n] && !providers[n].fallbackOnly
  for (const p of Object.values(providers)) if (Array.isArray(p.fallback)) p.fallback = p.fallback.filter((n) => !providers[n] || reachable(n))
  // The chain is the order providers are used when Claude is out of quota; names that are not configured are skipped.
  // Without one, a 429 from Claude is passed back as it is.
  const failoverChain = dedupe(lowerNames(raw.failover?.chain).filter(reachable))
  return {
    ...base,
    providers,
    failoverChain,
    failoverProvider: failoverChain[0] || null, // the first link; kept as its own field for callers that show a single target
  }
}

// Every env:VAR counts as set, so a config is judged by its shape alone and never by this shell's keys
// and so does every keychain: item, without looking at the keychain
const ANY_ENV = new Proxy({}, { get: () => 'set' })
const parseShape = (raw) => parseCfg(raw, ANY_ENV, { keychain: () => 'set' })

// HTTPS proxy mode: Claude Code keeps talking to api.anthropic.com (Remote Control insists on it) and uses the
// router as its HTTPS proxy. Only this host is opened up and routed; every other host is a plain byte tunnel.
const PROXY_MITM_HOST = 'api.anthropic.com'

// raw.proxy: { enabled: true } turns it on; anything else leaves it off, so the router is never an open CONNECT proxy by accident.
// `setup.mjs proxy enable` writes the setting; `proxy disable` clears it.
function parseProxyCfg(raw) {
  return { enabled: typeof raw === 'object' && raw !== null && raw.enabled === true }
}

// "host:port" from a CONNECT request line; null when it is not a usable target
function parseConnectTarget(authority) {
  const m = /^(?:\[([0-9a-f:.]+)\]|([a-z0-9._-]+)):(\d{1,5})$/i.exec(String(authority || '').trim())
  if (!m) return null
  const port = Number(m[3])
  if (port < 1 || port > 65535) return null
  return { host: (m[1] || m[2]).toLowerCase(), port }
}

// What to do with a CONNECT: answer for it ('mitm'), pass the bytes through untouched ('tunnel'), or turn it away.
// Without a usable certificate even api.anthropic.com is tunnelled, so Claude Code keeps working, just unrouted.
function proxyAction(proxyCfg, target, haveCert) {
  if (!proxyCfg || !proxyCfg.enabled || !target) return 'refuse'
  return target.host === PROXY_MITM_HOST && target.port === 443 && haveCert ? 'mitm' : 'tunnel'
}

// The plain-HTTP side of the router serves only local programs (Claude Code, the plugin, setup.mjs), none of which
// is a browser. A web page can still reach 127.0.0.1: a simple text/plain POST needs no preflight, an <img> GET
// carries no Origin, and DNS rebinding puts a foreign name on our address. So the Host header must name 127.0.0.1 or
// localhost on the port actually bound, and a browser marker (Origin, Sec-Fetch-Site) is refused, even from another
// local server such as localhost:3000. Browsers send Sec-Fetch-Site on every request to a loopback URL; Sec-Fetch-Mode
// is not a browser marker, because Node's built-in fetch sends "sec-fetch-mode: cors" on every request.
const LOCAL_HOST_RE = /^(127\.0\.0\.1|localhost):(\d{1,5})$/i
function isLocalRequest(headers, port) {
  const m = LOCAL_HOST_RE.exec(String((headers && headers.host) || ''))
  if (!m || Number(m[2]) !== port) return false
  return headers.origin === undefined && headers['sec-fetch-site'] === undefined
}

// Inside the opened-up tunnel only model calls are for the router. Token refresh, profile lookups, Remote Control
// and anything else must reach Anthropic unchanged: running them through decide() could send them to a provider.
function isRoutedRequest(method, url) {
  return method === 'POST' && /^\/v1\/messages(?:\/|\?|$)/.test(String(url || ''))
}

const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504, 529])

function parseRetryCfg(raw) {
  const r = typeof raw === 'object' && raw !== null ? raw : {}
  const num = (v, d) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : d)
  return {
    enabled: r.enabled !== false, // the global switch: false means no provider is ever retried
    attempts: Math.min(30, Math.floor(num(r.attempts, 3))), // 0 = unlimited: keep retrying until it answers
    delayMs: Math.min(60000, num(r.delayMs, 2000)),
    backoff: Math.min(4, Math.max(1, num(r.backoff, 2))),
    maxDelayMs: Math.min(300000, num(r.maxDelayMs, 10000)),
    failover: r.failover === true,
  }
}

// How long to wait before retrying the SAME provider, or null when retrying cannot help
// (status not retryable, or attempts exhausted — never when attempts is 0, the unlimited setting).
// Retry-After within budget is honoured; a longer one keeps polling at maxDelayMs instead of giving up.
function retryWaitMs(status, headers, attempt, cfg) {
  if (!RETRYABLE_STATUSES.has(status)) return null
  if (cfg.attempts > 0 && attempt >= cfg.attempts) return null
  const ra = headers && headers['retry-after']
  const raText = Array.isArray(ra) ? ra[0] : ra
  const raSec = Number(raText)
  if (Number.isFinite(raSec) && raSec > 0) {
    return Math.min(Math.max(raSec * 1000, cfg.delayMs), cfg.maxDelayMs)
  }
  return Math.min(cfg.maxDelayMs, cfg.delayMs * Math.pow(cfg.backoff, attempt))
}

// The provider that takes over when `providerName` cannot answer: its own `fallback` list, else the failover chain,
// skipping itself and every provider already tried for this request. null when nobody is left. A Claude account
// (kind "anthropic") takes over only a request for a Claude model: a glm request has no business on a subscription.
// This is the one path on which a body that went to another provider by its model name can reach the account; the
// first hop (toClaude) and the cooldown (decide) only see requests no provider claimed by model, and stay as in 0.7.5.
function nextFallback(cfg, providerName, tried = [], model = null) {
  if (!cfg || !cfg.providers) return null
  const own = cfg.providers[providerName] && cfg.providers[providerName].fallback
  if (own === null) return null
  const skip = new Set([providerName, ...tried])
  const fits = (p) => p && (!isAccount(p) || isClaudeModel(model))
  const next = (own || cfg.failoverChain || []).find((n) => !skip.has(n) && fits(cfg.providers[n]))
  return next ? cfg.providers[next] : null
}

// The `model` of a request body, or null when it has none or is not JSON
function requestModel(bodyBuf) {
  try {
    const m = JSON.parse(bodyBuf.toString('utf8')).model
    return typeof m === 'string' ? m : null
  } catch {
    return null
  }
}

function matchProviderByModel(cfg, model) {
  if (typeof model !== 'string' || !model || !cfg || !cfg.providers) return null
  const clean = wireModel(model)
  // A Claude account has no model and no patterns, and is skipped outright: its null model would otherwise equal a
  // model that is only a suffix, such as "[1m]"
  const all = Object.values(cfg.providers).filter((p) => !isAccount(p))
  // A provider's own model wins over another provider's pattern, whichever comes first in the file
  const own = all.find((p) => clean.toLowerCase() === wireModel(p.model).toLowerCase())
  if (own) return own.name
  const byPattern = all.find((p) => p.matchRegexes && p.matchRegexes.some((re) => re.test(model) || re.test(clean)))
  return byPattern ? byPattern.name : null
}

// Claude's three model tiers and their full model IDs. When a provider's matchModels catches one of these (for
// example "haiku" on glm), the router must also rewrite the body's `model` field to the provider's model ID so
// providers that do not recognize "claude-haiku-*" still accept the request.
const ALIAS_SLOTS = {
  haiku: 'claude-haiku-5-5',
  sonnet: 'claude-sonnet-5-5',
  opus: 'claude-opus-5-5',
}

function isClaudeModel(model) {
  return typeof model === 'string' && /^(claude[-_]|claude$|haiku\b|sonnet\b|opus\b)/i.test(wireModel(model).trim())
}

// Which provider (if any) currently claims each Claude model tier (`haiku`, `sonnet`, `opus`) via matchModels.
function detectAliases(cfg) {
  const out = {}
  if (!cfg || !cfg.providers) return out
  for (const [slot, sample] of Object.entries(ALIAS_SLOTS)) {
    const target = matchProviderByModel(cfg, sample)
    if (target) out[slot] = target
  }
  return out
}

// Subscription usage limits come back as 429 with the unified rate-limit status
// "rejected"; the message wording is the fallback signal.
function isUsageLimit(status, headers, bodyText) {
  if (status !== 429) return false
  if (String((headers && headers['anthropic-ratelimit-unified-status']) || '').toLowerCase() === 'rejected') return true
  return /usage limit|limit reached|hit your limit|limit (will )?resets?/i.test(bodyText || '')
}

// `sticky` maps sessionId -> { provider, at }. Session ids come from request headers and /__session, so the map has
// no prototype: a sid of "__proto__" is an ordinary entry instead of replacing the object's prototype.
function emptyState() {
  return { failoverSince: 0, nextClaudeTry: 0, sticky: Object.create(null) }
}

function parseState(raw) {
  const s = emptyState()
  if (typeof raw !== 'object' || raw === null) return s
  if (typeof raw.failoverSince === 'number') s.failoverSince = raw.failoverSince
  if (typeof raw.nextClaudeTry === 'number') s.nextClaudeTry = raw.nextClaudeTry

  const sticky = Object.create(null)
  if (typeof raw.sticky === 'object' && raw.sticky !== null) {
    for (const [sid, v] of Object.entries(raw.sticky)) {
      if (v && typeof v === 'object' && typeof v.provider === 'string' && typeof v.at === 'number') {
        sticky[sid] = { provider: v.provider.toLowerCase(), at: v.at }
      }
    }
  }
  return { failoverSince: s.failoverSince, nextClaudeTry: s.nextClaudeTry, sticky }
}

const STICKY_TTL_MS = 7 * 24 * 3600e3

// The hook rewrites its session's status file (model-relay-status/<session id>) at least daily, so a regular file
// untouched for a week belongs to a session that ended; anything else in the directory is left alone
function staleStatusFiles(entries, now) {
  return entries.filter((e) => e.isFile && now - e.mtimeMs >= STICKY_TTL_MS).map((e) => e.name)
}

function pruneSticky(state, now) {
  const base = parseState(state)
  const sticky = Object.create(null)
  for (const [sid, entry] of Object.entries(base.sticky)) {
    if (now - entry.at < STICKY_TTL_MS) sticky[sid] = entry
  }
  return { ...base, sticky }
}

function setSticky(state, sid, provider, now) {
  if (!sid) return state
  const base = parseState(state)
  const sticky = Object.assign(Object.create(null), base.sticky)
  if (!provider || provider === 'claude') {
    delete sticky[sid]
  } else {
    sticky[sid] = { provider: provider.toLowerCase(), at: now }
  }
  return { ...base, sticky }
}

function getSessionProvider(state, cfg, sid) {
  if (!sid) return 'claude'
  const base = parseState(state)
  const p = base.sticky[sid]?.provider
  if (p && cfg?.providers?.[p]) return p
  return 'claude'
}

// Where a request goes for a sid registered as a second account's window (reg = { account, registeredAt }), in place of
// decide: the account's own Claude requests never meet main's failover. A provider's model goes to that provider, as
// in decide; a /provider pin made after this registration goes to that provider; everything else goes to Claude as the
// caller sent it ({ claude: true }). Automatic pins from before the registration are ignored, not removed, and neither
// decide's cooldown nor its trial is ever reached. While the account is at its usage limit (now < limitedUntil(account))
// the rest goes to the first of its fallback accounts that is not at its own ({ account: <name> }), and back to the
// account when every one is ({ claude: true }: its 429 is then answered). targets: the usable names in order (the
// router passes them through the org rule); by default every fallbackOnly provider the account's list names.
function accountRoute(state, cfg, model, sid, reg, now = 0, limitedUntil = () => 0, targets = null) {
  const byModel = matchProviderByModel(cfg, model)
  if (byModel) return { route: routeLabel(byModel, false) }
  const pinned = getSessionProvider(state, cfg, sid)
  const at = state && state.sticky && state.sticky[sid] ? state.sticky[sid].at : 0
  if (pinned !== 'claude' && at > reg.registeredAt) return { route: routeLabel(pinned, true) }
  if (now >= limitedUntil(reg.account)) return { claude: true }
  const next = (targets || accountFallbacks(cfg, reg.account).map((x) => x.provider.name)).find((n) => now >= limitedUntil(n))
  return next ? { account: next } : { claude: true }
}

function routeLabel(providerName, rewrite) {
  return rewrite ? `${providerName}-rewrite` : providerName
}

function parseRoute(route, cfg) {
  if (route === 'claude' || route === 'claude-trial') {
    return { kind: 'claude', trial: route === 'claude-trial', provider: null, rewrite: false }
  }
  const rewrite = route.endsWith('-rewrite')
  const name = rewrite ? route.slice(0, -8) : route
  const provider = cfg?.providers?.[name] || null
  return { kind: 'provider', name, provider, rewrite }
}

function decide(state, cfg, model, sid, now) {
  const byModel = matchProviderByModel(cfg, model)
  if (byModel) return routeLabel(byModel, false)

  const stickyProvider = getSessionProvider(state, cfg, sid)
  if (stickyProvider !== 'claude') return routeLabel(stickyProvider, true)

  if (!cfg.failoverEnabled || !state.failoverSince || !cfg.failoverProvider) return 'claude'
  return now >= state.nextClaudeTry ? 'claude-trial' : routeLabel(cfg.failoverProvider, true)
}

function onLimited(state, cfg, now) {
  return { ...state, failoverSince: state.failoverSince || now, nextClaudeTry: now + cfg.cooldownMs }
}

function onClaudeOk(state) {
  return { ...state, failoverSince: 0, nextClaudeTry: 0 }
}

// Claude Code strips its own suffixes such as [1m] before sending; a rewrite must too.
const wireModel = (model) => String(model || '').replace(/\[[^\]]*\]$/, '')

// Claude Code's tool search on a provider other than Anthropic. Anthropic turns a `tool_reference` in a ToolSearch
// result into the deferred tool it names; no other provider does, and z.ai swaps a tool named ToolSearch for its own
// search and hides every other tool. So the provider gets the search under another name, every loaded tool as an
// ordinary one and each reference as text, and its calls to that name go back to Claude Code as ToolSearch.
const TOOL_SEARCH = 'ToolSearch'
const SEARCH_ALIAS = 'load_deferred_tools'
const PLACEHOLDER = 'DeferredToolPlaceholder'
const ALIAS_CALL = new RegExp(`("name"\\s*:\\s*)"${SEARCH_ALIAS}"`, 'g')

const loadedText = (c) => ({ type: 'text', text: `Tool ${c.tool_name} is loaded and can be called now.` })

// Rewrites j in place when it carries tool search: null when it does not, else whether it offers the search by alias
function adaptToolSearch(j) {
  if (!Array.isArray(j.tools) || !j.tools.some((t) => t && (t.name === TOOL_SEARCH || t.defer_loading === true))) return null
  j.tools = j.tools.filter((t) => !(t && t.name === PLACEHOLDER)).map((t) => {
    if (!isObj(t)) return t
    const { defer_loading: _deferred, ...tool } = t
    return tool.name === TOOL_SEARCH ? { ...tool, name: SEARCH_ALIAS } : tool
  })
  if (isObj(j.tool_choice) && j.tool_choice.name === TOOL_SEARCH) j.tool_choice = { ...j.tool_choice, name: SEARCH_ALIAS }
  for (const m of Array.isArray(j.messages) ? j.messages : []) {
    for (const b of Array.isArray(m && m.content) ? m.content : []) {
      if (b && b.type === 'tool_use' && b.name === TOOL_SEARCH) b.name = SEARCH_ALIAS
      if (b && b.type === 'tool_result' && Array.isArray(b.content)) b.content = b.content.map((c) => (c && c.type === 'tool_reference' ? loadedText(c) : c))
    }
  }
  return { aliased: j.tools.some((t) => t && t.name === SEARCH_ALIAS) }
}

// Claude Code announces tools that arrive or go mid-session (an MCP server that reconnected) as tool_addition and
// tool_removal blocks in system messages, not in tools[]. Anthropic applies them in order; no other provider does, so
// they are applied here: tools[] ends up as the session's tools stand now, and the blocks leave the messages, along
// with any system message they leave empty. Rewrites j in place; whether anything changed.
function applyToolChanges(j) {
  if (!Array.isArray(j.messages)) return false
  const isChange = (b) => b && (b.type === 'tool_addition' || b.type === 'tool_removal')
  if (!j.messages.some((m) => Array.isArray(m && m.content) && m.content.some(isChange))) return false
  const tools = new Map((Array.isArray(j.tools) ? j.tools : []).map((t) => [t && t.name, t]))
  for (const m of j.messages) {
    for (const b of Array.isArray(m && m.content) ? m.content : []) {
      if (b && b.type === 'tool_addition' && isObj(b.tool && b.tool.definition)) tools.set(b.tool.definition.name, b.tool.definition)
      if (b && b.type === 'tool_removal' && b.tool) tools.delete(b.tool.name)
    }
  }
  j.tools = [...tools.values()]
  j.messages = j.messages.flatMap((m) => {
    if (!Array.isArray(m && m.content) || !m.content.some(isChange)) return [m]
    const content = m.content.filter((b) => !isChange(b))
    return content.length ? [{ ...m, content }] : []
  })
  return true
}

// A provider's answer with its calls to the alias named ToolSearch again; works line by line, so a name cut across two
// chunks is still found, and decodes UTF-8 as a stream so a character cut across two chunks stays whole
function toolSearchRestorer() {
  const decoder = new StringDecoder('utf8')
  const restore = (text) => text.replace(ALIAS_CALL, `$1"${TOOL_SEARCH}"`)
  let carry = ''
  return new Transform({
    transform(chunk, _enc, done) {
      const text = carry + decoder.write(chunk)
      const cut = text.lastIndexOf('\n') + 1
      carry = text.slice(cut)
      done(null, restore(text.slice(0, cut)))
    },
    flush(done) {
      done(null, restore(carry + decoder.end()))
    },
  })
}

function stripCache(v) {
  if (Array.isArray(v)) v.forEach(stripCache)
  else if (v && typeof v === 'object') {
    delete v.cache_control
    Object.values(v).forEach(stripCache)
  }
}

function rewriteBody(bodyBuf, opts = {}) {
  const model = opts.model || null
  const defaultModel = opts.defaultModel || null
  const noCache = Boolean(opts.stripCacheControl)
  const j = JSON.parse(bodyBuf.toString('utf8'))
  if (noCache) stripCache(j)
  const changedTools = applyToolChanges(j)
  const search = adaptToolSearch(j)
  const restoreToolSearch = Boolean(search && search.aliased)
  const targetModel = model || (defaultModel && isClaudeModel(j.model) ? defaultModel : null)
  const strippedSame = !targetModel && typeof j.model === 'string' && wireModel(j.model) !== j.model ? wireModel(j.model) : null
  if (!targetModel && !strippedSame && !search && !noCache && !changedTools) return { body: bodyBuf, restoreToolSearch }
  if (targetModel) j.model = wireModel(targetModel)
  else if (strippedSame) j.model = strippedSame
  return { body: Buffer.from(JSON.stringify(j), 'utf8'), restoreToolSearch }
}

// Message Threads (anthropic-beta "message-threads-*"): Claude Code keeps the conversation on Anthropic's server and
// sends each later turn as only the new messages, without system prompt or tools. No provider holds that thread, so a
// provider would answer the last message alone. Refusing the beta the way Anthropic refuses an unknown one makes
// Claude Code drop threading for the session and resend the whole conversation.
function threadBetaRefusal(headers) {
  const raw = headers && headers['anthropic-beta']
  const betas = (Array.isArray(raw) ? raw.join(',') : String(raw || '')).split(',').map((b) => b.trim())
  const threads = betas.filter((b) => b.startsWith('message-threads'))
  if (!threads.length) return null
  return `Unexpected value(s) ${threads.map((b) => `\`${b}\``).join(', ')} for the \`anthropic-beta\` header: this provider keeps no message threads, send the full conversation`
}

// The sentence Claude Code puts in a <system-reminder> of the first message: "The user's email address is <email>. Use
// it only to …". The address is taken as one run of at most 254 characters with no space, quote, backslash or angle
// bracket, so the sentence may end the line, the text or run into markup such as </system-reminder>.
const EMAIL_PREFIX = "The user's email address is "
const EMAIL_SENTENCE = /The user's email address is ([^\s"\\<>\x00-\x1f\x7f]{1,254})\.(?![^\s"\\<>\x00-\x1f\x7f])/
const REMINDER = '<system-reminder>'
const stringsIn = (v, out = []) => {
  if (typeof v === 'string') out.push(v)
  else if (v && typeof v === 'object') for (const x of Object.values(v)) stringsIn(x, out)
  return out
}
const jsonText = (s) => Buffer.from(JSON.stringify(s).slice(1, -1), 'utf8') // s as it stands inside a JSON string

// The body for a Claude account (kind "anthropic") in rc-keep or api-only: the caller's bytes with exactly two kinds of
// value replaced by that account's: the ids inside metadata.user_id (a JSON string { account_uuid, device_id,
// session_id }; account_uuid, and device_id when the key is present, never added), and the address in the email sentence
// Claude Code injects into a <system-reminder> of the first message. Nothing else is scrubbed: your address or account
// id written anywhere else (system prompt, CLAUDE.md, a git log in the conversation) goes on as it is. The bytes are
// spliced, never re-serialised, so numbers past 2^53, key order and everything else arrive as Claude Code wrote them;
// the result must parse to the input with exactly those strings changed.
// account: { accountUuid, deviceId, email }. session: null, or { from, to } for the window's replacement session id:
// metadata.user_id's session_id must then be `from`, and becomes `to`, inside the same swap. { body, why }: why is null
// when spliced, or when the body has neither a user_id nor the sentence (a count_tokens or title call; that body goes
// unchanged); else a fixed reason (never a value from the body) and the body unchanged: the caller must then not send
// it with the account's token.
function spliceAccount(bodyBuf, account, session = null) {
  const unchanged = (why) => ({ body: bodyBuf, why })
  const { accountUuid, deviceId, email } = account || {}
  if (!UUID_RE.test(String(accountUuid || '')) || !DEVICE_ID_RE.test(String(deviceId || '')) || !isEmail(email)) return unchanged('the configured accountUuid, deviceId or email is not valid')
  const text = bodyBuf.toString('utf8')
  let j
  try {
    j = JSON.parse(text)
  } catch {
    return unchanged('the body is not JSON')
  }
  const swaps = []
  const expected = JSON.parse(text)
  const uid = j?.metadata?.user_id
  if (uid !== undefined) {
    if (typeof uid !== 'string') return unchanged('the body has no metadata.user_id string')
    let inner
    try {
      inner = JSON.parse(uid)
    } catch {
      return unchanged('metadata.user_id is not JSON')
    }
    if (!isObj(inner) || !UUID_RE.test(String(inner.account_uuid || ''))) return unchanged('metadata.user_id has no account_uuid UUID')
    // Re-serialising the inner object must give back exactly the string Claude Code sent, or more than the ids would change
    if (JSON.stringify(inner) !== uid) return unchanged('metadata.user_id is not in the form JSON.stringify writes')
    if (session && (typeof session.from !== 'string' || !session.from || inner.session_id !== session.from || !UUID_RE.test(String(session.to || '')))) return unchanged('metadata.user_id.session_id is not this window\'s session id')
    const nextUid = JSON.stringify({ ...inner, account_uuid: accountUuid, ...(Object.hasOwn(inner, 'device_id') ? { device_id: deviceId } : {}), ...(session ? { session_id: session.to } : {}) })
    swaps.push([Buffer.from(JSON.stringify(uid), 'utf8'), Buffer.from(JSON.stringify(nextUid), 'utf8')])
    expected.metadata.user_id = nextUid
  }

  // No sentence anywhere (a title or side call) is not a refusal; one anywhere but a first-message reminder, or more
  // than one, is
  const sentences = stringsIn(j).reduce((n, s) => n + s.split(EMAIL_PREFIX).length - 1, 0)
  if (sentences > 0) {
    const blocks = Array.isArray(j.messages) && j.messages[0] && Array.isArray(j.messages[0].content) ? j.messages[0].content : []
    const at = blocks.findIndex((b) => isObj(b) && b.type === 'text' && typeof b.text === 'string' && b.text.startsWith(REMINDER) && b.text.includes(EMAIL_PREFIX))
    const m = sentences === 1 && at >= 0 ? EMAIL_SENTENCE.exec(blocks[at].text) : null
    if (!m || !isEmail(m[1])) return unchanged('the email sentence is not once in a <system-reminder> of the first message')
    const oldSentence = `${EMAIL_PREFIX}${m[1]}.`
    const newSentence = `${EMAIL_PREFIX}${email}.`
    swaps.push([jsonText(oldSentence), jsonText(newSentence)])
    expected.messages[0].content[at].text = blocks[at].text.replace(oldSentence, () => newSentence)
  }
  if (!swaps.length) return unchanged(null)

  const places = []
  for (const [old, next] of swaps) {
    const i = bodyBuf.indexOf(old)
    if (i < 0) return unchanged('metadata.user_id or the email sentence is not written in the body the way JSON.stringify writes it')
    if (bodyBuf.indexOf(old, i + 1) >= 0) return unchanged('the metadata.user_id text or the email sentence occurs more than once in the body')
    places.push([i, old.length, next])
  }
  places.sort((a, b) => a[0] - b[0])
  const parts = []
  let pos = 0
  for (const [i, len, next] of places) {
    if (i < pos) return unchanged('the changes overlap')
    parts.push(bodyBuf.subarray(pos, i), next)
    pos = i + len
  }
  parts.push(bodyBuf.subarray(pos))
  const out = Buffer.concat(parts)
  // Each match must have been the string meant, not a look-alike somewhere else in the body
  let got
  try {
    got = JSON.parse(out.toString('utf8'))
  } catch {}
  if (!isDeepStrictEqual(got, expected)) return unchanged('the change was not exactly metadata.user_id and the email sentence')
  return { body: out, why: null }
}

// Anthropic takes a subscription's OAuth token only with this beta. A caller logged in with OAuth already sends it and
// its header goes on byte for byte; one that used an API key gets it appended.
const OAUTH_BETA = 'oauth-2025-04-20'
function withOAuthBeta(value) {
  const v = Array.isArray(value) ? value.join(',') : String(value || '')
  if (v.split(',').some((b) => b.trim() === OAUTH_BETA)) return v
  return v ? `${v},${OAUTH_BETA}` : OAUTH_BETA
}

function upstreamPath(base, reqUrl) {
  return new URL(base).pathname.replace(/\/$/, '') + reqUrl
}

module.exports = {
  isPort,
  realDir,
  sameDir,
  PRESETS,
  isFormat2,
  isObj,
  lowerNames,
  bareCfg,
  ANY_ENV,
  parseShape,
  wireModel,
  resolveToken,
  keychainRef,
  retryWaitMs,
  parseProvider,
  parseCfg,
  isAccount,
  modelLabel,
  accountProblems,
  spliceAccount,
  accountMode,
  accountActive,
  SAFE_NAME,
  accountView,
  accountRoute,
  fallbackLists,
  fallbackProblems,
  fallbackEntries,
  accountFallbacks,
  fallbackRefusal,
  expandHome,
  loginFile,
  readLoginJson,
  loginIds,
  selfAccounts,
  selfOf,
  bodyAccountUuid,
  ACCOUNT_MODES,
  UUID_RE,
  DEVICE_ID_RE,
  isEmail,
  withOAuthBeta,
  unresolvedEnv,
  cfgMissingMessage,
  nextFallback,
  requestModel,
  matchProviderByModel,
  ALIAS_SLOTS,
  isClaudeModel,
  detectAliases,
  setSticky,
  getSessionProvider,
  isUsageLimit,
  emptyState,
  parseState,
  pruneSticky,
  staleStatusFiles,
  decide,
  parseRoute,
  onLimited,
  onClaudeOk,
  rewriteBody,
  toolSearchRestorer,
  threadBetaRefusal,
  upstreamPath,
  PROXY_MITM_HOST,
  parseProxyCfg,
  parseConnectTarget,
  proxyAction,
  isRoutedRequest,
  isLocalRequest,
}
