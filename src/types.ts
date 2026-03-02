// Gateway Protocol 3 frame types
export interface RequestFrame {
  type: 'req';
  id: string;
  method: string;
  params?: unknown;
}

export interface ResponseFrame {
  type: 'res';
  id: string;
  ok: boolean;
  payload?: unknown;
  error?: { code: string; message: string };
}

export interface EventFrame {
  type: 'event';
  event: string;
  payload?: unknown;
  seq?: number;
  stateVersion?: number;
}

// ClawHouse-specific types
export type ClawState = 'idle' | 'working' | 'out' | 'returning' | 'chatting' | 'resting' | 'sleeping';

export interface ClawStateEvent {
  state: ClawState;
  detail?: string;        // e.g., tool name when "out"
  timestamp: number;
  previousState?: ClawState;
}

export interface PairingRequest {
  token: string;
  deviceId: string;
  deviceName: string;
  platform: 'ios';
  appVersion: string;
}

export interface PairingResponse {
  success: boolean;
  gatewayUrl?: string;
  agentId?: string;
  error?: string;
}

export interface ClawHouseEvent {
  type: 'state_change' | 'message' | 'tool_call' | 'tool_result' | 'heartbeat' | 'session_update';
  payload: unknown;
  timestamp: number;
  seq: number;
}

// Channel message types
export interface OutboundMessage {
  text: string;
  sessionKey: string;
  metadata?: Record<string, unknown>;
}

export interface InboundMessage {
  text: string;
  senderId: string;
  senderName: string;
  channel: string;
  sessionKey: string;
  timestamp: number;
}

// Connected client — represents an active WebSocket connection from an iOS device
export interface ConnectedClient {
  deviceId: string;
  deviceName: string;
  connectedAt: number;
  /** Send a ClawHouseEvent to this client over the WebSocket */
  send: (event: ClawHouseEvent) => void;
}

// Subscribe / Unsubscribe RPC params and response
export interface SubscribeParams {
  deviceId: string;
  deviceName: string;
}

export interface SubscribeResponse {
  success: boolean;
  currentState: ClawState;
  connectedAt: number;
}

export interface UnsubscribeParams {
  deviceId: string;
}

export interface UnsubscribeResponse {
  success: boolean;
}

// Persistent record of a paired device (written to disk)
export interface PairedDevice {
  deviceId: string;
  deviceName: string;
  platform: 'ios';
  appVersion: string;
  pairedAt: number;
  lastSeenAt: number;
  pushToken?: string;
  pushBundleId?: string;
  pushEnvironment?: 'development' | 'production';
}

// APNs push types
export interface PushPayload {
  title: string;
  body: string;
  data?: Record<string, unknown>;
}

export interface APNsConfig {
  keyId: string;
  teamId: string;
  keyPath: string;
}

// Relay configuration
export interface RelayConfig {
  url: string;   // wss://relay.clawhouse.dev/gateway/connect
  token: string; // relay_token from device registration
}

// Sessions proxy types
export interface SessionInfo {
  id: string;
  label?: string;
  createdAt?: number;
  /** Added by ClawHouse — the originating channel */
  channelSource: 'clawhouse';
  [key: string]: unknown;
}
