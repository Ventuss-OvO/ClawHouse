import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';

// ---------------------------------------------------------------------------
// Mock modules before importing the class under test
// ---------------------------------------------------------------------------

vi.mock('node:fs', () => ({
  readFileSync: vi.fn().mockReturnValue('-----BEGIN PRIVATE KEY-----\nfake-key\n-----END PRIVATE KEY-----'),
}));

// Helpers to capture http2 behavior
let mockClientErrorCb: ((err: Error) => void) | null = null;
let mockRequestHeaders: Record<string, string | number> = {};
let mockResponseHeaders: Record<string, string | number> = { ':status': 200 };
let mockResponseData = '';
let mockRequestErrorCb: ((err: Error) => void) | null = null;
let mockClientCloseCallCount = 0;

class MockClientSession extends EventEmitter {
  close = vi.fn(() => { mockClientCloseCallCount++; });

  request(headers: Record<string, string | number>) {
    mockRequestHeaders = headers;
    const req = new MockHttp2Stream();
    return req;
  }
}

class MockHttp2Stream extends EventEmitter {
  write = vi.fn();
  end = vi.fn(() => {
    // Simulate async response flow: response headers, then data, then end
    queueMicrotask(() => {
      this.emit('response', mockResponseHeaders);
      if (mockResponseData) {
        this.emit('data', Buffer.from(mockResponseData));
      }
      this.emit('end');
    });
  });
}

let mockClient: MockClientSession;

vi.mock('node:http2', () => ({
  connect: vi.fn((_url: string) => {
    mockClient = new MockClientSession();
    return mockClient;
  }),
}));

// Mock crypto.createSign to return a deterministic DER-encoded signature
const fakeDerSignature = Buffer.from([
  0x30, 0x44,
  0x02, 0x20,
  // r: 32 bytes
  ...Array(32).fill(0xAA),
  0x02, 0x20,
  // s: 32 bytes
  ...Array(32).fill(0xBB),
]);

vi.mock('node:crypto', () => ({
  createSign: vi.fn(() => ({
    update: vi.fn(),
    sign: vi.fn().mockReturnValue(fakeDerSignature),
  })),
}));

// ---------------------------------------------------------------------------
// Now import the class under test (after mocks are set up)
// ---------------------------------------------------------------------------

import { APNsSender } from '../src/push.js';
import type { APNsConfig, PushPayload } from '../src/push.js';
import * as http2 from 'node:http2';
import * as fs from 'node:fs';

// ---------------------------------------------------------------------------
// Test data
// ---------------------------------------------------------------------------

const validConfig: APNsConfig = {
  keyId: 'TESTKEY123',
  teamId: 'TEAM456789',
  keyPath: '/path/to/AuthKey.p8',
};

