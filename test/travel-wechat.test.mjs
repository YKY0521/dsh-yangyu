import test from 'node:test'
import assert from 'node:assert/strict'
import { createWeChatAdapter, validateWeChatBaseUrl, WECHAT_API_BASE, WECHAT_QR_TTL_MS, WECHAT_MAX_RESPONSE_BYTES } from '../lib/travel-wechat.js'

const credentials = { botToken: 'test-private-token', baseUrl: WECHAT_API_BASE, botId: 'fish@im.bot', userId: 'owner@im.wechat' }
const incoming = { message_id: '100', from_user_id: 'friend@im.wechat', to_user_id: credentials.botId,
  message_type: 1, item_list: [{ type: 1, text_item: { text: '你好小鱼' } }], context_token: 'test-context-token' }

function fixture(responses, initialTime = 1000) {
  const calls = []
  let time = initialTime
  const adapter = createWeChatAdapter({ now: () => time, fetchImpl: async (url, options) => {
    calls.push({ url: String(url), ...options })
    const next = responses.shift()
    assert.notEqual(next, undefined, 'unexpected outbound request')
    if (next instanceof Error) throw next
    return next instanceof Response ? next : Response.json(next)
  } })
  return { adapter, calls, setTime: value => { time = value } }
}

test('QR start uses current official POST wire format and returns content for local encoding', async () => {
  const f = fixture([{ qrcode: 'opaque-qr', qrcode_img_content: 'https://liteapp.weixin.qq.com/q/example' }])
  const result = await f.adapter.start()
  assert.equal(result.status, 'waiting')
  assert.equal(result.qrText, 'https://liteapp.weixin.qq.com/q/example')
  assert.equal(result.expiresAt, 1000 + WECHAT_QR_TTL_MS)
  assert.equal(result.credentials, undefined)
  const call = f.calls[0]
  assert.equal(call.method, 'POST')
  assert.equal(call.url, WECHAT_API_BASE + '/ilink/bot/get_bot_qrcode?bot_type=3')
  assert.deepEqual(JSON.parse(call.body), { local_token_list: [] })
  assert.equal(call.headers['iLink-App-Id'], 'bot')
  assert.equal(call.headers['iLink-App-ClientVersion'], '132106')
  assert.equal(call.headers.AuthorizationType, 'ilink_bot_token')
  assert.match(Buffer.from(call.headers['X-WECHAT-UIN'], 'base64').toString(), /^\d+$/)
  assert.equal(call.headers.Authorization, undefined)
  assert.equal(call.redirect, 'manual')
})

test('poll encodes opaque QR, handles scan/verification/expiry and only confirms with credentials', async () => {
  const f = fixture([{ status: 'wait' }, { status: 'scaned' }, { status: 'need_verifycode' }, { status: 'confirmed', bot_token: credentials.botToken,
    ilink_bot_id: credentials.botId, ilink_user_id: credentials.userId, baseurl: WECHAT_API_BASE }, { status: 'expired' }])
  const challenge = { qrcode: 'QR?&=+', baseUrl: WECHAT_API_BASE, expiresAt: 999999 }
  assert.equal((await f.adapter.poll({ challenge })).status, 'waiting')
  assert.equal(new URL(f.calls[0].url).searchParams.get('qrcode'), challenge.qrcode)
  assert.equal(f.calls[0].headers.Authorization, undefined)
  assert.equal(f.calls[0].headers.AuthorizationType, undefined)
  assert.equal((await f.adapter.poll({ challenge })).status, 'scanned')
  assert.equal((await f.adapter.poll({ challenge })).verificationRequired, true)
  const confirmed = await f.adapter.poll({ challenge: { ...challenge, verifyCode: '123456' } })
  assert.equal(confirmed.status, 'connected')
  assert.deepEqual(confirmed.credentials, credentials)
  assert.equal(confirmed.account.id, credentials.userId)
  assert.equal(new URL(f.calls[3].url).searchParams.get('verify_code'), '123456')
  assert.equal((await f.adapter.poll({ challenge })).status, 'expired')
  await assert.rejects(f.adapter.poll({ challenge: { ...challenge, verifyCode: '123&x=1' } }), { code: 'INVALID_INPUT' })
})

