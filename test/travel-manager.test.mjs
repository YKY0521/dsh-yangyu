import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createTravelManager } from '../lib/travel-manager.js'
import { createTravelState } from '../lib/travel-state.js'
import { createStore } from '../lib/store.js'

const clone = value => structuredClone(value)
const deferred = () => {
  let resolve, reject
  const promise = new Promise((a, b) => { resolve = a; reject = b })
  return { promise, resolve, reject }
}
async function settle(turns = 6) { for (let n = 0; n < turns; n++) await new Promise(setImmediate) }
const blocked = signal => new Promise((_, reject) => {
  if (signal.aborted) return reject(new Error('cancelled'))
  signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true })
})

function memoryState(initial = []) {
  let rows = clone(initial)
  return {
    list: () => clone(rows),
    get: (id, platform) => clone(rows.find(x => x.characterId === id && x.platform === platform) ?? null),
    put(value) {
      rows = rows.filter(x => x.characterId !== value.characterId || x.platform !== value.platform)
      rows.push(clone(value)); return clone(value)
    },
    remove(id, platform) { rows = rows.filter(x => x.characterId !== id || (platform && x.platform !== platform)); return true },
  }
}

function fixture(t, overrides = {}) {
  const characters = new Map(['fish_a', 'fish_b'].map(id => [id, { id, name: id }]))
  const store = { getCharacter(id) { const c = characters.get(id); if (!c) throw new Error('找不到角色'); return { character: clone(c) } } }
  const privateState = overrides.privateState ?? memoryState()
  const calls = { start: [], poll: [], receive: [], send: [], replies: [], close: [] }
  const defaults = {
    async start(args) { calls.start.push(args); return { status: 'waiting', qrText: 'https://example.invalid/qr', challenge: { value: 'opaque-qr' }, expiresAt: 999999 } },
    async poll(args) { calls.poll.push(args); return { status: 'waiting' } },
    async receive(args) { calls.receive.push(args); return blocked(args.signal) },
    async send(args) { calls.send.push(args); return { ok: true } },
    close(credentials) { calls.close.push(credentials) },
  }
  const wechat = { ...defaults, ...overrides.wechat }
  const qq = { ...defaults, ...overrides.qq }
  let clock = 1000
  const manager = createTravelManager({ store, privateState, adapters: { wechat, qq }, now: () => clock,
    resolveQQ: overrides.resolveQQ ?? (async () => ({ webUiUrl: 'http://127.0.0.1:6099', legacyBridgeEnabled: false })),
    ensureQQ: overrides.ensureQQ ?? (async () => {}),
    renderQR: overrides.renderQR ?? (async () => 'data:image/png;base64,AAAA'),
    reply: overrides.reply ?? (async args => { calls.replies.push(args); return '这是当前角色的回复' }),
  })
  t.after(async () => { manager.close(); await settle() })
  return { manager, store, characters, privateState, calls, setTime: value => { clock = value } }
}

function connected(id = 'account-owner', extras = {}) {
  return { status: 'connected', account: { id, name: '测试账号' },
    credentials: { botToken: 'private-test-credential', baseUrl: 'https://ilinkai.weixin.qq.com', botId: 'bot-test', userId: id }, ...extras }
}
const message = (id, peerId = 'account-owner') => ({ id, peerId, text: '请记住我的测试偏好', contextToken: 'private-context-' + id })

test('QR refresh changes generation and ignores a late confirmation from the old challenge', async t => {
  const old = deferred()
  let starts = 0
  const f = fixture(t, { wechat: {
    async start() { starts++; return { status: 'waiting', qrText: 'QR-' + starts, challenge: { value: 'challenge-' + starts }, expiresAt: 999999 } },
    async poll() { return old.promise },
  } })
  await f.manager.start('fish_a', 'wechat')
  const before = f.manager.view('fish_a').platforms[0]
  const pending = f.manager.poll('fish_a', 'wechat')
  await settle()
  await f.manager.action({ characterId: 'fish_a', platform: 'wechat', action: 'refresh', generation: before.generation })
  const after = f.manager.view('fish_a').platforms[0]
  assert.notEqual(after.generation, before.generation)
  old.resolve(connected())
  await pending
  assert.equal(f.privateState.get('fish_a', 'wechat'), null)
  assert.equal(f.manager.view('fish_a').platforms[0].generation, after.generation)
  assert.equal(f.manager.view('fish_a').platforms[0].status, 'waiting')
})

