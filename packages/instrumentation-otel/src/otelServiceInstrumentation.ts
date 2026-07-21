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
  OperationOutcome,
  OperationSpan,
  InitializeContext,
  MethodCallContext,
  ServiceInstrumentation,
} from '@composed-di/instrumentation-core'
import { ServiceKey } from '@composed-di/core'
import {
  ATTR_COMPOSED_DI_SERVICE_EVENT,
  ATTR_COMPOSED_DI_SERVICE_FUNCTION_ARGUMENTS,
  ATTR_COMPOSED_DI_SERVICE_FUNCTION_RESULT,
  ATTR_COMPOSED_DI_SERVICE_KEY,
} from './attributes'

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
export class OTELServiceInstrumentation extends ServiceInstrumentation {
  private readonly tracer: Tracer

  constructor(options: OTELInstrumentationOptions = {}) {
    super()
    this.tracer =
      options.tracer ?? trace.getTracer('@composed-di/instrumentation-otel')
  }

  initializeSpan(context: InitializeContext): OperationSpan {
    const attributes = this.buildAttributes({
      key: context.key,
      event: 'initialize',
      className: 'ServiceFactory',
      methodName: 'initialize',
    })
    const spanName = `ServiceFactory[${context.key.name}].initialize`
    return this.buildSpan(spanName, attributes)
  }

  disposeSpan(context: DisposeContext): OperationSpan {
    const attributes = this.buildAttributes({
      key: context.key,
      event: 'dispose',
      className: 'ServiceFactory',
      methodName: 'dispose',
    })
    const spanName = `ServiceFactory[${context.key.name}].dispose`
    return this.buildSpan(spanName, attributes)
  }

  methodCallSpan(context: MethodCallContext): OperationSpan {
    const attributes = this.buildAttributes({
      key: context.key,
      event: 'call',
      className: context.className,
      methodName: context.methodName,
      args: context.args,
    })
    const spanName = attributes[ATTR_CODE_FUNCTION_NAME]
    return this.buildSpan(spanName, attributes)
  }

  private buildSpan(spanName: string, attributes: Attributes): OperationSpan {
    const parentContext = otelContext.active()
    const span = this.tracer.startSpan(spanName, { attributes }, parentContext)
    const spanContext = trace.setSpan(parentContext, span)

    return {
      run: (fn) => otelContext.with(spanContext, fn),
      end: (outcome: OperationOutcome) => {
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
            ATTR_COMPOSED_DI_SERVICE_FUNCTION_RESULT,
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
    methodName: string
    args?: readonly unknown[]
  }) {
    const attributes: { [key: string]: string } = {
      [ATTR_CODE_FUNCTION_NAME]: `${params.className ?? params.key.name}.${params.methodName}`,
      [ATTR_COMPOSED_DI_SERVICE_KEY]: params.key.name,
      [ATTR_COMPOSED_DI_SERVICE_EVENT]: params.event,
    }

    // Present exactly when argument capture is enabled in the
    // InstrumentOptions; the args arrive already redacted.
    if (params.args) {
      attributes[ATTR_COMPOSED_DI_SERVICE_FUNCTION_ARGUMENTS] = serialize(
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
