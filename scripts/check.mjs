import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import assert from 'node:assert/strict'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
assert.equal(pkg.name, 'dsh-yangyu')
assert.match(pkg.version, /^\d+\.\d+\.\d+(?:-[a-z0-9.-]+)?$/)
assert.equal(pkg.dsh.bundle.patch, 'cordis.patch.yml')
assert.equal(pkg.dsh.client.platform, 'web')
for (const filename of [pkg.main, pkg.exports['./client'], pkg.icon, 'cordis.patch.yml', 'README.md', 'CHANGELOG.md', 'LICENSE', 'docs/COMPATIBILITY.md', 'docs/PUBLISHING.md']) {
  assert.ok(fs.statSync(path.join(root, filename)).isFile(), `Missing ${filename}`)
}
assert.match(fs.readFileSync(path.join(root, 'cordis.patch.yml'), 'utf8'), /name: dsh-yangyu/)
function scan(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const filename = path.join(directory, entry.name)
    if (entry.isDirectory()) scan(filename)
    else {
      if (/\.(?:js|mjs)$/.test(entry.name)) execFileSync(process.execPath, ['--check', filename], { stdio: 'pipe' })
      if (/\.(?:js|mjs|md|yml|json|svg)$/.test(entry.name)) {
        const text = fs.readFileSync(filename, 'utf8')
        assert.ok(!/C:[\\/]+Users[\\/]+\d{5}[\\/]/i.test(text), `Personal path in ${entry.name}`)
        assert.ok(!/sk-[A-Za-z0-9]{24,}/.test(text), `Possible credential in ${entry.name}`)
      }
    }
  }
}
scan(path.join(root, 'lib'))
scan(path.join(root, 'docs'))
console.log(`dsh-yangyu ${pkg.version}: manifest, source syntax and release files verified`)
