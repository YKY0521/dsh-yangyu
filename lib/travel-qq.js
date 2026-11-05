import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash, randomBytes } from 'node:crypto'

const HTTP_LIMIT = 512 * 1024
const QR_LIFETIME_MS = 120_000
const CONNECTION_TIMEOUT_MS = 8_000
const CLAIM_LIFETIME_MS = 10 * 60_000
const safeId = value => {
  const text = String(value ?? '')
  if (!/^\d{1,16}$/.test(text) || !Number.isSafeInteger(Number(text)) || Number(text) <= 0) return null
  return text
}

function readJson(filename) {
  if (!fs.existsSync(filename)) return null
  const stat = fs.statSync(filename)
  if (!stat.isFile() || stat.size > HTTP_LIMIT) throw new Error('QQ 本地配置文件过大或无效')
  try { return JSON.parse(fs.readFileSync(filename, 'utf8').replace(/^\uFEFF/, '')) }
  catch { throw new Error('QQ 本地配置文件无法解析') }
}

/** Restrict integration traffic to an explicitly configured local service. */
function localUrl(value, protocols) {
  let url
  try { url = new URL(value) } catch { throw new Error('QQ 服务地址无效') }
  if (!protocols.includes(url.protocol) || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
    || url.username || url.password || url.hash) throw new Error('QQ 服务地址只允许本机回环地址')
  return url
}

function configOf(value) {
  if (!value || typeof value !== 'object') throw new Error('尚未配置本机 QQ 登录服务')
  const web = localUrl(value.webUiUrl, ['http:', 'https:'])
  if (web.search) throw new Error('QQ 登录服务地址不能包含查询参数')
  const ws = localUrl(value.wsUrl, ['ws:', 'wss:'])
  const allowedUids = [...new Set((Array.isArray(value.allowedUids) ? value.allowedUids : []).map(safeId).filter(Boolean))]
  return {
    webUiUrl: web.href.replace(/\/$/, ''),
    webUiToken: typeof value.webUiToken === 'string' ? value.webUiToken : '',
    wsUrl: ws.href,
    accessToken: typeof value.accessToken === 'string' ? value.accessToken : '',
    allowedUids,
    ...(typeof value.webCredential === 'string' ? { webCredential: value.webCredential } : {}),
    ...(safeId(value.accountId) ? { accountId: safeId(value.accountId) } : {}),
    ...(safeId(value.expectedQQ) ? { expectedQQ: safeId(value.expectedQQ) } : {}),
    ...(typeof value.accountName === 'string' ? { accountName: value.accountName.slice(0, 100) } : {}),
    ...(value.legacyBridgeEnabled === true ? { legacyBridgeEnabled: true } : {}),
  }
}

