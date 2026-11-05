import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createStore, LIMITS } from '../lib/store.js'

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'yangyu-store-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  return { directory, store: createStore({ directory }) }
}

test('empty persona is supported; names/persona changes retain stable memory and session identity across restart', t => {
  const { directory, store } = fixture(t)
  const fish = store.createCharacter({ name: '小鱼' })
  assert.equal(fish.persona, '')
  assert.equal(fish.avatar, '🐟')
  store.bindSession({ characterId: fish.id, sessionId: 'session:fish', title: '初次相见' })
  const memory = store.saveMemory({ characterId: fish.id, text: '我们约好周末看海', kind: 'episode', important: true })
  store.updateCharacter(fish.id, { name: '鱼鱼', persona: '喜欢海边' })
  const reopened = createStore({ directory })
  const record = reopened.getCharacter(fish.id)
  assert.equal(record.character.name, '鱼鱼')
  assert.equal(record.character.persona, '喜欢海边')
  assert.equal(record.memories[0].id, memory.id)
  assert.equal(reopened.getBinding('session:fish').characterId, fish.id)
})

test('role boundaries apply to query, writes, deletes, source sessions, and session reassignment', t => {
  const { store } = fixture(t)
  const a = store.createCharacter({ name: '小鱼' })
  const b = store.createCharacter({ name: '阿茶' })
  const memory = store.saveMemory({ characterId: a.id, text: '共同的秘密', kind: 'fixed', important: true })
  store.bindSession({ characterId: a.id, sessionId: 'a' })
  assert.throws(() => store.bindSession({ characterId: b.id, sessionId: 'a' }), /另一角色/)
  assert.throws(() => store.saveMemory({ characterId: b.id, id: memory.id, text: '篡改' }), /找不到这个角色的记忆/)
  assert.throws(() => store.deleteMemory({ characterId: b.id, id: memory.id }), /找不到这个角色的记忆/)
  assert.throws(() => store.saveMemory({ characterId: b.id, text: '来源串号', sourceSessionId: 'a' }), /不匹配/)
  assert.throws(() => store.saveMemory({ characterId: b.id, text: '未知会话', sourceSessionId: 'unknown' }), /不匹配/)
  assert.deepEqual(store.recall(b.id, '共同的秘密'), [])
  assert.equal(store.getCharacter(a.id).memories[0].text, '共同的秘密')
})

test('event IDs deduplicate retries per role without replacing user-corrected memories', t => {
  const { store } = fixture(t)
  const a = store.createCharacter({ name: '小鱼' })
  const b = store.createCharacter({ name: '小鲸' })
  const input = { characterId: a.id, text: '记住第一次约定', kind: 'episode', sourceEventId: 'sessionA:event1' }
  const memory = store.saveMemory(input)
  store.saveMemory({ ...input, id: memory.id, text: '手动纠正后的约定' })
  const duplicate = store.saveMemory(input)
  assert.equal(duplicate.id, memory.id)
  assert.equal(duplicate.text, '手动纠正后的约定')
  store.saveMemory({ ...input, characterId: b.id })
  assert.equal(store.getCharacter(a.id).memories.length, 1)
  assert.equal(store.getCharacter(b.id).memories.length, 1)
})

test('recall finds Chinese and English clues, prioritizes fixed/important memories and respects a strict text budget', t => {
  const { store } = fixture(t)
  const fish = store.createCharacter({ name: '小鱼' })
  const save = (text, kind = 'episode', important = false) => store.saveMemory({ characterId: fish.id, text, kind, important })
  save('很重要的约定：每天晚安', 'episode', true)
  save('小鱼喜欢海边', 'fixed')
  save('我们上周去海边看了日落')
  save('Our favorite movie is Arrival')
  save('无关的午餐记录')
  const recalled = store.recall(fish.id, '想去海边看日落，聊聊 arrival')
  assert.equal(recalled[0].important, true)
  assert.equal(recalled[1].kind, 'fixed')
  assert(recalled.some(item => item.text.includes('日落')))
  assert(recalled.some(item => item.text.includes('Arrival')))
  assert(!recalled.some(item => item.text.includes('午餐')))
  assert(store.recall(fish.id, '海边', { maxChars: 15 }).reduce((sum, item) => sum + item.text.length, 0) <= 15)
  store.updateCharacter(fish.id, { memoryEnabled: false })
  assert.deepEqual(store.recall(fish.id, '海边'), [])
  assert.equal(store.getCharacter(fish.id).memories.length, 5)
})

test('mutations and snapshots never hand out live mutable state', t => {
  const { store } = fixture(t)
  const fish = store.createCharacter({ name: '小鱼' })
  fish.name = 'unexpected'
  const snapshot = store.snapshot()
  snapshot.characters[0].name = 'unexpected'
  snapshot.characters.length = 0
  const record = store.getCharacter(fish.id)
  record.character.persona = 'unexpected'
  assert.equal(store.getCharacter(fish.id).character.name, '小鱼')
  assert.equal(store.getCharacter(fish.id).character.persona, '')
})

