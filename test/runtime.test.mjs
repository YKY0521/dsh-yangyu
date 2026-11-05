import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import { createStore } from '../lib/store.js'
import { API, HTTP_BODY_LIMIT, install, trustedRequest, characterPrompt, lifeSessionIds } from '../lib/runtime.js'

/** Minimal structural mocks of DSH services, never an actual user's runtime. */
function fixture(t, { createTravel } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'yangyu-runtime-'))
  const store = createStore({ directory: path.join(home, 'storages', 'dsh-yangyu') })
  const handlers = new Map()
  const endpoints = new Map()
  const sections = new Map()
  const agents = new Map()
  const sessions = new Map()
  const cleanups = []
  let settings = []
  const ctx = {
    settings: { describe: () => settings },
    agents: { list: () => [...agents.values()], get: id => agents.get(id) },
    sessions: { get: id => sessions.get(id) },
    systemPrompt: {
      section(definition) {
        sections.set(definition.name, definition)
        return () => sections.delete(definition.name)
      },
    },
    webServer: {
      register(definition) {
        endpoints.set(definition.path, definition.handler)
        return () => endpoints.delete(definition.path)
      },
    },
    effect(factory) {
      const off = factory()
      if (typeof off === 'function') cleanups.push(off)
      return off
    },
    on(name, handler) {
      const list = handlers.get(name) ?? []
      list.push(handler)
      handlers.set(name, list)
      const off = () => {
        const index = list.indexOf(handler)
        if (index >= 0) list.splice(index, 1)
      }
      cleanups.push(off)
      return off
    },
  }
  const runtime = install(ctx, {}, { home, store, defineTool: definition => definition, createTravel })
  const mock = {
    home, store, ctx, runtime, handlers, endpoints, sections, agents, sessions,
    setSettings(rows) { settings = rows },
    setLifeSession(id) {
      const dir = path.join(home, 'bili-duty')
      fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ mainSessionId: id }))
    },
    addSession(id, messages = [], withAgent = true) {
      const session = { id, header: { id }, deriveMessages: () => messages }
      sessions.set(id, session)
      if (!withAgent) return { session }
      const definitions = new Map()
      const guards = new Set()
      const agent = {
        session,
        ctx: { tools: {
          register(definition) {
            definitions.set(definition.name, definition)
            return () => definitions.delete(definition.name)
          },
          guard(handler) { guards.add(handler); return () => guards.delete(handler) },
        } },
        definitions, guards,
      }
      agents.set(id, agent)
      return agent
    },
    async emit(name, ...args) {
      let result
      for (const handler of handlers.get(name) ?? []) result = await handler(...args)
      return result
    },
    async request(endpoint, { method = 'GET', body, headers = {}, remoteAddress = '127.0.0.1', rawBody } = {}) {
      const contents = rawBody ?? (body === undefined ? undefined : JSON.stringify(body))
      const request = Readable.from(contents === undefined ? [] : [Buffer.from(contents)])
      Object.assign(request, {
        method,
        url: API + endpoint,
        headers: { host: '127.0.0.1:3099', ...(contents === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
        socket: { remoteAddress },
      })
      const response = {
        status: undefined, headers: undefined, contents: undefined,
        writeHead(status, result) { this.status = status; this.headers = result },
        end(result) { this.contents = result },
      }
      const handler = endpoints.get(API + endpoint.split('?')[0])
      assert.equal(typeof handler, 'function', `Missing route ${endpoint}`)
      await handler(request, response)
      return { status: response.status, headers: response.headers, data: JSON.parse(response.contents) }
    },
    dispose() {
      for (const off of cleanups.splice(0).reverse()) off()
    },
  }
  t.after(() => {
    mock.dispose()
    // The path comes solely from mkdtemp and never from role names or HTTP input.
    fs.rmSync(home, { recursive: true, force: true })
  })
  return mock
}

