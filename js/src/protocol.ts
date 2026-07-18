/**
 * The request/response message protocol spoken between the main-thread
 * {@link Ferrovec} proxy and the dedicated {@link worker}. Every request carries
 * a correlation `id` that the matching response echoes back.
 */

import type { Device, QueryResult } from './types.ts';

export type RequestId = number;

export interface OpenRequest {
  id: RequestId;
  type: 'open';
  name: string;
  model?: string;
  device?: Device;
  /** Persist to OPFS when available. Defaults to `true`. */
  persist?: boolean;
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
export interface CloseRequest {
  id: RequestId;
  type: 'close';
}

export type WorkerRequest =
  | OpenRequest
  | InsertRequest
  | QueryRequest
  | RemoveRequest
  | SizeRequest
  | CloseRequest;

/** `Omit` that distributes over a union (plain `Omit` collapses to shared keys). */
export type DistributiveOmit<T, K extends keyof T> = T extends unknown ? Omit<T, K> : never;

/** A request payload without its correlation id (the proxy assigns it). */
export type WorkerRequestBody = DistributiveOmit<WorkerRequest, 'id'>;

/** Result payloads keyed by request type, for typed round-trips. */
export interface OpenResult {
  ready: true;
  /** Whether the opened index actually persists to disk (OPFS) or is in-memory. */
  persistent: boolean;
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
export interface CloseResult {
  closed: true;
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
}
export type WorkerResponse = SuccessResponse | ErrorResponse;
