import test from 'node:test'
import assert from 'node:assert/strict'
import { getEventListeners } from 'node:events'
import { createTravelResponder } from '../lib/travel-responder.js'

const clone = value => structuredClone(value)
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b }); return { promise, resolve, reject } }
async function settle(turns = 4) { for (let n = 0; n < turns; n++) await new Promise(setImmediate) }

function fixture(t, options = {}) {
  const events = new Set()
  const bindings = new Map()
  const connections = new Map()
  const agents = new Map()
  const calls = { create: [], resume: [], setups: [], selections: 0, cancelled: [], disposed: [] }
  for (const id of ['fish_a', 'fish_b']) for (const platform of ['wechat', 'qq']) {
    connections.set(`${id}:${platform}`, { characterId: id, platform, generation: 'generation-' + id + '-' + platform, peerSessions: {} })
  }
  const emit = (agent, type, data) => { for (const fn of [...events]) fn(agent.session, { type, data }) }
  function scoped() {
    const result = { restriction: null, mode: null, guard: null, section: null }
    const ctx = {
      tools: { restrict: filter => { result.restriction = filter }, presentAs: mode => { result.mode = mode }, guard: guard => { result.guard = guard } },
      systemPrompt: { section: value => { result.section = value } },
    }
    calls.setups.push(result)
    return ctx
  }
  function makeAgent(sid) {
    const agent = {
      session: { header: { id: sid } },
      ctx: scoped(),
      async followup(input) {
        if (options.followup) return options.followup({ agent, input, emit: (type, data) => emit(agent, type, data) })
        emit(agent, 'user/message', { id: input.id, content: input.content })
        emit(agent, 'assistant/message', { message: { content: [{ type: 'text', text: '中间步骤内容' }] } })
        emit(agent, 'assistant/message', { message: { content: [{ type: 'text', text: options.finalText ?? '这是最终角色回复' }] } })
        emit(agent, 'turn/end', { reason: { kind: 'completed' } })
      },
      whenIdle: () => options.whenIdle ? options.whenIdle(agent) : Promise.resolve(),
      cancel: reason => { calls.cancelled.push({ sid, reason }) },
    }
    return agent
  }
  function makeHandle(sid) {
    const agent = makeAgent(sid)
    agents.set(sid, agent)
    return { agent, async dispose() { calls.disposed.push(sid); agents.delete(sid) } }
  }
  const store = {
    getBinding: sid => clone(bindings.get(sid) ?? null),
    bindSession(value) { bindings.set(value.sessionId, clone(value)); return clone(value) },
  }
  const ctx = {
    on(name, fn) {
      assert.equal(name, 'session/event')
      events.add(fn)
      return () => events.delete(fn)
    },
    agentDefaultModel: { currentSelection() { calls.selections++; return options.selection === undefined ? { provider: 'test-provider', model: 'test-model' } : options.selection } },
    agents: {
      get: sid => agents.get(sid),
      async create(request) {
        calls.create.push(request)
        assert.ok(bindings.has(request.sessionId), 'the role must be bound before creating an agent')
        const handle = options.create ? await options.create(request, makeHandle) : makeHandle(request.sessionId)
        request.setup(handle.agent.ctx, handle.agent)
        return handle
      },
      async resume(request) {
        calls.resume.push(request)
        assert.ok(bindings.has(request.sessionId))
        const handle = options.resume ? await options.resume(request, makeHandle) : makeHandle(request.sessionId)
        request.setup(handle.agent.ctx, handle.agent)
        return handle
      },
    },
  }
  const getConnection = (id, platform) => clone(connections.get(`${id}:${platform}`) ?? null)
  const updateConnection = (id, platform, generation, patch) => {
    const key = `${id}:${platform}`, c = connections.get(key)
    if (!c || c.generation !== generation) return false
    connections.set(key, { ...c, ...clone(patch) }); return true
  }
  const responder = createTravelResponder({ ctx, store, home: '/synthetic-test-home', getConnection, updateConnection })
  t.after(() => responder.close())
  const request = (patch = {}) => ({ characterId: 'fish_a', platform: 'wechat', generation: 'generation-fish_a-wechat',
    message: { id: 'inbound-one', peerId: 'peer-one', text: '你好' }, signal: new AbortController().signal, ...patch })
  return { responder, events, bindings, connections, agents, calls, request, emit }
}