test('disconnect cancels an in-progress QR fetch and late completion cannot reconnect', async t => {
  const start = deferred()
  const f = fixture(t, { wechat: { start: () => start.promise } })
  const pending = f.manager.start('fish_a', 'wechat')
  await settle()
  await f.manager.action({ characterId: 'fish_a', platform: 'wechat', action: 'disconnect' })
  start.resolve(connected())
  await pending
  assert.equal(f.privateState.get('fish_a', 'wechat'), null)
  assert.equal(f.manager.view('fish_a').platforms[0].status, 'disconnected')
})

test('verification replaces an old poll; its late confirmation cannot replace the verified connection', async t => {
  const old = deferred()
  const seen = []
  let polls = 0
  const f = fixture(t, { wechat: { async poll(args) {
    seen.push({ signal: args.signal, challenge: clone(args.challenge) })
    if (polls++ === 0) return { status: 'scanned', verificationRequired: true }
    if (polls === 2) return old.promise
    return connected('verified-owner')
  } } })
  await f.manager.start('fish_a', 'wechat')
  await f.manager.poll('fish_a', 'wechat')
  assert.equal(f.manager.view('fish_a').platforms[0].verificationRequired, true)
  const pending = f.manager.poll('fish_a', 'wechat')
  await settle()
  await assert.rejects(f.manager.action({ characterId: 'fish_a', platform: 'wechat', action: 'verify', code: 'bad&code=1' }), /数字验证码/)
  await f.manager.action({ characterId: 'fish_a', platform: 'wechat', action: 'verify', code: '123456' })
  assert.equal(seen[1].signal.aborted, true)
  assert.equal(seen[2].challenge.verifyCode, '123456')
  old.resolve(connected('old-unverified-owner'))
  await pending
  assert.equal(f.privateState.get('fish_a', 'wechat').account.id, 'verified-owner')
  assert.ok(!JSON.stringify(f.manager.view('fish_a')).includes('123456'))
})

test('public status contains neither credentials nor challenge identifiers; QR expiry stops polling', async t => {
  const f = fixture(t)
  await f.manager.start('fish_a', 'wechat')
  const before = JSON.stringify(f.manager.view('fish_a'))
  assert.ok(!before.includes('opaque-qr'))
  f.setTime(1000000)
  await f.manager.poll('fish_a', 'wechat')
  assert.equal(f.calls.poll.length, 0)
  assert.equal(f.manager.view('fish_a').platforms[0].status, 'expired')
  const auth = fixture(t, { wechat: { poll: async () => connected() } })
  await auth.manager.start('fish_a', 'wechat')
  await auth.manager.poll('fish_a', 'wechat')
  const state = JSON.stringify(auth.manager.view('fish_a'))
  assert.ok(!state.includes('private-test-credential'))
  assert.ok(!state.includes('botToken'))
  assert.ok(!state.includes('account-owner'))
  assert.equal(auth.manager.view('fish_a').platforms[0].status, 'connected')
})

test('one IM account cannot bind two characters; the first authorization remains intact', async t => {
  const f = fixture(t, { wechat: { poll: async () => connected() } })
  await f.manager.start('fish_a', 'wechat'); await f.manager.poll('fish_a', 'wechat')
  await f.manager.start('fish_b', 'wechat'); await f.manager.poll('fish_b', 'wechat')
  assert.equal(f.manager.view('fish_b').platforms[0].status, 'error')
  assert.match(f.manager.view('fish_b').platforms[0].message, /另一位角色/)
  assert.equal(f.privateState.get('fish_a', 'wechat').account.id, 'account-owner')
  assert.equal(f.privateState.get('fish_b', 'wechat'), null)
})

