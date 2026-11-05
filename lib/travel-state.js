import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

// Separate from character exports: this file contains IM authorization secrets.
export function createTravelState(directory) {
  const filename = path.join(directory, 'travel-private.json')
  let state = { version: 1, connections: [] }
  if (fs.existsSync(filename)) {
    if (fs.statSync(filename).size > 4 * 1024 * 1024) throw new Error('出游授权文件过大，请恢复备份')
    try {
      state = JSON.parse(fs.readFileSync(filename, 'utf8'))
      if (state.version !== 1 || !Array.isArray(state.connections) || state.connections.length > 400) throw new Error()
      const keys = new Set()
      for (const c of state.connections) {
        if (typeof c.characterId !== 'string' || !['qq', 'wechat'].includes(c.platform) || typeof c.generation !== 'string') throw new Error()
        const key = `${c.characterId}:${c.platform}`
        if (keys.has(key)) throw new Error()
        keys.add(key)
      }
    } catch { throw new Error('出游授权文件损坏，已停止读取；请恢复备份') }
  }
  function commit(change) {
    const next = structuredClone(state)
    const result = change(next.connections)
    const text = JSON.stringify(next)
    if (Buffer.byteLength(text) > 4 * 1024 * 1024) throw new Error('出游授权存储已满')
    fs.mkdirSync(directory, { recursive: true })
    const tmp = path.join(directory, `.travel-${randomUUID()}.tmp`)
    let fd
    try {
      fd = fs.openSync(tmp, 'wx', 0o600)
      fs.writeFileSync(fd, text, 'utf8')
      fs.fsyncSync(fd)
      fs.closeSync(fd)
      fd = undefined
      fs.renameSync(tmp, filename)
    } catch {
      if (fd !== undefined) try { fs.closeSync(fd) } catch { /* preserve failure */ }
      try { fs.unlinkSync(tmp) } catch { /* best effort */ }
      throw new Error('出游授权保存失败，原授权数据已保留')
    }
    state = next
    return structuredClone(result)
  }
  return {
    list: () => structuredClone(state.connections),
    get: (id, platform) => structuredClone(state.connections.find(c => c.characterId === id && c.platform === platform) ?? null),
    put(connection) {
      return commit(rows => {
        const index = rows.findIndex(c => c.characterId === connection.characterId && c.platform === connection.platform)
        if (index < 0) rows.push(structuredClone(connection))
        else rows[index] = structuredClone(connection)
        return connection
      })
    },
    remove(id, platform) {
      return commit(rows => {
        for (let i = rows.length - 1; i >= 0; i--) if (rows[i].characterId === id && (!platform || rows[i].platform === platform)) rows.splice(i, 1)
        return true
      })
    },
  }
}
