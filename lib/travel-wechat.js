import { createHash, randomBytes, randomUUID } from 'node:crypto'

// Wire format checked against Tencent/openclaw-weixin (MIT), version 2.4.10.
// This adapter implements the HTTP protocol without importing OpenClaw or its state.
export const WECHAT_PROTOCOL_VERSION = '2.4.10'
export const WECHAT_API_BASE = 'https://ilinkai.weixin.qq.com'
export const WECHAT_QR_TTL_MS = 5 * 60_000
export const WECHAT_MAX_RESPONSE_BYTES = 1024 * 1024
const CLIENT_VERSION = String((2 << 16) | (4 << 8) | 10)
const ALLOWED_API_HOSTS = new Set(['ilinkai.weixin.qq.com'])
const MAX_TEXT = 16_000
const MAX_CURSOR = 256 * 1024
const MAX_RECENT_REPLIES = 1000
const REPLY_TTL_MS = 60 * 60_000

function error(code, message) {
  return Object.assign(new Error(message), { code })
}

function aborted() {
  return Object.assign(error('ABORTED', '微信请求已取消'), { name: 'AbortError' })
}

function string(value, label, maximum, { empty = false } = {}) {
  if (typeof value !== 'string' || value.length > maximum || value.includes('\0') || (!empty && !value.trim())) {
    throw error('INVALID_INPUT', `${label}无效`)
  }
  return value
}

function identifier(value, label) {
  const result = string(value, label, 512)
  if (/[\x00-\x20\x7f]/.test(result)) throw error('INVALID_INPUT', `${label}无效`)
  return result
}

/** No caller-supplied URL, redirect, port, credentials, query or path can select another host. */
export function validateWeChatBaseUrl(value) {
  let url
  try { url = new URL(value) } catch { throw error('UNTRUSTED_HOST', '微信服务地址无法验证') }
  if (url.protocol !== 'https:' || !ALLOWED_API_HOSTS.has(url.hostname) || url.username || url.password ||
      (url.port && url.port !== '443') || !['', '/'].includes(url.pathname) || url.search || url.hash) {
    throw error('UNTRUSTED_HOST', '微信返回了未支持的服务地址，请刷新二维码或稍后再试')
  }
  return url.origin
}

function credentialsOf(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw error('AUTH_EXPIRED', '微信连接已失效，请重新扫码')
  let botToken, botId, userId
  try {
    botToken = string(value.botToken, '微信凭证', 16_384)
    if (/[\x00-\x20\x7f]/.test(botToken)) throw new Error('invalid token')
    botId = identifier(value.botId, '微信机器人标识')
    userId = value.userId ? identifier(value.userId, '微信用户标识') : ''
  } catch { throw error('AUTH_EXPIRED', '微信连接已失效，请重新扫码') }
  return { botToken, botId, userId, baseUrl: validateWeChatBaseUrl(value.baseUrl || WECHAT_API_BASE) }
}

function accountOf(credentials) {
  return { id: credentials.userId || credentials.botId, name: '微信 ClawBot' }
}

function applicationHeaders() {
  return { 'iLink-App-Id': 'bot', 'iLink-App-ClientVersion': CLIENT_VERSION }
}

function postHeaders(credentials) {
  const headers = {
    ...applicationHeaders(),
    'Content-Type': 'application/json',
    AuthorizationType: 'ilink_bot_token',
    'X-WECHAT-UIN': Buffer.from(String(randomBytes(4).readUInt32BE(0)), 'utf8').toString('base64'),
  }
  if (credentials) headers.Authorization = `Bearer ${credentials.botToken}`
  return headers
}

function baseInfo() {
  return { channel_version: WECHAT_PROTOCOL_VERSION, bot_agent: 'Yangyu/0.2.0' }
}