test('export/import creates an independent copy and never reattaches old sessions', t => {
  const { directory, store } = fixture(t)
  const fish = store.createCharacter({ name: '小鱼', persona: '温和' })
  store.bindSession({ characterId: fish.id, sessionId: 'original' })
  store.saveMemory({ characterId: fish.id, text: '旧记忆', kind: 'episode', sourceSessionId: 'original', sourceEventId: 'original:1' })
  const backup = store.exportCharacter(fish.id)
  const copy = store.importCharacter(backup)
  assert.notEqual(copy.character.id, fish.id)
  assert.notEqual(copy.memories[0].id, backup.memories[0].id)
  assert.deepEqual(copy.bindings, [])
  assert(!('sourceSessionId' in copy.memories[0]))
  store.deleteCharacter(fish.id)
  assert.equal(store.getBinding('original'), null)
  assert.equal(store.getCharacter(copy.character.id).memories[0].text, '旧记忆')
  assert.equal(createStore({ directory }).snapshot().characters.length, 1)
})

test('malformed import, cross-role import and invalid fields are rejected without changing state', t => {
  const { store } = fixture(t)
  const fish = store.createCharacter({ name: '小鱼' })
  store.saveMemory({ characterId: fish.id, text: '有效记忆' })
  const baseline = store.snapshot()
  assert.throws(() => store.createCharacter({ name: '   ' }), /不能为空/)
  assert.throws(() => store.createCharacter({ name: 'a'.repeat(LIMITS.nameChars + 1) }), /超过/)
  assert.throws(() => store.createCharacter({ name: '头像', avatar: 'https://a' }), /短文本/)
  assert.throws(() => store.updateCharacter(fish.id, { id: 'fish_fake' }), /不支持/)
  assert.throws(() => store.updateCharacter(fish.id, { autoCapture: 'yes' }), /布尔值/)
  assert.throws(() => store.saveMemory({ characterId: fish.id, text: 'x'.repeat(LIMITS.memoryChars + 1) }), /超过/)
  assert.throws(() => store.recall(fish.id, 'x', { limit: Infinity }), /召回数量/)
  assert.throws(() => store.importCharacter({}), /受支持/)
  const backup = store.exportCharacter(fish.id)
  backup.memories[0].characterId = 'fish_other'
  assert.throws(() => store.importCharacter(backup), /其他角色/)
  assert.deepEqual(store.snapshot(), baseline)
})

test('corrupt/unsupported/orphaned persisted state fails closed and keeps the file unchanged', t => {
  const { directory, store } = fixture(t)
  const fish = store.createCharacter({ name: '小鱼' })
  const valid = store.snapshot()
  const cases = [
    '{broken',
    JSON.stringify({ ...valid, version: 99 }),
    JSON.stringify({ ...valid, characters: [{ ...fish, memoryEnabled: 'yes' }] }),
    JSON.stringify({ ...valid, bindings: [{ sessionId: 'a', characterId: 'fish_missing', createdAt: fish.createdAt }] }),
    JSON.stringify({ ...valid, characters: [fish, fish] }),
  ]
  const filename = path.join(directory, 'state.json')
  for (const contents of cases) {
    fs.writeFileSync(filename, contents)
    assert.throws(() => createStore({ directory }), /停止写入/)
    assert.equal(fs.readFileSync(filename, 'utf8'), contents)
  }
})

test('a failed atomic replacement rolls back memory and removes its temporary file', t => {
  const { directory, store } = fixture(t)
  const fish = store.createCharacter({ name: '小鱼' })
  const filename = path.join(directory, 'state.json')
  const original = fs.readFileSync(filename, 'utf8')
  // A directory at the destination reliably makes rename fail on Windows and Unix.
  fs.unlinkSync(filename)
  fs.mkdirSync(filename)
  assert.throws(() => store.updateCharacter(fish.id, { name: '保存不应成功' }), /保存失败/)
  assert.equal(store.getCharacter(fish.id).character.name, '小鱼')
  assert.equal(fs.readdirSync(directory).filter(name => name.endsWith('.tmp')).length, 0)
  fs.rmdirSync(filename)
  fs.writeFileSync(filename, original)
  assert.equal(createStore({ directory }).getCharacter(fish.id).character.name, '小鱼')
})

test('character capacity rejects additions without truncating old data', t => {
  const { store } = fixture(t)
  for (let index = 0; index < LIMITS.characters; index++) store.createCharacter({ name: `角色 ${index}` })
  assert.throws(() => store.createCharacter({ name: '超额角色' }), /数量或格式无效/)
  assert.equal(store.snapshot().characters.length, LIMITS.characters)
})
