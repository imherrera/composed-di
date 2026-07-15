import { ServiceFactory, ServiceKey, ServiceModule } from '@composed-di/core'
import type {
  EventOutcome,
  EventSpan,
  ServiceInstrumentation,
} from './serviceInstrumentation'
import type { RedactionRule } from './redaction'

type GenericFactory = ServiceFactory<unknown, readonly ServiceKey<any>[]>

/**
 * Configuration for {@link instrument}. Capture policy lives here, not in
 * the ServiceInstrumentation implementations: what an implementation
 * receives is exactly what it is allowed to record, so no implementation
 * carries its own capture flags or redaction logic.
 */
export interface InstrumentOptions {
  /**
   * The instrumentation notified of service lifecycle events and method
   * calls.
   */
  instrumentation: ServiceInstrumentation

  /**
   * Deliver method arguments to the instrumentation (as
   * MethodCallContext.args). Off by default: arguments may be large or
   * contain secrets, and they end up wherever the instrumentation exports
   * them. When off, the instrumentation never sees the arguments at all.
   */
  captureArguments?: boolean

  /**
   * Deliver method call return / resolved values to the instrumentation
   * (as the success outcome's `value`). Off by default, for the same
   * reasons as `captureArguments`. When off, the instrumentation never
   * sees the values at all. Initialize and dispose outcomes never carry a
   * value: the service instance is not useful information to report.
   */
  captureResults?: boolean

  /**
   * Per-service redaction applied to whatever the capture flags let
   * through: matched arguments and success values are blanked (or run
   * through the rule's custom mask) before the instrumentation sees them.
   * The capture flags are the primary gate — when capture is off there is
   * nothing to redact, and rules cannot re-enable delivery.
   */
  redactionRules?: readonly RedactionRule<any>[]
}

/**
 * Wraps service factories with instrumentation, so the given
 * ServiceInstrumentation is notified when a service is initialized or
 * disposed and when a method is called on a service instance, and may
 * return an EventSpan per operation to observe its completion. Service
 * instances are wrapped in a Proxy to observe method calls, and errors
 * are rethrown after being reported, so behavior is otherwise unchanged.
 *
 * ServiceModule entries are flattened into their factories, so an
 * already-built module can be instrumented as a whole. Compose the result
 * with `ServiceModule.from`:
 *
 * @example
 * ```ts
 * const module = ServiceModule.from(
 *   instrument([db, cache, api], {
 *     instrumentation: otel,
 *     captureArguments: true,
 *     captureResults: true,
 *     redactionRules: [redactionRule(VaultKey).redact('getSecret').build()],
 *   }),
 * );
 * ```
 *
 * @param entries - An array of ServiceModule or factory instances to wrap.
 * @param options - The instrumentation to notify, plus the capture and
 * redaction policy applied before anything reaches it.
 * @return The wrapped factories, ready to be passed to ServiceModule.from.
 */
export function instrument(
  entries: (ServiceModule | GenericFactory)[],
  options: InstrumentOptions,
): GenericFactory[] {
  return entries
    .flatMap((e) => (e instanceof ServiceModule ? e.factories : [e]))
    .map((factory) => makeObservable(options, factory))
}

/**
 * The capture policy of one instrumented factory: resolves what to report
 * for a call's arguments and a success outcome, combining the capture
 * flags with the factory's redaction rule (if any). This is the single
 * place that decides visibility — instrumentations record what they
 * receive and nothing else.
 */
interface Capture {
  /**
   * The arguments to deliver in MethodCallContext, or undefined when
   * argument capture is off.
   */
  args(
    functionName: string,
    args: readonly unknown[],
  ): readonly unknown[] | undefined

  /**
   * The success outcome to deliver to EventSpan.end for a method call:
   * carries the (possibly redacted) value when result capture is on, no
   * value otherwise.
   */
  success(functionName: string, value: unknown): EventOutcome
}

function makeCapture(
  options: InstrumentOptions,
  key: ServiceKey<unknown>,
): Capture {
  const rule = options.redactionRules?.find((r) => r.key === key)
  const captureArguments = options.captureArguments ?? false
  const captureResults = options.captureResults ?? false

  return {
    args: (functionName, args) =>
      captureArguments
        ? rule
          ? rule.maskArgs(functionName, args)
          : args
        : undefined,
    success: (functionName, value) =>
      captureResults
        ? {
            type: 'success',
            value: rule ? rule.maskResult(functionName, value) : value,
          }
        : { type: 'success' },
  }
}