/** Reads known configuration locations only. Secrets remain in the host process. */
export function discoverQQConfig({ home, userHome = os.homedir(), characterId } = {}) {
  const dshHome = home || process.env.DSH_HOME || path.join(userHome, '.dsh')
  const bridge = readJson(path.join(dshHome, 'qq-bridge', 'config.json'))
  const custom = readJson(path.join(dshHome, 'storages', 'dsh-yangyu', 'qq-service.json'))
  const configured = characterId && Object.hasOwn(custom?.characters ?? {}, characterId)
    ? custom.characters[characterId] : custom?.default ?? (custom?.webUiUrl ? custom : null)
  if (configured) {
    const result = configOf(configured)
    result.legacyBridgeEnabled = bridge?.enabled === true &&
      localUrl(bridge.wsUrl || 'ws://127.0.0.1:3001', ['ws:', 'wss:']).href === result.wsUrl
    return result
  }
  const base = path.join(userHome, 'napcat')
  const candidates = []
  const versions = path.join(base, 'onekey', 'NapCat.52230.Shell', 'versions')
  if (fs.existsSync(versions)) {
    const directories = fs.readdirSync(versions, { withFileTypes: true })
      .filter(e => e.isDirectory() && /^\d[\w.-]*$/.test(e.name)).map(e => e.name)
      .sort((a, b) => b.localeCompare(a, 'en', { numeric: true }))
    for (const version of directories) candidates.push(path.join(versions, version, 'resources', 'app', 'napcat', 'config', 'webui.json'))
  }
  candidates.push(path.join(base, 'shell38', 'config', 'webui.json'))
  let web
  let webUiConfigPath
  for (const file of candidates) {
    web = readJson(file)
    if (web) { webUiConfigPath = file; break }
  }
  if (!web && !bridge) return null
  const port = Number(web?.port ?? 6099)
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error('QQ WebUI 端口无效')
  const config = configOf({
    webUiUrl: `http://127.0.0.1:${port}`,
    webUiToken: web?.token || '',
    wsUrl: bridge?.wsUrl || 'ws://127.0.0.1:3001',
    accessToken: bridge?.accessToken || '',
    allowedUids: [bridge?.ownerUid, ...(Array.isArray(bridge?.allowedUids) ? bridge.allowedUids : [])],
    legacyBridgeEnabled: bridge?.enabled === true,
  })
  let launch
  if (webUiConfigPath) {
    const appDir = path.dirname(path.dirname(webUiConfigPath))
    const launcher = path.join(appDir, 'NapCatWinBootMain.exe')
    const hookDll = path.join(appDir, 'NapCatWinBootHook.dll')
    const qqExe = [path.join(base, 'onekey', 'NapCat.52230.Shell', 'QQ.exe'),
      path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Tencent', 'QQNT', 'QQ.exe')].find(f => fs.existsSync(f))
    const necessary = [launcher, hookDll, 'qqnt.json', 'loadNapCat.js', 'napcat.mjs'].map(f => path.isAbsolute(f) ? f : path.join(appDir, f))
    if (qqExe && necessary.every(f => fs.existsSync(f))) launch = { launcher, qqExe, hookDll, appDir }
  }
  return { ...config, ...(webUiConfigPath ? { webUiConfigPath } : {}), ...(launch ? { launch } : {}) }
}

function abortError() { return new Error('QQ 操作已取消') }
function assertNotAborted(signal) { if (signal?.aborted) throw abortError() }
function deferred() {
  let resolve, reject
  const promise = new Promise((a, b) => { resolve = a; reject = b })
  return { promise, resolve, reject }
}

/** Adapter for NapCat WebUI QR login and its private-message OneBot connection. */
export function createQQAdapter({ fetchImpl = globalThis.fetch, WebSocketImpl = globalThis.WebSocket, now = Date.now } = {}) {
  const sockets = new Map()

  async function request(config, endpoint, body, signal, authenticated = true) {
    assertNotAborted(signal)
    const control = new AbortController()
    const cancel = () => control.abort()
    signal?.addEventListener('abort', cancel, { once: true })
    const timer = setTimeout(cancel, 15_000)
    let response
    try {
      response = await fetchImpl(`${config.webUiUrl}/api${endpoint}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(authenticated ? { Authorization: `Bearer ${config.webCredential}` } : {}) },
        body: JSON.stringify(body ?? {}),
        signal: control.signal,
        redirect: 'error',
      })
      if (!response.ok) throw new Error('HTTP')
      const declared = Number(response.headers?.get?.('content-length') || 0)
      if (declared > HTTP_LIMIT) throw new Error('oversized')
      const raw = await response.text()
      if (Buffer.byteLength(raw) > HTTP_LIMIT) throw new Error('oversized')
      const result = JSON.parse(raw)
      if (result?.code !== 0) {
        const error = new Error(result?.message === 'Unauthorized' ? 'QQ 登录管理凭证已过期' : 'QQ 登录服务未能完成请求，请在本机 NapCat 中检查状态')
        error.authExpired = result?.message === 'Unauthorized'
        error.alreadyLoggedIn = result?.message === 'QQ Is Logined'
        throw error
      }
      return result.data ?? {}
    } catch (error) {
      if (error.authExpired || error.alreadyLoggedIn) throw error
      if (signal?.aborted) throw abortError()
      if (error.message?.startsWith('QQ 登录服务')) throw error
      throw new Error('无法连接本机 QQ 登录服务，请确认 NapCat 已启动')
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener('abort', cancel)
    }
  }

  async function authenticate(config, signal) {
    if (!config.webUiToken) throw new Error('QQ 登录服务尚未配置 WebUI Token')
    const hash = createHash('sha256').update(config.webUiToken + '.napcat').digest('hex')
    const data = await request(config, '/auth/login', { hash }, signal, false)
    if (data.require2FA) throw new Error('NapCat 已开启二次验证，请先在本机管理页完成验证')
    if (typeof data.Credential !== 'string' || data.Credential.length > 16_384) throw new Error('QQ 登录管理凭证无效')
    config.webCredential = data.Credential
  }

  async function api(config, endpoint, body, signal) {
    if (!config.webCredential) await authenticate(config, signal)
    try { return await request(config, endpoint, body, signal) }
    catch (error) {
      if (!error.authExpired) throw error
      await authenticate(config, signal)
      return request(config, endpoint, body, signal)
    }
  }

  async function status(config, challenge, signal) {
    const data = await api(config, '/QQLogin/CheckLoginStatus', {}, signal)
    if (data.isLogin === true && data.coreReady !== false) {
      const info = await api(config, '/QQLogin/GetQQLoginInfo', {}, signal)
      const id = safeId(info.uin ?? info.user_id)
      if (!id) throw new Error('QQ 登录成功但未取得有效账号标识')
      const expected = config.expectedQQ || config.accountId
      if (expected && expected !== id) throw new Error('QQ 登录账号已更换，请重新扫码绑定角色')
      config.accountId = id
      config.expectedQQ = id
      config.accountName = String(info.nick ?? info.nickname ?? '').slice(0, 100)
      return { status: 'connected', account: { id, name: config.accountName }, credentials: config }
    }
    const qrText = typeof data.qrcodeurl === 'string' ? data.qrcodeurl : challenge?.qrText
    const changed = qrText && qrText !== challenge?.qrText
    const expiresAt = changed ? now() + QR_LIFETIME_MS : challenge?.expiresAt ?? now() + QR_LIFETIME_MS
    const expired = /过期|失效|expired|timeout/i.test(String(data.loginError ?? '')) || now() >= expiresAt
    const state = data.qrLoginAccepted || data.loginPhase === 'qrcode_scanned' || data.loginPhase === 'initializing'
      ? 'scanned' : expired ? 'expired' : 'waiting'
    return {
      status: state,
      ...(qrText && qrText.length <= 16_384 ? { qrText } : {}),
      expiresAt,
      challenge: { config, qrText, expiresAt },
      credentials: config,
    }
  }

  const keyOf = config => createHash('sha256').update(JSON.stringify([config.wsUrl, config.accessToken, config.accountId])).digest('hex')
  function prune(entry) {
    for (const [key, item] of entry.claims) if (item.at < now() - CLAIM_LIFETIME_MS) entry.claims.delete(key)
    while (entry.seen.size > 2048) entry.seen.delete(entry.seen.values().next().value)
  }

  function queueEvent(entry, config, value) {
    const account = safeId(value?.self_id)
    if (account && account !== config.accountId) {
      entry.accountMismatch = true
      entry.queue.length = 0
      entry.claims.clear()
      entry.socket?.close()
      return
    }
    if (value?.echo != null) {
      const pending = entry.pending.get(String(value.echo))
      if (pending) {
        entry.pending.delete(String(value.echo))
        pending.finish(value)
      }
      return
    }
    if (value?.post_type !== 'message' || value?.message_type !== 'private') return
    const peerId = safeId(value.user_id)
    if (!peerId || account !== config.accountId || peerId === config.accountId || !config.allowedUids.includes(peerId)) return
    const id = String(value.message_id ?? '')
    if (!id || id.length > 256 || entry.seen.has(id)) return
    // Only real OneBot text segments enter the model. Files, CQ commands and images are not fetched.
    const text = Array.isArray(value.message) ? value.message.filter(s => s?.type === 'text' && typeof s.data?.text === 'string')
      .map(s => s.data.text).join('').slice(0, 16_000) : ''
    if (!text.trim()) return
    prune(entry)
    if (entry.queue.length >= 128 || entry.claims.size >= 512) return
    const contextToken = randomBytes(24).toString('hex')
    entry.seen.add(id)
    entry.claims.set(contextToken, { id, peerId, at: now(), sent: false })
    entry.queue.push({ id, peerId, text, contextToken, cursor: ++entry.cursor })
  }

  async function connection(config, signal) {
    assertNotAborted(signal)
    if (!config.accountId) throw new Error('QQ 尚未扫码登录')
    if (!config.allowedUids.length) throw new Error('QQ 尚未设置允许聊天的联系人，请先配置白名单')
    if (typeof WebSocketImpl !== 'function') throw new Error('当前 Node 不支持 QQ WebSocket 连接')
    const key = keyOf(config)
    let entry = sockets.get(key)
    if (entry?.accountMismatch) throw new Error('QQ 登录账号已更换，请重新扫码绑定角色')
    if (entry?.socket?.readyState === 1) return entry
    if (entry?.opening) { await entry.opening; return entry }
    entry ??= { queue: [], claims: new Map(), pending: new Map(), seen: new Set(), cursor: 0, sequence: 0, generation: randomBytes(12).toString('hex') }
    const ready = deferred()
    entry.opening = ready.promise
    sockets.set(key, entry)
    const url = localUrl(config.wsUrl, ['ws:', 'wss:'])
    if (config.accessToken) url.searchParams.set('access_token', config.accessToken)
    let socket
    try { socket = new WebSocketImpl(url.href) }
    catch {
      entry.opening = null
      sockets.delete(key)
      throw new Error('无法创建本机 QQ 消息连接')
    }
    entry.socket = socket
    const timeout = setTimeout(() => { ready.reject(new Error('连接本机 QQ 消息服务超时')); socket.close() }, CONNECTION_TIMEOUT_MS)
    const cancel = () => { ready.reject(abortError()); socket.close() }
    signal?.addEventListener('abort', cancel, { once: true })
    socket.addEventListener('open', () => ready.resolve())
    socket.addEventListener('error', () => ready.reject(new Error('无法连接本机 QQ 消息服务')))
    socket.addEventListener('close', () => {
      ready.reject(new Error('本机 QQ 消息服务已断开'))
      for (const pending of entry.pending.values()) pending.fail(new Error('QQ 消息服务已断开'))
      entry.pending.clear()
    })
    socket.addEventListener('message', event => {
      if (typeof event.data !== 'string' || event.data.length > HTTP_LIMIT) return
      try { queueEvent(entry, config, JSON.parse(event.data)) } catch { /* Reject malformed input, never execute it. */ }
    })
    try { await ready.promise; return entry }
    finally {
      clearTimeout(timeout)
      signal?.removeEventListener('abort', cancel)
      entry.opening = null
    }
  }

  async function callOneBot(entry, action, params, signal) {
    assertNotAborted(signal)
    const echo = `yangyu_${++entry.sequence}_${randomBytes(6).toString('hex')}`
    const response = deferred()
    const timer = setTimeout(() => { entry.pending.delete(echo); response.reject(new Error('QQ 消息服务确认超时')) }, CONNECTION_TIMEOUT_MS)
    const cancel = () => { entry.pending.delete(echo); response.reject(abortError()) }
    signal?.addEventListener('abort', cancel, { once: true })
    entry.pending.set(echo, { finish: response.resolve, fail: response.reject })
    try {
      entry.socket.send(JSON.stringify({ action, params, echo }))
      const result = await response.promise
      if (result.retcode !== 0 || (result.status && result.status !== 'ok')) throw new Error('QQ 服务未确认操作成功')
      return result.data ?? {}
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener('abort', cancel)
      entry.pending.delete(echo)
    }
  }

  return {
    async start({ config: input, signal } = {}) {
      const config = configOf(input)
      const first = await status(config, null, signal)
      if (first.status === 'connected') return first
      let data
      try { data = await api(config, '/QQLogin/RefreshQRcode', {}, signal) }
      catch (error) {
        if (error.alreadyLoggedIn) return status(config, null, signal)
        throw error
      }
      const qrText = data.qrcodeurl
      if (data.restarting === true) return { status: 'waiting', challenge: { config, expiresAt: now() + QR_LIFETIME_MS }, credentials: config }
      if (typeof qrText !== 'string' || !qrText || qrText.length > 16_384) throw new Error('QQ 登录服务尚未生成新的二维码，请稍后刷新')
      const expiresAt = now() + QR_LIFETIME_MS
      return { status: 'waiting', qrText, expiresAt, challenge: { config, qrText, expiresAt }, credentials: config }
    },
    async poll({ challenge, credentials, signal } = {}) {
      const config = configOf(credentials ?? challenge?.config)
      return status(config, challenge, signal)
    },
    async receive({ credentials, cursor = 0, signal } = {}) {
      const config = configOf(credentials)
      const entry = await connection(config, signal)
      prune(entry)
      const prefix = `${entry.generation}:`
      const previous = typeof cursor === 'string' && cursor.startsWith(prefix) ? Number(cursor.slice(prefix.length)) || 0 : 0
      const messages = entry.queue.splice(0).filter(m => m.cursor > previous)
        .map(({ cursor: _cursor, ...message }) => message)
      return { cursor: prefix + entry.cursor, messages }
    },
    async send({ credentials, message, text, signal } = {}) {
      const config = configOf(credentials)
      const entry = await connection(config, signal)
      prune(entry)
      const claim = entry.claims.get(message?.contextToken)
      if (!claim || claim.sent || claim.id !== message.id || claim.peerId !== message.peerId || !config.allowedUids.includes(claim.peerId)) {
        throw new Error('QQ 回复只能发送给当前适配器收到的白名单私聊消息')
      }
      if (typeof text !== 'string' || !text.trim() || text.length > 16_000) throw new Error('QQ 回复内容为空或过长')
      const info = await callOneBot(entry, 'get_login_info', {}, signal)
      if (safeId(info.user_id) !== config.accountId) {
        entry.accountMismatch = true
        entry.queue.length = 0
        entry.claims.clear()
        entry.socket.close()
        throw new Error('QQ 登录账号已更换，已阻止向外回复')
      }
      // Claim before the wire send: a lost acknowledgement must never cause duplicate replies.
      if (claim.sent) throw new Error('此 QQ 消息已经处理')
      claim.sent = true
      const result = await callOneBot(entry, 'send_private_msg', {
        user_id: Number(claim.peerId), message: [{ type: 'text', data: { text } }], auto_escape: true,
      }, signal)
      return { ok: true, id: String(result.message_id ?? '') }
    },
    close(credentials) {
      if (!credentials) {
        for (const entry of sockets.values()) entry.socket?.close()
        sockets.clear()
        return
      }
      const key = keyOf(configOf(credentials))
      const entry = sockets.get(key)
      if (entry) { entry.socket?.close(); sockets.delete(key) }
    },
  }
}