const create = (mock, name) => mock.runtime.mutate({ action: 'character.create', name }).entity
const bind = (mock, characterId, sessionId) => mock.runtime.mutate({ action: 'session.bind', characterId, sessionId })
const prompt = (mock, agent) => mock.sections.get('yangyu:character').text({ agent })
const assembly = () => ({
  sections: [{ name: 'dafeiyu:persona' }, { name: 'dafeiyu-life:memory' }, { name: 'deployment:persona-prefix' }, { name: 'yangyu:character' }, { name: 'safe:rules' }],
  contexts: [{ name: 'dafeiyu:life' }, { name: 'other:context' }],
  tools: [{ name: 'bili_search' }, { name: 'dafeiyu_recall' }, { name: 'yangyu_recall' }, { name: 'read_file' }],
  extra: 'preserved',
})

test('install exposes isolated routes and a scoped prompt; /state does not expose all role memory bodies', async t => {
  const mock = fixture(t)
  const fish = create(mock, '小鱼')
  const whale = create(mock, '小鲸')
  mock.store.saveMemory({ characterId: fish.id, text: 'ONLY_FISH_PRIVATE_MEMORY', kind: 'fixed' })
  mock.store.saveMemory({ characterId: whale.id, text: 'ONLY_WHALE_PRIVATE_MEMORY', kind: 'fixed' })
  assert(mock.sections.has('yangyu:character'))
  const response = await mock.request('/state')
  assert.equal(response.status, 200)
  assert.equal(response.data.characters.length, 2)
  assert.equal(typeof response.data.csrfToken, 'string')
  assert.equal(response.data.csrfToken.length, 64)
  assert(!JSON.stringify(response.data).includes('PRIVATE_MEMORY'))
  const detail = await mock.request(`/character?id=${fish.id}`)
  assert.equal(detail.data.memories.length, 1)
  assert.equal(detail.data.memories[0].text, 'ONLY_FISH_PRIVATE_MEMORY')
  assert(!JSON.stringify(detail.data).includes('ONLY_WHALE'))
  assert.equal(response.headers['Cache-Control'], 'no-store')
})

test('character.update strips transport fields and still rejects unsupported domain fields', t => {
  const mock = fixture(t)
  const fish = create(mock, '小鱼')
  const result = mock.runtime.mutate({ action: 'character.update', id: fish.id, name: '鱼鱼', persona: '' })
  assert.equal(result.entity.name, '鱼鱼')
  assert.equal(result.entity.id, fish.id)
  assert.equal(result.entity.persona, '')
  assert.throws(() => mock.runtime.mutate({ action: 'character.update', id: fish.id, sessionId: 'sneaky' }), /不支持/)
})

test('only blank sessions can be bound, and existing histories or another role cannot be reassigned', t => {
  const mock = fixture(t)
  const fish = create(mock, '小鱼')
  const whale = create(mock, '小鲸')
  const blank = mock.addSession('blank')
  bind(mock, fish.id, 'blank')
  assert.equal(mock.store.getBinding('blank').characterId, fish.id)
  assert(blank.definitions.has('yangyu_remember'))
  assert(blank.definitions.has('yangyu_recall'))
  assert.equal(blank.guards.size, 1)
  assert.throws(() => bind(mock, whale.id, 'blank'), /另一角色/)
  for (const role of ['user', 'assistant', 'tool']) {
    mock.addSession(`history-${role}`, [{ role, content: 'old message' }])
    assert.throws(() => bind(mock, fish.id, `history-${role}`), /尚未发言/)
    assert.equal(mock.store.getBinding(`history-${role}`), null)
  }
  assert.throws(() => bind(mock, fish.id, 'does-not-exist'), /先.*创建新会话/)
  mock.addSession('cold-blank', [], false)
  bind(mock, fish.id, 'cold-blank')
  assert.equal(mock.store.getBinding('cold-blank').characterId, fish.id)
})

test('life main-session conflicts reject binding, including session- prefix and in-memory selectors', t => {
  const mock = fixture(t)
  const fish = create(mock, '小鱼')
  mock.addSession('life-main')
  mock.setLifeSession('session-life-main')
  assert(lifeSessionIds(mock.ctx, mock.home).has('life-main'))
  assert.throws(() => bind(mock, fish.id, 'life-main'), /生活插件/)
  mock.addSession('settings-main')
  mock.setSettings([{ id: 'dsh-dafeiyu-life', value: { mainSessionId: 'settings-main' } }])
  assert.throws(() => bind(mock, fish.id, 'settings-main'), /生活插件/)
  mock.addSession('user-main')
  mock.setSettings([{ id: 'dafeiyu-life', user: { mainSessionId: 'user-main' } }])
  assert.throws(() => bind(mock, fish.id, 'user-main'), /生活插件/)
})

