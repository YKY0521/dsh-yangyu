import { randomUUID } from 'node:crypto'

const PLATFORMS = ['wechat', 'qq']
const labelOf = platform => platform === 'wechat' ? '微信' : 'QQ'
const keyOf = (id, platform) => `${id}:${platform}`
const masked = value => {
  const text = String(value ?? '')
  return text.length > 6 ? `${text.slice(0, 2)}***${text.slice(-3)}` : '已绑定账号'
}
const pause = (ms, signal) => new Promise(resolve => {
  if (signal.aborted) return resolve()
  const timer = setTimeout(done, ms)
  function done() { clearTimeout(timer); signal.removeEventListener('abort', done); resolve() }
  signal.addEventListener('abort', done, { once: true })
})

/** QR challenges stay in memory; only confirmed authorizations enter private storage. */
export function createTravelManager({ store, privateState, adapters, resolveQQ, ensureQQ, renderQR, reply, now = Date.now }) {
  const jobs = new Map()
  const workers = new Map()
  const polls = new Map()
  const starts = new Set()
  let closed = false

  function valid(id, platform) {
    store.getCharacter(id)
    if (!PLATFORMS.includes(platform)) throw new Error('不支持的出游平台')
    if (closed) throw new Error('出游连接已停止')
  }
  function current(id, platform) { return jobs.get(keyOf(id, platform)) ?? privateState.get(id, platform) }
  function update(id, platform, generation, patch) {
    const c = privateState.get(id, platform)
    if (!c || c.generation !== generation) return false
    privateState.put({ ...c, ...patch })
    return true
  }
  function safeError(error, c) {
    let text = String(error?.message || '连接失败，请重试').slice(0, 350)
    for (const value of [...Object.values(c?.credentials ?? {}), ...Object.values(c?.config ?? {})]) {
      if (typeof value === 'string' && value.length > 6) text = text.split(value).join('[已隐藏]')
    }
    return text.replace(/Bearer\s+\S+|(?:bot_token|access_token|token|Credential)[=:]\s*[^\s,;]+/gi, '[授权信息已隐藏]')
  }
  function stopWorker(id, platform) {
    const key = keyOf(id, platform)
    const worker = workers.get(key)
    if (worker) worker.abort()
    workers.delete(key)
    const c = privateState.get(id, platform)
    if (c?.credentials) try { adapters[platform].close?.(c.credentials) } catch { /* local cleanup must still allow disconnect */ }
  }
  function invalidateJob(id, platform) {
    const key = keyOf(id, platform)
    const job = jobs.get(key)
    job?.controller?.abort()
    jobs.delete(key)
    polls.delete(key)
  }
  function assertQQLease(id, config) {
    const resource = config.webUiUrl
    for (const c of [...privateState.list(), ...jobs.values()]) {
      if (c.platform === 'qq' && c.characterId !== id && c.resource === resource) {
        let name = '另一位角色'
        try { name = store.getCharacter(c.characterId).character.name } catch { /* deleted role */ }
        throw new Error(`这套 QQ 连接正在由“${name}”使用；请先解除该角色的连接，或使用另一套 QQ 实例`)
      }
    }
  }
  async function acceptConnected(id, platform, generation, result, job) {
    if (jobs.get(keyOf(id, platform)) !== job || job.controller.signal.aborted) return
    const credentials = result.credentials ?? job.credentials
    if (!credentials || !result.account?.id) throw new Error('平台没有返回完整授权，不能确认登录')
    for (const c of privateState.list()) {
      if (c.platform === platform && c.characterId !== id && c.account?.id === result.account.id) {
        throw new Error('这个账号已连接到另一位角色，请先解除原角色的连接')
      }
    }
    store.getCharacter(id)
    privateState.put({ characterId: id, platform, generation, status: 'connected', credentials,
      account: result.account, resource: job.resource, chatEnabled: true, cursor: '', seenIds: [], peerSessions: {}, updatedAt: now() })
    jobs.delete(keyOf(id, platform))
    startWorker(id, platform)
  }
  async function applyResult(id, platform, job, result) {
    if (jobs.get(keyOf(id, platform)) !== job || job.controller.signal.aborted) return
    if (result.status === 'connected') return acceptConnected(id, platform, job.generation, result, job)
    job.status = result.status
    job.verificationRequired = result.verificationRequired === true
    job.message = result.message ?? result.error
    if (result.credentials) job.credentials = result.credentials
    if (result.challenge) job.challenge = result.challenge
    if (result.expiresAt) job.expiresAt = result.expiresAt
    if (result.qrText && result.qrText !== job.qrText) {
      if (typeof result.qrText !== 'string' || result.qrText.length > 4096) throw new Error('平台返回的二维码内容无效')
      const image = await renderQR(result.qrText)
      if (jobs.get(keyOf(id, platform)) !== job || job.controller.signal.aborted) return
      job.qrText = result.qrText
      job.image = image
    }
  }

  async function start(id, platform, refresh = false, generation) {
    valid(id, platform)
    const key = keyOf(id, platform)
    if (starts.has(key)) throw new Error('正在获取二维码，请稍候')
    const existing = current(id, platform)
    if (generation && existing && existing.generation !== generation) throw new Error('二维码已更新，请刷新页面')
    if (existing?.credentials && existing.status === 'connected') return view(id)
    starts.add(key)
    let job
    try {
      let config
      if (platform === 'qq') {
        config = await resolveQQ(id)
        if (!config) throw new Error('没有找到可用的 QQ 扫码服务，请先安装并配置 NapCat')
        if (config.legacyBridgeEnabled) throw new Error('原“小鱼”QQ 桥还在使用这套连接，请先停用旧桥，再连接养鱼角色')
        assertQQLease(id, config)
      }
      invalidateJob(id, platform)
      stopWorker(id, platform)
      privateState.remove(id, platform)
      job = { characterId: id, platform, generation: randomUUID(), controller: new AbortController(), status: 'waiting',
        config, resource: config?.webUiUrl, expiresAt: now() + 300_000, message: '正在获取登录二维码' }
      jobs.set(key, job)
      if (platform === 'qq') await ensureQQ?.(config, job.controller.signal)
      const result = await adapters[platform].start({ config, refresh, signal: job.controller.signal })
      await applyResult(id, platform, job, result)
      return view(id)
    } catch (error) {
      if (job && jobs.get(key) === job && !job.controller.signal.aborted) {
        job.status = 'error'; job.message = safeError(error, job); job.image = null
      }
      throw new Error(safeError(error, job))
    } finally { starts.delete(key) }
  }

  async function poll(id, platform) {
    valid(id, platform)
    const key = keyOf(id, platform)
    const job = jobs.get(key)
    if (!job || !['waiting', 'scanned'].includes(job.status)) return
    if (now() >= job.expiresAt) { job.status = 'expired'; job.image = null; job.controller.abort(); return }
    if (polls.has(key)) return polls.get(key)
    const controller = job.controller
    const promise = (async () => {
      try {
        const result = await adapters[platform].poll({ challenge: job.challenge, credentials: job.credentials, signal: controller.signal })
        if (job.controller === controller) await applyResult(id, platform, job, result)
      } catch (error) {
        if (jobs.get(key) === job && job.controller === controller && !controller.signal.aborted) { job.status = 'error'; job.message = safeError(error, job); job.image = null }
      }
    })()
    polls.set(key, promise)
    try { await promise } finally { if (polls.get(key) === promise) polls.delete(key) }
  }

  function startWorker(id, platform) {
    if (closed || workers.has(keyOf(id, platform))) return
    const c = privateState.get(id, platform)
    if (!c?.credentials || !c.chatEnabled || c.status !== 'connected') return
    const controller = new AbortController()
    const signal = controller.signal
    const key = keyOf(id, platform)
    workers.set(key, controller)
    ;(async () => {
      try {
        while (!signal.aborted && !closed) {
          let active = privateState.get(id, platform)
          if (!active || active.generation !== c.generation || !active.chatEnabled) break
          store.getCharacter(id)
          const batch = await adapters[platform].receive({ credentials: active.credentials, cursor: active.cursor, signal })
          if (signal.aborted) break
          if (platform === 'qq' && (await resolveQQ(id))?.legacyBridgeEnabled) throw new Error('原“小鱼”QQ 桥已重新启用，养鱼聊天已暂停，避免重复回复')
          for (const message of batch.messages ?? []) {
            active = privateState.get(id, platform)
            if (signal.aborted || !active || active.generation !== c.generation || !active.chatEnabled) break
            if (!message?.id || !message.peerId || typeof message.text !== 'string' || !message.text.trim()) continue
            if (platform === 'wechat' && message.peerId !== active.credentials.userId) continue
            if (active.seenIds?.includes(message.id)) continue
            // Reserve before generating/sending: replay or ambiguous transport errors never duplicate a reply.
            update(id, platform, c.generation, { seenIds: [...(active.seenIds ?? []), message.id].slice(-256) })
            const text = await reply({ characterId: id, platform, message, generation: c.generation, signal })
            active = privateState.get(id, platform)
            if (signal.aborted || !active || active.generation !== c.generation || !active.chatEnabled) break
            await adapters[platform].send({ credentials: active.credentials, message, text, signal })
            update(id, platform, c.generation, { lastReplyAt: now(), message: '' })
          }
          if (!signal.aborted && batch.cursor !== undefined) update(id, platform, c.generation, { cursor: batch.cursor })
          if (!(batch.messages ?? []).length) await pause(500, signal)
        }
      } catch (error) {
        if (!signal.aborted && !closed) update(id, platform, c.generation, {
          status: error?.code === 'AUTH_EXPIRED' ? 'expired' : 'error', chatEnabled: false,
          message: safeError(error, privateState.get(id, platform)),
        })
      } finally {
        if (workers.get(key) === controller) workers.delete(key)
      }
    })()
  }

  function publicState(id, platform) {
    const c = current(id, platform)
    const state = { platform, label: labelOf(platform), status: c?.status ?? 'disconnected',
      chatEnabled: c?.chatEnabled === true, message: c?.message ?? '', generation: c?.generation }
    if (c?.verificationRequired) { state.verificationRequired = true; state.message = '请填写手机微信显示的数字验证码，或刷新二维码重试' }
    if (c?.account) state.account = { idMasked: masked(c.account.id), name: String(c.account.name || '已连接账号').slice(0, 100) }
    if (c?.image && ['waiting', 'scanned'].includes(c.status)) state.qr = { image: c.image, expiresAt: c.expiresAt, generation: c.generation }
    if (c?.lastReplyAt) state.lastReplyAt = c.lastReplyAt
    return state
  }
  function view(id) {
    store.getCharacter(id)
    return { ok: true, platforms: PLATFORMS.map(p => publicState(id, p)) }
  }
  return {
    view, start, poll, getConnection: (id, platform) => privateState.get(id, platform), updateConnection: update,
    async action({ characterId: id, platform, action, generation, code }) {
      valid(id, platform)
      if (action === 'start' || action === 'refresh') return start(id, platform, action === 'refresh', generation)
      const existing = current(id, platform)
      if (generation && existing && existing.generation !== generation) throw new Error('连接已更新，请刷新页面')
      if (action === 'verify') {
        const job = jobs.get(keyOf(id, platform))
        if (platform !== 'wechat' || !job?.verificationRequired || !job.challenge) throw new Error('当前连接不需要验证码')
        if (typeof code !== 'string' || !/^\d{4,12}$/.test(code)) throw new Error('请输入手机微信显示的数字验证码')
        job.challenge.verifyCode = code
        // Abort the prior status request before submitting a different verification state.
        job.controller.abort()
        job.controller = new AbortController()
        polls.delete(keyOf(id, platform))
        await poll(id, platform)
      } else if (action === 'disconnect') {
        invalidateJob(id, platform); stopWorker(id, platform); privateState.remove(id, platform)
      } else if (action === 'chat.enable' || action === 'chat.disable') {
        const c = privateState.get(id, platform)
        if (!c?.credentials) throw new Error('请先扫码连接账号')
        if (action === 'chat.disable') { update(id, platform, c.generation, { chatEnabled: false }); stopWorker(id, platform) }
        else {
          if (platform === 'qq' && (await resolveQQ(id))?.legacyBridgeEnabled) throw new Error('请先停用原“小鱼”QQ桥')
          update(id, platform, c.generation, { chatEnabled: true, status: 'connected', message: '' }); startWorker(id, platform)
        }
      } else throw new Error('未知出游操作')
      return view(id)
    },
    removeCharacter(id) {
      for (const p of PLATFORMS) { invalidateJob(id, p); stopWorker(id, p) }
      privateState.remove(id)
    },
    resume() {
      for (const c of privateState.list()) {
        try { store.getCharacter(c.characterId); startWorker(c.characterId, c.platform) }
        catch { privateState.remove(c.characterId, c.platform) }
      }
    },
    close() {
      closed = true
      for (const job of jobs.values()) job.controller.abort()
      for (const controller of workers.values()) controller.abort()
      for (const c of privateState.list()) adapters[c.platform]?.close?.(c.credentials)
      jobs.clear(); workers.clear(); polls.clear()
    },
  }
}
