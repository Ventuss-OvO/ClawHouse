import type { ClawState } from './types.js';
import type { APNsSender } from './push.js';
import type { PluginStorage } from './storage.js';

type UpdateStateFn = (state: ClawState, detail?: string) => void;

export interface HookDeps {
  pushSender?: APNsSender;
  storage?: PluginStorage;
  getClientCount?: () => number;
}

export function registerAgentHooks(api: any, updateState: UpdateStateFn, deps?: HookDeps) {
  // Hook into agent lifecycle
  api.registerHook('agent.run.before', () => {
    updateState('working');
  }, { id: 'clawhouse-agent-start' });

  api.registerHook('agent.run.after', () => {
    updateState('idle');

    // Push notification when no clients connected (app in background)
    if (deps?.pushSender && deps.storage && deps.getClientCount) {
      if (deps.getClientCount() === 0) {
        const devices = deps.storage.getDevicesWithPushTokens();
        if (devices.length > 0) {
          deps.pushSender.sendToAll(
            devices as Array<{ pushToken: string; pushBundleId: string; pushEnvironment: 'development' | 'production' }>,
            { title: 'Claw', body: 'Claw finished working', data: { type: 'message' } },
          ).catch(() => { /* push best-effort */ });
        }
      }
    }
  }, { id: 'clawhouse-agent-end' });

  // Hook into tool calls
  api.registerHook('tool.call.before', (_ctx: any, toolName: string) => {
    // Determine if this is an "external" tool (claw goes out)
    const externalTools = [
      'gmail', 'google_calendar', 'web_search', 'web_browse',
      'http_request', 'slack', 'discord', 'twitter',
      'github', 'notion', 'linear',
    ];

    const isExternal = externalTools.some(t => toolName.toLowerCase().includes(t));

    if (isExternal) {
      updateState('out', toolName);
    }
  }, { id: 'clawhouse-tool-start' });

  api.registerHook('tool.call.after', (_ctx: any, toolName: string) => {
    updateState('returning', toolName);

    // Transition back to working after a brief "returning" animation window
    setTimeout(() => {
      updateState('working');
    }, 2000);
  }, { id: 'clawhouse-tool-end' });

  api.logger.info('[ClawHouse] Agent hooks registered');
}
