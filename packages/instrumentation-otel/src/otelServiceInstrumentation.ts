import {
  type Attributes,
  context as otelContext,
  SpanStatusCode,
  trace,
  type Tracer,
} from '@opentelemetry/api'
import {
  type LifecycleContext,
  type OperationOutcome,
  type OperationSpan,
  type MethodCallContext,
  ServiceInstrumentation,
  type ServiceLifecycleEvent,
} from '@composed-di/instrumentation-core'
import { ServiceKey } from '@composed-di/core'
import {
  ATTR_CODE_FUNCTION_NAME,
  ATTR_COMPOSED_DI_SERVICE_EVENT,
  ATTR_COMPOSED_DI_SERVICE_FUNCTION_ARGUMENTS,
  ATTR_COMPOSED_DI_SERVICE_FUNCTION_RESULT,
  ATTR_COMPOSED_DI_SERVICE_KEY,
  ATTR_ERROR_TYPE,
  ERROR_TYPE_VALUE_OTHER,
} from './attributes.js'

// Instrumentation scope reported on every span. Keep in sync with package.json.
const SCOPE_NAME = '@composed-di/instrumentation-otel'
const SCOPE_VERSION = '0.14.0'

/**
 * A ServiceInstrumentation that records service events as OTEL spans.
 */
export class OTELServiceInstrumentation extends ServiceInstrumentation {
  private readonly tracer: Tracer = trace.getTracer(SCOPE_NAME, SCOPE_VERSION)

  lifecycleSpan(context: LifecycleContext): OperationSpan {
    const { className, methodName } = LIFECYCLE_TARGETS[context.event]
    const attributes = this.buildAttributes({
      key: context.key,
      event: context.event,
      className,
      methodName,
    })
    const spanName = context.key
      ? `${className}<${context.key.name}>.${methodName}`
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
    const spanName = `${context.className ?? context.key.name}.${context.methodName}`
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
          // InstrumentOptions. The value arrives already redacted.
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
    key?: ServiceKey<unknown> | undefined
    event: ServiceLifecycleEvent | 'call'
    className?: string | undefined
    methodName: string
    args?: readonly unknown[] | undefined
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
    // InstrumentOptions. The args arrive already redacted.
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
  module_get_or_null: { className: 'ServiceModule', methodName: 'getOrNull' },
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
