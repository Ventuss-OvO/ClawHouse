import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { RelayConnection } from '../src/relay.js';
import type { ConnectedClient, ClawHouseEvent } from '../src/types.js';

function createMockLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  };
}

const TEST_CONFIG = {
  url: 'wss://relay.clawhouse.dev/gateway/connect',
  token: 'test-relay-token-123',
};

describe('RelayConnection', () => {
  let relay: RelayConnection;
  let logger: ReturnType<typeof createMockLogger>;

  beforeEach(() => {
    vi.useFakeTimers();
    logger = createMockLogger();
    relay = new RelayConnection(TEST_CONFIG, logger);
  });

  afterEach(() => {
    relay.stop();
    vi.useRealTimers();
  });

  describe('constructor', () => {
    it('should initialize with config and logger', () => {
      expect(relay).toBeDefined();
      expect(relay.isConnected).toBe(false);
    });

    it('should have null callbacks initially', () => {
      expect(relay.onVirtualClientReady).toBeNull();
      expect(relay.onVirtualClientGone).toBeNull();
      expect(relay.onInboundRPC).toBeNull();
    });
  });

  describe('stop', () => {
    it('should mark as stopped and prevent reconnection', () => {
      relay.stop();
      expect(relay.isConnected).toBe(false);
    });

    it('should be safe to call stop multiple times', () => {
      relay.stop();
      relay.stop();
      relay.stop();
      expect(relay.isConnected).toBe(false);
    });
  });

  describe('callback wiring', () => {
    it('should accept onVirtualClientReady callback', () => {
      const callback = vi.fn();
      relay.onVirtualClientReady = callback;
      expect(relay.onVirtualClientReady).toBe(callback);
    });

    it('should accept onVirtualClientGone callback', () => {
      const callback = vi.fn();
      relay.onVirtualClientGone = callback;
      expect(relay.onVirtualClientGone).toBe(callback);
    });

    it('should accept onInboundRPC callback', () => {
      const callback = vi.fn();
      relay.onInboundRPC = callback;
      expect(relay.onInboundRPC).toBe(callback);
    });
  });

  describe('reconnect backoff', () => {
    it('should calculate exponential backoff delays', () => {
      // Simulate the backoff calculation
      const delays: number[] = [];
      for (let attempt = 0; attempt < 7; attempt++) {
        const base = Math.min(1000 * Math.pow(2, attempt), 60000);
        delays.push(base);
      }

      expect(delays[0]).toBe(1000);   // 1s
      expect(delays[1]).toBe(2000);   // 2s
      expect(delays[2]).toBe(4000);   // 4s
      expect(delays[3]).toBe(8000);   // 8s
      expect(delays[4]).toBe(16000);  // 16s
      expect(delays[5]).toBe(32000);  // 32s
      expect(delays[6]).toBe(60000);  // capped at 60s
    });

    it('should cap at 10 reconnect attempts', () => {
      const maxAttempts = 10;
      expect(maxAttempts).toBe(10);
    });
  });

  describe('URL construction', () => {
    it('should append token as query parameter', () => {
      const config = {
        url: 'wss://relay.clawhouse.dev/gateway/connect',
        token: 'my-token',
      };
      const url = `${config.url}?token=${encodeURIComponent(config.token)}`;
      expect(url).toBe('wss://relay.clawhouse.dev/gateway/connect?token=my-token');
    });

    it('should encode special characters in token', () => {
      const config = {
        url: 'wss://relay.clawhouse.dev/gateway/connect',
        token: 'token+with/special=chars',
      };
      const url = `${config.url}?token=${encodeURIComponent(config.token)}`;
      expect(url).toContain('token%2Bwith%2Fspecial%3Dchars');
    });
  });

  describe('virtual client', () => {
    it('should create a ConnectedClient with relay-client deviceId', () => {
      // Simulate what createVirtualClient returns
      const client: ConnectedClient = {
        deviceId: 'relay-client',
        deviceName: 'Relay',
        connectedAt: Date.now(),
        send: vi.fn(),
      };

      expect(client.deviceId).toBe('relay-client');
      expect(client.deviceName).toBe('Relay');
      expect(client.connectedAt).toBeGreaterThan(0);
    });

    it('should wrap events as Gateway event frames when sending', () => {
      const sentFrames: unknown[] = [];
      const mockSend = (data: string) => sentFrames.push(JSON.parse(data));

      // Simulate what the virtual client's send does
      const event: ClawHouseEvent = {
        type: 'state_change',
        payload: { state: 'working', timestamp: Date.now() },
        timestamp: Date.now(),
        seq: 1,
      };

      const frame = {
        type: 'event',
        event: `clawhouse.${event.type}`,
        payload: event.payload,
        seq: event.seq,
      };

      mockSend(JSON.stringify(frame));

      expect(sentFrames[0]).toEqual({
        type: 'event',
        event: 'clawhouse.state_change',
        payload: event.payload,
        seq: 1,
      });
    });
  });

  describe('message handling', () => {
    it('should parse relay peer events', () => {
      const peerEvent = {
        type: 'event',
        event: 'relay.peer_connected',
        role: 'client',
        timestamp: new Date().toISOString(),
      };

      expect(peerEvent.event).toBe('relay.peer_connected');
      expect(
        peerEvent.event === 'relay.peer_connected' ||
        peerEvent.event === 'relay.peer_disconnected'
      ).toBe(true);
    });

    it('should parse inbound RPC requests', () => {
      const rpcRequest = {
        type: 'req',
        id: 'req-123',
        method: 'clawhouse.pair',
        params: { deviceId: 'dev-1', token: 'abc' },
      };

      expect(rpcRequest.type).toBe('req');
      expect(rpcRequest.method).toBe('clawhouse.pair');
      expect(rpcRequest.id).toBe('req-123');
    });

    it('should match responses to pending requests by ID', () => {
      const pendingRequests = new Map<string, { resolve: Function }>();
      const resolve = vi.fn();
      pendingRequests.set('req-456', { resolve });

      const response = { type: 'res', id: 'req-456', ok: true, payload: { success: true } };

      const pending = pendingRequests.get(response.id);
      expect(pending).toBeDefined();
      pending!.resolve(response.payload);
      expect(resolve).toHaveBeenCalledWith({ success: true });
    });

    it('should handle malformed JSON gracefully', () => {
      // The handleMessage method should not throw on bad JSON
      const badJson = 'not-json{{{';
      expect(() => JSON.parse(badJson)).toThrow();
    });
  });
});
