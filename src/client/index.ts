/**
 * dsh-mcp-manager — browser half.
 *
 * Registers one surface: the "MCP Manager" card on the web settings page
 * (settings.section entry), which lists every configured MCP server with its
 * live state and drives add / edit / enable / test / remove over the loopback
 * route family.
 *
 * Failure policy: registration problems are logged, never thrown — the web
 * shell fails the whole boot when a plugin apply throws, and an external
 * plugin must not take the GUI down.
 */
// Type-only: pulls the settings-surface SlotMap merge (the 'settings.section'
// entry) and the client runtime Context merge.
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type { Context as ClientContext } from '@deepseek-ai/cordis'

import { McpManagerPanel } from './McpManagerPanel.tsx'

/** Required services. */
export const inject = ['slots']

/**
 * Register the MCP manager settings card.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  try {
    ctx.slots.inject('settings.section', () => ctx.slots.register(
      {
        name: 'settings.section',
        id: 'mcp-manager',
        order: 341,
        label: () => 'MCP Manager',
      },
      McpManagerPanel,
    ))
  } catch (error) {
    console.warn('[dsh-mcp-manager] settings panel registration failed:', error)
  }
}
