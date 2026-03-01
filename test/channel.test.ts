import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createClawHouseChannel } from '../src/channel.js';
import type { ChannelDeps } from '../src/channel.js';
import type { ClawHouseEvent, ConnectedClient } from '../src/types.js';

function createMockApi() {
  return {
    logger: {
      info: vi.fn(),
      debug: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
    config: {},
  };
}

describe('createClawHouseChannel', () => {
  let api: ReturnType<typeof createMockApi>;
  let channel: ReturnType<typeof createClawHouseChannel>;

  beforeEach(() => {
    api = createMockApi();
    channel = createClawHouseChannel(api);
  });

  it('should return channel plugin with correct id and meta', () => {
    expect(channel.channelPlugin.id).toBe('clawhouse');
    expect(channel.channelPlugin.meta.id).toBe('clawhouse');
    expect(channel.channelPlugin.meta.label).toBe('ClawHouse');
  });

  it('should start with idle state', () => {
    expect(channel.getCurrentState()).toBe('idle');
  });

  // ---------------------------------------------------------------------------
  // State management
  // ---------------------------------------------------------------------------

  describe('updateState', () => {
    it('should update current state', () => {
      channel.updateState('working');
      expect(channel.getCurrentState()).toBe('working');
    });

    it('should not broadcast if state unchanged', () => {
      const events: ClawHouseEvent[] = [];
      const client: ConnectedClient = {
        deviceId: 'test-device',
        deviceName: 'Test iPhone',
        connectedAt: Date.now(),
        send: (event) => events.push(event),
      };
      channel.addClient(client);

      // Force to idle first (already idle, so no event)
      channel.updateState('idle');
      expect(events).toHaveLength(0);

      // Now change to working — should broadcast
      channel.updateState('working');
      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('state_change');
    });

    it('should include previousState in state_change event', () => {
      const events: ClawHouseEvent[] = [];
      const client: ConnectedClient = {
        deviceId: 'test-device',
        deviceName: 'Test iPhone',
        connectedAt: Date.now(),
        send: (event) => events.push(event),
      };
      channel.addClient(client);

      channel.updateState('working');
      channel.updateState('out', 'gmail');

      expect(events).toHaveLength(2);
      const lastPayload = events[1].payload as any;
      expect(lastPayload.state).toBe('out');
      expect(lastPayload.previousState).toBe('working');
      expect(lastPayload.detail).toBe('gmail');
    });
  });

  // ---------------------------------------------------------------------------
  // Client management
  // ---------------------------------------------------------------------------

  describe('client management', () => {
    it('should add and track connected clients', () => {
      const client: ConnectedClient = {
        deviceId: 'device-1',
        deviceName: 'iPhone 1',
        connectedAt: Date.now(),
        send: vi.fn(),
      };

      channel.addClient(client);
      expect(channel.getConnectedClients().size).toBe(1);
      expect(channel.getConnectedClients().get('device-1')).toBe(client);
    });

    it('should remove clients', () => {
      const client: ConnectedClient = {
        deviceId: 'device-1',
        deviceName: 'iPhone 1',
        connectedAt: Date.now(),
        send: vi.fn(),
      };

      channel.addClient(client);
      channel.removeClient('device-1');
      expect(channel.getConnectedClients().size).toBe(0);
    });

    it('should broadcast events to all connected clients', () => {
      const events1: ClawHouseEvent[] = [];
      const events2: ClawHouseEvent[] = [];

      channel.addClient({
        deviceId: 'device-1',
        deviceName: 'iPhone 1',
        connectedAt: Date.now(),
        send: (event) => events1.push(event),
      });

      channel.addClient({
        deviceId: 'device-2',
        deviceName: 'iPhone 2',
        connectedAt: Date.now(),
        send: (event) => events2.push(event),
      });

      channel.updateState('working');

      expect(events1).toHaveLength(1);
      expect(events2).toHaveLength(1);
      expect(events1[0].type).toBe('state_change');
      expect(events2[0].type).toBe('state_change');
    });

    it('should remove clients whose send throws', () => {
      const goodEvents: ClawHouseEvent[] = [];

      channel.addClient({
        deviceId: 'device-good',
        deviceName: 'Good iPhone',
        connectedAt: Date.now(),
        send: (event) => goodEvents.push(event),
      });

      channel.addClient({
        deviceId: 'device-bad',
        deviceName: 'Bad iPhone',
        connectedAt: Date.now(),
        send: () => { throw new Error('connection lost'); },
      });

      expect(channel.getConnectedClients().size).toBe(2);
      channel.updateState('working');

      // Bad client should have been removed
      expect(channel.getConnectedClients().size).toBe(1);
      expect(channel.getConnectedClients().has('device-bad')).toBe(false);

      // Good client should still have received the event
      expect(goodEvents).toHaveLength(1);
    });
  });

  // ---------------------------------------------------------------------------
  // Outbound messages (sendText)
  // ---------------------------------------------------------------------------

  describe('outbound sendText', () => {
    it('should broadcast message event to connected clients', async () => {
      const events: ClawHouseEvent[] = [];
      channel.addClient({
        deviceId: 'device-1',
        deviceName: 'Test iPhone',
        connectedAt: Date.now(),
        send: (event) => events.push(event),
      });

      const result = await channel.channelPlugin.outbound.sendText({
        text: 'Hello from agent!',
        sessionKey: 'main',
      });

      expect(result).toEqual({ ok: true });

      // Should have: 1 state_change (to chatting) + 1 message
      const messageEvents = events.filter(e => e.type === 'message');
      expect(messageEvents).toHaveLength(1);

      const payload = messageEvents[0].payload as any;
      expect(payload.text).toBe('Hello from agent!');
      expect(payload.from).toBe('agent');
      expect(payload.sessionKey).toBe('main');
    });

    it('should transition state to chatting on sendText', async () => {
      await channel.channelPlugin.outbound.sendText({
        text: 'test message',
      });

      expect(channel.getCurrentState()).toBe('chatting');
    });
  });

  // ---------------------------------------------------------------------------
  // Event sequence numbers
  // ---------------------------------------------------------------------------

  describe('event sequencing', () => {
    it('should increment seq for each event', () => {
      const events: ClawHouseEvent[] = [];
      channel.addClient({
        deviceId: 'device-1',
        deviceName: 'Test iPhone',
        connectedAt: Date.now(),
        send: (event) => events.push(event),
      });

      channel.updateState('working');
      channel.updateState('out', 'gmail');
      channel.updateState('returning', 'gmail');

      expect(events[0].seq).toBe(1);
      expect(events[1].seq).toBe(2);
      expect(events[2].seq).toBe(3);
    });
  });

  // ---------------------------------------------------------------------------
  // Push notifications on sendText
  // ---------------------------------------------------------------------------

  describe('push notifications', () => {
    function createMockDeps(options?: {
      hasPushSender?: boolean;
      hasStorage?: boolean;
      devices?: Array<{ pushToken: string; pushBundleId: string; pushEnvironment: 'development' | 'production' }>;
      sendToAllImpl?: (...args: any[]) => Promise<void>;
    }): ChannelDeps {
      const deps: ChannelDeps = {};

      if (options?.hasPushSender !== false) {
        deps.pushSender = {
          sendToAll: options?.sendToAllImpl ?? vi.fn().mockResolvedValue(undefined),
          send: vi.fn().mockResolvedValue({ ok: true }),
        } as any;
      }

      if (options?.hasStorage !== false) {
        deps.storage = {
          getDevicesWithPushTokens: vi.fn().mockReturnValue(
            options?.devices ?? [
              { pushToken: 'token-abc', pushBundleId: 'com.test.clawhouse', pushEnvironment: 'development' as const },
            ],
          ),
        } as any;
      }

      return deps;
    }

    it('should send push with message preview when no clients connected', async () => {
      const deps = createMockDeps();
      const ch = createClawHouseChannel(api, deps);

      // No clients added — connectedClients.size === 0

      await ch.channelPlugin.outbound.sendText({ text: 'Hello from the claw!' });

      expect(deps.storage!.getDevicesWithPushTokens).toHaveBeenCalled();
      expect(deps.pushSender!.sendToAll).toHaveBeenCalledWith(
        [{ pushToken: 'token-abc', pushBundleId: 'com.test.clawhouse', pushEnvironment: 'development' }],
        { title: 'Claw', body: 'Hello from the claw!', data: { type: 'message' } },
      );
    });

    it('should truncate push preview for long messages', async () => {
      const deps = createMockDeps();
      const ch = createClawHouseChannel(api, deps);

      const longText = 'A'.repeat(150);
      await ch.channelPlugin.outbound.sendText({ text: longText });

      const expectedPreview = 'A'.repeat(100) + '...';
      expect(deps.pushSender!.sendToAll).toHaveBeenCalledWith(
        expect.any(Array),
        expect.objectContaining({ body: expectedPreview }),
      );
    });

    it('should NOT send push when clients are connected', async () => {
      const deps = createMockDeps();
      const ch = createClawHouseChannel(api, deps);

      ch.addClient({
        deviceId: 'device-online',
        deviceName: 'Online iPhone',
        connectedAt: Date.now(),
        send: vi.fn(),
      });

      await ch.channelPlugin.outbound.sendText({ text: 'You are here!' });

      expect(deps.pushSender!.sendToAll).not.toHaveBeenCalled();
    });

    it('should NOT send push when no pushSender in deps', async () => {
      const deps = createMockDeps({ hasPushSender: false });
      const ch = createClawHouseChannel(api, deps);

      // Should not throw even with 0 clients and no pushSender
      const result = await ch.channelPlugin.outbound.sendText({ text: 'No push sender' });
      expect(result).toEqual({ ok: true });
      // storage.getDevicesWithPushTokens should never be called
      expect(deps.storage!.getDevicesWithPushTokens).not.toHaveBeenCalled();
    });

    it('should NOT send push when no storage in deps', async () => {
      const deps = createMockDeps({ hasStorage: false });
      const ch = createClawHouseChannel(api, deps);

      const result = await ch.channelPlugin.outbound.sendText({ text: 'No storage' });
      expect(result).toEqual({ ok: true });
      expect(deps.pushSender!.sendToAll).not.toHaveBeenCalled();
    });

    it('should NOT break sendText when push fails', async () => {
      const deps = createMockDeps({
        sendToAllImpl: vi.fn().mockRejectedValue(new Error('APNs unreachable')),
      });
      const ch = createClawHouseChannel(api, deps);

      // sendText should still return ok even when push rejects
      const result = await ch.channelPlugin.outbound.sendText({ text: 'Push will fail' });
      expect(result).toEqual({ ok: true });

      // Push was attempted
      expect(deps.pushSender!.sendToAll).toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  // Idle monitor timeout
  // ---------------------------------------------------------------------------

  describe('idle monitor', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('should transition to resting after 5 minutes of idle', () => {
      channel.channelPlugin.gateway.start();

      expect(channel.getCurrentState()).toBe('idle');

      // Advance past the 5-minute rest threshold + one check interval (30s)
      vi.advanceTimersByTime(5 * 60 * 1000 + 30_000);

      expect(channel.getCurrentState()).toBe('resting');

      channel.channelPlugin.gateway.stop();
    });

    it('should transition to sleeping after 30 minutes of idle', () => {
      channel.channelPlugin.gateway.start();

      // First advance past rest threshold so state transitions to resting
      // (which resets lastActivityTime inside updateState)
      vi.advanceTimersByTime(5 * 60 * 1000 + 30_000);
      expect(channel.getCurrentState()).toBe('resting');

      // Now advance another 30 minutes from the resting transition
      vi.advanceTimersByTime(30 * 60 * 1000 + 30_000);

      expect(channel.getCurrentState()).toBe('sleeping');

      channel.channelPlugin.gateway.stop();
    });

    it('should NOT override active states (working/out/chatting)', () => {
      channel.channelPlugin.gateway.start();
      channel.updateState('working');

      // Advance well past rest threshold
      vi.advanceTimersByTime(10 * 60 * 1000);

      // Should still be working, not resting
      expect(channel.getCurrentState()).toBe('working');

      channel.channelPlugin.gateway.stop();
    });

    it('should return to idle from chatting after 3 seconds (sendText timeout)', async () => {
      await channel.channelPlugin.outbound.sendText({ text: 'test' });
      expect(channel.getCurrentState()).toBe('chatting');

      vi.advanceTimersByTime(3000);

      expect(channel.getCurrentState()).toBe('idle');
    });
  });

  // ---------------------------------------------------------------------------
  // Gateway lifecycle
  // ---------------------------------------------------------------------------

  describe('gateway start/stop', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('should log on start', () => {
      channel.channelPlugin.gateway.start();
      expect(api.logger.info).toHaveBeenCalledWith('[ClawHouse] Channel started');
      channel.channelPlugin.gateway.stop();
    });

    it('should log on stop', () => {
      channel.channelPlugin.gateway.start();
      channel.channelPlugin.gateway.stop();
      expect(api.logger.info).toHaveBeenCalledWith('[ClawHouse] Channel stopped');
    });

    it('should clear all connected clients on stop', () => {
      channel.addClient({
        deviceId: 'device-1',
        deviceName: 'iPhone 1',
        connectedAt: Date.now(),
        send: vi.fn(),
      });
      channel.addClient({
        deviceId: 'device-2',
        deviceName: 'iPhone 2',
        connectedAt: Date.now(),
        send: vi.fn(),
      });

      expect(channel.getConnectedClients().size).toBe(2);

      channel.channelPlugin.gateway.stop();

      expect(channel.getConnectedClients().size).toBe(0);
    });

    it('should stop idle monitor on stop (no further state transitions)', () => {
      channel.channelPlugin.gateway.start();
      channel.channelPlugin.gateway.stop();

      // Advance well past rest threshold — should NOT transition because monitor is stopped
      vi.advanceTimersByTime(10 * 60 * 1000);

      expect(channel.getCurrentState()).toBe('idle');
    });
  });
});
