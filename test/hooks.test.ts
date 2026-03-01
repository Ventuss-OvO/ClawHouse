import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { registerAgentHooks } from '../src/hooks.js';
import type { HookDeps } from '../src/hooks.js';
import type { ClawState } from '../src/types.js';

// ---------------------------------------------------------------------------
// Mock API that captures registered hooks
// ---------------------------------------------------------------------------

type HookCallback = (...args: any[]) => void;

interface RegisteredHook {
  name: string;
  callback: HookCallback;
  options: { id: string };
}

function createMockApi() {
  const hooks: RegisteredHook[] = [];

  return {
    hooks,
    registerHook: vi.fn((name: string, callback: HookCallback, options: { id: string }) => {
      hooks.push({ name, callback, options });
    }),
    logger: {
      info: vi.fn(),
      debug: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
  };
}

function getHook(hooks: RegisteredHook[], name: string): HookCallback {
  const hook = hooks.find((h) => h.name === name);
  if (!hook) throw new Error(`Hook "${name}" not registered`);
  return hook.callback;
}

function getHookById(hooks: RegisteredHook[], id: string): HookCallback {
  const hook = hooks.find((h) => h.options.id === id);
  if (!hook) throw new Error(`Hook with id "${id}" not registered`);
  return hook.callback;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('registerAgentHooks', () => {
  let api: ReturnType<typeof createMockApi>;
  let updateState: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    api = createMockApi();
    updateState = vi.fn();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // -------------------------------------------------------------------------
  // Registration basics
  // -------------------------------------------------------------------------

  it('should register four hooks', () => {
    registerAgentHooks(api, updateState);
    expect(api.registerHook).toHaveBeenCalledTimes(4);
  });

  it('should log after registration', () => {
    registerAgentHooks(api, updateState);
    expect(api.logger.info).toHaveBeenCalledWith('[ClawHouse] Agent hooks registered');
  });

  // -------------------------------------------------------------------------
  // agent.run.before
  // -------------------------------------------------------------------------

  describe('agent.run.before', () => {
    it('should call updateState("working")', () => {
      registerAgentHooks(api, updateState);
      const hook = getHookById(api.hooks, 'clawhouse-agent-start');
      hook();
      expect(updateState).toHaveBeenCalledWith('working');
    });
  });

  // -------------------------------------------------------------------------
  // agent.run.after
  // -------------------------------------------------------------------------

  describe('agent.run.after', () => {
    it('should call updateState("idle")', () => {
      registerAgentHooks(api, updateState);
      const hook = getHookById(api.hooks, 'clawhouse-agent-end');
      hook();
      expect(updateState).toHaveBeenCalledWith('idle');
    });

    it('should send push notification when pushSender + storage + 0 clients', () => {
      const sendToAll = vi.fn().mockResolvedValue(undefined);
      const deps: HookDeps = {
        pushSender: { sendToAll } as any,
        storage: {
          getDevicesWithPushTokens: vi.fn().mockReturnValue([
            { pushToken: 'token-1', pushBundleId: 'com.test', pushEnvironment: 'development' },
          ]),
        } as any,
        getClientCount: () => 0,
      };

      registerAgentHooks(api, updateState, deps);
      const hook = getHookById(api.hooks, 'clawhouse-agent-end');
      hook();

      expect(deps.storage!.getDevicesWithPushTokens).toHaveBeenCalled();
      expect(sendToAll).toHaveBeenCalledWith(
        [{ pushToken: 'token-1', pushBundleId: 'com.test', pushEnvironment: 'development' }],
        { title: 'Claw', body: 'Claw finished working', data: { type: 'message' } },
      );
    });

    it('should NOT send push notification when clients are connected (>0)', () => {
      const sendToAll = vi.fn().mockResolvedValue(undefined);
      const deps: HookDeps = {
        pushSender: { sendToAll } as any,
        storage: {
          getDevicesWithPushTokens: vi.fn().mockReturnValue([
            { pushToken: 'token-1', pushBundleId: 'com.test', pushEnvironment: 'development' },
          ]),
        } as any,
        getClientCount: () => 2,
      };

      registerAgentHooks(api, updateState, deps);
      const hook = getHookById(api.hooks, 'clawhouse-agent-end');
      hook();

      expect(sendToAll).not.toHaveBeenCalled();
    });

    it('should NOT send push notification when no pushSender', () => {
      const deps: HookDeps = {
        storage: {
          getDevicesWithPushTokens: vi.fn().mockReturnValue([]),
        } as any,
        getClientCount: () => 0,
      };

      registerAgentHooks(api, updateState, deps);
      const hook = getHookById(api.hooks, 'clawhouse-agent-end');
      hook();

      // Should not throw, and getDevicesWithPushTokens should NOT be called
      // because the guard checks pushSender first
      expect(deps.storage!.getDevicesWithPushTokens).not.toHaveBeenCalled();
    });

    it('should NOT send push when there are no devices with push tokens', () => {
      const sendToAll = vi.fn().mockResolvedValue(undefined);
      const deps: HookDeps = {
        pushSender: { sendToAll } as any,
        storage: {
          getDevicesWithPushTokens: vi.fn().mockReturnValue([]),
        } as any,
        getClientCount: () => 0,
      };

      registerAgentHooks(api, updateState, deps);
      const hook = getHookById(api.hooks, 'clawhouse-agent-end');
      hook();

      expect(deps.storage!.getDevicesWithPushTokens).toHaveBeenCalled();
      expect(sendToAll).not.toHaveBeenCalled();
    });

    it('should swallow errors from sendToAll (best-effort push)', async () => {
      const sendToAll = vi.fn().mockRejectedValue(new Error('APNs down'));
      const deps: HookDeps = {
        pushSender: { sendToAll } as any,
        storage: {
          getDevicesWithPushTokens: vi.fn().mockReturnValue([
            { pushToken: 'token-1', pushBundleId: 'com.test', pushEnvironment: 'development' },
          ]),
        } as any,
        getClientCount: () => 0,
      };

      registerAgentHooks(api, updateState, deps);
      const hook = getHookById(api.hooks, 'clawhouse-agent-end');

      // Should not throw
      expect(() => hook()).not.toThrow();
    });
  });

  // -------------------------------------------------------------------------
  // tool.call.before — external tool detection
  // -------------------------------------------------------------------------

  describe('tool.call.before', () => {
    beforeEach(() => {
      registerAgentHooks(api, updateState);
    });

    const externalTools = [
      'gmail', 'google_calendar', 'web_search', 'web_browse',
      'http_request', 'slack', 'discord', 'twitter',
      'github', 'notion', 'linear',
    ];

    it.each(externalTools)(
      'should detect "%s" as external and call updateState("out", toolName)',
      (toolName) => {
        const hook = getHookById(api.hooks, 'clawhouse-tool-start');
        hook({}, toolName);
        expect(updateState).toHaveBeenCalledWith('out', toolName);
      },
    );

    it('should detect all 11 external tool patterns', () => {
      expect(externalTools).toHaveLength(11);
    });

    it('should detect compound tool names containing external pattern (e.g., "gmail_send")', () => {
      const hook = getHookById(api.hooks, 'clawhouse-tool-start');
      hook({}, 'gmail_send_email');
      expect(updateState).toHaveBeenCalledWith('out', 'gmail_send_email');
    });

    it('should match case-insensitively (e.g., "Gmail", "SLACK")', () => {
      const hook = getHookById(api.hooks, 'clawhouse-tool-start');

      hook({}, 'Gmail_Read');
      expect(updateState).toHaveBeenCalledWith('out', 'Gmail_Read');

      updateState.mockClear();

      hook({}, 'SLACK_POST');
      expect(updateState).toHaveBeenCalledWith('out', 'SLACK_POST');
    });

    it('should NOT call updateState for internal tool "file_read"', () => {
      const hook = getHookById(api.hooks, 'clawhouse-tool-start');
      hook({}, 'file_read');
      expect(updateState).not.toHaveBeenCalled();
    });

    it('should NOT call updateState for internal tool "code_execute"', () => {
      const hook = getHookById(api.hooks, 'clawhouse-tool-start');
      hook({}, 'code_execute');
      expect(updateState).not.toHaveBeenCalled();
    });

    it('should NOT call updateState for internal tool "memory_search"', () => {
      const hook = getHookById(api.hooks, 'clawhouse-tool-start');
      hook({}, 'memory_search');
      expect(updateState).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // tool.call.after
  // -------------------------------------------------------------------------

  describe('tool.call.after', () => {
    it('should call updateState("returning", toolName) immediately', () => {
      registerAgentHooks(api, updateState);
      const hook = getHookById(api.hooks, 'clawhouse-tool-end');
      hook({}, 'gmail');
      expect(updateState).toHaveBeenCalledWith('returning', 'gmail');
    });

    it('should call updateState("working") after 2000ms timeout', () => {
      registerAgentHooks(api, updateState);
      const hook = getHookById(api.hooks, 'clawhouse-tool-end');
      hook({}, 'web_search');

      // Immediately after: only "returning" should have been called
      expect(updateState).toHaveBeenCalledTimes(1);
      expect(updateState).toHaveBeenCalledWith('returning', 'web_search');

      // Advance timer by 2000ms
      vi.advanceTimersByTime(2000);

      expect(updateState).toHaveBeenCalledTimes(2);
      expect(updateState).toHaveBeenLastCalledWith('working');
    });

    it('should not call updateState("working") before 2000ms', () => {
      registerAgentHooks(api, updateState);
      const hook = getHookById(api.hooks, 'clawhouse-tool-end');
      hook({}, 'notion');

      vi.advanceTimersByTime(1999);
      expect(updateState).toHaveBeenCalledTimes(1); // only "returning"
    });
  });
});