test('QQ instance has an exclusive character lease, including in-progress QR jobs', async t => {
  const f = fixture(t)
  await f.manager.start('fish_a', 'qq')
  await assert.rejects(f.manager.start('fish_b', 'qq'), /另一套 QQ 实例|正在由/)
  await f.manager.action({ characterId: 'fish_a', platform: 'qq', action: 'disconnect' })
  await f.manager.start('fish_b', 'qq')
  assert.equal(f.manager.view('fish_b').platforms[1].status, 'waiting')
  const legacy = fixture(t, { resolveQQ: async () => ({ webUiUrl: 'http://127.0.0.1:6099', legacyBridgeEnabled: true }) })
  await assert.rejects(legacy.manager.start('fish_a', 'qq'), /旧桥|QQ 桥/)
  assert.equal(legacy.calls.start.length, 0)
})

test('only WeChat scanner messages reach the responder and duplicate IDs do not send twice', async t => {
  const ownerMessage = message('one')
  let receives = 0
  const f = fixture(t, { wechat: {
    poll: async () => connected(),
    async receive(args) {
      if (receives++ === 0) return { cursor: 'next-opaque', messages: [message('stranger', 'not-the-scanner'), ownerMessage, ownerMessage] }
      return blocked(args.signal)
    },
  } })
  await f.manager.start('fish_a', 'wechat'); await f.manager.poll('fish_a', 'wechat'); await settle()
  assert.equal(f.calls.replies.length, 1)
  assert.equal(f.calls.replies[0].characterId, 'fish_a')
  assert.strictEqual(f.calls.replies[0].message, ownerMessage)
  assert.equal(f.calls.send.length, 1)
  assert.strictEqual(f.calls.send[0].message, ownerMessage)
  assert.equal(f.calls.send[0].text, '这是当前角色的回复')
  assert.equal(f.privateState.get('fish_a', 'wechat').cursor, 'next-opaque')
  assert.deepEqual(f.privateState.get('fish_a', 'wechat').seenIds, ['one'])
})

test('QQ provider-authorized private messages retain the original target and context', async t => {
  const allowed = message('qq-1', 'allowed-qq-peer')
  let receives = 0
  const f = fixture(t, { qq: {
    poll: async () => connected('qq-account'),
    async receive(args) { return receives++ ? blocked(args.signal) : { messages: [allowed] } },
  } })
  await f.manager.start('fish_a', 'qq'); await f.manager.poll('fish_a', 'qq'); await settle()
  assert.equal(f.calls.replies.length, 1)
  assert.equal(f.calls.send.length, 1)
  assert.strictEqual(f.calls.send[0].message, allowed)
  assert.equal(f.calls.replies[0].platform, 'qq')
})

test('an entire large provider batch is processed before its cursor advances', async t => {
  let receives = 0
  const batch = Array.from({ length: 35 }, (_, i) => message('batch-' + i))
  const observedCursors = []
  let state
  const f = fixture(t, { wechat: {
    poll: async () => connected(),
    receive: async args => receives++ ? blocked(args.signal) : { cursor: 'after-all-35', messages: batch },
  }, reply: async () => { observedCursors.push(state.get('fish_a', 'wechat').cursor); return '回复' } })
  state = f.privateState
  await f.manager.start('fish_a', 'wechat'); await f.manager.poll('fish_a', 'wechat'); await settle(12)
  assert.equal(f.calls.send.length, 35)
  assert.ok(observedCursors.every(cursor => cursor === ''))
  assert.equal(state.get('fish_a', 'wechat').cursor, 'after-all-35')
})

test('pause while the model is pending prevents sending its late result', async t => {
  const answer = deferred()
  let receives = 0
  let requested
  const begun = new Promise(resolve => { requested = resolve })
  const f = fixture(t, { wechat: { poll: async () => connected(),
    receive: async args => receives++ ? blocked(args.signal) : { messages: [message('pause-1')] } },
    reply: async () => { requested(); return answer.promise },
  })
  await f.manager.start('fish_a', 'wechat'); await f.manager.poll('fish_a', 'wechat'); await begun
  await f.manager.action({ characterId: 'fish_a', platform: 'wechat', action: 'chat.disable' })
  answer.resolve('这条回复不应发送')
  await settle()
  assert.equal(f.calls.send.length, 0)
  assert.equal(f.privateState.get('fish_a', 'wechat').chatEnabled, false)
  assert.ok(f.privateState.get('fish_a', 'wechat').credentials)
})

