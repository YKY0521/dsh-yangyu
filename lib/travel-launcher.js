import fs from 'node:fs'
import path from 'node:path'
import { spawn, execFile } from 'node:child_process'
import { promisify } from 'node:util'

const run = promisify(execFile)
let starting

/** Start the already installed service, never the old script that kills QQ processes. */
export async function ensureQQService(config, signal) {
  const url = new URL(config.webUiUrl)
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || url.username || url.password) throw new Error('QQ 扫码服务必须位于本机')
  async function available() {
    try {
      const response = await fetch(url, { redirect: 'manual', signal: AbortSignal.any([signal, AbortSignal.timeout(1500)]) })
      await response.body?.cancel()
      return true
    } catch { return false }
  }
  if (signal.aborted) throw new Error('连接操作已取消')
  if (await available()) return
  if (!config.launch || process.platform !== 'win32') throw new Error('QQ 扫码服务尚未运行，请先启动已安装的 NapCat')
  if (starting) { await starting; if (signal.aborted) throw new Error('连接操作已取消'); return }
  starting = (async () => {
    const { launcher, qqExe, hookDll, appDir } = config.launch
    if (path.basename(launcher) !== 'NapCatWinBootMain.exe' || path.basename(qqExe) !== 'QQ.exe' || path.basename(hookDll) !== 'NapCatWinBootHook.dll') throw new Error('QQ 启动配置无效')
    if (![launcher, qqExe, hookDll, path.join(appDir, 'loadNapCat.js'), path.join(appDir, 'napcat.mjs')].every(f => fs.existsSync(f))) throw new Error('QQ 扫码组件不完整，请修复 NapCat 安装')
    const { stdout } = await run('tasklist.exe', ['/FI', 'IMAGENAME eq QQ.exe', '/FO', 'CSV', '/NH'], { windowsHide: true, timeout: 5000 })
    if (!/^"QQ\.exe",/im.test(stdout)) {
      if (signal.aborted) throw new Error('连接操作已取消')
      const env = { ...process.env, NAPCAT_PATCH_PACKAGE: path.join(appDir, 'qqnt.json'),
        NAPCAT_LOAD_PATH: path.join(appDir, 'loadNapCat.js'), NAPCAT_INJECT_PATH: hookDll,
        NAPCAT_LAUNCHER_PATH: launcher, NAPCAT_MAIN_PATH: path.join(appDir, 'napcat.mjs') }
      delete env.ELECTRON_RUN_AS_NODE
      await new Promise((resolve, reject) => {
        const child = spawn(launcher, [qqExe, hookDll], { cwd: appDir, env, windowsHide: true, detached: true, stdio: 'ignore' })
        child.once('error', () => reject(new Error('QQ 扫码组件启动失败，请检查 NapCat 安装')))
        child.once('spawn', () => { child.unref(); resolve() })
      })
    }
    const deadline = Date.now() + 20_000
    while (Date.now() < deadline && !signal.aborted) {
      if (await available()) return
      await new Promise(resolve => {
        const done = () => { clearTimeout(timer); signal.removeEventListener('abort', done); resolve() }
        const timer = setTimeout(done, 600)
        signal.addEventListener('abort', done, { once: true })
      })
    }
    throw new Error(signal.aborted ? '连接操作已取消' : 'QQ 扫码服务尚未就绪；如果普通 QQ 正在运行，请使用 NapCat 启动的 QQ 后重试')
  })()
  try { await starting } finally { starting = null }
}
