import { AsyncLocalStorage } from 'node:async_hooks';
import { performance } from 'node:perf_hooks';
import type {
  DisposeContext,
  EventSpan,
  InitializeContext,
  MethodCallContext,
  ServiceInstrumentation,
} from '@composed-di/instrumentation-core';
import { SpanEvent, SpanKind } from './events';

/** The span context propagated across sync and async call boundaries. */
interface SpanContext {
  id: number;
}

export interface DashboardInstrumentationOptions {
  /**
   * Serialize method arguments onto call spans, so the dashboard can show
   * them. On by default — the dashboard is a development tool — but turn
   * this off when arguments may contain secrets, or when events are
   * exported to a dashboard server you don't control.
   */
  captureArguments?: boolean;

  /**
   * Serialize return / resolved values onto call spans. On by default,
   * with the same caveats as `captureArguments`.
   */
  captureResults?: boolean;

  /** Longest serialized value kept; longer ones are truncated. Default 200. */
  maxValueLength?: number;
}

/**
 * A ServiceInstrumentation that turns service events into structured
 * start/end span events for the realtime dashboard.
 *
 * - Uses AsyncLocalStorage to link spans to the span that was active when
 *   they started, which lets the dashboard draw cross-service call edges
 *   (e.g. UserService.getUser -> Database.query). The observed operation
 *   is invoked through the span's `run` wrapper, so the context is scoped
 *   to the operation and its async continuations.
 * - Emits events synchronously to subscribers; it never buffers.
 */
export class DashboardInstrumentation implements ServiceInstrumentation {
  private readonly context = new AsyncLocalStorage<SpanContext>();
  private readonly listeners = new Set<(event: SpanEvent) => void>();
  private nextId = 1;
  private readonly captureArguments: boolean;
  private readonly captureResults: boolean;
  private readonly maxValueLength: number;

  constructor({
    captureArguments = true,
    captureResults = true,
    maxValueLength = 200,
  }: DashboardInstrumentationOptions = {}) {
    this.captureArguments = captureArguments;
    this.captureResults = captureResults;
    this.maxValueLength = maxValueLength;
  }

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

  onMethodCall({ key, functionName, args }: MethodCallContext): EventSpan {
    return this.startSpan(
      key.name,
      functionName,
      'call',
      this.captureArguments ? this.serialize(args) : undefined,
    );
  }

  private startSpan(
    service: string,
    method: string,
    kind: SpanKind,
    args?: string,
  ): EventSpan {
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
      args,
    });

    const startedAt = performance.now();
    let ended = false;
    const end = (error: string | null, result?: string) => {
      if (ended) return;
      ended = true;
      this.emit({
        type: 'end',
        id,
        time: Date.now(),
        durationMs: performance.now() - startedAt,
        error,
        result,
      });
    };

    return {
      // Running the operation inside this span's context makes it the
      // parent of any spans started within.
      run: (fn) => this.context.run({ id }, fn),
      end: (outcome) => {
        if (outcome.type === 'failure') {
          end(errorMessage(outcome.error));
        } else {
          const capture = kind === 'call' && this.captureResults;
          end(null, capture ? this.serialize(outcome.value) : undefined);
        }
      },
    };
  }

  private serialize(value: unknown): string {
    let text: string;
    try {
      text = JSON.stringify(value) ?? String(value);
    } catch {
      text = '[unserializable]';
    }
    return text.length > this.maxValueLength
      ? text.slice(0, this.maxValueLength) + '…'
      : text;
  }

  private emit(event: SpanEvent): void {
    this.listeners.forEach((listener) => listener(event));
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