test('an unprefixed life selector rejects the actual session-prefixed DSH session ID', t => {
  const mock = fixture(t)
  const fish = create(mock, '小鱼')
  mock.addSession('session-abc')
  mock.setLifeSession('abc')
  assert.throws(() => bind(mock, fish.id, 'session-abc'), /生活插件/)
  assert.equal(mock.store.getBinding('session-abc'), null)
})

test('dynamic unprefixed life selectors block prefixed sessions and expose the original binding ID in conflicts', async t => {
  const mock = fixture(t)
  const fish = create(mock, '小鱼')
  const agent = mock.addSession('session-abc')
  bind(mock, fish.id, 'session-abc')
  assert.deepEqual(mock.runtime.state().compatibility.conflicts, [])
  mock.setLifeSession('abc')
  let steps = 0
  await assert.rejects(mock.emit('agent/pre-step', { agent }, () => { steps++ }), /生活插件/)
  assert.equal(steps, 0)
  assert.throws(() => prompt(mock, agent), /生活插件/)
  const [guard] = agent.guards
  assert.match(await guard({ name: 'yangyu_remember' }), /生活插件/)
  const remember = agent.definitions.get('yangyu_remember')
  await assert.rejects(remember.execute({ text: '不可保存' }, { agent, callId: 'blocked' }), /生活插件/)
  assert.deepEqual(mock.runtime.state().compatibility.conflicts, [{ sessionId: 'session-abc', characterId: fish.id }])
  assert.equal(mock.store.getCharacter(fish.id).memories.length, 0)
})

test('plugin reload with an existing life conflict keeps management available while rejecting role execution', async t => {
  const mock = fixture(t)
  const fish = create(mock, '小鱼')
  const agent = mock.addSession('session-abc')
  bind(mock, fish.id, 'session-abc')
  mock.setLifeSession('abc')
  mock.dispose()
  assert.equal(agent.guards.size, 0)
  // Recreate plugin registrations over the same isolated store and live agents.
  assert.doesNotThrow(() => {
    mock.runtime = install(mock.ctx, {}, { home: mock.home, store: mock.store, defineTool: definition => definition })
  })
  assert.equal(agent.guards.size, 1)
  const status = await mock.request('/state')
  assert.equal(status.status, 200)
  assert.deepEqual(status.data.compatibility.conflicts, [{ sessionId: 'session-abc', characterId: fish.id }])
  const updated = await mock.request('/mutate', {
    method: 'POST',
    headers: { 'x-yangyu-token': status.data.csrfToken },
    body: { action: 'character.update', id: fish.id, name: '仍可管理' },
  })
  assert.equal(updated.status, 200)
  assert.equal(updated.data.entity.name, '仍可管理')
  await assert.rejects(mock.emit('agent/pre-step', { agent }, () => {}), /生活插件/)
  const [guard] = agent.guards
  assert.match(await guard({ name: 'yangyu_remember' }), /生活插件/)
  const remember = agent.definitions.get('yangyu_remember')
  await assert.rejects(remember.execute({ text: '不可保存' }, { agent, callId: 'blocked' }), /生活插件/)
  assert.equal(mock.store.getCharacter(fish.id).memories.length, 0)
})

test('life selector changes after binding are caught before the next step, assembly, prompt and tool execution', async t => {
  const mock = fixture(t)
  const fish = create(mock, '小鱼')
  const agent = mock.addSession('own-session')
  bind(mock, fish.id, 'own-session')
  let steps = 0
  await mock.emit('agent/pre-step', { agent }, () => { steps++ })
  assert.equal(steps, 1)
  mock.setLifeSession('own-session')
  await assert.rejects(mock.emit('agent/pre-step', { agent }, () => { steps++ }), /生活插件/)
  assert.equal(steps, 1)
  assert.throws(() => prompt(mock, agent), /生活插件/)
  await assert.rejects(mock.emit('system-prompt/assemble', assembly(), { agent }, async () => assembly()), /生活插件/)
  const remember = agent.definitions.get('yangyu_remember')
  await assert.rejects(remember.execute({ text: 'should not save' }, { agent, callId: '1' }), /生活插件/)
  assert.equal(mock.store.getCharacter(fish.id).memories.length, 0)
  const status = mock.runtime.state()
  assert.equal(status.compatibility.conflicts[0].sessionId, 'own-session')
})