test('disconnect while the model is pending prevents late send and removes credentials', async t => {
  const answer = deferred()
  let receives = 0
  let requested
  const begun = new Promise(resolve => { requested = resolve })
  const f = fixture(t, { wechat: { poll: async () => connected(),
    receive: async args => receives++ ? blocked(args.signal) : { messages: [message('disconnect-1')] } },
    reply: async () => { requested(); return answer.promise },
  })
  await f.manager.start('fish_a', 'wechat'); await f.manager.poll('fish_a', 'wechat'); await begun
  await f.manager.action({ characterId: 'fish_a', platform: 'wechat', action: 'disconnect' })
  answer.resolve('不应发送')
  await settle()
  assert.equal(f.calls.send.length, 0)
  assert.equal(f.privateState.get('fish_a', 'wechat'), null)
  assert.equal(f.manager.view('fish_a').platforms[0].status, 'disconnected')
})

test('character removal discards private authorizations and invalidates pending QR confirmations', async t => {
  const late = deferred()
  const f = fixture(t, { wechat: { poll: async () => connected() }, qq: { poll: () => late.promise } })
  await f.manager.start('fish_a', 'wechat'); await f.manager.poll('fish_a', 'wechat')
  await f.manager.start('fish_a', 'qq')
  const pending = f.manager.poll('fish_a', 'qq')
  await settle()
  f.manager.removeCharacter('fish_a')
  f.characters.delete('fish_a')
  late.resolve(connected('qq-account')); await pending; await settle()
  assert.deepEqual(f.privateState.list(), [])
  assert.equal(f.calls.send.length, 0)
  assert.throws(() => f.manager.view('fish_a'), /找不到角色/)
})

test('authentication expiry pauses chat and does not expose credentials through an error', async t => {
  const secret = 'private-test-credential'
  const f = fixture(t, { wechat: { poll: async () => connected(),
    receive: async () => { throw Object.assign(new Error('credential ' + secret + ' token=' + secret), { code: 'AUTH_EXPIRED' }) } } })
  await f.manager.start('fish_a', 'wechat'); await f.manager.poll('fish_a', 'wechat'); await settle()
  const state = f.manager.view('fish_a').platforms[0]
  assert.equal(state.status, 'expired')
  assert.equal(state.chatEnabled, false)
  assert.ok(!state.message.includes(secret))
})

function diskFixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'yangyu-travel-test-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  return { directory, filename: path.join(directory, 'travel-private.json') }
}

test('private authorizations persist separately and never enter role export or import', t => {
  const { directory } = diskFixture(t)
  const store = createStore({ directory })
  const role = store.createCharacter({ name: '仅测试角色' })
  const state = createTravelState(directory)
  state.put({ characterId: role.id, platform: 'wechat', generation: 'generation-private', ...connected(), chatEnabled: false })
  assert.equal(createTravelState(directory).get(role.id, 'wechat').credentials.botToken, 'private-test-credential')
  const exported = store.exportCharacter(role.id)
  assert.ok(!JSON.stringify(exported).includes('private-test-credential'))
  const imported = store.importCharacter(exported)
  assert.notEqual(imported.character.id, role.id)
  assert.equal(state.get(imported.character.id, 'wechat'), null)
  state.remove(role.id)
  assert.deepEqual(createTravelState(directory).list(), [])
})

test('corrupt private state is rejected without overwriting the original file', t => {
  const { directory, filename } = diskFixture(t)
  const original = '{not-json-private-fixture'
  fs.writeFileSync(filename, original)
  assert.throws(() => createTravelState(directory), /损坏/)
  assert.equal(fs.readFileSync(filename, 'utf8'), original)
})

test('atomic replacement failure preserves both previous private state and original file', t => {
  const { directory, filename } = diskFixture(t)
  const state = createTravelState(directory)
  const initial = { characterId: 'fish_a', platform: 'wechat', generation: 'one', ...connected(), chatEnabled: false }
  state.put(initial)
  const original = fs.readFileSync(filename, 'utf8')
  t.mock.method(fs, 'renameSync', () => { throw new Error('synthetic rename failure') })
  assert.throws(() => state.put({ ...initial, generation: 'two' }), /原授权数据已保留/)
  assert.equal(state.get('fish_a', 'wechat').generation, 'one')
  assert.equal(fs.readFileSync(filename, 'utf8'), original)
  assert.ok(fs.readdirSync(directory).every(name => !name.endsWith('.tmp')))
})