async function readJson(response, signal) {
  const declared = Number(response.headers?.get?.('content-length'))
  if (Number.isFinite(declared) && declared > WECHAT_MAX_RESPONSE_BYTES) {
    await response.body?.cancel?.().catch(() => {})
    throw error('RESPONSE_TOO_LARGE', '微信响应过大，请稍后再试')
  }
  const chunks = []
  let size = 0
  const reader = response.body?.getReader?.()
  if (reader) {
    const cancel = () => { reader.cancel().catch(() => {}) }
    signal.addEventListener('abort', cancel, { once: true })
    try {
      while (true) {
        if (signal.aborted) throw aborted()
        const { done, value } = await reader.read()
        if (done) break
        size += value.byteLength
        if (size > WECHAT_MAX_RESPONSE_BYTES) {
          await reader.cancel().catch(() => {})
          throw error('RESPONSE_TOO_LARGE', '微信响应过大，请稍后再试')
        }
        chunks.push(Buffer.from(value))
      }
    } finally {
      signal.removeEventListener('abort', cancel)
      reader.releaseLock?.()
    }
  } else {
    const bytes = Buffer.from(await response.arrayBuffer())
    if (bytes.byteLength > WECHAT_MAX_RESPONSE_BYTES) throw error('RESPONSE_TOO_LARGE', '微信响应过大，请稍后再试')
    chunks.push(bytes)
  }
  let result
  try {
    result = JSON.parse(Buffer.concat(chunks).toString('utf8'), (key, value, context) => {
      // Preserve uint64 IDs when a server sends JSON numbers instead of strings.
      if (key === 'message_id' && typeof value === 'number') {
        if (context?.source && /^\d+$/.test(context.source)) return context.source
        if (Number.isSafeInteger(value) && value >= 0) return String(value)
        throw new Error('unsafe message ID')
      }
      return value
    })
  } catch { throw error('INVALID_RESPONSE', '微信响应格式无法识别，请稍后再试') }
  if (!result || typeof result !== 'object' || Array.isArray(result)) throw error('INVALID_RESPONSE', '微信响应格式无法识别，请稍后再试')
  if (result.ret === -14 || result.errcode === -14) throw error('AUTH_EXPIRED', '微信登录已过期，请重新扫码')
  if ((result.ret !== undefined && result.ret !== 0) || (result.errcode !== undefined && result.errcode !== 0)) {
    throw error('PROVIDER_ERROR', '微信服务暂时无法完成请求，请稍后再试')
  }
  return result
}