test('malformed life selector fails closed without touching its configuration', async t => {
  const mock = fixture(t)
  const fish = create(mock, '小鱼')
  const agent = mock.addSession('own-session')
  bind(mock, fish.id, 'own-session')
  const directory = path.join(mock.home, 'bili-duty')
  fs.mkdirSync(directory, { recursive: true })
  const filename = path.join(directory, 'config.json')
  fs.writeFileSync(filename, '{bad-json')
  await assert.rejects(mock.emit('agent/pre-step', { agent }, () => {}), /配置无法读取/)
  assert.equal(fs.readFileSync(filename, 'utf8'), '{bad-json')
  assert.match(mock.runtime.state().compatibility.conflicts[0].error, /配置无法读取/)
})

test('role prompts and assembly filters are scoped; unrelated global sessions remain unchanged', async t => {
  const mock = fixture(t)
  const fish = create(mock, '小鱼')
  const whale = create(mock, '小鲸')
  const fishAgent = mock.addSession('fish-session')
  const whaleAgent = mock.addSession('whale-session')
  const normal = mock.addSession('normal-session')
  bind(mock, fish.id, 'fish-session')
  bind(mock, whale.id, 'whale-session')
  mock.store.saveMemory({ characterId: fish.id, text: 'ONLY_FISH', kind: 'fixed' })
  mock.store.saveMemory({ characterId: whale.id, text: 'ONLY_WHALE', kind: 'fixed' })
  assert(prompt(mock, fishAgent).includes('ONLY_FISH'))
  assert(!prompt(mock, fishAgent).includes('ONLY_WHALE'))
  assert(prompt(mock, whaleAgent).includes('ONLY_WHALE'))
  assert.equal(prompt(mock, normal), '')
  assert.equal(characterPrompt(mock.store, undefined), '')
  const original = assembly()
  const filtered = await mock.emit('system-prompt/assemble', original, { agent: fishAgent }, async () => original)
  assert.deepEqual(filtered.sections.map(item => item.name), ['yangyu:character', 'safe:rules'])
  assert.deepEqual(filtered.contexts.map(item => item.name), ['other:context'])
  assert.deepEqual(filtered.tools.map(item => item.name), ['yangyu_recall', 'read_file'])
  assert.equal(filtered.extra, 'preserved')
  assert.equal(original.tools.length, 4)
  const unbound = await mock.emit('system-prompt/assemble', original, { agent: normal }, async () => original)
  assert.strictEqual(unbound, original)
  assert.equal(normal.definitions.size, 0)
  let continued = false
  await mock.emit('agent/pre-step', { agent: normal }, () => { continued = true })
  assert.equal(continued, true)
})

test('inbox and user session events supply only the matching session recall query', async t => {
  const mock = fixture(t)
  const fish = create(mock, '小鱼')
  const fishAgent = mock.addSession('fish-session')
  const normal = mock.addSession('normal-session')
  bind(mock, fish.id, 'fish-session')
  mock.store.saveMemory({ characterId: fish.id, text: '海边的日落', kind: 'episode' })
  mock.store.saveMemory({ characterId: fish.id, text: '上周看的电影', kind: 'episode' })
  await mock.emit('agent/inbox/inserted', { agent: fishAgent, message: { role: 'user', content: [{ type: 'text', text: '聊聊海边' }] } })
  assert(prompt(mock, fishAgent).includes('海边的日落'))
  assert(!prompt(mock, fishAgent).includes('上周看的电影'))
  await mock.emit('agent/inbox/inserted', { agent: normal, message: { role: 'user', content: '电影' } })
  assert(!prompt(mock, fishAgent).includes('上周看的电影'))
  await mock.emit('session/event', fishAgent.session, { type: 'user/message', data: { message: { content: '电影' } } })
  assert(prompt(mock, fishAgent).includes('上周看的电影'))
})

