// In-memory storage for the sync service. Production maps the same shapes onto D1/R2 (docs/sync/DEPLOYMENT.md).
import type { PushSubscriptionRecord } from './push.js';

export interface DeviceRecord {
  deviceId: string;
  signPublic: string;
  encPublic: string;
  enrolledAt: number;
  lastSeenAt: number;
  revoked: boolean;
}

export interface ObjectRecord {
  seq: number;
  objectId: string;
  epoch: number;
  schemaVersion: number;
  nonce: string;
  ciphertext: string;
  bytes: number;
  receivedAt: number;
}

export interface KeyWrapRecord {
  deviceId: string;
  epoch: number;
  fromEncPublic: string;
  signature: string; // by the sender's signing key over the wrap; recipients check it against a key they pinned
  wrapped: { ephemeralPublic: string; nonce: string; ciphertext: string };
}

export interface EnrollmentRecord {
  tokenHash: string;
  accountId: string;
  expiresAt: number;
  joined?: { signPublic: string; encPublic: string; confirm: string };
  approved?: { deviceId: string; epoch: number; fromEncPublic: string; wrapped: KeyWrapRecord['wrapped'] };
}

export interface AccountRecord {
  accountId: string;
  region: string;
  createdAt: number;
  lastActiveAt: number;
  epoch: number;
  /** sha256 of the account key for the current epoch, set by whoever bumped it. Whoever's commitment is stored won the rotation. */
  epochCommit: string | null;
  nextSeq: number;
  storageBytes: number;
  devices: Map<string, DeviceRecord>;
  objects: ObjectRecord[];
  objectIds: Map<string, number>; // objectId -> seq, makes uploads idempotent
  keyWraps: KeyWrapRecord[];
  push: Map<string, PushSubscriptionRecord>; // deviceId -> subscription (one per device)
  pushSent: Map<string, number>; // `${deviceId}|${kind}|${dedupeKey}` -> send time, for duplicate suppression
}

export interface AuditEvent {
  type:
    | 'account_created' | 'device_enrolled' | 'device_revoked' | 'device_removed' | 'objects_written' | 'account_deleted'
    | 'auth_failed' | 'rate_limited' | 'epoch_rotated' | 'retention_pruned' | 'inactive_warning'
    | 'push_subscribed' | 'push_revoked' | 'push_expired' | 'push_sent' | 'push_suppressed';
  at: number;
  accountId?: string;
  deviceId?: string;
  count?: number;
  bytesBucket?: string;
}

export class MemoryStore {
  accounts = new Map<string, AccountRecord>();
  enrollments = new Map<string, EnrollmentRecord>();
  deleted = new Map<string, number>(); // opaque account id -> deletion time (tombstone, 35 days)
  audit: AuditEvent[] = [];
}
