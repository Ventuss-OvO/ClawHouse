import type { ConnectedClient, ClawHouseEvent, RequestFrame, ResponseFrame, EventFrame } from './types.js';

export interface RelayConfig {
  url: string;   // wss://relay.clawhouse.dev/gateway/connect
  token: string; // relay_token from device registration
}

interface PendingRequest {
  resolve: (payload: unknown) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

const WS_OPEN = 1; // WebSocket.OPEN

/**
 * RelayConnection manages an outbound WebSocket to the relay service.
 * It creates a virtual client that the channel system treats identically
 * to a direct WebSocket connection from the iOS app.
 *
 * Uses the native Node.js WebSocket API (Node 22+).
 */
export class RelayConnection {
  private ws: WebSocket | null = null;
  private config: RelayConfig;
  private logger: { info: (...args: unknown[]) => void; warn: (...args: unknown[]) => void; debug: (...args: unknown[]) => void };
  private reconnectAttempt = 0;
  private maxReconnectAttempts = 10;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  private pendingRequests = new Map<string, PendingRequest>();

  // Callbacks set by the plugin
  onVirtualClientReady: ((client: ConnectedClient) => void) | null = null;
  onVirtualClientGone: ((deviceId: string) => void) | null = null;
  onInboundRPC: ((method: string, params: unknown, respond: (ok: boolean, payload: unknown) => void) => void) | null = null;

  constructor(config: RelayConfig, logger: any) {
    this.config = config;
    this.logger = logger;
  }

  start(): void {
    this.stopped = false;
    this.reconnectAttempt = 0;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    // Reject all pending requests
    for (const [id, pending] of this.pendingRequests) {
      clearTimeout(pending.timer);
      pending.reject(new Error('Relay connection stopped'));
      this.pendingRequests.delete(id);
    }
    if (this.ws) {
      this.ws.close(1000, 'Plugin shutting down');
      this.ws = null;
    }
  }

  private connect(): void {
    if (this.stopped) return;

    const url = `${this.config.url}?token=${encodeURIComponent(this.config.token)}`;
    this.logger.info(`[ClawHouse/Relay] Connecting to relay...`);

    try {
      this.ws = new WebSocket(url);
    } catch (err) {
      this.logger.warn(`[ClawHouse/Relay] Failed to create WebSocket: ${err}`);
      this.scheduleReconnect();
      return;
    }

    this.ws.addEventListener('open', () => {
      this.logger.info('[ClawHouse/Relay] Connected to relay');
      this.reconnectAttempt = 0;

      // Create virtual client
      if (this.onVirtualClientReady) {
        const client = this.createVirtualClient();
        this.onVirtualClientReady(client);
      }
    });

    this.ws.addEventListener('message', (event: MessageEvent) => {
      const raw = typeof event.data === 'string' ? event.data : String(event.data);
      this.handleMessage(raw);
    });

    this.ws.addEventListener('close', (event: CloseEvent) => {
      this.logger.info(`[ClawHouse/Relay] Disconnected: ${event.code} ${event.reason}`);
      this.ws = null;

      if (this.onVirtualClientGone) {
        this.onVirtualClientGone('relay-client');
      }

      if (!this.stopped) {
        this.scheduleReconnect();
      }
    });

    this.ws.addEventListener('error', () => {
      this.logger.warn(`[ClawHouse/Relay] WebSocket error`);
      // 'close' event will follow
    });
  }

  private handleMessage(raw: string): void {
    let frame: RequestFrame | ResponseFrame | EventFrame;
    try {
      frame = JSON.parse(raw);
    } catch {
      this.logger.warn(`[ClawHouse/Relay] Invalid JSON from relay: ${raw.slice(0, 100)}`);
      return;
    }

    // Handle relay-specific events
    if ('type' in frame && frame.type === 'event') {
      const eventFrame = frame as EventFrame;
      if (eventFrame.event === 'relay.peer_connected' || eventFrame.event === 'relay.peer_disconnected') {
        this.logger.info(`[ClawHouse/Relay] ${eventFrame.event}`);
        return;
      }
    }

    // Handle RPC request from iOS app (via relay)
    if ('type' in frame && frame.type === 'req') {
      const reqFrame = frame as RequestFrame;
      this.logger.debug(`[ClawHouse/Relay] Inbound RPC: ${reqFrame.method} id=${reqFrame.id}`);

      if (this.onInboundRPC) {
        this.onInboundRPC(reqFrame.method, reqFrame.params, (ok, payload) => {
          this.sendFrame({
            type: 'res',
            id: reqFrame.id,
            ok,
            ...(ok ? { payload } : { error: payload as any }),
          } as ResponseFrame);
        });
      }
      return;
    }

    // Handle response to our requests
    if ('type' in frame && frame.type === 'res') {
      const resFrame = frame as ResponseFrame;
      const pending = this.pendingRequests.get(resFrame.id);
      if (pending) {
        clearTimeout(pending.timer);
        this.pendingRequests.delete(resFrame.id);
        if (resFrame.ok) {
          pending.resolve(resFrame.payload);
        } else {
          pending.reject(new Error(resFrame.error?.message ?? 'RPC failed'));
        }
      }
      return;
    }
  }

  private createVirtualClient(): ConnectedClient {
    return {
      deviceId: 'relay-client',
      deviceName: 'Relay',
      connectedAt: Date.now(),
      send: (event: ClawHouseEvent) => {
        // Wrap as Gateway event frame (same as direct WebSocket)
        this.sendFrame({
          type: 'event',
          event: `clawhouse.${event.type}`,
          payload: event.payload,
          seq: event.seq,
        } as EventFrame);
      },
    };
  }

  private sendFrame(frame: ResponseFrame | EventFrame): void {
    if (this.ws && this.ws.readyState === WS_OPEN) {
      this.ws.send(JSON.stringify(frame));
    }
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectAttempt >= this.maxReconnectAttempts) {
      if (this.reconnectAttempt >= this.maxReconnectAttempts) {
        this.logger.warn('[ClawHouse/Relay] Max reconnect attempts reached');
      }
      return;
    }

    // Exponential backoff: 1s, 2s, 4s, 8s, ... capped at 60s
    const base = Math.min(1000 * Math.pow(2, this.reconnectAttempt), 60000);
    const jitter = Math.random() * 1000;
    const delay = base + jitter;

    this.reconnectAttempt++;
    this.logger.info(`[ClawHouse/Relay] Reconnecting in ${Math.round(delay)}ms (attempt ${this.reconnectAttempt}/${this.maxReconnectAttempts})`);

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  get isConnected(): boolean {
    return this.ws !== null && this.ws.readyState === WS_OPEN;
  }
}