test('scoped tools resolve identity from exec.agent, deduplicate retries, and honor current feature switches', async t => {
  const mock = fixture(t)
  const fish = create(mock, '小鱼')
  const whale = create(mock, '小鲸')
  const fishAgent = mock.addSession('fish-session')
  const whaleAgent = mock.addSession('whale-session')
  bind(mock, fish.id, 'fish-session')
  bind(mock, whale.id, 'whale-session')
  const remember = fishAgent.definitions.get('yangyu_remember')
  const recall = fishAgent.definitions.get('yangyu_recall')
  await remember.execute({ text: '喜欢抹茶冰淇淋', important: true }, { agent: whaleAgent, callId: 'event-1' })
  assert.equal(mock.store.getCharacter(fish.id).memories.length, 0)
  assert.equal(mock.store.getCharacter(whale.id).memories.length, 1)
  await remember.execute({ text: '喜欢抹茶冰淇淋', important: true }, { agent: whaleAgent, callId: 'event-2' })
  assert.equal(mock.store.getCharacter(whale.id).memories.length, 1)
  const recalled = await recall.execute({ query: '抹茶' }, { agent: whaleAgent })
  assert(recalled.includes('喜欢抹茶'))
  assert.equal(await recall.execute({ query: '抹茶' }, { agent: fishAgent }), '[]')
  await assert.rejects(remember.execute({ text: 'wrong envelope' }, { sessionId: 'whale-session', callId: 'bad' }), /没有绑定/)
  mock.store.updateCharacter(whale.id, { autoCapture: false })
  assert.match(await remember.execute({ text: '不该记住' }, { agent: whaleAgent, callId: 'disabled' }), /已关闭/)
  assert.equal(mock.store.getCharacter(whale.id).memories.length, 1)
  mock.store.updateCharacter(whale.id, { memoryEnabled: false, autoCapture: true })
  assert.match(await remember.execute({ text: '不该记住' }, { agent: whaleAgent, callId: 'disabled-2' }), /已关闭/)
  assert.match(await recall.execute({ query: '抹茶' }, { agent: whaleAgent }), /已关闭/)
  assert(!prompt(mock, whaleAgent).includes('喜欢抹茶'))
})

test('tool execution guard blocks old life tools and deleted roles, and disposal removes scoped registrations', async t => {
  const mock = fixture(t)
  const fish = create(mock, '小鱼')
  const agent = mock.addSession('fish-session')
  bind(mock, fish.id, 'fish-session')
  const [guard] = agent.guards
  assert.match(await guard({ name: 'bili_search' }), /其他角色/)
  assert.match(await guard({ name: 'dafeiyu_recall' }), /其他角色/)
  assert.equal(await guard({ name: 'read_file' }), undefined)
  mock.runtime.mutate({ action: 'character.delete', id: fish.id })
  assert.match(await guard({ name: 'read_file' }), /已删除/)
  await assert.rejects(mock.emit('agent/pre-step', { agent }, () => {}), /已删除/)
  await mock.emit('agent/disposed', { agent })
  assert.equal(agent.definitions.size, 0)
  assert.equal(agent.guards.size, 0)
})

test('trustedRequest rejects remote peers, DNS rebinding, hostile origins and cross-site requests', () => {
  const request = (remoteAddress, host, headers = {}) => ({ socket: { remoteAddress }, headers: { host, ...headers } })
  assert.equal(trustedRequest(request('127.0.0.1', 'localhost:3099')), true)
  assert.equal(trustedRequest(request('::1', '[::1]:3099', { origin: 'http://[::1]:3099' })), true)
  assert.equal(trustedRequest(request('::ffff:127.0.0.1', '127.0.0.1:3099')), true)
  for (const invalid of [
    request('192.168.1.4', 'localhost:3099'),
    request('127.0.0.1', 'evil.example:3099'),
    request('127.0.0.1', 'user@localhost:3099'),
    request('127.0.0.1', 'localhost:3099/path'),
    request('127.0.0.1', 'localhost:3099?x=y'),
    request('127.0.0.1', 'localhost:3099', { origin: 'http://evil.example' }),
    request('127.0.0.1', 'localhost:3099', { origin: 'http://localhost:3100' }),
    request('127.0.0.1', 'localhost:3099', { origin: 'null' }),
    request('127.0.0.1', 'localhost:3099', { 'sec-fetch-site': 'cross-site' }),
  ]) assert.equal(trustedRequest(invalid), false)
})

