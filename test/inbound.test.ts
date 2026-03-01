import { describe, it, expect, vi } from 'vitest';
import { preprocessInbound, setupInboundHandler } from '../src/inbound.js';
import type { InboundMessage } from '../src/types.js';

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

function createMockApi() {
  return {
    logger: {
      info: vi.fn(),
      debug: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
  };
}

function createTestMessage(overrides: Partial<InboundMessage> = {}): InboundMessage {
  return {
    text: 'Hello from iOS',
    senderId: 'device-001',
    senderName: 'Test iPhone',
    channel: 'original-channel',
    sessionKey: 'main',
    timestamp: 1700000000000,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests: preprocessInbound
// ---------------------------------------------------------------------------

describe('preprocessInbound', () => {
  it('should set channel to "clawhouse"', () => {
    const msg = createTestMessage();
    const result = preprocessInbound(msg);
    expect(result.message.channel).toBe('clawhouse');
  });

  it('should override any existing channel value', () => {
    const msg = createTestMessage({ channel: 'discord' });
    const result = preprocessInbound(msg);
    expect(result.message.channel).toBe('clawhouse');
  });

  it('should preserve all other message fields', () => {
    const msg = createTestMessage({
      text: 'Specific text',
      senderId: 'device-xyz',
      senderName: 'My iPad',
      sessionKey: 'session-42',
      timestamp: 9999999999999,
    });

    const result = preprocessInbound(msg);

    expect(result.message.text).toBe('Specific text');
    expect(result.message.senderId).toBe('device-xyz');
    expect(result.message.senderName).toBe('My iPad');
    expect(result.message.sessionKey).toBe('session-42');
    expect(result.message.timestamp).toBe(9999999999999);
  });

  it('should not mutate the original message object', () => {
    const msg = createTestMessage({ channel: 'whatsapp' });
    preprocessInbound(msg);
    expect(msg.channel).toBe('whatsapp');
  });

  it('should pass through the context unchanged', () => {
    const msg = createTestMessage();
    const ctx = { deviceId: 'dev-1', deviceName: 'iPhone 16' };
    const result = preprocessInbound(msg, ctx);
    expect(result.context).toBe(ctx);
  });

  it('should use an empty context when none is provided', () => {
    const msg = createTestMessage();
    const result = preprocessInbound(msg);
    expect(result.context).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// Tests: setupInboundHandler
// ---------------------------------------------------------------------------

describe('setupInboundHandler', () => {
  it('should not throw', () => {
    const api = createMockApi();
    expect(() => setupInboundHandler(api)).not.toThrow();
  });

  it('should log that the inbound handler is ready', () => {
    const api = createMockApi();
    setupInboundHandler(api);
    expect(api.logger.info).toHaveBeenCalledWith(
      '[ClawHouse] Inbound handler ready (Gateway routes chat.send automatically)',
    );
  });
});
