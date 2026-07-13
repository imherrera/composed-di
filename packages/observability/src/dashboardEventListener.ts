import { AsyncLocalStorage } from 'node:async_hooks';
import { performance } from 'node:perf_hooks';
import type {
  DisposeContext,
  EventSpan,
  InitializeContext,
  MethodCallContext,
  ServiceEventListener,
} from '@composed-di/core';
import { SpanEvent, SpanKind } from './events';

/** The span context propagated across sync and async call boundaries. */
interface SpanContext {
  id: number;
}

/**
 * A ServiceEventListener that turns service events into structured
 * start/end span events for the realtime dashboard.
 *
 * - Uses AsyncLocalStorage to link spans to the span that was active when
 *   they started, which lets the dashboard draw cross-service call edges
 *   (e.g. UserService.getUser -> Database.query). Because a listener does
 *   not control the invocation of the operation it observes, the context
 *   is entered with `enterWith` and can outlive the span within the same
 *   synchronous frame; the dashboard tolerates this, as parents are only
 *   resolved among still-open spans.
 * - Emits events synchronously to subscribers; it never buffers.
 */
export class DashboardEventListener implements ServiceEventListener {
  private readonly context = new AsyncLocalStorage<SpanContext>();
  private readonly listeners = new Set<(event: SpanEvent) => void>();
  private nextId = 1;

  /**
   * Subscribes to span events.
   *
   * @returns A function that removes the subscription.
   */
  subscribe(listener: (event: SpanEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  onInitialize({ key }: InitializeContext): EventSpan {
    return this.startSpan(key.name, 'initialize', 'initialize');
  }

  onDispose({ key }: DisposeContext): EventSpan {
    return this.startSpan(key.name, 'dispose', 'dispose');
  }

  onMethodCall({ key, functionName }: MethodCallContext): EventSpan {
    return this.startSpan(key.name, functionName, 'call');
  }

  private startSpan(service: string, method: string, kind: SpanKind): EventSpan {
    const id = this.nextId++;
    const parent = this.context.getStore();

    this.emit({
      type: 'start',
      id,
      parentId: parent?.id ?? null,
      name: `${service}.${method}`,
      service,
      method,
      kind,
      time: Date.now(),
    });

    const startedAt = performance.now();
    let ended = false;
    const end = (error: string | null) => {
      if (ended) return;
      ended = true;
      this.emit({
        type: 'end',
        id,
        time: Date.now(),
        durationMs: performance.now() - startedAt,
        error,
      });
    };

    // The observed operation runs right after this hook returns, in the
    // same synchronous frame, so entering the context here makes this span
    // the parent of any spans started inside the operation.
    this.context.enterWith({ id });

    return {
      end: () => end(null),
      error: (error) => end(errorMessage(error)),
    };
  }

  private emit(event: SpanEvent): void {
    this.listeners.forEach((listener) => listener(event));
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
