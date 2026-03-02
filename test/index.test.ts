import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// We need to mock the push module before importing index so the APNsSender
// constructor does not attempt to read a real key file from disk.
vi.mock('../src/push.js', () => {
  class MockAPNsSender {
    constructor(_config: any) {
      // No-op — don't read files
    }
    async send(_payload: any) { return { ok: true, status: 200 }; }
    async sendToAll(_devices: any[], _notification: any) { return; }
  }
  return { APNsSender: MockAPNsSender };
});

import register from '../src/index.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type Handler = (ctx: any) => any;

function createMockApi(configOverrides?: Record<string, any>) {
  const gatewayMethods = new Map<string, Handler>();
  const hooks = new Map<string, Handler>();
  let channelPlugin: any = null;
  let service: any = null;

  const tempDir = mkdtempSync(join(tmpdir(), 'clawhouse-idx-'));

  const api = {
    logger: {
      info: vi.fn(),
      debug: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
    config: {
      dataDir: tempDir,
      pairingToken: 'valid-token',
      ...configOverrides,
    },
    registerGatewayMethod: vi.fn((name: string, handler: Handler) => {
      gatewayMethods.set(name, handler);
    }),
    registerHook: vi.fn((name: string, handler: Handler) => {
      hooks.set(name, handler);
    }),
    registerChannel: vi.fn(({ plugin }: any) => {
      channelPlugin = plugin;
    }),
    registerService: vi.fn((svc: any) => {
      service = svc;
    }),
    callMethod: vi.fn(),
  };

  return {
    api,
    tempDir,
    getGatewayMethod: (name: string) => gatewayMethods.get(name)!,
    getHook: (name: string) => hooks.get(name)!,
    getChannel: () => channelPlugin,
    getService: () => service,
  };
}

function makeRespond() {
  const calls: Array<{ ok: boolean; payload: any }> = [];
  const fn = (ok: boolean, payload: any) => {
    calls.push({ ok, payload });
  };
  return { fn, calls };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('register (index.ts)', () => {
  let mock: ReturnType<typeof createMockApi>;

  beforeEach(() => {
    mock = createMockApi();
    register(mock.api);
  });

  // Cleanup temp dirs
  afterEach(() => {
    try { rmSync(mock.tempDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  // ---------------------------------------------------------------------------
  // Plugin registration
  // ---------------------------------------------------------------------------

  describe('plugin registration', () => {
    it('should register all 7 gateway methods', () => {
      const names = (mock.api.registerGatewayMethod as any).mock.calls.map((c: any) => c[0]);
      expect(names).toContain('clawhouse.pair');
      expect(names).toContain('clawhouse.subscribe');
      expect(names).toContain('clawhouse.unsubscribe');
      expect(names).toContain('clawhouse.registerPushToken');
      expect(names).toContain('clawhouse.state');
      expect(names).toContain('clawhouse.sessions');
      expect(names).toContain('clawhouse.clients');
      expect(names).toHaveLength(7);
    });

    it('should register a channel', () => {
      expect(mock.api.registerChannel).toHaveBeenCalledTimes(1);
      expect(mock.getChannel()).toBeTruthy();
    });

    it('should register a service with id clawhouse-service', () => {
      expect(mock.api.registerService).toHaveBeenCalledTimes(1);
      const svc = mock.getService();
      expect(svc.id).toBe('clawhouse-service');
      expect(typeof svc.start).toBe('function');
      expect(typeof svc.stop).toBe('function');
    });

    it('should register agent hooks', () => {
      expect(mock.api.registerHook).toHaveBeenCalled();
    });

    it('should log loading and loaded messages', () => {
      const infoCalls = (mock.api.logger.info as any).mock.calls.map((c: any) => c[0]);
      expect(infoCalls.some((m: string) => m.includes('Plugin loading'))).toBe(true);
      expect(infoCalls.some((m: string) => m.includes('Plugin loaded successfully'))).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // APNs sender initialization
  // ---------------------------------------------------------------------------

  describe('APNs sender initialization', () => {
    it('should initialize APNs sender when config is provided', () => {
      const m = createMockApi({
        apns: { keyId: 'K123', teamId: 'T456', keyPath: '/fake/path.p8' },
      });
      register(m.api);
      const infoCalls = (m.api.logger.info as any).mock.calls.map((c: any) => c[0]);
      expect(infoCalls.some((s: string) => s.includes('APNs push sender initialized'))).toBe(true);
      rmSync(m.tempDir, { recursive: true, force: true });
    });

    it('should not initialize APNs sender when config is missing', () => {
      // mock already has no apns config
      const infoCalls = (mock.api.logger.info as any).mock.calls.map((c: any) => c[0]);
      expect(infoCalls.some((s: string) => s.includes('APNs push sender initialized'))).toBe(false);
    });

    it('should not initialize APNs sender when config is incomplete', () => {
      const m = createMockApi({
        apns: { keyId: 'K123' }, // missing teamId and keyPath
      });
      register(m.api);
      const infoCalls = (m.api.logger.info as any).mock.calls.map((c: any) => c[0]);
      expect(infoCalls.some((s: string) => s.includes('APNs push sender initialized'))).toBe(false);
      rmSync(m.tempDir, { recursive: true, force: true });
    });
  });

  // ---------------------------------------------------------------------------
  // RPC: clawhouse.pair
  // ---------------------------------------------------------------------------

  describe('clawhouse.pair', () => {
    it('should reject missing token', () => {
      const handler = mock.getGatewayMethod('clawhouse.pair');
      const { fn, calls } = makeRespond();

      handler({ params: { deviceId: 'd1', deviceName: 'iPhone', platform: 'ios' }, respond: fn });

      expect(calls).toHaveLength(1);
      expect(calls[0].ok).toBe(false);
      expect(calls[0].payload.error.code).toBe('MISSING_TOKEN');
    });

    it('should reject non-string token', () => {
      const handler = mock.getGatewayMethod('clawhouse.pair');
      const { fn, calls } = makeRespond();

      handler({ params: { token: 123, deviceId: 'd1', deviceName: 'iPhone', platform: 'ios' }, respond: fn });

      expect(calls[0].ok).toBe(false);
      expect(calls[0].payload.error.code).toBe('MISSING_TOKEN');
    });

    it('should reject missing deviceId', () => {
      const handler = mock.getGatewayMethod('clawhouse.pair');
      const { fn, calls } = makeRespond();

      handler({ params: { token: 'valid-token', deviceName: 'iPhone', platform: 'ios' }, respond: fn });

      expect(calls[0].ok).toBe(false);
      expect(calls[0].payload.error.code).toBe('MISSING_DEVICE_ID');
    });

    it('should reject non-string deviceId', () => {
      const handler = mock.getGatewayMethod('clawhouse.pair');
      const { fn, calls } = makeRespond();

      handler({ params: { token: 'valid-token', deviceId: 42, deviceName: 'iPhone', platform: 'ios' }, respond: fn });

      expect(calls[0].ok).toBe(false);
      expect(calls[0].payload.error.code).toBe('MISSING_DEVICE_ID');
    });

    it('should reject missing deviceName', () => {
      const handler = mock.getGatewayMethod('clawhouse.pair');
      const { fn, calls } = makeRespond();

      handler({ params: { token: 'valid-token', deviceId: 'd1', platform: 'ios' }, respond: fn });

      expect(calls[0].ok).toBe(false);
      expect(calls[0].payload.error.code).toBe('MISSING_DEVICE_NAME');
    });

    it('should reject non-string deviceName', () => {
      const handler = mock.getGatewayMethod('clawhouse.pair');
      const { fn, calls } = makeRespond();

      handler({ params: { token: 'valid-token', deviceId: 'd1', deviceName: true, platform: 'ios' }, respond: fn });

      expect(calls[0].ok).toBe(false);
      expect(calls[0].payload.error.code).toBe('MISSING_DEVICE_NAME');
    });

    it('should reject non-ios platform', () => {
      const handler = mock.getGatewayMethod('clawhouse.pair');
      const { fn, calls } = makeRespond();

      handler({ params: { token: 'valid-token', deviceId: 'd1', deviceName: 'Pixel', platform: 'android' }, respond: fn });

      expect(calls[0].ok).toBe(false);
      expect(calls[0].payload.error.code).toBe('UNSUPPORTED_PLATFORM');
    });

    it('should reject missing platform', () => {
      const handler = mock.getGatewayMethod('clawhouse.pair');
      const { fn, calls } = makeRespond();

      handler({ params: { token: 'valid-token', deviceId: 'd1', deviceName: 'iPhone' }, respond: fn });

      expect(calls[0].ok).toBe(false);
      expect(calls[0].payload.error.code).toBe('UNSUPPORTED_PLATFORM');
    });

    it('should reject invalid pairing token', () => {
      const handler = mock.getGatewayMethod('clawhouse.pair');
      const { fn, calls } = makeRespond();

      handler({ params: { token: 'wrong-token', deviceId: 'd1', deviceName: 'iPhone', platform: 'ios' }, respond: fn });

      expect(calls[0].ok).toBe(false);
      expect(calls[0].payload.error.code).toBe('INVALID_TOKEN');
    });

    it('should succeed with valid params (new pairing)', () => {
      const handler = mock.getGatewayMethod('clawhouse.pair');
      const { fn, calls } = makeRespond();

      handler({
        params: { token: 'valid-token', deviceId: 'd1', deviceName: 'iPhone', platform: 'ios', appVersion: '1.0.0' },
        respond: fn,
      });

      expect(calls[0].ok).toBe(true);
      expect(calls[0].payload.success).toBe(true);
      expect(calls[0].payload.agentId).toBe('main');
      expect(typeof calls[0].payload.pairedAt).toBe('number');
    });

    it('should preserve pairedAt on re-pair', () => {
      const handler = mock.getGatewayMethod('clawhouse.pair');

      // First pair
      const { fn: fn1, calls: calls1 } = makeRespond();
      handler({
        params: { token: 'valid-token', deviceId: 'd1', deviceName: 'iPhone', platform: 'ios', appVersion: '1.0.0' },
        respond: fn1,
      });
      const firstPairedAt = calls1[0].payload.pairedAt;

      // Re-pair same deviceId
      const { fn: fn2, calls: calls2 } = makeRespond();
      handler({
        params: { token: 'valid-token', deviceId: 'd1', deviceName: 'iPhone Pro', platform: 'ios', appVersion: '2.0.0' },
        respond: fn2,
      });

      expect(calls2[0].ok).toBe(true);
      expect(calls2[0].payload.pairedAt).toBe(firstPairedAt);
    });

    it('should default appVersion to "unknown" when not provided', () => {
      const handler = mock.getGatewayMethod('clawhouse.pair');
      const { fn, calls } = makeRespond();

      handler({
        params: { token: 'valid-token', deviceId: 'd-ver', deviceName: 'iPhone', platform: 'ios' },
        respond: fn,
      });

      expect(calls[0].ok).toBe(true);
      // Verify via logger output that appVersion was set to "unknown"
      const infoCalls = (mock.api.logger.info as any).mock.calls.map((c: any) => c[0]);
      expect(infoCalls.some((m: string) => m.includes('vunknown'))).toBe(true);
    });

    it('should skip token check when pairingToken config is absent', () => {
      const m = createMockApi({ pairingToken: undefined });
      register(m.api);

      const handler = m.getGatewayMethod('clawhouse.pair');
      const { fn, calls } = makeRespond();

      handler({
        params: { token: 'anything', deviceId: 'd1', deviceName: 'iPhone', platform: 'ios' },
        respond: fn,
      });

      expect(calls[0].ok).toBe(true);
      rmSync(m.tempDir, { recursive: true, force: true });
    });

    it('should handle null params gracefully', () => {
      const handler = mock.getGatewayMethod('clawhouse.pair');
      const { fn, calls } = makeRespond();

      handler({ params: null, respond: fn });

      expect(calls[0].ok).toBe(false);
      expect(calls[0].payload.error.code).toBe('MISSING_TOKEN');
    });

    it('should handle undefined params gracefully', () => {
      const handler = mock.getGatewayMethod('clawhouse.pair');
      const { fn, calls } = makeRespond();

      handler({ params: undefined, respond: fn });

      expect(calls[0].ok).toBe(false);
      expect(calls[0].payload.error.code).toBe('MISSING_TOKEN');
    });

    it('should log "[new]" for first-time pairing', () => {
      const handler = mock.getGatewayMethod('clawhouse.pair');
      const { fn } = makeRespond();

      handler({
        params: { token: 'valid-token', deviceId: 'brand-new', deviceName: 'iPhone', platform: 'ios' },
        respond: fn,
      });

      const infoCalls = (mock.api.logger.info as any).mock.calls.map((c: any) => c[0]);
      expect(infoCalls.some((m: string) => m.includes('[new]'))).toBe(true);
    });

    it('should log "[re-paired]" for existing device', () => {
      const handler = mock.getGatewayMethod('clawhouse.pair');

      // First pair
      const { fn: fn1 } = makeRespond();
      handler({
        params: { token: 'valid-token', deviceId: 're-pair-d', deviceName: 'iPhone', platform: 'ios' },
        respond: fn1,
      });

      // Clear logger to isolate the re-pair log
      (mock.api.logger.info as any).mockClear();

      // Re-pair
      const { fn: fn2 } = makeRespond();
      handler({
        params: { token: 'valid-token', deviceId: 're-pair-d', deviceName: 'iPhone', platform: 'ios' },
        respond: fn2,
      });

      const infoCalls = (mock.api.logger.info as any).mock.calls.map((c: any) => c[0]);
      expect(infoCalls.some((m: string) => m.includes('[re-paired]'))).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // RPC: clawhouse.subscribe
  // ---------------------------------------------------------------------------

  describe('clawhouse.subscribe', () => {
    // Helper: pair a device first
    function pairDevice(deviceId = 'sub-device') {
      const handler = mock.getGatewayMethod('clawhouse.pair');
      const { fn } = makeRespond();
      handler({
        params: { token: 'valid-token', deviceId, deviceName: 'Test iPhone', platform: 'ios' },
        respond: fn,
      });
    }

    it('should reject missing deviceId', () => {
      const handler = mock.getGatewayMethod('clawhouse.subscribe');
      const { fn, calls } = makeRespond();

      handler({ params: { deviceName: 'iPhone' }, connection: {}, respond: fn });

      expect(calls[0].ok).toBe(false);
      expect(calls[0].payload.error.code).toBe('MISSING_DEVICE_ID');
    });

    it('should reject non-string deviceId', () => {
      const handler = mock.getGatewayMethod('clawhouse.subscribe');
      const { fn, calls } = makeRespond();

      handler({ params: { deviceId: 99, deviceName: 'iPhone' }, connection: {}, respond: fn });

      expect(calls[0].ok).toBe(false);
      expect(calls[0].payload.error.code).toBe('MISSING_DEVICE_ID');
    });

    it('should reject missing deviceName', () => {
      const handler = mock.getGatewayMethod('clawhouse.subscribe');
      const { fn, calls } = makeRespond();

      handler({ params: { deviceId: 'sub-device' }, connection: {}, respond: fn });

      expect(calls[0].ok).toBe(false);
      expect(calls[0].payload.error.code).toBe('MISSING_DEVICE_NAME');
    });

    it('should reject non-string deviceName', () => {
      const handler = mock.getGatewayMethod('clawhouse.subscribe');
      const { fn, calls } = makeRespond();

      handler({ params: { deviceId: 'sub-device', deviceName: false }, connection: {}, respond: fn });

      expect(calls[0].ok).toBe(false);
      expect(calls[0].payload.error.code).toBe('MISSING_DEVICE_NAME');
    });

    it('should reject unpaired device', () => {
      const handler = mock.getGatewayMethod('clawhouse.subscribe');
      const { fn, calls } = makeRespond();

      handler({
        params: { deviceId: 'never-paired', deviceName: 'iPhone' },
        connection: {},
        respond: fn,
      });

      expect(calls[0].ok).toBe(false);
      expect(calls[0].payload.error.code).toBe('NOT_PAIRED');
    });

    it('should succeed for a previously paired device', () => {
      pairDevice('sub-device');

      const handler = mock.getGatewayMethod('clawhouse.subscribe');
      const { fn, calls } = makeRespond();
      const mockConnection = { send: vi.fn() };

      handler({
        params: { deviceId: 'sub-device', deviceName: 'Test iPhone' },
        connection: mockConnection,
        respond: fn,
      });

      expect(calls[0].ok).toBe(true);
      expect(calls[0].payload.success).toBe(true);
      expect(calls[0].payload.currentState).toBe('idle');
      expect(typeof calls[0].payload.connectedAt).toBe('number');
    });

    it('should add the client to connected clients list', () => {
      pairDevice('sub-device-2');

      const subscribeHandler = mock.getGatewayMethod('clawhouse.subscribe');
      const { fn } = makeRespond();
      const mockConnection = { send: vi.fn() };

      subscribeHandler({
        params: { deviceId: 'sub-device-2', deviceName: 'Test iPhone' },
        connection: mockConnection,
        respond: fn,
      });

      // Verify via clawhouse.clients
      const clientsHandler = mock.getGatewayMethod('clawhouse.clients');
      const { fn: fn2, calls: calls2 } = makeRespond();
      clientsHandler({ respond: fn2 });

      expect(calls2[0].payload.count).toBeGreaterThanOrEqual(1);
      const found = calls2[0].payload.clients.some((c: any) => c.deviceId === 'sub-device-2');
      expect(found).toBe(true);
    });

    it('should handle null params gracefully', () => {
      const handler = mock.getGatewayMethod('clawhouse.subscribe');
      const { fn, calls } = makeRespond();

      handler({ params: null, connection: {}, respond: fn });

      expect(calls[0].ok).toBe(false);
      expect(calls[0].payload.error.code).toBe('MISSING_DEVICE_ID');
    });

    it('should succeed in relay mode (connection is null) without adding client', () => {
      pairDevice('relay-sub-device');

      const handler = mock.getGatewayMethod('clawhouse.subscribe');
      const { fn, calls } = makeRespond();

      // In relay mode, onInboundRPC passes connection: null
      handler({
        params: { deviceId: 'relay-sub-device', deviceName: 'Test iPhone' },
        connection: null,
        respond: fn,
      });

      expect(calls[0].ok).toBe(true);
      expect(calls[0].payload.success).toBe(true);
      expect(calls[0].payload.currentState).toBe('idle');

      // Verify NO client was added (relay virtual client handles events)
      const clientsHandler = mock.getGatewayMethod('clawhouse.clients');
      const { fn: cFn, calls: cCalls } = makeRespond();
      clientsHandler({ respond: cFn });
      const found = cCalls[0].payload.clients.some((c: any) => c.deviceId === 'relay-sub-device');
      expect(found).toBe(false);
    });

    it('should wrap events using connection.send with Gateway framing', () => {
      pairDevice('frame-test-device');

      const subscribeHandler = mock.getGatewayMethod('clawhouse.subscribe');
      const { fn } = makeRespond();
      const mockConnection = { send: vi.fn() };

      subscribeHandler({
        params: { deviceId: 'frame-test-device', deviceName: 'Test iPhone' },
        connection: mockConnection,
        respond: fn,
      });

      // Trigger a state change to cause an event broadcast
      const stateHandler = mock.getGatewayMethod('clawhouse.state');
      // We need to trigger a state change through something that calls updateState.
      // Use the hook registered for agent.run.before which calls updateState('working').
      const hookCalls = (mock.api.registerHook as any).mock.calls;
      const agentStartHook = hookCalls.find((c: any) => c[0] === 'agent.run.before');
      if (agentStartHook) {
        agentStartHook[1](); // Call the hook handler
      }

      // The connection.send should be called with Gateway event framing
      expect(mockConnection.send).toHaveBeenCalled();
      const frame = mockConnection.send.mock.calls[0][0];
      expect(frame.type).toBe('event');
      expect(frame.event).toMatch(/^clawhouse\./);
    });
  });

  // ---------------------------------------------------------------------------
  // RPC: clawhouse.unsubscribe
  // ---------------------------------------------------------------------------

  describe('clawhouse.unsubscribe', () => {
    it('should reject missing deviceId', () => {
      const handler = mock.getGatewayMethod('clawhouse.unsubscribe');
      const { fn, calls } = makeRespond();

      handler({ params: {}, respond: fn });

      expect(calls[0].ok).toBe(false);
      expect(calls[0].payload.error.code).toBe('MISSING_DEVICE_ID');
    });

    it('should reject non-string deviceId', () => {
      const handler = mock.getGatewayMethod('clawhouse.unsubscribe');
      const { fn, calls } = makeRespond();

      handler({ params: { deviceId: 42 }, respond: fn });

      expect(calls[0].ok).toBe(false);
      expect(calls[0].payload.error.code).toBe('MISSING_DEVICE_ID');
    });

    it('should succeed even for unknown deviceId (no-op remove)', () => {
      const handler = mock.getGatewayMethod('clawhouse.unsubscribe');
      const { fn, calls } = makeRespond();

      handler({ params: { deviceId: 'nonexistent' }, respond: fn });

      expect(calls[0].ok).toBe(true);
      expect(calls[0].payload.success).toBe(true);
    });

    it('should remove client from connected clients', () => {
      // Pair + subscribe
      const pairHandler = mock.getGatewayMethod('clawhouse.pair');
      const { fn: pFn } = makeRespond();
      pairHandler({
        params: { token: 'valid-token', deviceId: 'unsub-d', deviceName: 'iPhone', platform: 'ios' },
        respond: pFn,
      });

      const subHandler = mock.getGatewayMethod('clawhouse.subscribe');
      const { fn: sFn } = makeRespond();
      subHandler({
        params: { deviceId: 'unsub-d', deviceName: 'iPhone' },
        connection: { send: vi.fn() },
        respond: sFn,
      });

      // Verify subscribed
      const clientsHandler = mock.getGatewayMethod('clawhouse.clients');
      const { fn: cFn1, calls: cCalls1 } = makeRespond();
      clientsHandler({ respond: cFn1 });
      expect(cCalls1[0].payload.count).toBeGreaterThanOrEqual(1);

      // Unsubscribe
      const unsubHandler = mock.getGatewayMethod('clawhouse.unsubscribe');
      const { fn: uFn, calls: uCalls } = makeRespond();
      unsubHandler({ params: { deviceId: 'unsub-d' }, respond: uFn });

      expect(uCalls[0].ok).toBe(true);

      // Verify removed
      const { fn: cFn2, calls: cCalls2 } = makeRespond();
      clientsHandler({ respond: cFn2 });
      const stillPresent = cCalls2[0].payload.clients.some((c: any) => c.deviceId === 'unsub-d');
      expect(stillPresent).toBe(false);
    });

    it('should handle null params gracefully', () => {
      const handler = mock.getGatewayMethod('clawhouse.unsubscribe');
      const { fn, calls } = makeRespond();

      handler({ params: null, respond: fn });

      expect(calls[0].ok).toBe(false);
      expect(calls[0].payload.error.code).toBe('MISSING_DEVICE_ID');
    });
  });

  // ---------------------------------------------------------------------------
  // RPC: clawhouse.registerPushToken
  // ---------------------------------------------------------------------------

  describe('clawhouse.registerPushToken', () => {
    function pairDevice(deviceId = 'push-device') {
      const handler = mock.getGatewayMethod('clawhouse.pair');
      const { fn } = makeRespond();
      handler({
        params: { token: 'valid-token', deviceId, deviceName: 'iPhone', platform: 'ios' },
        respond: fn,
      });
    }

    it('should reject missing deviceId', () => {
      const handler = mock.getGatewayMethod('clawhouse.registerPushToken');
      const { fn, calls } = makeRespond();

      handler({ params: { pushToken: 'abc123' }, respond: fn });

      expect(calls[0].ok).toBe(false);
      expect(calls[0].payload.error.code).toBe('MISSING_DEVICE_ID');
    });

    it('should reject non-string deviceId', () => {
      const handler = mock.getGatewayMethod('clawhouse.registerPushToken');
      const { fn, calls } = makeRespond();

      handler({ params: { deviceId: 123, pushToken: 'abc' }, respond: fn });

      expect(calls[0].ok).toBe(false);
      expect(calls[0].payload.error.code).toBe('MISSING_DEVICE_ID');
    });

    it('should reject missing pushToken', () => {
      const handler = mock.getGatewayMethod('clawhouse.registerPushToken');
      const { fn, calls } = makeRespond();

      handler({ params: { deviceId: 'push-device' }, respond: fn });

      expect(calls[0].ok).toBe(false);
      expect(calls[0].payload.error.code).toBe('MISSING_PUSH_TOKEN');
    });

    it('should reject non-string pushToken', () => {
      const handler = mock.getGatewayMethod('clawhouse.registerPushToken');
      const { fn, calls } = makeRespond();

      handler({ params: { deviceId: 'push-device', pushToken: 999 }, respond: fn });

      expect(calls[0].ok).toBe(false);
      expect(calls[0].payload.error.code).toBe('MISSING_PUSH_TOKEN');
    });

    it('should reject unpaired device (NOT_PAIRED)', () => {
      const handler = mock.getGatewayMethod('clawhouse.registerPushToken');
      const { fn, calls } = makeRespond();

      handler({ params: { deviceId: 'never-paired-push', pushToken: 'abc123' }, respond: fn });

      expect(calls[0].ok).toBe(false);
      expect(calls[0].payload.error.code).toBe('NOT_PAIRED');
    });

    it('should succeed for a paired device', () => {
      pairDevice('push-device');

      const handler = mock.getGatewayMethod('clawhouse.registerPushToken');
      const { fn, calls } = makeRespond();

      handler({
        params: { deviceId: 'push-device', pushToken: 'apns-token-abc123' },
        respond: fn,
      });

      expect(calls[0].ok).toBe(true);
      expect(calls[0].payload.success).toBe(true);
    });

    it('should default pushBundleId when not provided', () => {
      pairDevice('push-defaults');

      const handler = mock.getGatewayMethod('clawhouse.registerPushToken');
      const { fn } = makeRespond();

      handler({
        params: { deviceId: 'push-defaults', pushToken: 'token123' },
        respond: fn,
      });

      // We verify the log message was emitted (success path)
      const infoCalls = (mock.api.logger.info as any).mock.calls.map((c: any) => c[0]);
      expect(infoCalls.some((m: string) => m.includes('Push token registered'))).toBe(true);
    });

    it('should accept production pushEnvironment', () => {
      pairDevice('push-prod');

      const handler = mock.getGatewayMethod('clawhouse.registerPushToken');
      const { fn, calls } = makeRespond();

      handler({
        params: {
          deviceId: 'push-prod',
          pushToken: 'token456',
          pushBundleId: 'com.example.app',
          pushEnvironment: 'production',
        },
        respond: fn,
      });

      expect(calls[0].ok).toBe(true);
    });

    it('should default pushEnvironment to development for non-production value', () => {
      pairDevice('push-env-dev');

      const handler = mock.getGatewayMethod('clawhouse.registerPushToken');
      const { fn, calls } = makeRespond();

      handler({
        params: {
          deviceId: 'push-env-dev',
          pushToken: 'token789',
          pushEnvironment: 'staging', // not 'production'
        },
        respond: fn,
      });

      expect(calls[0].ok).toBe(true);
    });

    it('should handle null params gracefully', () => {
      const handler = mock.getGatewayMethod('clawhouse.registerPushToken');
      const { fn, calls } = makeRespond();

      handler({ params: null, respond: fn });

      expect(calls[0].ok).toBe(false);
      expect(calls[0].payload.error.code).toBe('MISSING_DEVICE_ID');
    });
  });

  // ---------------------------------------------------------------------------
  // RPC: clawhouse.state
  // ---------------------------------------------------------------------------

  describe('clawhouse.state', () => {
    it('should return current state and timestamp', () => {
      const handler = mock.getGatewayMethod('clawhouse.state');
      const { fn, calls } = makeRespond();

      handler({ respond: fn });

      expect(calls[0].ok).toBe(true);
      expect(calls[0].payload.state).toBe('idle');
      expect(typeof calls[0].payload.timestamp).toBe('number');
    });

    it('should reflect updated state after agent activity', () => {
      // Trigger agent.run.before hook to set state to "working"
      const hookCalls = (mock.api.registerHook as any).mock.calls;
      const agentStartHook = hookCalls.find((c: any) => c[0] === 'agent.run.before');
      if (agentStartHook) {
        agentStartHook[1]();
      }

      const handler = mock.getGatewayMethod('clawhouse.state');
      const { fn, calls } = makeRespond();
      handler({ respond: fn });

      expect(calls[0].payload.state).toBe('working');
    });
  });

  // ---------------------------------------------------------------------------
  // RPC: clawhouse.sessions
  // ---------------------------------------------------------------------------

  describe('clawhouse.sessions', () => {
    it('should return enriched sessions on success (array result)', async () => {
      mock.api.callMethod.mockResolvedValueOnce([
        { id: 'sess-1', label: 'Chat 1' },
        { id: 'sess-2', label: 'Chat 2' },
      ]);

      const handler = mock.getGatewayMethod('clawhouse.sessions');
      const { fn, calls } = makeRespond();

      await handler({ params: {}, respond: fn });

      expect(calls[0].ok).toBe(true);
      expect(calls[0].payload.sessions).toHaveLength(2);
      expect(calls[0].payload.sessions[0].channelSource).toBe('clawhouse');
      expect(calls[0].payload.sessions[1].channelSource).toBe('clawhouse');
    });

    it('should handle { sessions: [...] } result shape', async () => {
      mock.api.callMethod.mockResolvedValueOnce({
        sessions: [{ id: 'sess-3', label: 'Chat 3' }],
      });

      const handler = mock.getGatewayMethod('clawhouse.sessions');
      const { fn, calls } = makeRespond();

      await handler({ params: {}, respond: fn });

      expect(calls[0].ok).toBe(true);
      expect(calls[0].payload.sessions).toHaveLength(1);
      expect(calls[0].payload.sessions[0].channelSource).toBe('clawhouse');
    });

    it('should handle empty result', async () => {
      mock.api.callMethod.mockResolvedValueOnce([]);

      const handler = mock.getGatewayMethod('clawhouse.sessions');
      const { fn, calls } = makeRespond();

      await handler({ params: {}, respond: fn });

      expect(calls[0].ok).toBe(true);
      expect(calls[0].payload.sessions).toHaveLength(0);
    });

    it('should handle non-array non-object result gracefully', async () => {
      mock.api.callMethod.mockResolvedValueOnce('unexpected-string');

      const handler = mock.getGatewayMethod('clawhouse.sessions');
      const { fn, calls } = makeRespond();

      await handler({ params: {}, respond: fn });

      expect(calls[0].ok).toBe(true);
      expect(calls[0].payload.sessions).toHaveLength(0);
    });

    it('should handle null result gracefully', async () => {
      mock.api.callMethod.mockResolvedValueOnce(null);

      const handler = mock.getGatewayMethod('clawhouse.sessions');
      const { fn, calls } = makeRespond();

      await handler({ params: {}, respond: fn });

      expect(calls[0].ok).toBe(true);
      expect(calls[0].payload.sessions).toHaveLength(0);
    });

    it('should respond with error when callMethod throws', async () => {
      mock.api.callMethod.mockRejectedValueOnce(new Error('sessions.list failed'));

      const handler = mock.getGatewayMethod('clawhouse.sessions');
      const { fn, calls } = makeRespond();

      await handler({ params: {}, respond: fn });

      expect(calls[0].ok).toBe(false);
      expect(calls[0].payload.error.code).toBe('SESSIONS_ERROR');
      expect(calls[0].payload.error.message).toBe('sessions.list failed');
    });

    it('should handle non-Error throw', async () => {
      mock.api.callMethod.mockRejectedValueOnce('string-error');

      const handler = mock.getGatewayMethod('clawhouse.sessions');
      const { fn, calls } = makeRespond();

      await handler({ params: {}, respond: fn });

      expect(calls[0].ok).toBe(false);
      expect(calls[0].payload.error.code).toBe('SESSIONS_ERROR');
      expect(calls[0].payload.error.message).toBe('string-error');
    });

    it('should pass params to callMethod', async () => {
      mock.api.callMethod.mockResolvedValueOnce([]);

      const handler = mock.getGatewayMethod('clawhouse.sessions');
      const { fn } = makeRespond();

      await handler({ params: { limit: 10 }, respond: fn });

      expect(mock.api.callMethod).toHaveBeenCalledWith('sessions.list', { limit: 10 });
    });

    it('should default params to empty object when null', async () => {
      mock.api.callMethod.mockResolvedValueOnce([]);

      const handler = mock.getGatewayMethod('clawhouse.sessions');
      const { fn } = makeRespond();

      await handler({ params: null, respond: fn });

      expect(mock.api.callMethod).toHaveBeenCalledWith('sessions.list', {});
    });
  });

  // ---------------------------------------------------------------------------
  // RPC: clawhouse.clients
  // ---------------------------------------------------------------------------

  describe('clawhouse.clients', () => {
    it('should return empty list when no clients connected', () => {
      const handler = mock.getGatewayMethod('clawhouse.clients');
      const { fn, calls } = makeRespond();

      handler({ respond: fn });

      expect(calls[0].ok).toBe(true);
      expect(calls[0].payload.clients).toEqual([]);
      expect(calls[0].payload.count).toBe(0);
    });

    it('should return connected clients with correct shape', () => {
      // Pair + subscribe a device
      const pairHandler = mock.getGatewayMethod('clawhouse.pair');
      const { fn: pFn } = makeRespond();
      pairHandler({
        params: { token: 'valid-token', deviceId: 'client-d', deviceName: 'iPhone 15', platform: 'ios' },
        respond: pFn,
      });

      const subHandler = mock.getGatewayMethod('clawhouse.subscribe');
      const { fn: sFn } = makeRespond();
      subHandler({
        params: { deviceId: 'client-d', deviceName: 'iPhone 15' },
        connection: { send: vi.fn() },
        respond: sFn,
      });

      const handler = mock.getGatewayMethod('clawhouse.clients');
      const { fn, calls } = makeRespond();
      handler({ respond: fn });

      expect(calls[0].ok).toBe(true);
      expect(calls[0].payload.count).toBeGreaterThanOrEqual(1);
      const client = calls[0].payload.clients.find((c: any) => c.deviceId === 'client-d');
      expect(client).toBeDefined();
      expect(client.deviceName).toBe('iPhone 15');
      expect(typeof client.connectedAt).toBe('number');
    });

    it('should not include the send function in client response', () => {
      // Pair + subscribe a device
      const pairHandler = mock.getGatewayMethod('clawhouse.pair');
      const { fn: pFn } = makeRespond();
      pairHandler({
        params: { token: 'valid-token', deviceId: 'no-send-d', deviceName: 'iPad', platform: 'ios' },
        respond: pFn,
      });

      const subHandler = mock.getGatewayMethod('clawhouse.subscribe');
      const { fn: sFn } = makeRespond();
      subHandler({
        params: { deviceId: 'no-send-d', deviceName: 'iPad' },
        connection: { send: vi.fn() },
        respond: sFn,
      });

      const handler = mock.getGatewayMethod('clawhouse.clients');
      const { fn, calls } = makeRespond();
      handler({ respond: fn });

      const client = calls[0].payload.clients.find((c: any) => c.deviceId === 'no-send-d');
      expect(client.send).toBeUndefined();
    });
  });

  // ---------------------------------------------------------------------------
  // Service lifecycle
  // ---------------------------------------------------------------------------

  describe('service lifecycle', () => {
    it('should log on service start', () => {
      const svc = mock.getService();
      (mock.api.logger.info as any).mockClear();

      svc.start();

      const infoCalls = (mock.api.logger.info as any).mock.calls.map((c: any) => c[0]);
      expect(infoCalls.some((m: string) => m.includes('Background service started'))).toBe(true);
      expect(infoCalls.some((m: string) => m.includes('Storage directory'))).toBe(true);
    });

    it('should log paired device count on start if devices exist', () => {
      // Pair a device first
      const pairHandler = mock.getGatewayMethod('clawhouse.pair');
      const { fn } = makeRespond();
      pairHandler({
        params: { token: 'valid-token', deviceId: 'svc-d', deviceName: 'iPhone', platform: 'ios' },
        respond: fn,
      });

      (mock.api.logger.info as any).mockClear();

      const svc = mock.getService();
      svc.start();

      const infoCalls = (mock.api.logger.info as any).mock.calls.map((c: any) => c[0]);
      expect(infoCalls.some((m: string) => m.includes('previously paired device(s) loaded'))).toBe(true);
    });

    it('should not log paired device count when none exist', () => {
      // Use a fresh mock with no paired devices
      const freshMock = createMockApi();
      register(freshMock.api);

      (freshMock.api.logger.info as any).mockClear();

      const svc = freshMock.getService();
      svc.start();

      const infoCalls = (freshMock.api.logger.info as any).mock.calls.map((c: any) => c[0]);
      expect(infoCalls.some((m: string) => m.includes('previously paired device(s)'))).toBe(false);
      rmSync(freshMock.tempDir, { recursive: true, force: true });
    });

    it('should log on service stop', () => {
      const svc = mock.getService();
      (mock.api.logger.info as any).mockClear();

      svc.stop();

      const infoCalls = (mock.api.logger.info as any).mock.calls.map((c: any) => c[0]);
      expect(infoCalls.some((m: string) => m.includes('Background service stopped'))).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // Storage directory fallback
  // ---------------------------------------------------------------------------

  describe('storage config', () => {
    it('should fall back to cwd when dataDir config is absent', () => {
      const m = createMockApi({ dataDir: undefined });
      // Temporarily mock process.cwd to control the fallback
      const originalCwd = process.cwd;
      const fakeCwd = mkdtempSync(join(tmpdir(), 'clawhouse-cwd-'));
      process.cwd = () => fakeCwd;

      try {
        register(m.api);
        // If no error, the plugin loaded successfully with cwd fallback
        const infoCalls = (m.api.logger.info as any).mock.calls.map((c: any) => c[0]);
        expect(infoCalls.some((s: string) => s.includes('Plugin loaded successfully'))).toBe(true);
      } finally {
        process.cwd = originalCwd;
        rmSync(fakeCwd, { recursive: true, force: true });
        rmSync(m.tempDir, { recursive: true, force: true });
      }
    });
  });
});

// Need afterEach in vitest scope
import { afterEach } from 'vitest';