test('native responder binds identity before create, uses current model and exposes only scoped memory tools', async t => {
  const f = fixture(t)
  const request = f.request()
  assert.equal(await f.responder.reply(request), '这是最终角色回复')
  assert.equal(f.calls.selections, 1)
  assert.equal(f.calls.create.length, 1)
  const created = f.calls.create[0]
  assert.equal(created.agentOptions.provider, 'test-provider')
  assert.equal(created.agentOptions.model, 'test-model')
  assert.equal(created.agentOptions.maxTokens, 2048)
  assert.equal(f.bindings.get(created.sessionId).characterId, 'fish_a')
  const setup = f.calls.setups[0]
  assert.deepEqual(setup.restriction, { allow: [] })
  assert.equal(setup.mode, 'native')
  assert.equal(setup.guard({ name: 'yangyu_remember' }), undefined)
  assert.equal(setup.guard({ name: 'yangyu_recall' }), undefined)
  assert.ok(setup.guard({ name: 'read_file' }))
  assert.ok(setup.guard({ name: 'bili_config' }))
  assert.match(setup.section.text, /不授予电脑控制/)
  assert.equal(f.events.size, 0)
  assert.equal(getEventListeners(request.signal, 'abort').length, 0, 'successful reply must not leak abort handlers')
})

test('an IM session resumed by the GUI is restricted again before accepting a remote message', async t => {
  const f = fixture(t)
  await f.responder.reply(f.request())
  const [sid, original] = [...f.agents.entries()][0]
  const safety = {}
  const guiAgent = { ...original, ctx: {
    tools: { restrict(value) { safety.restriction = value }, presentAs(value) { safety.mode = value }, guard(value) { safety.guard = value } },
    systemPrompt: { section(value) { safety.section = value } },
  } }
  f.agents.set(sid, guiAgent)
  await f.responder.reply(f.request({ message: { id: 'inbound-again', peerId: 'peer-one', text: '新的私聊' } }))
  assert.deepEqual(safety.restriction, { allow: [] })
  assert.equal(safety.mode, 'native')
  assert.ok(safety.guard({ name: 'write_file' }))
  assert.equal(safety.guard({ name: 'yangyu_remember' }), undefined)
})

test('peer and platform identities isolate native sessions while the same peer reuses its bound session', async t => {
  const f = fixture(t)
  await f.responder.reply(f.request())
  const first = f.calls.create[0].sessionId
  await f.responder.reply(f.request({ message: { id: 'second', peerId: 'peer-one', text: '继续聊' } }))
  assert.equal(f.calls.create.length, 1)
  await f.responder.reply(f.request({ message: { id: 'third', peerId: 'peer-two', text: '你好' } }))
  await f.responder.reply(f.request({ platform: 'qq', generation: 'generation-fish_a-qq' }))
  await f.responder.reply(f.request({ characterId: 'fish_b', generation: 'generation-fish_b-wechat' }))
  assert.equal(f.calls.create.length, 4)
  assert.equal(new Set(f.calls.create.map(x => x.sessionId)).size, 4)
  assert.equal(f.connections.get('fish_a:wechat').peerSessions[Buffer.from('peer-one').toString('base64url')], first)
})

test('existing durable peer session is resumed; foreign role bindings are rejected', async t => {
  const f = fixture(t)
  const key = Buffer.from('peer-one').toString('base64url')
  f.bindings.set('session-restored', { characterId: 'fish_a', sessionId: 'session-restored' })
  f.connections.get('fish_a:wechat').peerSessions[key] = 'session-restored'
  assert.equal(await f.responder.reply(f.request()), '这是最终角色回复')
  assert.equal(f.calls.resume.length, 1)
  assert.equal(f.calls.create.length, 0)
  const bad = fixture(t)
  bad.bindings.set('session-foreign', { characterId: 'fish_b', sessionId: 'session-foreign' })
  bad.connections.get('fish_a:wechat').peerSessions[key] = 'session-foreign'
  await assert.rejects(bad.responder.reply(bad.request()), /归属不匹配/)
  assert.equal(bad.calls.create.length, 0)
  assert.equal(bad.calls.resume.length, 0)
})

