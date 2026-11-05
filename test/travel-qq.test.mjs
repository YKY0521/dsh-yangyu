import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { createHash } from 'node:crypto'
import { createQQAdapter, discoverQQConfig } from '../lib/travel-qq.js'

const configuration = () => ({ webUiUrl: 'http://127.0.0.1:6099', webUiToken: 'fixture-web-token',
  wsUrl: 'ws://127.0.0.1:3001', accessToken: 'fixture-onebot-token', allowedUids: ['10001'] })
const credentials = () => ({ ...configuration(), webCredential: 'fixture-credential', accountId: '90001', expectedQQ: '90001' })

test('QQ supports a private per-role service override without sharing the old bridge instance', t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'yangyu-qq-override-'))
  t.after(() => fs.rmSync(home, { recursive: true, force: true }))
  fs.mkdirSync(path.join(home, 'storages', 'dsh-yangyu'), { recursive: true })
  fs.mkdirSync(path.join(home, 'qq-bridge'), { recursive: true })
  fs.writeFileSync(path.join(home, 'qq-bridge', 'config.json'), JSON.stringify({ enabled: true, wsUrl: 'ws://127.0.0.1:3001', ownerUid: 10001 }))
  fs.writeFileSync(path.join(home, 'storages', 'dsh-yangyu', 'qq-service.json'), JSON.stringify({
    default: configuration(), characters: { fish_second: { ...configuration(), webUiUrl: 'http://127.0.0.1:6100', wsUrl: 'ws://127.0.0.1:3002' } },
  }))
  const second = discoverQQConfig({ home, userHome: home, characterId: 'fish_second' })
  assert.equal(second.webUiUrl, 'http://127.0.0.1:6100')
  assert.equal(second.wsUrl, 'ws://127.0.0.1:3002/')
  assert.equal(second.legacyBridgeEnabled, false)
  assert.equal(discoverQQConfig({ home, userHome: home, characterId: 'fish_other' }).legacyBridgeEnabled, true)
})
const response = data => ({ ok: true, headers: new Map(), async text() { return JSON.stringify({ code: 0, data }) } })
function webFixture(overrides = {}) {
  const calls = []
  let state = { isLogin: false, loginPhase: 'waiting_qrcode', qrcodeurl: 'https://qq.example.test/qr/old', ...overrides.state }
  let account = '90001'
  const fetchImpl = async (url, options) => {
    const endpoint = new URL(url).pathname.replace('/api', '')
    calls.push({ endpoint, options })
    if (overrides.handler) {
      const result = await overrides.handler(endpoint, options, calls)
      if (result) return result
    }
    if (endpoint === '/auth/login') return response({ Credential: 'fixture-credential' })
    if (endpoint === '/QQLogin/CheckLoginStatus') return response(state)
    if (endpoint === '/QQLogin/GetQQLoginInfo') return response({ uin: account, nick: '测试鱼', online: true })
    if (endpoint === '/QQLogin/RefreshQRcode') {
      state = { ...state, qrcodeurl: 'https://qq.example.test/qr/new' }
      return response({ qrcodeurl: state.qrcodeurl })
    }
    throw new Error('Unexpected endpoint')
  }
  return { fetchImpl, calls, setState(value) { state = { ...state, ...value } }, setAccount(value) { account = value } }
}

function socketFixture() {
  const sockets = []
  const sent = []
  let account = '90001'
  class Socket extends EventTarget {
    readyState = 0
    constructor(url) {
      super()
      this.url = url
      sockets.push(this)
      queueMicrotask(() => { this.readyState = 1; this.dispatchEvent(new Event('open')) })
    }
    emit(value) { this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(value) })) }
    send(raw) {
      const value = JSON.parse(raw)
      sent.push(value)
      queueMicrotask(() => this.emit({ status: 'ok', retcode: 0, echo: value.echo,
        data: value.action === 'get_login_info' ? { user_id: account } : { message_id: 'reply-1' } }))
    }
    close() { this.readyState = 3; this.dispatchEvent(new Event('close')) }
  }
  return { Socket, sockets, sent, setAccount(value) { account = value } }
}

const privateMessage = (id, extra = {}) => ({ post_type: 'message', message_type: 'private', self_id: '90001',
  user_id: '10001', message_id: id, message: [{ type: 'text', data: { text: '测试消息' } }], ...extra })

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yangyu-qq-test-'))
  t.after(() => {
    const resolved = path.resolve(root)
    assert.ok(resolved.startsWith(path.resolve(os.tmpdir()) + path.sep))
    assert.match(path.basename(resolved), /^yangyu-qq-test-/)
    fs.rmSync(resolved, { recursive: true, force: true })
  })
  return root
}

test('QQ discovery reads only configured known paths and safely returns null when absent', t => {
  const root = fixture(t)
  assert.equal(discoverQQConfig({ home: path.join(root, 'home'), userHome: root }), null)
})