const validPayload: PushPayload = {
  deviceToken: 'abc123def456',
  bundleId: 'com.clawhouse.ClawHouse',
  environment: 'development',
  title: 'Claw',
  body: 'Claw finished working',
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('APNsSender', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mockResponseHeaders = { ':status': 200 };
    mockResponseData = '';
    mockRequestHeaders = {};
    mockRequestErrorCb = null;
    mockClientErrorCb = null;
    mockClientCloseCallCount = 0;
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // -------------------------------------------------------------------------
  // Constructor
  // -------------------------------------------------------------------------

  describe('constructor', () => {
    it('should create instance with valid config and read the key file', () => {
      const sender = new APNsSender(validConfig);
      expect(sender).toBeInstanceOf(APNsSender);
      expect(fs.readFileSync).toHaveBeenCalledWith('/path/to/AuthKey.p8', 'utf-8');
    });
  });

  // -------------------------------------------------------------------------
  // JWT generation
  // -------------------------------------------------------------------------

  describe('JWT generation (via send)', () => {
    it('should produce a three-part JWT (header.payload.signature)', async () => {
      const sender = new APNsSender(validConfig);
      vi.setSystemTime(new Date('2025-06-15T12:00:00Z'));

      const promise = sender.send(validPayload);
      await vi.runAllTimersAsync();
      await promise;

      // Extract the JWT from the authorization header
      const authHeader = mockRequestHeaders['authorization'] as string;
      expect(authHeader).toBeDefined();
      expect(authHeader.startsWith('bearer ')).toBe(true);

      const jwt = authHeader.replace('bearer ', '');
      const parts = jwt.split('.');
      expect(parts).toHaveLength(3);
    });

    it('should have correct JWT header fields (alg: ES256, kid: keyId)', async () => {
      const sender = new APNsSender(validConfig);
      vi.setSystemTime(new Date('2025-06-15T12:00:00Z'));

      const promise = sender.send(validPayload);
      await vi.runAllTimersAsync();
      await promise;

      const authHeader = mockRequestHeaders['authorization'] as string;
      const jwt = authHeader.replace('bearer ', '');
      const headerPart = jwt.split('.')[0]!;
      const header = JSON.parse(Buffer.from(headerPart, 'base64url').toString());

      expect(header.alg).toBe('ES256');
      expect(header.kid).toBe('TESTKEY123');
    });

    it('should have correct JWT payload fields (iss: teamId, iat: current timestamp)', async () => {
      const sender = new APNsSender(validConfig);
      const testTime = new Date('2025-06-15T12:00:00Z');
      vi.setSystemTime(testTime);

      const promise = sender.send(validPayload);
      await vi.runAllTimersAsync();
      await promise;

      const authHeader = mockRequestHeaders['authorization'] as string;
      const jwt = authHeader.replace('bearer ', '');
      const claimsPart = jwt.split('.')[1]!;
      const claims = JSON.parse(Buffer.from(claimsPart, 'base64url').toString());

      expect(claims.iss).toBe('TEAM456789');
      expect(claims.iat).toBe(Math.floor(testTime.getTime() / 1000));
    });
  });

  // -------------------------------------------------------------------------
  // JWT caching
  // -------------------------------------------------------------------------

  describe('JWT caching', () => {
    it('should return the same JWT within 50 minutes', async () => {
      const sender = new APNsSender(validConfig);
      vi.setSystemTime(new Date('2025-06-15T12:00:00Z'));

      // First call
      const promise1 = sender.send(validPayload);
      await vi.runAllTimersAsync();
      await promise1;
      const jwt1 = (mockRequestHeaders['authorization'] as string).replace('bearer ', '');

      // Advance 49 minutes
      vi.setSystemTime(new Date('2025-06-15T12:49:00Z'));

      // Second call
      const promise2 = sender.send(validPayload);
      await vi.runAllTimersAsync();
      await promise2;
      const jwt2 = (mockRequestHeaders['authorization'] as string).replace('bearer ', '');

      expect(jwt1).toBe(jwt2);
    });

    it('should generate a new JWT after 50 minutes', async () => {
      const sender = new APNsSender(validConfig);
      vi.setSystemTime(new Date('2025-06-15T12:00:00Z'));

      // First call
      const promise1 = sender.send(validPayload);
      await vi.runAllTimersAsync();
      await promise1;
      const jwt1 = (mockRequestHeaders['authorization'] as string).replace('bearer ', '');

      // Advance 51 minutes (past the 50-minute cache window)
      vi.setSystemTime(new Date('2025-06-15T12:51:00Z'));

      // Second call
      const promise2 = sender.send(validPayload);
      await vi.runAllTimersAsync();
      await promise2;
      const jwt2 = (mockRequestHeaders['authorization'] as string).replace('bearer ', '');

      expect(jwt1).not.toBe(jwt2);
    });
  });

  // -------------------------------------------------------------------------
  // send method - HTTP/2 request
  // -------------------------------------------------------------------------

  describe('send', () => {
    it('should connect to sandbox host for development environment', async () => {
      const sender = new APNsSender(validConfig);

      const promise = sender.send({ ...validPayload, environment: 'development' });
      await vi.runAllTimersAsync();
      await promise;

      expect(http2.connect).toHaveBeenCalledWith('https://api.sandbox.push.apple.com');
    });

    it('should connect to production host for production environment', async () => {
      const sender = new APNsSender(validConfig);

      const promise = sender.send({ ...validPayload, environment: 'production' });
      await vi.runAllTimersAsync();
      await promise;

      expect(http2.connect).toHaveBeenCalledWith('https://api.push.apple.com');
    });

    it('should set correct request headers', async () => {
      const sender = new APNsSender(validConfig);

      const promise = sender.send(validPayload);
      await vi.runAllTimersAsync();
      await promise;

      expect(mockRequestHeaders[':method']).toBe('POST');
      expect(mockRequestHeaders[':path']).toBe('/3/device/abc123def456');
      expect((mockRequestHeaders['authorization'] as string).startsWith('bearer ')).toBe(true);
      expect(mockRequestHeaders['apns-topic']).toBe('com.clawhouse.ClawHouse');
      expect(mockRequestHeaders['apns-push-type']).toBe('alert');
      expect(mockRequestHeaders['apns-priority']).toBe('10');
      expect(mockRequestHeaders['apns-expiration']).toBe('0');
    });

    it('should return ok: true with status 200 on success', async () => {
      mockResponseHeaders = { ':status': 200 };
      const sender = new APNsSender(validConfig);

      const promise = sender.send(validPayload);
      await vi.runAllTimersAsync();
      const result = await promise;

      expect(result).toEqual({ ok: true, status: 200 });
    });

    it('should return ok: false with status and reason on APNs error', async () => {
      mockResponseHeaders = { ':status': 400 };
      mockResponseData = JSON.stringify({ reason: 'BadDeviceToken' });
      const sender = new APNsSender(validConfig);

      const promise = sender.send(validPayload);
      await vi.runAllTimersAsync();
      const result = await promise;

      expect(result).toEqual({ ok: false, status: 400, reason: 'BadDeviceToken' });
    });

    it('should return reason UNKNOWN when error response has invalid JSON', async () => {
      mockResponseHeaders = { ':status': 500 };
      mockResponseData = 'not-json';
      const sender = new APNsSender(validConfig);

      const promise = sender.send(validPayload);
      await vi.runAllTimersAsync();
      const result = await promise;

      expect(result).toEqual({ ok: false, status: 500, reason: 'UNKNOWN' });
    });

    it('should return CONNECTION_ERROR on client error', async () => {
      const sender = new APNsSender(validConfig);

      // Override connect to emit error on the client
      vi.mocked(http2.connect).mockImplementationOnce((_url: string) => {
        mockClient = new MockClientSession();
        // Emit error after a tick
        queueMicrotask(() => mockClient.emit('error', new Error('connect failed')));
        return mockClient as any;
      });

      const promise = sender.send(validPayload);
      await vi.runAllTimersAsync();
      const result = await promise;

      expect(result).toEqual({ ok: false, reason: 'CONNECTION_ERROR' });
    });
  });

  // -------------------------------------------------------------------------
  // sendToAll
  // -------------------------------------------------------------------------

  describe('sendToAll', () => {
    it('should send to all devices', async () => {
      mockResponseHeaders = { ':status': 200 };
      const sender = new APNsSender(validConfig);

      const devices = [
        { pushToken: 'token-1', pushBundleId: 'com.test', pushEnvironment: 'development' as const },
        { pushToken: 'token-2', pushBundleId: 'com.test', pushEnvironment: 'production' as const },
      ];

      const promise = sender.sendToAll(devices, { title: 'Hi', body: 'Hello' });
      await vi.runAllTimersAsync();
      await promise;

      // http2.connect should have been called twice (once per device)
      expect(http2.connect).toHaveBeenCalledTimes(2);
    });

    it('should handle partial failures gracefully (does not throw)', async () => {
      const sender = new APNsSender(validConfig);
      let callCount = 0;

      // First call succeeds, second fails
      vi.mocked(http2.connect).mockImplementation((_url: string) => {
        callCount++;
        mockClient = new MockClientSession();
        if (callCount === 2) {
          queueMicrotask(() => mockClient.emit('error', new Error('connect failed')));
        }
        return mockClient as any;
      });

      const devices = [
        { pushToken: 'token-1', pushBundleId: 'com.test', pushEnvironment: 'development' as const },
        { pushToken: 'token-2', pushBundleId: 'com.test', pushEnvironment: 'development' as const },
      ];

      // Should not throw even with partial failure
      const promise = sender.sendToAll(devices, { title: 'Hi', body: 'Hello' });
      await vi.runAllTimersAsync();
      await expect(promise).resolves.toBeUndefined();
    });

    it('should pass custom data through to each send call', async () => {
      mockResponseHeaders = { ':status': 200 };
      const sender = new APNsSender(validConfig);

      const devices = [
        { pushToken: 'token-1', pushBundleId: 'com.test', pushEnvironment: 'development' as const },
      ];

      // Spy on the request write to verify payload
      let writtenData = '';
      vi.mocked(http2.connect).mockImplementationOnce((_url: string) => {
        mockClient = new MockClientSession();
        const origRequest = mockClient.request.bind(mockClient);
        mockClient.request = (headers: any) => {
          mockRequestHeaders = headers;
          const stream = new MockHttp2Stream();
          stream.write = vi.fn((data: string) => { writtenData = data; });
          return stream as any;
        };
        return mockClient as any;
      });

      const promise = sender.sendToAll(
        devices,
        { title: 'Hi', body: 'Hello', data: { type: 'message', custom: true } },
      );
      await vi.runAllTimersAsync();
      await promise;

      const parsed = JSON.parse(writtenData);
      expect(parsed.type).toBe('message');
      expect(parsed.custom).toBe(true);
      expect(parsed.aps.alert.title).toBe('Hi');
      expect(parsed.aps.alert.body).toBe('Hello');
    });
  });

  // -------------------------------------------------------------------------
  // DER to raw signature conversion
  // -------------------------------------------------------------------------

  describe('DER to raw signature conversion', () => {
    it('should produce a 64-byte raw signature from a standard DER signature', async () => {
      // Our fakeDerSignature has r=32 bytes of 0xAA, s=32 bytes of 0xBB
      // The JWT signature part should be base64url of 64 bytes (32 + 32)
      const sender = new APNsSender(validConfig);
      vi.setSystemTime(new Date('2025-06-15T12:00:00Z'));

      const promise = sender.send(validPayload);
      await vi.runAllTimersAsync();
      await promise;

      const authHeader = mockRequestHeaders['authorization'] as string;
      const jwt = authHeader.replace('bearer ', '');
      const signaturePart = jwt.split('.')[2]!;
      const rawSig = Buffer.from(signaturePart, 'base64url');

      expect(rawSig.length).toBe(64);
      // First 32 bytes should be r (0xAA)
      expect(rawSig.subarray(0, 32).every((b) => b === 0xAA)).toBe(true);
      // Last 32 bytes should be s (0xBB)
      expect(rawSig.subarray(32, 64).every((b) => b === 0xBB)).toBe(true);
    });
  });
});