test('missing model blocks native agent creation without binding a dead session', async t => {
  const f = fixture(t, { selection: null })
  await assert.rejects(f.responder.reply(f.request()), /选择可用模型/)
  assert.equal(f.calls.create.length, 0)
  assert.equal(f.bindings.size, 0)
})

test('a connection changed during agent construction disposes the abandoned agent without replying', async t => {
  const ready = deferred(), created = deferred()
  const f = fixture(t, { create: async (request, makeHandle) => { ready.resolve(); await created.promise; return makeHandle(request.sessionId) } })
  const pending = f.responder.reply(f.request())
  await ready.promise
  f.connections.delete('fish_a:wechat')
  created.resolve()
  await assert.rejects(pending, /连接已变更/)
  assert.equal(f.calls.disposed.length, 1)
  assert.equal(f.events.size, 0)
})

test('abort cancels the model and always unregisters event and abort listeners', async t => {
  const begun = deferred()
  const f = fixture(t, { whenIdle: () => { begun.resolve(); return new Promise(() => {}) } })
  const controller = new AbortController()
  const pending = f.responder.reply(f.request({ signal: controller.signal }))
  await begun.promise
  controller.abort()
  await assert.rejects(pending, /连接已断开|没有生成/)
  assert.equal(f.calls.cancelled.length, 1)
  assert.equal(f.events.size, 0)
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0)
})

test('timeout cancels pending generation and cleans all listeners', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const begun = deferred()
  const f = fixture(t, { whenIdle: () => { begun.resolve(); return new Promise(() => {}) } })
  const request = f.request()
  const pending = f.responder.reply(request)
  await begun.promise
  t.mock.timers.tick(120_001)
  await assert.rejects(pending, /超时/)
  assert.equal(f.calls.cancelled.length, 1)
  assert.equal(f.events.size, 0)
  assert.equal(getEventListeners(request.signal, 'abort').length, 0)
})

test('a failed or aborted turn does not send an intermediate assistant preface', async t => {
  for (const kind of ['error', 'aborted']) {
    const f = fixture(t, { followup: async ({ input, emit }) => {
      emit('user/message', { id: input.id })
      emit('assistant/message', { message: { content: [{ type: 'text', text: '我先查询一下' }] } })
      emit('turn/end', { reason: { kind } })
    } })
    await assert.rejects(f.responder.reply(f.request()), /没有生成|失败|完成|中止|取消/)
    assert.equal(f.events.size, 0)
  }
})

test('empty final output and previous unclaimed assistant events cannot become a reply', async t => {
  const f = fixture(t, { followup: async ({ input, emit }) => {
    emit('assistant/message', { message: { content: [{ type: 'text', text: '旧的无关消息' }] } })
    emit('user/message', { id: input.id })
    emit('turn/end', { reason: { kind: 'completed' } })
  } })
  await assert.rejects(f.responder.reply(f.request()), /没有生成/)
  assert.equal(f.events.size, 0)
})

test('events from a different session cannot replace the current peer final reply', async t => {
  let f
  f = fixture(t, { followup: async ({ input, emit }) => {
    emit('user/message', { id: input.id })
    f.emit({ session: { header: { id: 'session-unrelated' } } }, 'assistant/message', { message: { content: [{ type: 'text', text: '不应发送给当前用户' }] } })
    emit('assistant/message', { message: { content: [{ type: 'text', text: '当前会话自己的回复' }] } })
    emit('turn/end', { reason: { kind: 'completed' } })
  } })
  assert.equal(await f.responder.reply(f.request()), '当前会话自己的回复')
})
