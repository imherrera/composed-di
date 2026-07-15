import {
  Attributes,
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
  ServiceInstrumentation,
} from '@composed-di/instrumentation-core';
import { ServiceKey } from '@composed-di/core';

export interface OTELInstrumentationOptions {
  /**
   * The tracer used to create spans. Defaults to a tracer obtained from
   * the global tracer provider — the one `NodeSDK` (and therefore
   * `@opentelemetry/auto-instrumentations-node`) registers on startup —
   * so most setups can omit it. The global lookup is lazy: it also works
   * when the instrumentation is constructed before the SDK starts.
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
}

export class OTELInstrumentation implements ServiceInstrumentation {
  private readonly tracer: Tracer;
  private readonly captureArguments: boolean;
  private readonly captureResults: boolean;

  constructor(options: OTELInstrumentationOptions = {}) {
    this.tracer =
      options.tracer ?? trace.getTracer('@composed-di/instrumentation-otel');
    this.captureArguments = options.captureArguments ?? false;
    this.captureResults = options.captureResults ?? false;
  }

  onInitialize(context: InitializeContext): EventSpan {
    const attributes = this.buildAttributes({
      key: context.key,
      event: 'initialize',
      className: 'ServiceFactory',
      functionName: 'initialize',
    });
    const spanName = `ServiceFactory[${context.key.name}].initialize`;
    return this.buildSpan(spanName, attributes, this.captureResults);
  }

  onDispose(context: DisposeContext): EventSpan {
    const attributes = this.buildAttributes({
      key: context.key,
      event: 'dispose',
      className: 'ServiceFactory',
      functionName: 'dispose',
    });
    const spanName = `ServiceFactory[${context.key.name}].dispose`;
    return this.buildSpan(spanName, attributes, false);
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
    return this.buildSpan(spanName, attributes, this.captureResults);
  }

  private buildSpan(
    spanName: string,
    attributes: Attributes,
    captureResult: boolean,
  ): EventSpan {
    const parentContext = otelContext.active();
    const span = this.tracer.startSpan(spanName, { attributes }, parentContext);
    const spanContext = trace.setSpan(parentContext, span);

    return {
      run: (fn) => otelContext.with(spanContext, fn),
      end: (outcome: EventOutcome) => {
        if (outcome.type === 'failure') {
          const error = outcome.error;
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
        } else if (captureResult) {
          span.setAttribute(
            'composed_di.service.function.result',
            serialize(outcome.value),
          );
        }
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
