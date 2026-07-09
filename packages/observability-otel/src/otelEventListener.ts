import { AsyncLocalStorage } from 'node:async_hooks';
import {
  Attributes,
  Context,
  context as otelContext,
  SpanStatusCode,
  trace,
  Tracer,
} from '@opentelemetry/api';
import {
  ATTR_CODE_FUNCTION_NAME,
  ATTR_ERROR_TYPE,
  ERROR_TYPE_VALUE_OTHER,
} from '@opentelemetry/semantic-conventions';
import type {
  DisposeContext,
  EventSpan,
  InitializeContext,
  MethodCallContext,
  ServiceEventListener,
} from '@composed-di/core';

/**
 * Reported as the instrumentation scope version of the default tracer.
 * Keep in sync with package.json.
 */
const PACKAGE_VERSION = '0.5.0-alpha';

export interface OtelEventListenerOptions {
  /**
   * The tracer used to create spans. Defaults to a tracer obtained from the
   * global provider, so registering an SDK TracerProvider (before or after
   * constructing the listener) is enough to start exporting spans.
   */
  tracer?: Tracer;

  /**
   * Record method arguments as the `composed_di.args` span attribute,
   * serialized to JSON. Off by default: arguments may be large or contain
   * secrets, and they end up wherever spans are exported.
   */
  captureArguments?: boolean;

  /**
   * Record return / resolved values as the `composed_di.result` span
   * attribute, serialized to JSON. Off by default, for the same reasons
   * as `captureArguments`. Applies to method call and initialize spans.
   */
  captureResults?: boolean;

  /**
   * Maximum length of a serialized `composed_di.args` / `composed_di.result`
   * attribute value; longer values are truncated. Default 1024.
   */
  maxCaptureLength?: number;
}

/**
 * A ServiceEventListener that records service initialization, disposal, and
 * method calls as OpenTelemetry spans.
 *
 * Span names are `<service>.<operation>` (e.g. "Database.query"). Spans carry
 * the standard `code.function.name` attribute (the fully-qualified name, per
 * the OpenTelemetry code semantic conventions) alongside the domain-specific
 * attributes `composed_di.service` and
 * `composed_di.event` ('initialize' | 'dispose' | 'call'). Failed
 * operations record the exception, set the span status to ERROR with the
 * exception message as its description, and set `error.type` as the general
 * error semantic conventions recommend.
 *
 * Nesting: spans started by this listener parent to each other across
 * sync and async boundaries (e.g. UserService.getUser -> Database.query),
 * and the outermost span parents to whatever OpenTelemetry context is
 * active when the operation starts (e.g. an incoming-request span from
 * HTTP instrumentation). Because a listener does not control the
 * invocation it observes, it cannot activate its spans in the global
 * OpenTelemetry context: spans the application creates *inside* an
 * observed method will not automatically parent to that method's span.
 */
export class OtelEventListener implements ServiceEventListener {
  /** The parent context propagated across the listener's own spans. */
  private readonly activeContext = new AsyncLocalStorage<Context>();
  private readonly tracer: Tracer;
  private readonly captureArguments: boolean;
  private readonly captureResults: boolean;
  private readonly maxCaptureLength: number;

  constructor(options: OtelEventListenerOptions = {}) {
    this.tracer =
      options.tracer ??
      trace.getTracer('@composed-di/observability-otel', PACKAGE_VERSION);
    this.captureArguments = options.captureArguments ?? false;
    this.captureResults = options.captureResults ?? false;
    this.maxCaptureLength = options.maxCaptureLength ?? 1024;
  }

  onInitialize({ key }: InitializeContext): EventSpan {
    return this.startSpan(key.name, 'initialize', 'initialize', undefined);
  }

  onDispose({ key }: DisposeContext): EventSpan {
    return this.startSpan(key.name, 'dispose', 'dispose', undefined);
  }

  onMethodCall({ key, methodName, args }: MethodCallContext): EventSpan {
    return this.startSpan(
      key.name,
      methodName,
      'call',
      this.captureArguments ? this.serialize(args) : undefined,
    );
  }

  private startSpan(
    service: string,
    functionName: string,
    event: 'initialize' | 'dispose' | 'call',
    serializedArgs: string | undefined,
  ): EventSpan {
    const attributes: Attributes = {
      [ATTR_CODE_FUNCTION_NAME]: `${service}.${functionName}`,
      'composed_di.service': service,
      'composed_di.event': event,
    };
    if (serializedArgs !== undefined) {
      attributes['composed_di.args'] = serializedArgs;
    }

    const parent = this.activeContext.getStore() ?? otelContext.active();
    const span = this.tracer.startSpan(
      `${service}.${functionName}`,
      { attributes },
      parent,
    );
    // The observed operation runs right after this hook returns, in the
    // same synchronous frame, so entering the context here makes this span
    // the parent of spans this listener starts inside the operation.
    this.activeContext.enterWith(trace.setSpan(parent, span));

    const captureResult = event !== 'dispose' && this.captureResults;
    return {
      end: (outcome) => {
        if (captureResult && outcome !== undefined) {
          span.setAttribute(
            'composed_di.result',
            this.serialize(outcome.result),
          );
        }
        span.end();
      },
      error: (error) => {
        span.recordException(error instanceof Error ? error : String(error));
        span.setAttribute(
          ATTR_ERROR_TYPE,
          error instanceof Error
            ? error.name || ERROR_TYPE_VALUE_OTHER
            : ERROR_TYPE_VALUE_OTHER,
        );
        span.setStatus({
          code: SpanStatusCode.ERROR,
          message: error instanceof Error ? error.message : String(error),
        });
        span.end();
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
    return text.length > this.maxCaptureLength
      ? `${text.slice(0, this.maxCaptureLength)}…`
      : text;
  }
}
