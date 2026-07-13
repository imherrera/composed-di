import { AsyncLocalStorage } from 'node:async_hooks';
import { getSegment, Segment, Subsegment } from 'aws-xray-sdk-core';
import type {
  DisposeContext,
  EventSpan,
  InitializeContext,
  MethodCallContext,
  ServiceEventListener,
} from '@composed-di/core';

/** X-Ray rejects subsegment names longer than 200 characters. */
const MAX_NAME_LENGTH = 200;

export interface XrayEventListenerOptions {
  /**
   * Resolves the segment or subsegment new subsegments should attach to
   * when no composed-di operation is already active. Defaults to the SDK's
   * `getSegment()`, which reads the ambient context set by the X-Ray
   * middleware (Express, Lambda, ...). Operations observed while this
   * yields nothing (no sampled trace in flight) are not recorded.
   */
  segmentSource?: () => Segment | Subsegment | undefined;

  /**
   * Record method arguments as `composed_di.args` subsegment metadata,
   * serialized to JSON. Off by default: arguments may be large or contain
   * secrets, and they end up in the X-Ray console and API.
   */
  captureArguments?: boolean;

  /**
   * Record return / resolved values as `composed_di.result` subsegment
   * metadata, serialized to JSON. Off by default, for the same reasons as
   * `captureArguments`. Applies to method call and initialize subsegments.
   */
  captureResults?: boolean;

  /**
   * Maximum length of a serialized args / result metadata value; longer
   * values are truncated. Default 1024.
   */
  maxCaptureLength?: number;
}

/** Tracks a subsegment this listener opened, and whether it was closed. */
interface ActiveOperation {
  subsegment: Subsegment;
  closed: boolean;
}

/**
 * A ServiceEventListener that records service initialization, disposal, and
 * method calls as AWS X-Ray subsegments.
 *
 * Subsegments are named `<service>.<operation>` (e.g. "Database.query") and
 * annotated with `composed_di_service`, `composed_di_method`, and
 * `composed_di_operation` ('initialize' | 'dispose' | 'call'), so traces can
 * be filtered with expressions like
 * `annotation.composed_di_service = "Database"`. Failed operations record
 * the exception and are marked as faults.
 *
 * This listener creates no segments of its own: it attaches subsegments to
 * the trace the application already has in flight (via the X-Ray middleware
 * or a custom `segmentSource`). Operations that run outside any sampled
 * trace are silently not recorded — an observer must never break or slow
 * the service path, so every hook swallows its own failures.
 *
 * Nesting: subsegments opened by this listener parent to each other across
 * sync and async boundaries (e.g. UserService.getUser -> Database.query).
 * Because a listener does not control the invocation it observes, it cannot
 * update the SDK's own ambient segment: subsegments the application opens
 * *inside* an observed method attach to the middleware's segment, not to
 * the method's subsegment.
 */
export class XrayEventListener implements ServiceEventListener {
  /** The parent operation propagated across the listener's own subsegments. */
  private readonly activeOperation = new AsyncLocalStorage<ActiveOperation>();
  private readonly segmentSource: () => Segment | Subsegment | undefined;
  private readonly captureArguments: boolean;
  private readonly captureResults: boolean;
  private readonly maxCaptureLength: number;

  constructor(options: XrayEventListenerOptions = {}) {
    this.segmentSource = options.segmentSource ?? (() => getSegment());
    this.captureArguments = options.captureArguments ?? false;
    this.captureResults = options.captureResults ?? false;
    this.maxCaptureLength = options.maxCaptureLength ?? 1024;
  }

  onInitialize({ key }: InitializeContext): EventSpan | void {
    return this.observe(key.name, 'initialize', 'initialize', undefined);
  }

  onDispose({ key }: DisposeContext): EventSpan | void {
    return this.observe(key.name, 'dispose', 'dispose', undefined);
  }

  onMethodCall({ key, functionName, args }: MethodCallContext): EventSpan | void {
    return this.observe(
      key.name,
      functionName,
      'call',
      this.captureArguments ? this.serialize(args) : undefined,
    );
  }

  private observe(
    service: string,
    method: string,
    operation: 'initialize' | 'dispose' | 'call',
    serializedArgs: string | undefined,
  ): EventSpan | void {
    let state: ActiveOperation;
    try {
      const parent = this.resolveParent();
      if (!parent) {
        return; // No sampled trace in flight — observe nothing.
      }

      const subsegment = parent.addNewSubsegment(
        `${service}.${method}`.slice(0, MAX_NAME_LENGTH),
      );
      subsegment.addAnnotation('composed_di_service', service);
      subsegment.addAnnotation('composed_di_method', method);
      subsegment.addAnnotation('composed_di_operation', operation);
      if (serializedArgs !== undefined) {
        subsegment.addMetadata('args', serializedArgs, 'composed_di');
      }

      state = { subsegment, closed: false };
      // The observed operation runs right after this hook returns, in the
      // same synchronous frame, so entering the context here makes this
      // subsegment the parent of subsegments opened inside the operation.
      this.activeOperation.enterWith(state);
    } catch {
      return; // Instrumentation failures must never reach the application.
    }

    const captureResult = operation !== 'dispose' && this.captureResults;
    return {
      end: (outcome) => {
        try {
          if (outcome.type === 'failure') {
            const error = outcome.error;
            state.closed = true;
            state.subsegment.close(
              error instanceof Error ? error : String(error),
            );
            return;
          }
          if (captureResult) {
            state.subsegment.addMetadata(
              'result',
              this.serialize(outcome.value),
              'composed_di',
            );
          }
          state.closed = true;
          state.subsegment.close();
        } catch {
          // Swallow: see above.
        }
      },
    };
  }

  private resolveParent(): Segment | Subsegment | undefined {
    const active = this.activeOperation.getStore();
    if (active && !active.closed) {
      return active.subsegment;
    }
    try {
      return this.segmentSource() ?? undefined;
    } catch {
      // The SDK's getSegment() throws under the RUNTIME_ERROR
      // context-missing strategy when no trace is in flight.
      return undefined;
    }
  }

  private serialize(value: unknown): string {
    let text: string;
    try {
      text = JSON.stringify(value) ?? String(value);
    } catch {
      text = '[unserializable]';
    }
    return text.length > this.maxCaptureLength
      ? `${text.slice(0, this.maxCaptureLength)}…`
      : text;
  }
}
