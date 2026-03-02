import { createClawHouseChannel } from './channel.js';
import { registerAgentHooks } from './hooks.js';
import { setupInboundHandler } from './inbound.js';
import { PluginStorage } from './storage.js';
import { APNsSender } from './push.js';
import { RelayConnection } from './relay.js';
import type {
  SubscribeParams,
  SubscribeResponse,
  UnsubscribeParams,
  UnsubscribeResponse,
  ConnectedClient,
  PairedDevice,
  SessionInfo,
  APNsConfig,
  RelayConfig,
} from './types.js';

export default function register(api: any) {
  api.logger.info('[ClawHouse] Plugin loading...');

  // Resolve storage directory from plugin config or fall back to cwd
  const baseDir: string = api.config?.dataDir ?? process.cwd();
  const storage = new PluginStorage(baseDir);

  // Initialize APNs sender if config is provided
  let pushSender: APNsSender | undefined;
  const apnsConfig: APNsConfig | undefined = api.config?.apns;
  if (apnsConfig?.keyId && apnsConfig?.teamId && apnsConfig?.keyPath) {
    try {
      pushSender = new APNsSender(apnsConfig);
      api.logger.info('[ClawHouse] APNs push sender initialized');
    } catch (err) {
      api.logger.warn(`[ClawHouse] Failed to init APNs sender: ${err}`);
    }
  }

  // Create channel (returns helpers including addClient / removeClient)
  const {
    channelPlugin,
    updateState,
    broadcastEvent,
    addClient,
    removeClient,
    getConnectedClients,
    getCurrentState,
  } = createClawHouseChannel(api, { pushSender, storage });

  // Register the channel with the Gateway
  api.registerChannel({ plugin: channelPlugin });

  // Register agent lifecycle hooks
  registerAgentHooks(api, updateState, {
    pushSender,
    storage,
    getClientCount: () => getConnectedClients().size,
  });

  // Register inbound pre-processing (no-op for now, wires future hooks)
  setupInboundHandler(api);

  // Store RPC handlers for relay dispatch
  const rpcHandlers = new Map<string, (ctx: any) => void | Promise<void>>();

  // ---------------------------------------------------------------------------
  // Gateway RPC: clawhouse.pair
  // ---------------------------------------------------------------------------

  const handlePair = ({ params, respond }: any) => {
    const { token, deviceId, deviceName, platform, appVersion } = params ?? {};

    // --- Validate required fields ---
    if (!token || typeof token !== 'string') {
      respond(false, { error: { code: 'MISSING_TOKEN', message: 'Pairing token is required' } });
      return;
    }
    if (!deviceId || typeof deviceId !== 'string') {
      respond(false, { error: { code: 'MISSING_DEVICE_ID', message: 'deviceId is required' } });
      return;
    }
    if (!deviceName || typeof deviceName !== 'string') {
      respond(false, { error: { code: 'MISSING_DEVICE_NAME', message: 'deviceName is required' } });
      return;
    }
    if (platform !== 'ios') {
      respond(false, { error: { code: 'UNSUPPORTED_PLATFORM', message: 'Only "ios" platform is supported' } });
      return;
    }

    // --- Validate pairing token ---
    const configToken: string | undefined = api.config?.pairingToken;
    if (configToken && token !== configToken) {
      respond(false, { error: { code: 'INVALID_TOKEN', message: 'Pairing token does not match' } });
      return;
    }

    // --- Persist or update paired device record ---
    const existing = storage.getPairedDevice(deviceId);
    const now = Date.now();

    const pairedDevice: PairedDevice = {
      deviceId,
      deviceName,
      platform: 'ios',
      appVersion: typeof appVersion === 'string' ? appVersion : 'unknown',
      pairedAt: existing?.pairedAt ?? now,
      lastSeenAt: now,
    };

    storage.addPairedDevice(pairedDevice);

    api.logger.info(
      `[ClawHouse] Device paired: ${deviceName} (${deviceId}) v${pairedDevice.appVersion}` +
      (existing ? ' [re-paired]' : ' [new]')
    );

    respond(true, {
      success: true,
      agentId: 'main',
      pairedAt: pairedDevice.pairedAt,
    });
  };

  api.registerGatewayMethod('clawhouse.pair', handlePair);
  rpcHandlers.set('clawhouse.pair', handlePair);

  // ---------------------------------------------------------------------------
  // Gateway RPC: clawhouse.subscribe
  // iOS app calls this after pairing to register for event broadcasting.
  // ---------------------------------------------------------------------------

  const handleSubscribe = ({ params, connection, respond }: any) => {
    const { deviceId, deviceName } = (params ?? {}) as SubscribeParams;

    if (!deviceId || typeof deviceId !== 'string') {
      respond(false, { error: { code: 'MISSING_DEVICE_ID', message: 'deviceId is required' } });
      return;
    }
    if (!deviceName || typeof deviceName !== 'string') {
      respond(false, { error: { code: 'MISSING_DEVICE_NAME', message: 'deviceName is required' } });
      return;
    }

    // Verify that this device has been previously paired
    const pairedDevice = storage.getPairedDevice(deviceId);
    if (!pairedDevice) {
      respond(false, {
        error: {
          code: 'NOT_PAIRED',
          message: 'Device must complete pairing (clawhouse.pair) before subscribing',
        },
      });
      return;
    }

    // Update lastSeenAt
    storage.updatePairedDevice(deviceId, { lastSeenAt: Date.now(), deviceName });

    // In direct mode, create a client entry using the Gateway connection.
    // In relay mode (connection is null), the virtual client already handles
    // event delivery — skip creating a duplicate client.
    if (connection && typeof connection.send === 'function') {
      const client: ConnectedClient = {
        deviceId,
        deviceName,
        connectedAt: Date.now(),
        send: (event) => {
          connection.send({
            type: 'event',
            event: `clawhouse.${event.type}`,
            payload: event.payload,
            seq: event.seq,
          });
        },
      };

      addClient(client);
    }

    const response: SubscribeResponse = {
      success: true,
      currentState: getCurrentState(),
      connectedAt: Date.now(),
    };

    api.logger.info(`[ClawHouse] Device subscribed: ${deviceName} (${deviceId})`);
    respond(true, response);
  };

  api.registerGatewayMethod('clawhouse.subscribe', handleSubscribe);
  rpcHandlers.set('clawhouse.subscribe', handleSubscribe);

  // ---------------------------------------------------------------------------
  // Gateway RPC: clawhouse.unsubscribe
  // iOS app calls this on graceful disconnect.
  // ---------------------------------------------------------------------------

  const handleUnsubscribe = ({ params, respond }: any) => {
    const { deviceId } = (params ?? {}) as UnsubscribeParams;

    if (!deviceId || typeof deviceId !== 'string') {
      respond(false, { error: { code: 'MISSING_DEVICE_ID', message: 'deviceId is required' } });
      return;
    }

    removeClient(deviceId);

    // Update lastSeenAt even on graceful disconnect
    storage.updatePairedDevice(deviceId, { lastSeenAt: Date.now() });

    const response: UnsubscribeResponse = { success: true };
    respond(true, response);
  };

  api.registerGatewayMethod('clawhouse.unsubscribe', handleUnsubscribe);
  rpcHandlers.set('clawhouse.unsubscribe', handleUnsubscribe);

  // ---------------------------------------------------------------------------
  // Gateway RPC: clawhouse.registerPushToken
  // iOS app calls this after connection to register/update its APNs push token.
  // ---------------------------------------------------------------------------

  const handleRegisterPushToken = ({ params, respond }: any) => {
    const { deviceId, pushToken, pushBundleId, pushEnvironment } = params ?? {};

    if (!deviceId || typeof deviceId !== 'string') {
      respond(false, { error: { code: 'MISSING_DEVICE_ID', message: 'deviceId is required' } });
      return;
    }
    if (!pushToken || typeof pushToken !== 'string') {
      respond(false, { error: { code: 'MISSING_PUSH_TOKEN', message: 'pushToken is required' } });
      return;
    }

    const updated = storage.updatePairedDevice(deviceId, {
      pushToken,
      pushBundleId: typeof pushBundleId === 'string' ? pushBundleId : 'com.clawhouse.ClawHouse',
      pushEnvironment: pushEnvironment === 'production' ? 'production' : 'development',
    });

    if (!updated) {
      respond(false, { error: { code: 'NOT_PAIRED', message: 'Device must be paired first' } });
      return;
    }

    api.logger.info(`[ClawHouse] Push token registered for device ${deviceId}`);
    respond(true, { success: true });
  };

  api.registerGatewayMethod('clawhouse.registerPushToken', handleRegisterPushToken);
  rpcHandlers.set('clawhouse.registerPushToken', handleRegisterPushToken);

  // ---------------------------------------------------------------------------
  // Gateway RPC: clawhouse.state
  // ---------------------------------------------------------------------------

  const handleState = ({ respond }: any) => {
    respond(true, {
      state: getCurrentState(),
      timestamp: Date.now(),
    });
  };

  api.registerGatewayMethod('clawhouse.state', handleState);
  rpcHandlers.set('clawhouse.state', handleState);

  // ---------------------------------------------------------------------------
  // Gateway RPC: clawhouse.sessions
  // Proxy for sessions.list that enriches each session with channel metadata.
  // ---------------------------------------------------------------------------

  const handleSessions = async ({ params, respond }: any) => {
    try {
      // Delegate to the built-in sessions.list method
      const result: unknown = await api.callMethod('sessions.list', params ?? {});

      // Enrich each session entry with channelSource info.
      let sessions: SessionInfo[] = [];
      const raw: unknown[] = Array.isArray(result)
        ? result
        : (result && typeof result === 'object' && Array.isArray((result as any).sessions))
          ? (result as any).sessions
          : [];

      sessions = raw.map((s) => ({
        ...(s as Record<string, unknown>),
        channelSource: 'clawhouse' as const,
      })) as SessionInfo[];

      respond(true, { sessions });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      respond(false, { error: { code: 'SESSIONS_ERROR', message } });
    }
  };

  api.registerGatewayMethod('clawhouse.sessions', handleSessions);
  rpcHandlers.set('clawhouse.sessions', handleSessions);

  // ---------------------------------------------------------------------------
  // Gateway RPC: clawhouse.clients
  // Diagnostic endpoint — list currently connected iOS clients.
  // ---------------------------------------------------------------------------

  const handleClients = ({ respond }: any) => {
    const clients = Array.from(getConnectedClients().values()).map((c) => ({
      deviceId: c.deviceId,
      deviceName: c.deviceName,
      connectedAt: c.connectedAt,
    }));

    respond(true, { clients, count: clients.length });
  };

  api.registerGatewayMethod('clawhouse.clients', handleClients);
  rpcHandlers.set('clawhouse.clients', handleClients);

  // ---------------------------------------------------------------------------
  // Relay mode (outbound connection to relay service)
  // ---------------------------------------------------------------------------

  let relayConnection: RelayConnection | null = null;
  const relayConfig: RelayConfig | undefined = api.config?.relay;

  if (relayConfig?.url && relayConfig?.token) {
    relayConnection = new RelayConnection(relayConfig, api.logger);

    relayConnection.onVirtualClientReady = (client: ConnectedClient) => {
      addClient(client);
      api.logger.info('[ClawHouse] Relay virtual client connected');
    };

    relayConnection.onVirtualClientGone = (deviceId: string) => {
      removeClient(deviceId);
      api.logger.info('[ClawHouse] Relay virtual client disconnected');
    };

    // Handle inbound RPC from iOS app via relay
    relayConnection.onInboundRPC = async (method: string, params: unknown, respond: (ok: boolean, payload: unknown) => void) => {
      const handler = rpcHandlers.get(method);
      if (handler) {
        // Dispatch clawhouse.* methods to local handlers.
        // Pass connection as null so subscribe skips creating a duplicate client.
        await handler({ params, respond, connection: null });
      } else {
        // Forward Gateway built-in methods (chat.send, chat.history, sessions.list, etc.)
        try {
          const result = await api.callMethod(method, params ?? {});
          respond(true, result);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          respond(false, { code: 'RPC_ERROR', message });
        }
      }
    };

    api.logger.info(`[ClawHouse] Relay mode configured: ${relayConfig.url}`);
  }

  // ---------------------------------------------------------------------------
  // Background service
  // ---------------------------------------------------------------------------

  api.registerService({
    id: 'clawhouse-service',
    start: () => {
      api.logger.info('[ClawHouse] Background service started');
      api.logger.info(`[ClawHouse] Storage directory: ${storage.dataDirectory}`);

      const paired = storage.listPairedDevices();
      if (paired.length > 0) {
        api.logger.info(`[ClawHouse] ${paired.length} previously paired device(s) loaded`);
      }

      // Start relay connection if configured
      if (relayConnection) {
        relayConnection.start();
        api.logger.info('[ClawHouse] Relay connection started');
      }
    },
    stop: () => {
      api.logger.info('[ClawHouse] Background service stopped');

      // Stop relay connection
      if (relayConnection) {
        relayConnection.stop();
        api.logger.info('[ClawHouse] Relay connection stopped');
      }
    },
  });

  api.logger.info('[ClawHouse] Plugin loaded successfully');
}
