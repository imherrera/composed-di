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
import {
  DisposeContext,
  EventOutcome,
  EventSpan,
  InitializeContext,
  MethodCallContext,
  ServiceEventListener,
  ServiceKey,
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
   * Record method arguments as the `composed_di.service.function.arguments`
   * span attribute, serialized to JSON. Off by default: arguments may be
   * large or contain secrets, and they end up wherever spans are exported.
   */
  captureArguments?: boolean;

  /**
   * Record return / resolved values as the
   * `composed_di.service.function.result` span attribute, serialized to
   * JSON. Off by default, for the same reasons as `captureArguments`.
   * Applies to method call and initialize spans.
   */
  captureResults?: boolean;

  /**
   * Maximum length of a serialized `composed_di.service.function.arguments`
   * / `composed_di.service.function.result` attribute value; longer values
   * are truncated. Default 1024.
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
 * attributes `composed_di.service.key` and
 * `composed_di.service.event` ('initialize' | 'dispose' | 'call'). When the service
 * is implemented by a named class, `code.function.name` is qualified with
 * the class name (e.g. "PostgresDatabase.query") since it identifies the
 * actual code; span names and `composed_di.service.key` always use the
 * ServiceKey name, which is what the module resolves and queries group by. Failed
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

  onInitialize(context: InitializeContext): EventSpan {
    const attributes = this.buildAttributes({
      key: context.key,
      event: 'call',
      className: 'ServiceFactory',
      functionName: 'initialize',
    });
    const spanName = `ServiceFactory[${context.key.name}].initialize`;
    return this.buildSpan(spanName, attributes);
  }

  onDispose(context: DisposeContext): EventSpan {
    const attributes = this.buildAttributes({
      key: context.key,
      event: 'dispose',
      className: 'ServiceFactory',
      functionName: 'dispose',
    });
    const spanName = `ServiceFactory[${context.key.name}].dispose`;
    return this.buildSpan(spanName, attributes);
  }

  onMethodCall(context: MethodCallContext): EventSpan {
    const attributes = this.buildAttributes({
      key: context.key,
      event: 'call',
      className: context.className,
      functionName: context.functionName,
      args: context.args,
    });
    const spanName = attributes[ATTR_CODE_FUNCTION_NAME];
    return this.buildSpan(spanName, attributes);
  }

  private buildSpan(spanName: string, attributes: Attributes): EventSpan {
    const context = this.activeContext.getStore() ?? otelContext.active();
    const span = this.tracer.startSpan(spanName, { attributes }, context);

    return {
      end: (outcome?: EventOutcome) => {
        if (this.captureResults && outcome !== undefined) {
          span.setAttribute(
            'composed_di.service.function.result',
            serialize(outcome.result),
          );
        }
        span.end();
      },
      error: (error: unknown) => {
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

  private buildAttributes(params: {
    key: ServiceKey<unknown>;
    event: 'initialize' | 'dispose' | 'call';
    className?: string;
    functionName: string;
    args?: readonly unknown[];
  }) {
    const attributes: { [key: string]: string } = {
      [ATTR_CODE_FUNCTION_NAME]: `${params.className ?? params.key.name}.${params.functionName}`,
      'composed_di.service.key': params.key.name,
      'composed_di.service.event': params.event,
    };

    if (params.args && this.captureArguments) {
      attributes['composed_di.service.function.arguments'] = serialize(
        params.args,
      );
    }

    return attributes;
  }
}

function serialize(value: unknown): string {
  let text: string;
  try {
    text = JSON.stringify(value) ?? String(value);
  } catch {
    text = '[unserializable]';
  }
  return text;
}
