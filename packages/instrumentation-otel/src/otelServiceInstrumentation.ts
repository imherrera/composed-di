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
  LifecycleContext,
  OperationOutcome,
  OperationSpan,
  MethodCallContext,
  ServiceInstrumentation,
  ServiceLifecycleEvent,
} from '@composed-di/instrumentation-core'
import { ServiceKey } from '@composed-di/core'
import {
  ATTR_COMPOSED_DI_SERVICE_EVENT,
  ATTR_COMPOSED_DI_SERVICE_FUNCTION_ARGUMENTS,
  ATTR_COMPOSED_DI_SERVICE_FUNCTION_RESULT,
  ATTR_COMPOSED_DI_SERVICE_KEY,
} from './attributes'
import * as pkg from '../package.json'

export interface OTELInstrumentationOptions {}

/**
 * A ServiceInstrumentation that records service events as OTEL spans.
 */
export class OTELServiceInstrumentation extends ServiceInstrumentation {
  private readonly tracer: Tracer = trace.getTracer(pkg.name, pkg.version)

  lifecycleSpan(context: LifecycleContext): OperationSpan {
    const { className, methodName } = LIFECYCLE_TARGETS[context.event]
    const attributes = this.buildAttributes({
      key: context.key,
      event: context.event,
      className,
      methodName,
    })
    const spanName = context.key
      ? `${className}[${context.key.name}].${methodName}`
      : `${className}.${methodName}`
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
    key?: ServiceKey<unknown>
    event: ServiceLifecycleEvent | 'call'
    className?: string
    methodName: string
    args?: readonly unknown[]
  }) {
    const attributes: { [key: string]: string } = {
      [ATTR_CODE_FUNCTION_NAME]: `${params.className ?? params.key?.name}.${params.methodName}`,
      [ATTR_COMPOSED_DI_SERVICE_EVENT]: params.event,
    }

    // module_dispose concerns the whole module, not one service
    if (params.key) {
      attributes[ATTR_COMPOSED_DI_SERVICE_KEY] = params.key.name
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

/**
 * The class and method each lifecycle event corresponds to, used to name
 * the span and its code attributes.
 */
const LIFECYCLE_TARGETS: Record<
  ServiceLifecycleEvent,
  { className: string; methodName: string }
> = {
  factory_initialize: { className: 'ServiceFactory', methodName: 'initialize' },
  factory_dispose: { className: 'ServiceFactory', methodName: 'dispose' },
  module_get: { className: 'ServiceModule', methodName: 'get' },
  module_dispose: { className: 'ServiceModule', methodName: 'dispose' },
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
