import type { ClawState, ClawHouseEvent, ClawStateEvent, ConnectedClient } from './types.js';

// Idle timeout thresholds (ms)
const IDLE_REST_THRESHOLD = 5 * 60 * 1000;   // 5 minutes
const IDLE_SLEEP_THRESHOLD = 30 * 60 * 1000;  // 30 minutes

import type { APNsSender } from './push.js';
import type { PluginStorage } from './storage.js';

export interface ChannelDeps {
  pushSender?: APNsSender;
  storage?: PluginStorage;
}

export function createClawHouseChannel(api: any, deps?: ChannelDeps) {
  let currentState: ClawState = 'idle';
  let lastActivityTime = Date.now();
  let eventSeq = 0;
  let idleTimer: ReturnType<typeof setInterval> | null = null;

  // Track which iOS devices are currently subscribed / connected
  const connectedClients = new Map<string, ConnectedClient>();

  // ---------------------------------------------------------------------------
  // Client registry
  // ---------------------------------------------------------------------------

  function addClient(client: ConnectedClient): void {
    connectedClients.set(client.deviceId, client);
    api.logger.info(
      `[ClawHouse] Client connected: ${client.deviceName} (${client.deviceId}). ` +
      `Total clients: ${connectedClients.size}`
    );
  }

  function removeClient(deviceId: string): void {
    const client = connectedClients.get(deviceId);
    if (client) {
      connectedClients.delete(deviceId);
      api.logger.info(
        `[ClawHouse] Client disconnected: ${client.deviceName} (${deviceId}). ` +
        `Total clients: ${connectedClients.size}`
      );
    }
  }

  function broadcastToClients(event: ClawHouseEvent): void {
    if (connectedClients.size === 0) return;

    const failed: string[] = [];

    for (const [deviceId, client] of connectedClients) {
      try {
        client.send(event);
      } catch (err) {
        api.logger.warn(`[ClawHouse] Failed to send to ${deviceId}: ${err}`);
        failed.push(deviceId);
      }
    }

    // Clean up clients whose send threw — they are likely disconnected
    for (const deviceId of failed) {
      removeClient(deviceId);
    }
  }

  // ---------------------------------------------------------------------------
  // State management
  // ---------------------------------------------------------------------------

  function updateState(newState: ClawState, detail?: string) {
    const previousState = currentState;
    if (previousState === newState) return;

    currentState = newState;
    lastActivityTime = Date.now();

    const stateEvent: ClawStateEvent = {
      state: newState,
      detail,
      timestamp: Date.now(),
      previousState,
    };

    broadcastEvent({
      type: 'state_change',
      payload: stateEvent,
      timestamp: Date.now(),
      seq: ++eventSeq,
    });

    api.logger.info(`[ClawHouse] State: ${previousState} → ${newState}${detail ? ` (${detail})` : ''}`);
  }

  function broadcastEvent(event: ClawHouseEvent) {
    api.logger.debug(`[ClawHouse] Event: ${event.type} seq=${event.seq}`);
    broadcastToClients(event);
  }

  // ---------------------------------------------------------------------------
  // Idle monitor
  // ---------------------------------------------------------------------------

  function startIdleMonitor() {
    idleTimer = setInterval(() => {
      const idleDuration = Date.now() - lastActivityTime;

      if (currentState === 'working' || currentState === 'out' || currentState === 'chatting') {
        return; // Don't override active states
      }

      if (idleDuration >= IDLE_SLEEP_THRESHOLD && currentState !== 'sleeping') {
        updateState('sleeping');
      } else if (idleDuration >= IDLE_REST_THRESHOLD && currentState !== 'resting') {
        updateState('resting');
      }
    }, 30_000); // Check every 30 seconds
  }

  function stopIdleMonitor() {
    if (idleTimer) {
      clearInterval(idleTimer);
      idleTimer = null;
    }
  }

  // ---------------------------------------------------------------------------
  // Channel plugin definition
  // ---------------------------------------------------------------------------

  const channelPlugin = {
    id: 'clawhouse',

    meta: {
      id: 'clawhouse',
      label: 'ClawHouse',
      selectionLabel: 'ClawHouse (iOS)',
      blurb: 'Connect ClawHouse iOS app as a Gateway channel.',
      aliases: ['clawhouse', 'ios'],
      systemImage: 'iphone',
    },

    capabilities: {
      chatTypes: ['direct'] as const,
    },

    config: {
      listAccountIds: () => ['default'],
      resolveAccount: () => ({
        id: 'default',
        label: 'ClawHouse iOS App',
      }),
    },

    outbound: {
      deliveryMode: 'direct' as const,
      sendText: async (params: { text: string; sessionKey?: string }) => {
        updateState('chatting');

        broadcastEvent({
          type: 'message',
          payload: {
            text: params.text,
            from: 'agent',
            sessionKey: params.sessionKey,
          },
          timestamp: Date.now(),
          seq: ++eventSeq,
        });

        // Push notification when no clients connected (app in background)
        if (connectedClients.size === 0 && deps?.pushSender && deps?.storage) {
          const devices = deps.storage.getDevicesWithPushTokens();
          if (devices.length > 0) {
            const preview = params.text.length > 100 ? params.text.slice(0, 100) + '...' : params.text;
            deps.pushSender.sendToAll(
              devices as Array<{ pushToken: string; pushBundleId: string; pushEnvironment: 'development' | 'production' }>,
              { title: 'Claw', body: preview, data: { type: 'message' } },
            ).catch(() => { /* push best-effort */ });
          }
        }

        // After sending, return to idle tracking
        lastActivityTime = Date.now();
        setTimeout(() => {
          if (currentState === 'chatting') {
            updateState('idle');
          }
        }, 3000);

        return { ok: true };
      },
    },

    gateway: {
      start: () => {
        api.logger.info('[ClawHouse] Channel started');
        startIdleMonitor();
      },
      stop: () => {
        api.logger.info('[ClawHouse] Channel stopped');
        stopIdleMonitor();
        connectedClients.clear();
      },
    },
  };

  return {
    channelPlugin,
    updateState,
    broadcastEvent,
    addClient,
    removeClient,
    broadcastToClients,
    getConnectedClients: () => connectedClients,
    getCurrentState: () => currentState,
    eventSeq: () => eventSeq,
  };
}
