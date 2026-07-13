import {
  getNamespace,
  getSegment,
  isAutomaticMode,
  Segment,
  setSegment,
  Subsegment,
} from 'aws-xray-sdk-core';
import {
  DisposeContext,
  EventOutcome,
  EventSpan,
  InitializeContext,
  MethodCallContext,
  ServiceModuleListener,
  ServiceKey,
} from '@composed-di/core';

/** X-Ray rejects subsegment names longer than 200 characters. */
const MAX_NAME_LENGTH = 200;

export interface XrayEventListenerOptions {
  /**
   * Fallback that resolves the segment or subsegment new subsegments
   * should attach to when the SDK has no ambient segment — e.g. in manual
   * mode, or in automatic mode without the X-Ray middleware. The ambient
   * segment (the SDK's `getSegment()`) is always consulted first.
   * Operations observed while neither yields a segment (no sampled trace
   * in flight) are not recorded.
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
 * Nesting: each observed operation runs with its subsegment as the SDK's
 * ambient segment (via the SDK's own CLS namespace), so subsegments of
 * nested service calls nest under each other, and so do subsegments the
 * application opens *inside* an observed method (captured AWS SDK clients,
 * `captureAsyncFunc`, ...). In manual mode there is no ambient context, so
 * all subsegments attach flat to the `segmentSource` segment.
 */
export class XrayEventListener implements ServiceModuleListener {
  private readonly segmentSource?: () => Segment | Subsegment | undefined;
  private readonly captureArguments: boolean;
  private readonly captureResults: boolean;
  private readonly maxCaptureLength: number;

  constructor(options: XrayEventListenerOptions = {}) {
    this.segmentSource = options.segmentSource;
    this.captureArguments = options.captureArguments ?? false;
    this.captureResults = options.captureResults ?? false;
    this.maxCaptureLength = options.maxCaptureLength ?? 1024;
  }

  onInitialize(context: InitializeContext): EventSpan | void {
    const annotations = this.buildAnnotations({
      key: context.key,
      event: 'initialize',
      functionName: 'initialize',
    });
    const spanName = `${context.key.name}.initialize`;
    return this.buildSpan(spanName, annotations, undefined, this.captureResults);
  }

  onDispose(context: DisposeContext): EventSpan | void {
    const annotations = this.buildAnnotations({
      key: context.key,
      event: 'dispose',
      functionName: 'dispose',
    });
    const spanName = `${context.key.name}.dispose`;
    return this.buildSpan(spanName, annotations, undefined, false);
  }

  onMethodCall(context: MethodCallContext): EventSpan | void {
    const annotations = this.buildAnnotations({
      key: context.key,
      event: 'call',
      functionName: context.functionName,
    });
    const spanName = `${context.key.name}.${context.functionName}`;
    const serializedArgs = this.captureArguments
      ? serialize(context.args, this.maxCaptureLength)
      : undefined;
    return this.buildSpan(
      spanName,
      annotations,
      serializedArgs,
      this.captureResults,
    );
  }

  private buildSpan(
    spanName: string,
    annotations: { [key: string]: string },
    serializedArgs: string | undefined,
    captureResult: boolean,
  ): EventSpan | void {
    let subsegment: Subsegment;
    try {
      const parent = this.resolveParent();
      if (!parent) {
        return; // No sampled trace in flight — observe nothing.
      }

      subsegment = parent.addNewSubsegment(spanName.slice(0, MAX_NAME_LENGTH));
      for (const [name, value] of Object.entries(annotations)) {
        subsegment.addAnnotation(name, value);
      }
      if (serializedArgs !== undefined) {
        subsegment.addMetadata('args', serializedArgs, 'composed_di');
      }
    } catch {
      return; // Instrumentation failures must never reach the application.
    }

    return {
      run: (fn) => runWithAmbientSegment(subsegment, fn),
      end: (outcome: EventOutcome) => {
        try {
          if (outcome.type === 'failure') {
            const error = outcome.error;
            subsegment.close(error instanceof Error ? error : String(error));
            return;
          }
          if (captureResult) {
            subsegment.addMetadata(
              'result',
              serialize(outcome.value, this.maxCaptureLength),
              'composed_di',
            );
          }
          subsegment.close();
        } catch {
          // Swallow: see above.
        }
      },
    };
  }

  private buildAnnotations(params: {
    key: ServiceKey<unknown>;
    event: 'initialize' | 'dispose' | 'call';
    functionName: string;
  }) {
    const annotations: { [key: string]: string } = {
      composed_di_service: params.key.name,
      composed_di_method: params.functionName,
      composed_di_operation: params.event,
    };

    return annotations;
  }

  private resolveParent(): Segment | Subsegment | undefined {
    // Inside an observed operation the ambient segment is that operation's
    // subsegment (established by `run`), so nesting needs no bookkeeping.
    if (isAutomaticMode()) {
      try {
        const ambient = getSegment();
        if (ambient) {
          return ambient;
        }
      } catch {
        // getSegment() throws under the RUNTIME_ERROR context-missing
        // strategy when no trace is in flight.
      }
    }
    try {
      return this.segmentSource?.() ?? undefined;
    } catch {
      return undefined;
    }
  }
}

/**
 * Runs the operation with the given subsegment as the SDK's ambient
 * segment, inside a fresh CLS context that the operation body and its
 * async continuations inherit. In manual mode (no ambient context), or if
 * the SDK context is unavailable, the operation runs unwrapped — it must
 * be invoked exactly once either way.
 */
function runWithAmbientSegment<T>(subsegment: Subsegment, fn: () => T): T {
  let namespace: ReturnType<typeof getNamespace> | undefined;
  try {
    namespace = isAutomaticMode() ? getNamespace() : undefined;
  } catch {
    namespace = undefined;
  }
  if (!namespace) {
    return fn();
  }
  return namespace.runAndReturn(() => {
    try {
      setSegment(subsegment);
    } catch {
      // Instrumentation failures must never reach the application.
    }
    return fn();
  });
}

function serialize(value: unknown, maxLength: number): string {
  let text: string;
  try {
    text = JSON.stringify(value) ?? String(value);
  } catch {
    text = '[unserializable]';
  }
  return text.length > maxLength ? `${text.slice(0, maxLength)}…` : text;
}
