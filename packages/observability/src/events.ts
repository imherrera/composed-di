/**
 * Event and state types shared between the dashboard event listener, the
 * dashboard server, and the browser client (over the SSE wire).
 */

/** Classifies what a span represents in the service lifecycle. */
export type SpanKind = 'initialize' | 'dispose' | 'call';

/** Emitted when a traced function starts executing. */
export interface SpanStart {
  type: 'start';
  /** Monotonically increasing span id, unique per tracer. */
  id: number;
  /** Id of the span that was active when this one started, if any. */
  parentId: number | null;
  /** The qualified span name, e.g. "Database.query". */
  name: string;
  /** The service the span belongs to, or null if it could not be attributed. */
  service: string | null;
  /** The method or lifecycle step, e.g. "query" or "initialize". */
  method: string;
  kind: SpanKind;
  /** Epoch milliseconds. */
  time: number;
}

/** Emitted when a traced function finishes (or throws/rejects). */
export interface SpanEnd {
  type: 'end';
  /** Matches the id of the corresponding SpanStart. */
  id: number;
  /** Epoch milliseconds. */
  time: number;
  durationMs: number;
  /** The error message when the traced function threw or rejected. */
  error: string | null;
}

export type SpanEvent = SpanStart | SpanEnd;

export type ServiceStatus =
  | 'pending'
  | 'initializing'
  | 'ready'
  | 'error'
  | 'disposed';

/** Aggregated per-service counters maintained by the dashboard. */
export interface ServiceStats {
  status: ServiceStatus;
  /** Duration of the last successful initialization, if any. */
  initMs: number | null;
  /** Number of completed method-call spans. */
  calls: number;
  /** Number of spans (of any kind) that ended with an error. */
  errors: number;
  /** Sum of completed method-call durations, for averaging. */
  totalCallMs: number;
}

export interface GraphNode {
  name: string;
}

/** A dependency edge: `from` depends on `to`. */
export interface GraphEdge {
  from: string;
  to: string;
}

/**
 * The enriched event broadcast to dashboard clients. The server resolves
 * cross-span context (parent service, span metadata on end events) and the
 * updated per-service stats so the client needs no correlation logic.
 */
export interface WireEvent {
  span: SpanEvent;
  /** Service of the span; on end events resolved from the matching start. */
  service: string | null;
  method: string;
  kind: SpanKind;
  /** Service of the parent span, when the span was started by another service. */
  parentService: string | null;
  /** Updated stats for `service`, present when the event changed them. */
  stats: ServiceStats | null;
}

/** Full state sent to a client when it connects. */
export interface DashboardSnapshot {
  nodes: GraphNode[];
  edges: GraphEdge[];
  services: Record<string, ServiceStats>;
  recent: WireEvent[];
}
