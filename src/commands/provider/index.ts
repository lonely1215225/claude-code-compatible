import type { Command } from '../../commands.js'

const provider = {
  type: 'local-jsx',
  name: 'provider',
  aliases: ['providers'],
  description: 'Configure AI provider, API key, base URL, and protocol',
  load: () => import('./provider.js'),
} satisfies Command

export default provider
