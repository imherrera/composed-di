/**
 * Custom `composed_di.*` span attribute names, following the
 * `ATTR_*` naming convention of `@opentelemetry/semantic-conventions`.
 */

/** The service key the operation belongs to. */
export const ATTR_COMPOSED_DI_SERVICE_KEY = 'composed_di.service.key'

/** The lifecycle event being recorded: `initialize`, `dispose`, or `call`. */
export const ATTR_COMPOSED_DI_SERVICE_EVENT = 'composed_di.service.event'

/**
 * The method call arguments, serialized to JSON. Present exactly when
 * argument capture is enabled in the InstrumentOptions.
 */
export const ATTR_COMPOSED_DI_SERVICE_FUNCTION_ARGUMENTS =
  'composed_di.service.function.arguments'

/**
 * The method call result, serialized to JSON. Present exactly when
 * result capture is enabled in the InstrumentOptions.
 */
export const ATTR_COMPOSED_DI_SERVICE_FUNCTION_RESULT =
  'composed_di.service.function.result'
