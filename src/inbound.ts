/**
 * Inbound message handling — FROM the iOS app TO the agent.
 *
 * Flow overview
 * -------------
 * The Gateway handles inbound chat messages automatically: when the iOS app
 * sends a `chat.send` RPC over its operator WebSocket connection, the Gateway
 * routes the message to the active session via the normal channel pipeline.
 * No special handling is required here for that core path.
 *
 * This module provides hooks for ClawHouse-specific preprocessing that should
 * run *before* the message reaches the agent, such as:
 *   - Attaching channel metadata (deviceId, deviceName) to the message context
 *   - Rate-limiting or deduplication per device
 *   - Logging inbound traffic for debugging
 */

import type { InboundMessage } from './types.js';

export interface InboundContext {
  deviceId?: string;
  deviceName?: string;
}

/**
 * Preprocess an inbound message from the iOS app before it is forwarded to
 * the agent. Returns the (possibly mutated) message along with enriched
 * context that downstream handlers can use.
 *
 * @param message  Raw inbound message received from the Gateway.
 * @param context  Optional ClawHouse-specific context (device info, etc.).
 * @returns        Enriched message and context ready for agent consumption.
 */
export function preprocessInbound(
  message: InboundMessage,
  context: InboundContext = {}
): { message: InboundMessage; context: InboundContext } {
  // Attach ClawHouse channel identifier so the agent can distinguish the
  // source from other channels (Discord, WhatsApp, etc.)
  const enriched: InboundMessage = {
    ...message,
    channel: 'clawhouse',
  };

  return { message: enriched, context };
}

/**
 * Set up any additional inbound processing the plugin needs.
 *
 * Currently this is a no-op because the Gateway routes `chat.send` messages
 * to the agent automatically. Call this from `index.ts` if you later need to
 * register a hook that fires on every inbound message for preprocessing.
 *
 * @param api  The OpenClaw plugin API handle.
 */
export function setupInboundHandler(api: any): void {
  // Future hook registration goes here, e.g.:
  //
  //   api.registerHook('channel.message.before', (msg: InboundMessage) => {
  //     if (msg.channel !== 'clawhouse') return;
  //     return preprocessInbound(msg, { deviceId: msg.senderId });
  //   });
  //
  api.logger.info('[ClawHouse] Inbound handler ready (Gateway routes chat.send automatically)');
}