test('locally expired challenge does not poll or falsely report login', async () => {
  const f = fixture([])
  assert.equal((await f.adapter.poll({ challenge: { qrcode: 'expired', expiresAt: 999 } })).status, 'expired')
  assert.equal(f.calls.length, 0)
  const missing = fixture([{ status: 'confirmed' }])
  await assert.rejects(missing.adapter.poll({ challenge: { qrcode: 'valid', expiresAt: 99999 } }), { code: 'AUTH_EXPIRED' })
  const bound = fixture([{ status: 'binded_redirect' }])
  assert.equal((await bound.adapter.poll({ challenge: { qrcode: 'valid', expiresAt: 99999 } })).status, 'error')
})

test('refresh starts a new challenge with a new lifetime and never reuses old QR text', async () => {
  const f = fixture([{ qrcode: 'qr-one', qrcode_img_content: 'content-one' }, { qrcode: 'qr-two', qrcode_img_content: 'content-two' }])
  const one = await f.adapter.start()
  f.setTime(4000)
  const two = await f.adapter.start()
  assert.notEqual(one.challenge.qrcode, two.challenge.qrcode)
  assert.notEqual(one.qrText, two.qrText)
  assert.equal(two.expiresAt - one.expiresAt, 3000)
})

test('API URL and redirects cannot select arbitrary hosts or emit authorization to them', async () => {
  for (const value of ['http://ilinkai.weixin.qq.com', 'https://ilinkai.weixin.qq.com.evil.test', 'https://evil.test', 'https://127.0.0.1',
    'https://ilinkai.weixin.qq.com:8443', 'https://user:pass@ilinkai.weixin.qq.com', 'https://ilinkai.weixin.qq.com/other', 'https://ilinkai.weixin.qq.com/?x=1']) {
    assert.throws(() => validateWeChatBaseUrl(value), { code: 'UNTRUSTED_HOST' })
  }
  const f = fixture([{ status: 'scaned_but_redirect', redirect_host: 'evil.test' }, { status: 'confirmed', bot_token: credentials.botToken,
    ilink_bot_id: credentials.botId, baseurl: 'https://evil.test' }, new Response('', { status: 302, headers: { location: 'https://evil.test' } })])
  const challenge = { qrcode: 'valid', expiresAt: 99999 }
  await assert.rejects(f.adapter.poll({ challenge }), { code: 'UNTRUSTED_HOST' })
  await assert.rejects(f.adapter.poll({ challenge }), { code: 'UNTRUSTED_HOST' })
  await assert.rejects(f.adapter.start(), { code: 'UNTRUSTED_HOST' })
  assert.ok(f.calls.every(call => new URL(call.url).origin === WECHAT_API_BASE))
})

test('receive returns only replyable private inbound text and opaque cursor', async () => {
  const f = fixture([{ ret: 0, get_updates_buf: 'opaque/next?cursor=+', msgs: [incoming,
    { ...incoming, message_id: '2', message_type: 2 }, { ...incoming, message_id: '3', group_id: 'group' },
    { ...incoming, message_id: '4', from_user_id: credentials.botId }, { ...incoming, message_id: '5', context_token: '' },
    { ...incoming, message_id: '6', item_list: [{ type: 2, image_item: { url: 'https://evil.test/image' } }] },
    { ...incoming, message_id: '7', item_list: [{ type: 1, text_item: { text: '' } }] },
    { ...incoming, message_id: '8', to_user_id: 'another-bot@im.bot' }] }])
  const result = await f.adapter.receive({ credentials, cursor: 'opaque/old?cursor=+' })
  assert.equal(result.cursor, 'opaque/next?cursor=+')
  assert.deepEqual(result.messages, [{ id: '100', peerId: incoming.from_user_id, text: '你好小鱼', contextToken: incoming.context_token }])
  const call = f.calls[0]
  assert.equal(call.headers.Authorization, 'Bearer ' + credentials.botToken)
  assert.equal(JSON.parse(call.body).get_updates_buf, 'opaque/old?cursor=+')
  assert.equal(JSON.parse(call.body).base_info.bot_agent, 'Yangyu/0.2.0')
})

test('message uint64 IDs are preserved rather than rounded by JSON parsing', async () => {
  const source = JSON.stringify({ ret: 0, msgs: [incoming] }).replace('"100"', '18446744073709551615')
  const f = fixture([new Response(source)])
  const result = await f.adapter.receive({ credentials })
  assert.equal(result.messages[0].id, '18446744073709551615')
})

