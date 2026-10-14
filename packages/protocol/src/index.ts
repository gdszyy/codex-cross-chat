/**
 * Shared protocol types and constants for the Codex cross-device relay.
 * Authority: docs/mechanism-design.md v1.1 (§2 roster fields, §5 message
 * semantics, §5.2 three-layer status, §7.2 runtime parameters, §9 endpoints).
 */

/** Service tiers (§0.5). */
export type Tier = 't1_managed' | 't2_desktop';
export type DeliveryMode = 'push' | 'manual_pull';
export type RosterStatus = 'active' | 'paused' | 'revoked';
export type Role = 'manager' | 'worker' | 'verifier' | 'observer';

export type MessageType = 'TASK' | 'QUERY' | 'CLARIFY' | 'CANCEL';

/** §5.2 three-layer status. */
export type DeliveryStatus =
  | 'queued'
  | 'device_received'
  | 'expired'
  | 'rejected';
export type ExecStatus =
  | 'pending'
  | 'running'
  | 'waiting_user'
  | 'completed'
  | 'failed'
  | 'interrupted'
  | 'result_pending_verify';
export type ReturnStatus =
  | 'local_saved'
  | 'cloud_saved'
  | 'delivered'
  | 'origin_processed';

export type ResultKind = 'RESULT' | 'STATUS';

/** §7.2 runtime parameters — database config items with defaults, NOT env vars. */
export interface RuntimeConfig {
  /** §5.4 chain depth limit; default 3. */
  chain_limit: number;
  /** §3.2 join code default TTL in hours. */
  join_code_ttl_hours: number;
  /** §6 body retention (days). */
  retention_body_days: number;
  /** §6 metadata retention (days). */
  retention_meta_days: number;
  /** §7.2 heartbeat interval (seconds). */
  heartbeat_interval_s: number;
  /** §7.2 offline threshold (seconds). */
  offline_after_s: number;
  /** §7.2 reconnect backoff ceiling (seconds). */
  reconnect_max_backoff_s: number;
  /** §7.2 unstarted request expiry (hours). */
  unstarted_expire_hours: number;
  /** §6 body size cap (bytes) = 64 KB. */
  body_max_bytes: number;
}

export const DEFAULT_CONFIG: RuntimeConfig = {
  chain_limit: 3,
  join_code_ttl_hours: 24,
  retention_body_days: 7,
  retention_meta_days: 30,
  heartbeat_interval_s: 30,
  offline_after_s: 90,
  reconnect_max_backoff_s: 60,
  unstarted_expire_hours: 24,
  body_max_bytes: 64 * 1024,
};

export const ROLE_VALUES: readonly Role[] = [
  'manager',
  'worker',
  'verifier',
  'observer',
];

export const MESSAGE_TYPES: readonly MessageType[] = [
  'TASK',
  'QUERY',
  'CLARIFY',
  'CANCEL',
];

export interface RosterRow {
  conv_id: string;
  device_id: string;
  profile: string;
  thread_id: string;
  alias: string;
  role: Role;
  task: string;
  task_ref: string | null;
  project: string;
  owner_label: string;
  allow_sources: string[];
  registered_via: string;
  roster_status: RosterStatus;
  tier: Tier;
  delivery_mode: DeliveryMode;
  registered_at: number;
  last_seen_at: number | null;
  last_pull_at: number | null;
}

export interface DeviceRow {
  device_id: string;
  device_token: string;
  owner_label: string;
  created_at: number;
  revoked_at: number | null;
  last_seen_at: number | null;
}

export interface RequestRow {
  request_id: string;
  root_request_id: string;
  parent_request_id: string | null;
  chain_depth: number;
  from_conv: string;
  to_conv: string;
  type: MessageType;
  body: string;
  context: string | null;
  result_requirement: string | null;
  ttl_s: number;
  size_bytes: number;
  delivery_status: DeliveryStatus;
  exec_status: ExecStatus;
  return_status: ReturnStatus | null;
  return_addr: string;
  turn_id: string | null;
  error: string | null;
  result_missing: boolean;
  created_at: number;
  claimed_at: number | null;
  started_at: number | null;
  /** Relay grants execution before the Bridge invokes a model; not a model turn id. */
  start_authorized_at?: number | null;
  completed_at: number | null;
  delivered_at: number | null;
  returned_at: number | null;
  expires_at: number;
}

export interface ResultRow {
  result_id: string;
  request_id: string;
  kind: ResultKind;
  body: string;
  evidence: string | null;
  exec_status: ExecStatus | null;
  is_first: boolean;
  created_at: number;
}

export interface MessageEnvelope<T> {
  ok: boolean;
  data?: T;
  error?: { code: string; message: string };
}

/** WS event pushed server -> device. */
export interface WsEvent {
  event: 'request.available' | 'result.available' | 'revoked';
  id: number;
  payload: Record<string, unknown>;
}
