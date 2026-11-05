import { install } from './runtime.js'
import { createTravelFeature } from './travel.js'

export const name = 'dsh-yangyu'
export const inject = ['systemPrompt', 'tools', 'agents', 'sessions', 'webServer', 'settings', 'agentDefaultModel']

export async function apply(ctx, config = {}) {
  if (config.enabled === false) return
  const { defineTool } = await import('@deepseek-ai/dsh-tools')
  const { default: QRCode } = await import('qrcode')
  install(ctx, config, { defineTool, createTravel: args => createTravelFeature({ ...args,
    renderQR: text => QRCode.toDataURL(text, { width: 300, margin: 2, errorCorrectionLevel: 'M' }),
  }) })
}