export function createWeChatAdapter({ fetchImpl = globalThis.fetch, now = Date.now } = {}) {
  if (typeof fetchImpl !== 'function' || typeof now !== 'function') throw new TypeError('微信适配器依赖无效')
  const recentInbound = new Map()

  async function request({ baseUrl = WECHAT_API_BASE, endpoint, method = 'POST', body, credentials, signal, timeout = 15_000 }) {
    const origin = validateWeChatBaseUrl(baseUrl)
    if (signal?.aborted) throw aborted()
    const controller = new AbortController()
    let timedOut = false
    let onAbort
    let rejectAbort
    const abortPromise = new Promise((_, reject) => { rejectAbort = reject })
    const cancel = () => { controller.abort(); rejectAbort(timedOut ? error('TIMEOUT', '微信服务响应超时，请稍后重试') : aborted()) }
    const timer = setTimeout(() => { timedOut = true; cancel() }, timeout)
    if (signal) { onAbort = cancel; signal.addEventListener('abort', onAbort, { once: true }) }
    const work = (async () => {
      const response = await fetchImpl(new URL(endpoint, origin + '/'), {
        method, redirect: 'manual', signal: controller.signal,
        headers: method === 'GET' ? applicationHeaders() : postHeaders(credentials),
        ...(method === 'POST' ? { body: JSON.stringify(body) } : {}),
      })
      if (response.status >= 300 && response.status < 400) {
        await response.body?.cancel?.().catch(() => {})
        throw error('UNTRUSTED_HOST', '微信请求发生了未支持的跳转，请刷新二维码')
      }
      if (!response.ok) {
        await response.body?.cancel?.().catch(() => {})
        throw error('HTTP_ERROR', `微信服务暂时不可用（HTTP ${Number(response.status) || 0}）`)
      }
      return readJson(response, controller.signal)
    })()
    try { return await Promise.race([work, abortPromise]) }
    catch (cause) {
      if (signal?.aborted) throw aborted()
      if (timedOut) throw error('TIMEOUT', '微信服务响应超时，请稍后重试')
      if (cause?.code && ['AUTH_EXPIRED', 'HTTP_ERROR', 'PROVIDER_ERROR', 'INVALID_RESPONSE', 'RESPONSE_TOO_LARGE', 'UNTRUSTED_HOST'].includes(cause.code)) throw cause
      throw error('NETWORK_ERROR', '无法连接微信服务，请检查网络后重试')
    } finally {
      clearTimeout(timer)
      if (onAbort) signal.removeEventListener('abort', onAbort)
    }
  }

  function purgeRecent() {
    for (const [key, value] of recentInbound) if (value.expiresAt <= now()) recentInbound.delete(key)
    while (recentInbound.size > MAX_RECENT_REPLIES) recentInbound.delete(recentInbound.keys().next().value)
  }

  function receiptKey(credentials, message) {
    const tokenFingerprint = createHash('sha256').update(credentials.botToken).digest('hex')
    return createHash('sha256').update(JSON.stringify([credentials.botId, tokenFingerprint, message.id, message.peerId])).digest('hex')
  }

  return {
    async start({ signal } = {}) {
      const result = await request({ endpoint: 'ilink/bot/get_bot_qrcode?bot_type=3', body: { local_token_list: [] }, signal })
      const qrcode = string(result.qrcode, '微信二维码', 8192)
      const qrText = string(result.qrcode_img_content, '微信二维码内容', 8192)
      const expiresAt = now() + WECHAT_QR_TTL_MS
      return { status: 'waiting', qrText, expiresAt, challenge: { qrcode, baseUrl: WECHAT_API_BASE, expiresAt } }
    },

    async poll({ challenge, credentials, signal } = {}) {
      if (!challenge || typeof challenge !== 'object' || Array.isArray(challenge)) throw error('INVALID_INPUT', '请先获取微信二维码')
      const qrcode = string(challenge.qrcode, '微信二维码', 8192)
      const baseUrl = validateWeChatBaseUrl(challenge.baseUrl || WECHAT_API_BASE)
      if (!Number.isFinite(challenge.expiresAt)) throw error('INVALID_INPUT', '微信二维码有效期无效')
      if (challenge.expiresAt <= now()) return { status: 'expired', expiresAt: challenge.expiresAt }
      const query = new URLSearchParams({ qrcode })
      if (challenge.verifyCode !== undefined) {
        const code = string(challenge.verifyCode, '微信验证码', 16)
        if (!/^\d{4,12}$/.test(code)) throw error('INVALID_INPUT', '请输入手机微信显示的数字验证码')
        query.set('verify_code', code)
      }
      const result = await request({ baseUrl, endpoint: 'ilink/bot/get_qrcode_status?' + query, method: 'GET', signal, timeout: 38_000 })
      const common = { challenge: { ...challenge, baseUrl }, expiresAt: challenge.expiresAt }
      switch (result.status) {
        case 'wait': return { ...common, status: 'waiting' }
        case 'scaned': {
          const nextChallenge = { ...common.challenge }
          delete nextChallenge.verifyCode
          return { ...common, challenge: nextChallenge, status: 'scanned' }
        }
        case 'expired': return { status: 'expired', expiresAt: challenge.expiresAt }
        case 'need_verifycode': return { ...common, status: 'scanned', verificationRequired: true, message: '请输入手机微信显示的数字验证码，以继续连接' }
        case 'verify_code_blocked': return { status: 'error', error: '微信验证码多次不匹配，请稍后刷新二维码重试' }
        case 'scaned_but_redirect': {
          const host = string(result.redirect_host, '微信路由地址', 512)
          const redirected = validateWeChatBaseUrl('https://' + host)
          return { ...common, status: 'scanned', challenge: { ...challenge, baseUrl: redirected } }
        }
        case 'binded_redirect': {
          if (!credentials) return { status: 'error', error: '微信提示此账号已经连接，但本角色没有可用凭证，请在微信中解除旧连接后重试' }
          const saved = credentialsOf(credentials)
          return { status: 'connected', credentials: saved, account: accountOf(saved), alreadyConnected: true }
        }
        case 'confirmed': {
          // A status string alone is not proof of a working login.
          const saved = credentialsOf({ botToken: result.bot_token, botId: result.ilink_bot_id,
            userId: result.ilink_user_id || '', baseUrl: result.baseurl || baseUrl })
          return { status: 'connected', credentials: saved, account: accountOf(saved) }
        }
        default: throw error('INVALID_RESPONSE', '微信返回了未知登录状态，请稍后刷新二维码')
      }
    },

    async receive({ credentials, cursor = '', signal } = {}) {
      const saved = credentialsOf(credentials)
      string(cursor, '微信消息游标', MAX_CURSOR, { empty: true })
      const result = await request({ baseUrl: saved.baseUrl, endpoint: 'ilink/bot/getupdates',
        body: { get_updates_buf: cursor, base_info: baseInfo() }, credentials: saved, signal, timeout: 40_000 })
      const nextCursor = result.get_updates_buf === undefined || result.get_updates_buf === '' ? cursor
        : string(result.get_updates_buf, '微信消息游标', MAX_CURSOR)
      if (result.msgs !== undefined && !Array.isArray(result.msgs)) throw error('INVALID_RESPONSE', '微信消息列表格式无法识别')
      const messages = []
      purgeRecent()
      for (const incoming of result.msgs ?? []) {
        if (!incoming || incoming.message_type !== 1 || incoming.group_id || incoming.delete_time_ms || !Array.isArray(incoming.item_list)) continue
        let id, peerId, contextToken
        try {
          id = identifier(incoming.message_id ?? incoming.client_id, '微信消息标识')
          peerId = identifier(incoming.from_user_id, '微信消息来源')
          contextToken = string(incoming.context_token, '微信回复上下文', 16_384)
        } catch { continue }
        if (peerId === saved.botId || (incoming.to_user_id && incoming.to_user_id !== saved.botId)) continue
        const text = incoming.item_list.filter(item => item?.type === 1 && typeof item.text_item?.text === 'string')
          .map(item => item.text_item.text).join('\n').trim()
        if (!text || text.length > MAX_TEXT) continue
        const message = { id, peerId, text, contextToken }
        const key = receiptKey(saved, message)
        const prior = recentInbound.get(key)
        recentInbound.set(key, { peerId, contextToken, clientId: prior?.clientId ?? 'yangyu-' + randomUUID(), expiresAt: now() + REPLY_TTL_MS })
        messages.push(message)
      }
      purgeRecent()
      return { cursor: nextCursor, messages }
    },

    async send({ credentials, message, text, signal } = {}) {
      const saved = credentialsOf(credentials)
      if (!message || typeof message !== 'object' || Array.isArray(message)) throw error('INVALID_INPUT', '缺少可回复的微信入站消息')
      identifier(message.id, '微信消息标识')
      identifier(message.peerId, '微信消息来源')
      string(message.contextToken, '微信回复上下文', 16_384)
      string(text, '微信回复内容', MAX_TEXT)
      purgeRecent()
      const receipt = recentInbound.get(receiptKey(saved, message))
      if (!receipt || receipt.peerId !== message.peerId || receipt.contextToken !== message.contextToken) {
        throw error('INVALID_REPLY', '只能回复此连接最近收到的微信消息，不能指定其他收件人')
      }
      const clientId = receipt.clientId
      const result = await request({ baseUrl: saved.baseUrl, endpoint: 'ilink/bot/sendmessage', credentials: saved, signal,
        body: { msg: { from_user_id: '', to_user_id: receipt.peerId, client_id: clientId,
          message_type: 2, message_state: 2, context_token: receipt.contextToken,
          item_list: [{ type: 1, text_item: { text } }] }, base_info: baseInfo() } })
      if (result.ret !== 0) throw error('INVALID_RESPONSE', '微信未确认发送结果，请检查连接状态')
      recentInbound.delete(receiptKey(saved, message))
      return { ok: true, messageId: result.message_id ?? clientId }
    },
  }
}
