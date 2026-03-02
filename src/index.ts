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

  // ---------------------------------------------------------------------------
  // Gateway RPC: clawhouse.pair
  // ---------------------------------------------------------------------------

  api.registerGatewayMethod('clawhouse.pair', ({ params, respond }: any) => {
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
  });

  // ---------------------------------------------------------------------------
  // Gateway RPC: clawhouse.subscribe
  // iOS app calls this after pairing to register for event broadcasting.
  // ---------------------------------------------------------------------------

  api.registerGatewayMethod('clawhouse.subscribe', ({ params, connection, respond }: any) => {
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

    // Build the client entry — `connection.send` is provided by the Gateway
    // for writing frames back over the active WebSocket.
    const client: ConnectedClient = {
      deviceId,
      deviceName,
      connectedAt: Date.now(),
      send: (event) => {
        // Wrap the ClawHouseEvent as a Gateway event frame so Protocol 3
        // framing is preserved on the wire.
        if (connection && typeof connection.send === 'function') {
          connection.send({
            type: 'event',
            event: `clawhouse.${event.type}`,
            payload: event.payload,
            seq: event.seq,
          });
        }
      },
    };

    addClient(client);

    const response: SubscribeResponse = {
      success: true,
      currentState: getCurrentState(),
      connectedAt: client.connectedAt,
    };

    api.logger.info(`[ClawHouse] Device subscribed: ${deviceName} (${deviceId})`);
    respond(true, response);
  });

  // ---------------------------------------------------------------------------
  // Gateway RPC: clawhouse.unsubscribe
  // iOS app calls this on graceful disconnect.
  // ---------------------------------------------------------------------------

  api.registerGatewayMethod('clawhouse.unsubscribe', ({ params, respond }: any) => {
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
  });

  // ---------------------------------------------------------------------------
  // Gateway RPC: clawhouse.registerPushToken
  // iOS app calls this after connection to register/update its APNs push token.
  // ---------------------------------------------------------------------------

  api.registerGatewayMethod('clawhouse.registerPushToken', ({ params, respond }: any) => {
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
  });

  // ---------------------------------------------------------------------------
  // Gateway RPC: clawhouse.state
  // ---------------------------------------------------------------------------

  api.registerGatewayMethod('clawhouse.state', ({ respond }: any) => {
    respond(true, {
      state: getCurrentState(),
      timestamp: Date.now(),
    });
  });

  // ---------------------------------------------------------------------------
  // Gateway RPC: clawhouse.sessions
  // Proxy for sessions.list that enriches each session with channel metadata.
  // ---------------------------------------------------------------------------

  api.registerGatewayMethod('clawhouse.sessions', async ({ params, respond }: any) => {
    try {
      // Delegate to the built-in sessions.list method
      const result: unknown = await api.callMethod('sessions.list', params ?? {});

      // Enrich each session entry with channelSource info.
      // Gateway's sessions.list returns objects with `id`; use type assertion
      // because the spread of an untyped response can't be statically verified.
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
  });

  // ---------------------------------------------------------------------------
  // Gateway RPC: clawhouse.clients
  // Diagnostic endpoint — list currently connected iOS clients.
  // ---------------------------------------------------------------------------

  api.registerGatewayMethod('clawhouse.clients', ({ respond }: any) => {
    const clients = Array.from(getConnectedClients().values()).map((c) => ({
      deviceId: c.deviceId,
      deviceName: c.deviceName,
      connectedAt: c.connectedAt,
    }));

    respond(true, { clients, count: clients.length });
  });

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
    relayConnection.onInboundRPC = (method: string, params: unknown, respond: (ok: boolean, payload: unknown) => void) => {
      // Dispatch to registered Gateway methods by simulating the method call
      // The relay is transparent — same RPC methods work
      const handler = rpcHandlers.get(method);
      if (handler) {
        handler({ params, respond, connection: { send: (frame: unknown) => {
          // For subscribe, the connection.send is used to create the client's send function
          // In relay mode, the virtual client handles this
        }}});
      } else {
        respond(false, { code: 'METHOD_NOT_FOUND', message: `Unknown method: ${method}` });
      }
    };

    api.logger.info(`[ClawHouse] Relay mode configured: ${relayConfig.url}`);
  }

  // Store RPC handlers for relay dispatch
  const rpcHandlers = new Map<string, (ctx: any) => void>();

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