test('QQ discovery preserves host-only secrets, allowlist and verified launcher files', t => {
  const root = fixture(t)
  const home = path.join(root, 'home')
  const base = path.join(root, 'napcat', 'onekey', 'NapCat.52230.Shell')
  const app = path.join(base, 'versions', '9.9.33-52230', 'resources', 'app', 'napcat')
  fs.mkdirSync(path.join(home, 'qq-bridge'), { recursive: true })
  fs.mkdirSync(path.join(app, 'config'), { recursive: true })
  fs.writeFileSync(path.join(home, 'qq-bridge', 'config.json'), JSON.stringify({ enabled: true, wsUrl: 'ws://127.0.0.1:3001', accessToken: 'onebot-fixture', ownerUid: 10001, allowedUids: ['10002', '10001', 'invalid'] }))
  fs.writeFileSync(path.join(app, 'config', 'webui.json'), JSON.stringify({ token: 'web-fixture', port: 6099 }))
  fs.writeFileSync(path.join(base, 'QQ.exe'), '')
  for (const name of ['NapCatWinBootMain.exe', 'NapCatWinBootHook.dll', 'qqnt.json', 'loadNapCat.js', 'napcat.mjs']) fs.writeFileSync(path.join(app, name), '')
  const config = discoverQQConfig({ home, userHome: root })
  assert.equal(config.webUiToken, 'web-fixture')
  assert.equal(config.accessToken, 'onebot-fixture')
  assert.deepEqual(config.allowedUids, ['10001', '10002'])
  assert.equal(config.legacyBridgeEnabled, true)
  assert.equal(config.launch.qqExe, path.join(base, 'QQ.exe'))
  assert.equal(config.webUiConfigPath, path.join(app, 'config', 'webui.json'))
})

test('QQ start authenticates WebUI and really refreshes the QR challenge', async () => {
  const web = webFixture()
  const adapter = createQQAdapter({ fetchImpl: web.fetchImpl, now: () => 1000 })
  const value = await adapter.start({ config: configuration() })
  assert.equal(value.status, 'waiting')
  assert.equal(value.qrText, 'https://qq.example.test/qr/new')
  assert.equal(value.expiresAt, 121000)
  assert.equal(value.challenge.config.webCredential, 'fixture-credential')
  const login = web.calls.find(c => c.endpoint === '/auth/login')
  assert.equal(JSON.parse(login.options.body).hash, createHash('sha256').update('fixture-web-token.napcat').digest('hex'))
  assert.equal(web.calls.filter(c => c.endpoint === '/QQLogin/RefreshQRcode').length, 1)
  assert.equal(web.calls.find(c => c.endpoint === '/QQLogin/RefreshQRcode').options.headers.Authorization, 'Bearer fixture-credential')
})

test('QQ poll exposes scan, expiry and real connected account without inventing login', async () => {
  const web = webFixture()
  let clock = 1000
  const adapter = createQQAdapter({ fetchImpl: web.fetchImpl, now: () => clock })
  let result = await adapter.start({ config: configuration() })
  web.setState({ loginPhase: 'qrcode_scanned', qrLoginAccepted: true })
  result = await adapter.poll(result)
  assert.equal(result.status, 'scanned')
  web.setState({ loginPhase: 'waiting_qrcode', qrLoginAccepted: false })
  clock = 122000
  result = await adapter.poll(result)
  assert.equal(result.status, 'expired')
  web.setState({ isLogin: true, coreReady: true })
  result = await adapter.poll(result)
  assert.equal(result.status, 'connected')
  assert.deepEqual(result.account, { id: '90001', name: '测试鱼' })
  assert.equal(result.credentials.expectedQQ, '90001')
  assert.equal(web.calls.filter(c => c.endpoint === '/auth/login').length, 1)
})

test('QQ never refreshes an already logged in account and detects account replacement', async () => {
  const web = webFixture({ state: { isLogin: true, coreReady: true } })
  const adapter = createQQAdapter({ fetchImpl: web.fetchImpl })
  const connected = await adapter.start({ config: configuration() })
  assert.equal(connected.status, 'connected')
  assert.ok(!web.calls.some(c => c.endpoint === '/QQLogin/RefreshQRcode'))
  web.setAccount('90002')
  await assert.rejects(adapter.poll(connected), /账号已更换/)
})

test('QQ auth expiry renews once, but 2FA remains a user step', async () => {
  let invalid = true
  const web = webFixture({ handler(endpoint) {
    if (endpoint === '/QQLogin/CheckLoginStatus' && invalid) {
      invalid = false
      return { ok: true, async text() { return JSON.stringify({ code: -1, message: 'Unauthorized' }) } }
    }
  } })
  const adapter = createQQAdapter({ fetchImpl: web.fetchImpl })
  await adapter.poll({ credentials: credentials() })
  assert.equal(web.calls.filter(c => c.endpoint === '/auth/login').length, 1)
  const twoFactor = createQQAdapter({ fetchImpl: async () => response({ require2FA: true }) })
  await assert.rejects(twoFactor.start({ config: configuration() }), /二次验证/)
})

