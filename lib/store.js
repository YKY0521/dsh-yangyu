import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

/** Local-only storage. No role ID or request value is ever used as a file path. */
export const LIMITS = Object.freeze({
  characters: 200,
  memories: 20_000,
  memoriesPerCharacter: 5_000,
  bindings: 10_000,
  fileBytes: 16 * 1024 * 1024,
  nameChars: 60,
  personaChars: 64_000,
  memoryChars: 8_000,
  avatarChars: 16,
})

const FORMAT = 'dsh-yangyu-character'
const clone = value => structuredClone(value)
const now = () => new Date().toISOString()
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key)
const fail = message => { throw new Error(message) }
const object = (value, label) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label}必须是对象`)
  return value
}
const text = (value, label, max, { empty = false, trim = false } = {}) => {
  if (typeof value !== 'string') fail(`${label}必须是文本`)
  const result = trim ? value.trim() : value
  if ((!empty && !result.trim()) || result.length > max || result.includes('\0')) {
    fail(`${label}${empty ? '' : '不能为空，且'}不能超过 ${max} 个字符或包含空字符`)
  }
  return result
}
const idOf = (value, label = 'ID') => {
  if (typeof value !== 'string' || !/^[a-z][a-z0-9_-]{0,79}$/i.test(value)) fail(`${label}无效`)
  return value
}
const sessionOf = value => {
  const result = text(value, '会话ID', 256, { trim: true })
  if (/[\x00-\x1f\x7f]/.test(result)) fail('会话ID含无效字符')
  return result
}
const boolean = (value, label) => {
  if (typeof value !== 'boolean') fail(`${label}必须是布尔值`)
  return value
}
const dateOf = (value, label) => {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
    || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) fail(`${label}无效`)
  return value
}
const avatarOf = value => {
  const result = text(value, '头像', LIMITS.avatarChars, { empty: true, trim: true })
  if (/[<>\x00-\x1f\x7f]/.test(result) || /(?:https?:|data:|file:|javascript:|www\.)/i.test(result)) {
    fail('头像请使用表情或短文本')
  }
  return result
}
const kindOf = value => {
  if (value !== 'fixed' && value !== 'episode') fail('记忆类型必须是 fixed 或 episode')
  return value
}
const unique = (items, field, label) => {
  const values = new Set()
  for (const item of items) {
    if (values.has(item[field])) fail(`${label}重复`)
    values.add(item[field])
  }
  return values
}

function validateCharacter(value) {
  object(value, '角色')
  return {
    id: idOf(value.id, '角色ID'),
    name: text(value.name, '名字', LIMITS.nameChars, { trim: true }),
    avatar: avatarOf(value.avatar),
    persona: text(value.persona, '人设', LIMITS.personaChars, { empty: true }),
    memoryEnabled: boolean(value.memoryEnabled, '记忆开关'),
    autoCapture: boolean(value.autoCapture, '自动记忆开关'),
    createdAt: dateOf(value.createdAt, '创建时间'),
    updatedAt: dateOf(value.updatedAt, '更新时间'),
  }
}

function validateMemory(value) {
  object(value, '记忆')
  const result = {
    id: idOf(value.id, '记忆ID'),
    characterId: idOf(value.characterId, '角色ID'),
    text: text(value.text, '记忆', LIMITS.memoryChars, { trim: true }),
    kind: kindOf(value.kind),
    important: boolean(value.important, '重要标记'),
    createdAt: dateOf(value.createdAt, '创建时间'),
    updatedAt: dateOf(value.updatedAt, '更新时间'),
  }
  if (own(value, 'sourceSessionId')) result.sourceSessionId = sessionOf(value.sourceSessionId)
  if (own(value, 'sourceEventId')) result.sourceEventId = text(value.sourceEventId, '来源事件ID', 512)
  return result
}

function validateBinding(value) {
  object(value, '会话绑定')
  const result = {
    sessionId: sessionOf(value.sessionId),
    characterId: idOf(value.characterId, '角色ID'),
    createdAt: dateOf(value.createdAt, '创建时间'),
  }
  if (own(value, 'title')) result.title = text(value.title, '会话标题', 200, { empty: true, trim: true })
  return result
}

function validateState(value) {
  object(value, '数据')
  if (value.version !== 1) fail('不支持的数据版本')
  for (const field of ['characters', 'memories', 'bindings']) {
    if (!Array.isArray(value[field]) || value[field].length > LIMITS[field]) fail(`${field}数量或格式无效`)
  }
  const result = {
    version: 1,
    characters: value.characters.map(validateCharacter),
    memories: value.memories.map(validateMemory),
    bindings: value.bindings.map(validateBinding),
  }
  const characterIds = unique(result.characters, 'id', '角色ID')
  unique(result.memories, 'id', '记忆ID')
  unique(result.bindings, 'sessionId', '会话ID')
  const bindingById = new Map(result.bindings.map(binding => [binding.sessionId, binding]))
  const counts = new Map()
  const eventIds = new Set()
  for (const binding of result.bindings) {
    if (!characterIds.has(binding.characterId)) fail('会话绑定指向不存在的角色')
  }
  for (const memory of result.memories) {
    if (!characterIds.has(memory.characterId)) fail('记忆指向不存在的角色')
    const count = (counts.get(memory.characterId) || 0) + 1
    if (count > LIMITS.memoriesPerCharacter) fail('单个角色记忆数量已达上限')
    counts.set(memory.characterId, count)
    if (memory.sourceSessionId && bindingById.get(memory.sourceSessionId)?.characterId !== memory.characterId) {
      fail('记忆来源会话与角色不匹配')
    }
    if (memory.kind === 'episode' && memory.sourceEventId) {
      const key = JSON.stringify([memory.characterId, memory.sourceEventId])
      if (eventIds.has(key)) fail('重复的相处记忆事件')
      eventIds.add(key)
    }
  }
  return result
}

function termsOf(query) {
  const result = new Set()
  const normalized = String(query ?? '').slice(0, 2048).normalize('NFKC').toLowerCase()
  for (const word of normalized.match(/[a-z0-9_]{2,}/g) || []) {
    result.add(word)
    if (result.size >= 64) return [...result]
  }
  for (const word of normalized.match(/\p{Script=Han}+/gu) || []) {
    const chars = [...word]
    if (chars.length === 1) result.add(word)
    for (let index = 0; index + 1 < chars.length; index++) {
      result.add(chars[index] + chars[index + 1])
      if (result.size >= 64) return [...result]
    }
  }
  return [...result]
}

const boundedInteger = (value, label, min, max) => {
  if (!Number.isInteger(value) || value < min || value > max) fail(`${label}必须在 ${min} 到 ${max} 之间`)
  return value
}

/**
 * Synchronous writes serialize mutation within the single DSH host process.
 * Each commit validates a fresh state and atomically renames a temporary file.
 * An I/O failure leaves both the current in-memory state and old file untouched.
 * Use exactly one store instance for a given directory in a host process.
 */
export function createStore({ directory } = {}) {
  if (typeof directory !== 'string' || !directory.trim()) fail('必须指定存储目录')
  const root = path.resolve(directory)
  const filename = path.join(root, 'state.json')
  let state = { version: 1, characters: [], bindings: [], memories: [] }
  if (fs.existsSync(filename)) {
    try {
      const stat = fs.statSync(filename)
      if (!stat.isFile() || stat.size > LIMITS.fileBytes) fail('数据文件过大或格式无效')
      state = validateState(JSON.parse(fs.readFileSync(filename, 'utf8')))
    } catch (error) {
      throw new Error(`养鱼数据无法读取；已停止写入，请先恢复备份：${error.message}`, { cause: error })
    }
  }

  function persist(next) {
    const serialized = JSON.stringify(next, null, 2)
    if (Buffer.byteLength(serialized) > LIMITS.fileBytes) fail('数据文件容量已达上限，请导出并清理旧记忆')
    fs.mkdirSync(root, { recursive: true })
    const temporary = path.join(root, `.state-${randomUUID()}.tmp`)
    let descriptor
    try {
      descriptor = fs.openSync(temporary, 'wx', 0o600)
      fs.writeFileSync(descriptor, serialized, 'utf8')
      fs.fsyncSync(descriptor)
      fs.closeSync(descriptor)
      descriptor = undefined
      fs.renameSync(temporary, filename)
    } catch (error) {
      if (descriptor !== undefined) {
        try { fs.closeSync(descriptor) } catch { /* Preserve the original I/O error. */ }
      }
      try { fs.unlinkSync(temporary) } catch { /* May not have been created. */ }
      throw new Error(`养鱼数据保存失败：${error.message}`, { cause: error })
    }
  }

  function mutate(action) {
    const next = clone(state)
    const result = action(next)
    const validated = validateState(next)
    persist(validated)
    state = validated
    return clone(result)
  }

  function requireCharacter(target, id) {
    idOf(id, '角色ID')
    const character = target.characters.find(item => item.id === id)
    if (!character) fail('找不到这个角色')
    return character
  }

  const api = {
    snapshot: () => clone(state),
    getCharacter(id) {
      return clone({
        character: requireCharacter(state, id),
        memories: state.memories.filter(item => item.characterId === id),
        bindings: state.bindings.filter(item => item.characterId === id),
      })
    },
    createCharacter(input) {
      object(input, '角色')
      return mutate(next => {
        const timestamp = now()
        const character = validateCharacter({
          id: `fish_${randomUUID()}`,
          name: input.name,
          avatar: input.avatar ?? '🐟',
          persona: input.persona ?? '',
          memoryEnabled: true,
          autoCapture: true,
          createdAt: timestamp,
          updatedAt: timestamp,
        })
        next.characters.push(character)
        return character
      })
    },
    updateCharacter(id, patch) {
      object(patch, '角色更新')
      return mutate(next => {
        const character = requireCharacter(next, id)
        const allowed = ['name', 'avatar', 'persona', 'memoryEnabled', 'autoCapture']
        for (const field of Object.keys(patch)) {
          if (!allowed.includes(field)) fail(`不支持更新角色字段：${field}`)
        }
        for (const field of allowed) if (own(patch, field)) character[field] = patch[field]
        character.updatedAt = now()
        return validateCharacter(character)
      })
    },
    deleteCharacter(id) {
      return mutate(next => {
        requireCharacter(next, id)
        next.characters = next.characters.filter(item => item.id !== id)
        next.memories = next.memories.filter(item => item.characterId !== id)
        next.bindings = next.bindings.filter(item => item.characterId !== id)
        return { id }
      })
    },
    bindSession(input) {
      object(input, '会话绑定')
      return mutate(next => {
        requireCharacter(next, input.characterId)
        const sessionId = sessionOf(input.sessionId)
        const existing = next.bindings.find(item => item.sessionId === sessionId)
        if (existing && existing.characterId !== input.characterId) fail('该会话已属于另一角色，请新建会话')
        if (existing) {
          if (own(input, 'title')) existing.title = text(input.title, '会话标题', 200, { empty: true, trim: true })
          return existing
        }
        const binding = validateBinding({
          sessionId,
          characterId: input.characterId,
          createdAt: now(),
          ...(own(input, 'title') ? { title: input.title } : {}),
        })
        next.bindings.push(binding)
        return binding
      })
    },
    getBinding(sessionId) {
      const normalized = sessionOf(sessionId)
      return clone(state.bindings.find(item => item.sessionId === normalized) ?? null)
    },
    saveMemory(input) {
      object(input, '记忆')
      requireCharacter(state, input.characterId)
      if (input.sourceSessionId && api.getBinding(input.sourceSessionId)?.characterId !== input.characterId) {
        fail('记忆来源会话与角色不匹配')
      }
      if (!input.id && input.kind === 'episode' && input.sourceEventId) {
        const previous = state.memories.find(item => item.characterId === input.characterId
          && item.kind === 'episode' && item.sourceEventId === input.sourceEventId)
        if (previous) return clone(previous)
      }
      return mutate(next => {
        requireCharacter(next, input.characterId)
        let existing
        if (input.id !== undefined) {
          idOf(input.id, '记忆ID')
          existing = next.memories.find(item => item.id === input.id)
          if (!existing || existing.characterId !== input.characterId) fail('找不到这个角色的记忆')
        }
        const timestamp = now()
        const memory = validateMemory({
          ...(existing || {}),
          id: existing?.id ?? `memory_${randomUUID()}`,
          characterId: input.characterId,
          text: input.text,
          kind: input.kind ?? existing?.kind ?? 'episode',
          important: input.important ?? existing?.important ?? false,
          createdAt: existing?.createdAt ?? timestamp,
          updatedAt: timestamp,
          ...(own(input, 'sourceSessionId') ? { sourceSessionId: input.sourceSessionId } : {}),
          ...(own(input, 'sourceEventId') ? { sourceEventId: input.sourceEventId } : {}),
        })
        if (existing) next.memories[next.memories.indexOf(existing)] = memory
        else next.memories.push(memory)
        return memory
      })
    },
    deleteMemory(input) {
      object(input, '记忆')
      return mutate(next => {
        requireCharacter(next, input.characterId)
        idOf(input.id, '记忆ID')
        const memory = next.memories.find(item => item.id === input.id && item.characterId === input.characterId)
        if (!memory) fail('找不到这个角色的记忆')
        next.memories = next.memories.filter(item => item.id !== memory.id)
        return { id: memory.id }
      })
    },
    recall(characterId, query, { limit = 8, maxChars = 6500 } = {}) {
      const character = requireCharacter(state, characterId)
      boundedInteger(limit, '召回数量', 1, 100)
      boundedInteger(maxChars, '召回字数', 1, 32_000)
      if (!character.memoryEnabled) return []
      const terms = termsOf(query)
      const scored = state.memories.filter(memory => memory.characterId === characterId).map(memory => {
        const content = memory.text.normalize('NFKC').toLowerCase()
        const hits = terms.filter(term => content.includes(term)).length
        const relevance = terms.length ? hits / terms.length : 0
        return { memory, hits, score: (memory.important ? 100 : 0) + (memory.kind === 'fixed' ? 60 : 0) + relevance * 40 }
      }).filter(item => item.memory.important || item.memory.kind === 'fixed' || item.hits > 0)
        .sort((a, b) => b.score - a.score || b.memory.updatedAt.localeCompare(a.memory.updatedAt) || a.memory.id.localeCompare(b.memory.id))
      const result = []
      let budget = maxChars
      for (const { memory } of scored) {
        if (result.length >= limit || budget <= 0) break
        const selected = clone(memory)
        if (selected.text.length > budget) {
          // Avoid retaining half of an emoji at the truncation boundary.
          selected.text = selected.text.slice(0, budget)
          if (/[\uD800-\uDBFF]$/.test(selected.text)) selected.text = selected.text.slice(0, -1)
        }
        if (!selected.text) continue
        budget -= selected.text.length
        result.push(selected)
      }
      return result
    },
    exportCharacter(id) {
      const { character, memories } = api.getCharacter(id)
      return { format: FORMAT, version: 1, character, memories }
    },
    importCharacter(data) {
      object(data, '导入数据')
      if (data.format !== FORMAT || data.version !== 1) fail('不是受支持的养鱼角色备份')
      // Check before cloning to keep even direct API callers bounded.
      if (!Array.isArray(data.memories) || data.memories.length > LIMITS.memoriesPerCharacter) fail('导入记忆数量无效')
      const serialized = JSON.stringify(data)
      if (Buffer.byteLength(serialized) > LIMITS.fileBytes) fail('导入文件过大')
      const original = validateCharacter(data.character)
      const memories = data.memories.map(validateMemory)
      unique(memories, 'id', '导入记忆ID')
      for (const memory of memories) if (memory.characterId !== original.id) fail('导入记忆包含其他角色的数据')
      return mutate(next => {
        const timestamp = now()
        const character = { ...original, id: `fish_${randomUUID()}`, createdAt: timestamp, updatedAt: timestamp }
        next.characters.push(character)
        const imported = memories.map(memory => {
          // Historical session IDs must not attach a copy to existing chat histories.
          const { sourceSessionId, sourceEventId, ...rest } = memory
          return { ...rest, id: `memory_${randomUUID()}`, characterId: character.id }
        })
        next.memories.push(...imported)
        return { character, memories: imported, bindings: [] }
      })
    },
  }
  return api
}
