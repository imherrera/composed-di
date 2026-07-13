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

export interface OTELEventListenerOptions {
  /**
   * The tracer used to create spans.
   */
  tracer: Tracer;

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

/**
 * One in-flight listener span, linked to the frame that was active when it
 * started. AsyncLocalStorage.enterWith cannot be undone once the operation
 * finishes (end/error may fire in a different async context than the one
 * the frame was entered in), so instead of detaching, finished frames are
 * marked `ended` and readers skip them via `liveFrame`.
 */
interface SpanFrame {
  readonly context: Context;
  readonly parent: SpanFrame | undefined;
  ended: boolean;
}

export class OTELEventListener implements ServiceEventListener {
  private readonly activeFrame = new AsyncLocalStorage<SpanFrame>();
  private readonly tracer: Tracer;
  private readonly captureArguments: boolean;
  private readonly captureResults: boolean;

  constructor(options: OTELEventListenerOptions) {
    this.tracer = options.tracer;
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
    const parent = findParentFrame(this.activeFrame.getStore());
    const parentContext = parent?.context ?? otelContext.active();
    const span = this.tracer.startSpan(spanName, { attributes }, parentContext);

    const frame: SpanFrame = {
      context: trace.setSpan(parentContext, span),
      parent,
      ended: false,
    };
    // The operation body runs in this same async context right after the
    // listener returns, so it and its async continuations see this frame.
    this.activeFrame.enterWith(frame);

    return {
      end: (outcome?: EventOutcome) => {
        frame.ended = true;
        if (this.captureResults && outcome !== undefined) {
          span.setAttribute(
            'composed_di.service.function.result',
            serialize(outcome.result),
          );
        }
        span.end();
      },
      error: (error: unknown) => {
        frame.ended = true;
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

/**
 * Walks up the frame chain to the nearest span that has not finished yet,
 * or undefined when every ancestor has ended (the ambient OTEL context is
 * the parent then).
 */
function findParentFrame(frame: SpanFrame | undefined): SpanFrame | undefined {
  while (frame && frame.ended) {
    frame = frame.parent;
  }
  return frame;
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