test('QQ restricts endpoint origins and honours cancellation before network I/O', async () => {
  let calls = 0
  const adapter = createQQAdapter({ fetchImpl: async () => { calls++; return response({}) } })
  await assert.rejects(adapter.start({ config: { ...configuration(), webUiUrl: 'http://example.com' } }), /本机回环/)
  await assert.rejects(adapter.start({ config: { ...configuration(), wsUrl: 'ws://user:pass@127.0.0.1:3001' } }), /本机回环/)
  const controller = new AbortController(); controller.abort()
  await assert.rejects(adapter.start({ config: configuration(), signal: controller.signal }), /已取消/)
  assert.equal(calls, 0)
})

test('QQ receive accepts only own-account allowlisted private text, with bounded dedupe and cursor', async () => {
  const mock = socketFixture()
  const adapter = createQQAdapter({ WebSocketImpl: mock.Socket })
  const c = credentials()
  let result = await adapter.receive({ credentials: c })
  const socket = mock.sockets[0]
  assert.equal(new URL(socket.url).searchParams.get('access_token'), c.accessToken)
  socket.emit(privateMessage('stranger', { user_id: '10002' }))
  socket.emit(privateMessage('group', { message_type: 'group' }))
  socket.emit(privateMessage('own', { user_id: '90001' }))
  socket.emit(privateMessage('file', { message: [{ type: 'file', data: { file: 'private' } }] }))
  socket.emit(privateMessage('allowed'))
  socket.emit(privateMessage('allowed'))
  result = await adapter.receive({ credentials: c, cursor: result.cursor })
  assert.equal(result.messages.length, 1)
  assert.equal(result.messages[0].peerId, '10001')
  assert.equal(result.messages[0].text, '测试消息')
  assert.match(result.messages[0].contextToken, /^[a-f0-9]{48}$/)
  assert.equal((await adapter.receive({ credentials: c, cursor: result.cursor })).messages.length, 0)
  adapter.close(c)
})

test('QQ send is tied to a received message and cannot broadcast or duplicate a reply', async () => {
  const mock = socketFixture()
  const adapter = createQQAdapter({ WebSocketImpl: mock.Socket })
  const c = credentials()
  await adapter.receive({ credentials: c })
  mock.sockets[0].emit(privateMessage('m1'))
  const [message] = (await adapter.receive({ credentials: c })).messages
  await assert.rejects(adapter.send({ credentials: c, message: { ...message, peerId: '10002' }, text: '不会发送' }), /白名单私聊/)
  assert.ok(!mock.sent.some(x => x.action === 'send_private_msg'))
  const result = await adapter.send({ credentials: c, message, text: '合成测试回复' })
  assert.equal(result.ok, true)
  assert.equal(mock.sent[0].action, 'get_login_info')
  const outgoing = mock.sent.find(x => x.action === 'send_private_msg')
  assert.equal(outgoing.params.user_id, 10001)
  assert.deepEqual(outgoing.params.message, [{ type: 'text', data: { text: '合成测试回复' } }])
  await assert.rejects(adapter.send({ credentials: c, message, text: '不会重复' }), /白名单私聊/)
  assert.equal(mock.sent.filter(x => x.action === 'send_private_msg').length, 1)
  adapter.close(c)
})

test('QQ rejects empty allowlists and changes in WS self_id before they can reach a role', async () => {
  const mock = socketFixture()
  const adapter = createQQAdapter({ WebSocketImpl: mock.Socket })
  await assert.rejects(adapter.receive({ credentials: { ...credentials(), allowedUids: [] } }), /白名单/)
  assert.equal(mock.sockets.length, 0)
  await adapter.receive({ credentials: credentials() })
  mock.sockets[0].emit(privateMessage('m1', { self_id: '90002' }))
  await assert.rejects(adapter.receive({ credentials: credentials() }), /账号已更换/)
  assert.equal(mock.sockets[0].readyState, 3)
  adapter.close()
})

test('QQ rechecks the live account immediately before sending and refuses a switched account', async () => {
  const mock = socketFixture()
  const adapter = createQQAdapter({ WebSocketImpl: mock.Socket })
  await adapter.receive({ credentials: credentials() })
  mock.sockets[0].emit(privateMessage('m1'))
  const [message] = (await adapter.receive({ credentials: credentials() })).messages
  mock.setAccount('90002')
  await assert.rejects(adapter.send({ credentials: credentials(), message, text: '不会串发' }), /账号已更换/)
  assert.ok(!mock.sent.some(x => x.action === 'send_private_msg'))
  adapter.close()
})

test('QQ receive cursors do not drop messages after a fresh adapter connection', async () => {
  const mock = socketFixture()
  const adapter = createQQAdapter({ WebSocketImpl: mock.Socket })
  const first = await adapter.receive({ credentials: credentials() })
  adapter.close()
  await adapter.receive({ credentials: credentials(), cursor: first.cursor })
  mock.sockets[1].emit(privateMessage('m2'))
  const second = await adapter.receive({ credentials: credentials(), cursor: first.cursor })
  assert.equal(second.messages.length, 1)
  assert.notEqual(second.cursor.split(':')[0], first.cursor.split(':')[0])
  adapter.close()
})
