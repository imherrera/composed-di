/**
 * Span attribute names used by this instrumentation, following the `ATTR_*`
 * naming convention of `@opentelemetry/semantic-conventions`. The
 * `composed_di.*` names are custom, the rest are inlined copies of stable
 * OpenTelemetry conventions.
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

/** The name of the function the span covers, qualified by its class or service key. */
export const ATTR_CODE_FUNCTION_NAME = 'code.function.name'

/** The type of the error that ended the operation. */
export const ATTR_ERROR_TYPE = 'error.type'

/** {@link ATTR_ERROR_TYPE} value for errors that expose no more specific type. */
export const ERROR_TYPE_VALUE_OTHER = '_OTHER'
