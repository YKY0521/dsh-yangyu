import path from 'node:path'
import { createTravelState } from './travel-state.js'
import { createTravelManager } from './travel-manager.js'
import { createTravelResponder } from './travel-responder.js'
import { createWeChatAdapter } from './travel-wechat.js'
import { createQQAdapter, discoverQQConfig } from './travel-qq.js'
import { ensureQQService } from './travel-launcher.js'

export function createTravelFeature({ ctx, store, home, renderQR }) {
  let manager
  const responder = createTravelResponder({ ctx, store, home,
    getConnection: (...args) => manager.getConnection(...args),
    updateConnection: (...args) => manager.updateConnection(...args),
  })
  manager = createTravelManager({ store, privateState: createTravelState(path.join(home, 'storages', 'dsh-yangyu')),
    adapters: { wechat: createWeChatAdapter(), qq: createQQAdapter() },
    resolveQQ: characterId => discoverQQConfig({ home, characterId }), ensureQQ: ensureQQService,
    renderQR, reply: responder.reply,
  })
  ctx.on('ready', () => manager.resume())
  ctx.effect(() => () => { manager.close(); return responder.close() })
  // Plugins may also be hot-loaded after the host's ready event.
  const timer = setTimeout(() => manager.resume(), 0)
  ctx.effect(() => () => clearTimeout(timer))
  return manager
}
