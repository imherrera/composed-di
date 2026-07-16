import {
  Attributes,
  context as otelContext,
  SpanStatusCode,
  trace,
  Tracer,
} from '@opentelemetry/api'
import {
  ATTR_CODE_FUNCTION_NAME,
  ATTR_ERROR_TYPE,
  ERROR_TYPE_VALUE_OTHER,
} from '@opentelemetry/semantic-conventions'
import {
  DisposeContext,
  EventOutcome,
  EventSpan,
  InitializeContext,
  MethodCallContext,
  ServiceInstrumentation,
} from '@composed-di/instrumentation-core'
import { ServiceKey } from '@composed-di/core'

export interface OTELInstrumentationOptions {
  /**
   * The tracer used to create spans. Defaults to a tracer obtained from
   * the global tracer provider — the one `NodeSDK` (and therefore
   * `@opentelemetry/auto-instrumentations-node`) registers on startup —
   * so most setups can omit it. The global lookup is lazy: it also works
   * when the instrumentation is constructed before the SDK starts.
   */
  tracer?: Tracer
}

/**
 * A ServiceInstrumentation that records service events as OTEL spans.
 *
 * Arguments and results are recorded (as the
 * `composed_di.service.function.arguments` / `.result` attributes,
 * serialized to JSON) exactly when `instrument()` (inherited from
 * ServiceInstrumentation) delivers them — capture and redaction policy
 * live in the InstrumentOptions, not here.
 */
export class OTELInstrumentation extends ServiceInstrumentation {
  private readonly tracer: Tracer

  constructor(options: OTELInstrumentationOptions = {}) {
    super()
    this.tracer =
      options.tracer ?? trace.getTracer('@composed-di/instrumentation-otel')
  }

  onInitialize(context: InitializeContext): EventSpan {
    const attributes = this.buildAttributes({
      key: context.key,
      event: 'initialize',
      className: 'ServiceFactory',
      functionName: 'initialize',
    })
    const spanName = `ServiceFactory[${context.key.name}].initialize`
    return this.buildSpan(spanName, attributes)
  }

  onDispose(context: DisposeContext): EventSpan {
    const attributes = this.buildAttributes({
      key: context.key,
      event: 'dispose',
      className: 'ServiceFactory',
      functionName: 'dispose',
    })
    const spanName = `ServiceFactory[${context.key.name}].dispose`
    return this.buildSpan(spanName, attributes)
  }

  onMethodCall(context: MethodCallContext): EventSpan {
    const attributes = this.buildAttributes({
      key: context.key,
      event: 'call',
      className: context.className,
      functionName: context.functionName,
      args: context.args,
    })
    const spanName = attributes[ATTR_CODE_FUNCTION_NAME]
    return this.buildSpan(spanName, attributes)
  }

  private buildSpan(spanName: string, attributes: Attributes): EventSpan {
    const parentContext = otelContext.active()
    const span = this.tracer.startSpan(spanName, { attributes }, parentContext)
    const spanContext = trace.setSpan(parentContext, span)

    return {
      run: (fn) => otelContext.with(spanContext, fn),
      end: (outcome: EventOutcome) => {
        if (outcome.type === 'failure') {
          const error = outcome.error
          span.recordException(error instanceof Error ? error : String(error))
          span.setAttribute(
            ATTR_ERROR_TYPE,
            error instanceof Error
              ? error.name || ERROR_TYPE_VALUE_OTHER
              : ERROR_TYPE_VALUE_OTHER,
          )
          span.setStatus({
            code: SpanStatusCode.ERROR,
            message: error instanceof Error ? error.message : String(error),
          })
        } else if ('value' in outcome) {
          // Present exactly when result capture is enabled in the
          // InstrumentOptions; the value arrives already redacted.
          span.setAttribute(
            'composed_di.service.function.result',
            serialize(outcome.value),
          )
        }
        span.end()
      },
    }
  }

  private buildAttributes(params: {
    key: ServiceKey<unknown>
    event: 'initialize' | 'dispose' | 'call'
    className?: string
    functionName: string
    args?: readonly unknown[]
  }) {
    const attributes: { [key: string]: string } = {
      [ATTR_CODE_FUNCTION_NAME]: `${params.className ?? params.key.name}.${params.functionName}`,
      'composed_di.service.key': params.key.name,
      'composed_di.service.event': params.event,
    }

    // Present exactly when argument capture is enabled in the
    // InstrumentOptions; the args arrive already redacted.
    if (params.args) {
      attributes['composed_di.service.function.arguments'] = serialize(
        params.args,
      )
    }

    return attributes
  }
}

function serialize(value: unknown): string {
  let text: string
  try {
    text = JSON.stringify(value) ?? String(value)
  } catch {
    text = '[unserializable]'
  }
  return text
}
