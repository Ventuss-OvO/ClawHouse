import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createClawHouseChannel } from '../src/channel.js';
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
});