test('HTTP mutations require the current CSRF token and JSON; failures preserve data', async t => {
  const mock = fixture(t)
  const { data } = await mock.request('/state')
  const token = data.csrfToken
  const body = { action: 'character.create', name: '小鱼' }
  assert.equal((await mock.request('/mutate', { method: 'POST', body })).status, 403)
  assert.equal((await mock.request('/mutate', { method: 'POST', body, headers: { 'x-yangyu-token': 'x'.repeat(64) } })).status, 403)
  assert.equal((await mock.request('/mutate', { method: 'POST', body, headers: { 'x-yangyu-token': token, origin: 'http://evil.example' } })).status, 403)
  assert.equal(mock.store.snapshot().characters.length, 0)
  const added = await mock.request('/mutate', { method: 'POST', body, headers: { 'x-yangyu-token': token, origin: 'http://127.0.0.1:3099' } })
  assert.equal(added.status, 200)
  assert.equal(added.data.entity.name, '小鱼')
  assert.equal((await mock.request('/mutate', { method: 'GET' })).status, 405)
  assert.equal((await mock.request('/state', { method: 'POST' })).status, 405)
  assert.equal((await mock.request('/mutate', { method: 'POST', rawBody: '{bad', headers: { 'x-yangyu-token': token } })).status, 400)
  assert.equal((await mock.request('/mutate', { method: 'POST', body, headers: { 'x-yangyu-token': token, 'content-type': 'text/plain' } })).status, 400)
  assert.equal((await mock.request('/mutate', { method: 'POST', body: [], headers: { 'x-yangyu-token': token } })).status, 400)
  const tooLarge = await mock.request('/mutate', {
    method: 'POST', rawBody: 'x'.repeat(HTTP_BODY_LIMIT + 1), headers: { 'x-yangyu-token': token },
  })
  assert.equal(tooLarge.status, 400)
  assert.match(tooLarge.data.error, /18 MiB/)
  assert.equal(mock.store.snapshot().characters.length, 1)
})

test('travel HTTP uses the same origin/CSRF boundary, awaits actions, polls one role and cleans authorization on deletion', async t => {
  const calls = []
  const mock = fixture(t, { createTravel: ({ store }) => ({
    view(id) { store.getCharacter(id); return { ok: true, platforms: [{ platform: 'wechat', status: 'waiting' }] } },
    async poll(id, platform) { calls.push(['poll', id, platform]) },
    async action(input) { store.getCharacter(input.characterId); await Promise.resolve(); calls.push(['action', input.action]); return this.view(input.characterId) },
    removeCharacter(id) { calls.push(['remove', id]) },
  }) })
  const role = create(mock, '出游自检')
  const token = (await mock.request('/state')).data.csrfToken
  const url = `/travel?characterId=${role.id}&platform=wechat`
  const status = await mock.request(url)
  assert.equal(status.status, 200)
  assert.deepEqual(calls[0], ['poll', role.id, 'wechat'])
  const body = { action: 'start', platform: 'wechat', characterId: role.id }
  assert.equal((await mock.request('/travel', { method: 'POST', body })).status, 403)
  const started = await mock.request('/travel', { method: 'POST', body, headers: { 'x-yangyu-token': token } })
  assert.equal(started.status, 200)
  assert.deepEqual(calls[1], ['action', 'start'])
  assert.equal((await mock.request('/travel?characterId=not-a-role&platform=qq')).status, 400)
  assert.equal((await mock.request('/travel', { method: 'DELETE' })).status, 405)
  mock.runtime.mutate({ action: 'character.delete', id: role.id })
  assert.deepEqual(calls[2], ['remove', role.id])
})

test('a broken travel authorization store leaves ordinary character management working', async t => {
  const mock = fixture(t, { createTravel() { throw new Error('private secret must not escape') } })
  const role = create(mock, '仍可管理')
  assert.equal((await mock.request('/state')).data.characters.length, 1)
  const result = await mock.request(`/travel?characterId=${role.id}`)
  assert.equal(result.status, 200)
  assert.ok(result.data.platforms.every(p => p.status === 'unavailable'))
  assert.ok(!JSON.stringify(result.data).includes('private secret'))
})
