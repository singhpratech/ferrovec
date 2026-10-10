/**
 * The request/response message protocol spoken between the main-thread
 * {@link Ferrovec} proxy and the dedicated {@link worker}. Every request carries
 * a correlation `id` that the matching response echoes back.
 */

import type { Role } from './coordinator.ts';
import type { Device, Durability, QueryResult } from './types.ts';

export type RequestId = number;

export interface OpenRequest {
  id: RequestId;
  type: 'open';
  name: string;
  model?: string;
  device?: Device;
  /** Persist to OPFS when available. Defaults to `true`. */
  persist?: boolean;
  /**
   * `'strict'` (default): every insert/remove is flushed to OPFS before its
   * response is sent. `'relaxed'`: acknowledged up to 50 ms before the flush.
   */
  durability?: Durability;
}
export interface InsertRequest {
  id: RequestId;
  type: 'insert';
  text: string;
  docId?: string;
}
export interface QueryRequest {
  id: RequestId;
  type: 'query';
  text: string;
  k: number;
}
export interface RemoveRequest {
  id: RequestId;
  type: 'remove';
  docId: string;
}
export interface SizeRequest {
  id: RequestId;
  type: 'size';
}
/**
 * Force unflushed write-ahead log records to disk and write a checkpoint (sent
 * by `Ferrovec.flush`; on a follower, routed to the leader).
 */
export interface FlushRequest {
  id: RequestId;
  type: 'flush';
}
export interface RoleRequest {
  id: RequestId;
  type: 'role';
}
export interface CloseRequest {
  id: RequestId;
  type: 'close';
}
/**
 * Delete store `name`'s OPFS directory. Only legal in a worker with no open
 * store (sent by `Ferrovec.destroy` to a throwaway worker).
 */
export interface DestroyRequest {
  id: RequestId;
  type: 'destroy';
  name: string;
}

export type WorkerRequest =
  | OpenRequest
  | InsertRequest
  | QueryRequest
  | RemoveRequest
  | SizeRequest
  | FlushRequest
  | RoleRequest
  | CloseRequest
  | DestroyRequest;

/** `Omit` that distributes over a union (plain `Omit` collapses to shared keys). */
export type DistributiveOmit<T, K extends keyof T> = T extends unknown ? Omit<T, K> : never;

/** A request payload without its correlation id (the proxy assigns it). */
export type WorkerRequestBody = DistributiveOmit<WorkerRequest, 'id'>;

/** Result payloads keyed by request type, for typed round-trips. */
export interface OpenResult {
  ready: true;
  /** Whether the opened index actually persists to disk (OPFS) or is in-memory. */
  persistent: boolean;
  /** Coordination role this session resolved to: leader, follower, or solo. */
  role: Role;
  // `storagePersisted` is deliberately NOT part of this payload: the
  // `navigator.storage.persist()` request is Window-only, so the main-thread
  // proxy makes it itself and exposes the answer as `Ferrovec.storagePersisted`.
}
export interface InsertResult {
  id: string;
}
export type QueryResultPayload = QueryResult[];
export interface RemoveResult {
  removed: boolean;
}
export interface SizeResult {
  size: number;
}
export interface FlushResult {
  flushed: true;
}
export interface RoleResult {
  role: Role;
}
export interface CloseResult {
  closed: true;
}
export interface DestroyResult {
  destroyed: true;
}

export interface SuccessResponse {
  id: RequestId;
  ok: true;
  result: unknown;
}
export interface ErrorResponse {
  id: RequestId;
  ok: false;
  error: string;
  /**
   * The thrown error's `name` (e.g. `'EmbeddingSpaceMismatchError'`), so the
   * main thread can rethrow an `Error` callers can `switch (err.name)` on —
   * class identity does not survive `postMessage`.
   */
  errorName?: string;
}
export type WorkerResponse = SuccessResponse | ErrorResponse;

/**
 * An unsolicited push from the worker (no correlation id) — currently only the
 * role-change notification the main-thread proxy uses to keep `db.role` live
 * across a failover promotion.
 */
export interface RoleChangeEvent {
  type: 'event';
  event: 'role';
  role: Role;
}

/** Everything the worker may post back: request responses plus pushed events. */
export type WorkerOutbound = WorkerResponse | RoleChangeEvent;