test('send can only reply to an actual matching received message and uses its context token', async () => {
  const f = fixture([{ ret: 0, msgs: [incoming] }, { ret: 0, message_id: 'reply-100' }])
  await assert.rejects(f.adapter.send({ credentials, message: { id: 'fake', peerId: incoming.from_user_id, contextToken: incoming.context_token }, text: '不应发送' }), { code: 'INVALID_REPLY' })
  const { messages: [message] } = await f.adapter.receive({ credentials })
  for (const patch of [{ peerId: 'other@im.wechat' }, { contextToken: 'wrong-context' }, { id: 'other' }]) {
    await assert.rejects(f.adapter.send({ credentials, message: { ...message, ...patch }, text: '不应发送' }), { code: 'INVALID_REPLY' })
  }
  await assert.rejects(f.adapter.send({ credentials: { ...credentials, botId: 'different@im.bot' }, message, text: '不应发送' }), { code: 'INVALID_REPLY' })
  await assert.rejects(f.adapter.send({ credentials: { ...credentials, botToken: 'another-login-token' }, message, text: '不应发送' }), { code: 'INVALID_REPLY' })
  const result = await f.adapter.send({ credentials, message: { ...message }, text: '你好，收到你的消息' })
  assert.deepEqual(result, { ok: true, messageId: 'reply-100' })
  assert.equal(f.calls.length, 2)
  const body = JSON.parse(f.calls[1].body)
  assert.equal(body.msg.to_user_id, message.peerId)
  assert.equal(body.msg.context_token, message.contextToken)
  assert.equal(body.msg.message_type, 2)
  assert.equal(body.msg.message_state, 2)
  assert.match(body.msg.client_id, /^yangyu-/)
  assert.deepEqual(body.msg.item_list, [{ type: 1, text_item: { text: '你好，收到你的消息' } }])
  await assert.rejects(f.adapter.send({ credentials, message, text: '不应重复发送' }), { code: 'INVALID_REPLY' })
})

test('reply receipts expire, preventing replay from old sessions', async () => {
  const f = fixture([{ ret: 0, msgs: [incoming] }])
  const { messages: [message] } = await f.adapter.receive({ credentials })
  f.setTime(1000 + 60 * 60_000)
  await assert.rejects(f.adapter.send({ credentials, message, text: '不应发送' }), { code: 'INVALID_REPLY' })
  assert.equal(f.calls.length, 1)
})

test('expired credentials and provider errors are sanitized and never reveal private tokens', async () => {
  const f = fixture([{ ret: -14, errmsg: credentials.botToken }, { errcode: -14, errmsg: credentials.botToken },
    new Response(credentials.botToken, { status: 500 }), new Error('URL included ' + credentials.botToken)])
  for (const code of ['AUTH_EXPIRED', 'AUTH_EXPIRED', 'HTTP_ERROR', 'NETWORK_ERROR']) {
    await assert.rejects(f.adapter.receive({ credentials }), cause => cause.code === code && !String(cause).includes(credentials.botToken))
  }
})

test('oversized JSON and malformed responses are rejected without exposing their content', async () => {
  const f = fixture([new Response('x', { headers: { 'content-length': String(WECHAT_MAX_RESPONSE_BYTES + 1) } }),
    new Response('x'.repeat(WECHAT_MAX_RESPONSE_BYTES + 1)), new Response('private-' + credentials.botToken), Response.json([])])
  for (const code of ['RESPONSE_TOO_LARGE', 'RESPONSE_TOO_LARGE', 'INVALID_RESPONSE', 'INVALID_RESPONSE']) {
    await assert.rejects(f.adapter.start(), cause => cause.code === code && !String(cause).includes(credentials.botToken))
  }
})

test('external cancellation propagates as a sanitized AbortError even when fetch ignores its signal', async () => {
  const controller = new AbortController()
  let started
  const ready = new Promise(resolve => { started = resolve })
  const adapter = createWeChatAdapter({ fetchImpl: () => { started(); return new Promise(() => {}) } })
  const pending = adapter.start({ signal: controller.signal })
  await ready
  controller.abort(new Error(credentials.botToken))
  await assert.rejects(pending, cause => cause.name === 'AbortError' && cause.code === 'ABORTED' && !String(cause).includes(credentials.botToken))
  await assert.rejects(adapter.start({ signal: controller.signal }), { name: 'AbortError' })
})

test('internal deadline bounds a fetch that never settles or honors cancellation', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const adapter = createWeChatAdapter({ fetchImpl: () => new Promise(() => {}) })
  const pending = adapter.start()
  t.mock.timers.tick(15_001)
  await assert.rejects(pending, cause => cause.code === 'TIMEOUT' && !String(cause).includes(credentials.botToken))
})