/**
 * Wraps a given service factory with instrumentation to notify a
 * ServiceInstrumentation of lifecycle events and method calls.
 *
 * For each of initialize, dispose, and method calls, the instrumentation
 * is invoked at the start of the operation and may return an EventSpan
 * whose `end` is called with the outcome when the operation finishes.
 * Errors are rethrown after being reported.
 *
 * @param options The instrumentation to notify and the capture policy.
 * @param delegate The original service factory to be instrumented.
 * @return A new service factory that provides the same dependencies but includes event notification logic.
 */
function makeObservable<T, D extends readonly ServiceKey<any>[]>(
  options: InstrumentOptions,
  delegate: ServiceFactory<any, D>,
): ServiceFactory<T, D> {
  const instrumentation = options.instrumentation
  const key = delegate.provides
  const capture = makeCapture(options, key)

  return ServiceFactory.singleton({
    scope: delegate.scope,
    provides: delegate.provides,
    dependsOn: delegate.dependsOn,
    initialize: async (...args) => {
      const span = instrumentation.onInitialize?.({ key })
      if (!span) {
        return delegate.initialize(...args)
      }

      try {
        const instance = await span.run(() => delegate.initialize(...args))
        span.end({ type: 'success' })
        return observeMethodCalls(instance, instrumentation, key, capture)
      } catch (error) {
        span.end({ type: 'failure', error })
        throw error
      }
    },
    dispose: () => {
      const dispose = delegate.dispose
      if (dispose) {
        const span = instrumentation.onDispose?.({ key })
        if (span) {
          try {
            span.run(dispose)
            span.end({ type: 'success' })
          } catch (error) {
            span.end({ type: 'failure', error })
            throw error
          }
        }
      }
    },
  })
}

/**
 * Wraps an object with a Proxy to notify the instrumentation of method calls.
 *
 * Methods returning a promise report their outcome when the promise
 * settles, not when the method returns.
 *
 * @param thing The object whose method calls need to be observed.
 * @param instrumentation The instrumentation notified of method call events.
 * @param key The service key used to identify the service in events.
 * @param capture The capture policy deciding what argument and result
 * values (if any) are delivered with each event.
 * @return A Proxy wrapping the input object, with all method calls being reported.
 */
function observeMethodCalls(
  thing: any,
  instrumentation: ServiceInstrumentation,
  key: ServiceKey<unknown>,
  capture: Capture,
): any {
  if (typeof thing !== 'object' || thing === null) {
    return thing
  }

  const className = classNameOf(thing)

  return new Proxy(thing, {
    get(target, prop) {
      const value = Reflect.get(target, prop)
      if (typeof value === 'function' && typeof prop === 'string') {
        return (...args: unknown[]) => {
          const span = instrumentation.onMethodCall?.({
            key,
            className,
            functionName: prop,
            args: capture.args(prop, args),
          })
          try {
            const result = invokeWithin(span, () => value.apply(target, args))
            if (result instanceof Promise) {
              return result.then(
                (resolved) => {
                  span?.end(capture.success(prop, resolved))
                  return resolved
                },
                (error) => {
                  span?.end({ type: 'failure', error })
                  throw error
                },
              )
            }
            span?.end(capture.success(prop, result))
            return result
          } catch (error) {
            span?.end({ type: 'failure', error })
            throw error
          }
        }
      }
      return value
    },
  })
}

/**
 * Invokes an operation through the EventSpan's `run` wrapper when the
 * instrumentation returned a span, so it can establish ambient state
 * (tracing context) around the operation; invokes the operation directly
 * otherwise.
 *
 * @param span The EventSpan returned by the instrumentation, if any.
 * @param fn The thunk performing the operation.
 * @returns The value returned by `fn`.
 */
function invokeWithin<T>(span: EventSpan | void, fn: () => T): T {
  return span ? span.run(fn) : fn()
}

/**
 * Resolves the class name of a service instance, or undefined for values
 * that are not instances of a named class (plain object literals,
 * null-prototype objects).
 *
 * @param thing The service instance to inspect.
 * @returns The constructor name, or undefined when there is none to report.
 */
function classNameOf(thing: object): string | undefined {
  const name = thing.constructor?.name
  return name && name !== 'Object' ? name : undefined
}
