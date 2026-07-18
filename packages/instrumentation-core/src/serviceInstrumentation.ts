import {
  OneShotFactory,
  ServiceFactory,
  SingletonFactory,
  ServiceKey,
  ServiceModule,
} from '@composed-di/core'
import {
  DisposeContext,
  InitializeContext,
  InstrumentOptions,
  MethodCallContext,
  OperationSpan,
} from './types'

type GenericFactory = ServiceFactory<unknown, readonly ServiceKey<any>[]>

/**
 * Base class for instrumenting services. Extend it and override the hooks
 * to observe lifecycle events and method calls of the services wrapped by
 * {@link ServiceInstrumentation.install}.
 *
 * Instrumentation is strictly observational: subclasses see every
 * operation but must never alter it — see the OperationSpan contract.
 *
 * Each hook is invoked when the corresponding operation starts and may
 * return an OperationSpan that is notified when that operation finishes.
 * Returning nothing opts out of completion tracking for that call.
 */
export abstract class ServiceInstrumentation {
  /**
   * Factories excluded from instrumentation by {@link ServiceInstrumentation.optOut},
   * shared across every instrumentation instance and backend: a factory
   * opted out here is skipped by install(), regardless of which
   * ServiceInstrumentation wraps it.
   */
  private static readonly optedOut = new WeakSet<GenericFactory>()

  /**
   * Factories produced by this instrumentation's install(), so overlapping
   * installs pass them through unchanged instead of wrapping them twice
   * (which would report every operation twice).
   */
  private readonly instrumented = new WeakSet<GenericFactory>()

  /**
   * Invoked at the start of the initialization process for a specific service.
   *
   * @param context - Context of the initialization, including the service key.
   * @return An OperationSpan notified when initialization finishes, or void.
   */
  abstract onInitialize(context: InitializeContext): OperationSpan

  /**
   * Invoked when the disposal process for a service starts.
   *
   * @param context - Context of the disposal, including the service key.
   * @return An OperationSpan notified when disposal finishes, or void.
   */
  abstract onDispose(context: DisposeContext): OperationSpan

  /**
   * Invoked when a method call starts on a service instance.
   *
   * @param context - Context of the invocation, including the service key,
   * the method name, and its arguments.
   * @return An OperationSpan notified when the call finishes, or void.
   */
  abstract onMethodCall(context: MethodCallContext): OperationSpan

  /**
   * Wraps service factories so this instrumentation is notified when a
   * service is initialized or disposed and when a method is called on a
   * service instance. Service instances are wrapped in a Proxy to observe
   * method calls, and errors are rethrown after being reported, so
   * behavior is otherwise unchanged.
   *
   * ServiceModule entries are flattened into their factories, so an
   * already-built module can be instrumented as a whole. Factories this
   * instrumentation already wrapped are passed through unchanged, so
   * overlapping installs never double-report an operation. This makes
   * layered composition safe: base modules can install instrumentation
   * where they are defined, and a higher-level module can install over
   * everything it aggregates without tracking which factories are
   * already wrapped. Factories excluded via {@link ServiceInstrumentation.optOut}
   * are likewise passed through unchanged. Compose the result with
   * `ServiceModule.from`:
   *
   * @example
   * ```ts
   * const module = ServiceModule.from(
   *   otel.instrument([db, cache, api], {
   *     capture: {
   *       arguments: true,
   *       results: true,
   *       redact: [redactionRule(VaultKey).redact('getSecret').build()],
   *     },
   *   }),
   * );
   * ```
   *
   * @param entries - An array of ServiceModule or factory instances to wrap.
   * @param options - The capture and redaction policy applied before
   * anything reaches this instrumentation.
   * @return The wrapped factories, ready to be passed to ServiceModule.from.
   */
  install(
    entries: (ServiceModule | GenericFactory)[],
    options: InstrumentOptions = {},
  ): GenericFactory[] {
    return entries
      .flatMap((e) => (e instanceof ServiceModule ? e.factories : [e]))
      .map((factory) => {
        const shouldSkipInstrumentation =
          ServiceInstrumentation.optedOut.has(factory) ||
          this.instrumented.has(factory)
        if (shouldSkipInstrumentation) {
          return factory
        }

        const instrumentedServiceFactory = instrumentServiceFactory(
          this,
          options,
          factory,
        )
        this.instrumented.add(instrumentedServiceFactory)
        return instrumentedServiceFactory
      })
  }

  /**
   * Marks the provided services or factories as opted out for instrumentation.
   *
   * @param entries The list of `ServiceModule` instances or `GenericFactory` instances to opt out.
   * @return The same list of `ServiceModule` or `GenericFactory` instances that were passed in.
   */
  static optOut(
    ...entries: (ServiceModule | GenericFactory)[]
  ): (ServiceModule | GenericFactory)[] {
    entries.forEach((e) => {
      if (e instanceof ServiceModule) {
        e.factories.forEach((factory) =>
          ServiceInstrumentation.optedOut.add(factory),
        )
      } else {
        ServiceInstrumentation.optedOut.add(e)
      }
    })
    return entries
  }
}

/**
 * The capture policy of one instrumented factory: resolves what to report
 * for a call's arguments and result, combining the capture flags with the
 * factory's redaction rule (if any). This is the single place that
 * decides visibility — instrumentations record what they receive and
 * nothing else.
 */
interface CapturePolicy {
  /**
   * The arguments to deliver in MethodCallContext, or undefined when
   * argument capture is off.
   */
  args(
    methodName: string,
    args: readonly unknown[],
  ): readonly unknown[] | undefined

  /**
   * The result to deliver with a method call's success outcome: the
   * (possibly redacted) value, wrapped so spreading it into the outcome
   * preserves the value-presence contract — a captured `undefined` return
   * yields `{ value: undefined }` (key present), while capture off yields
   * undefined (no key at all).
   */
  result(methodName: string, value: unknown): { value: unknown } | undefined
}

function buildCapturePolicy(
  options: InstrumentOptions,
  key: ServiceKey<unknown>,
): CapturePolicy {
  const capture = options.capture
  const rule = capture?.redactionRules?.find((r) => r.key === key)
  const captureArguments = capture?.arguments ?? false
  const captureResults = capture?.results ?? false

  return {
    args: (methodName, args) =>
      captureArguments
        ? rule
          ? rule.maskArgs(methodName, args)
          : args
        : undefined,
    result: (methodName, value) =>
      captureResults
        ? { value: rule ? rule.maskResult(methodName, value) : value }
        : undefined,
  }
}

/**
 * Wraps a given service factory with instrumentation to notify a
 * ServiceInstrumentation of lifecycle events and method calls.
 *
 * For each of initialize, dispose, and method calls, the instrumentation
 * is invoked at the start of the operation and may return an OperationSpan
 * whose `end` is called with the outcome when the operation finishes.
 * Errors are rethrown after being reported.
 *
 * @param instrumentation The instrumentation to notify.
 * @param options The capture policy.
 * @param delegate The original service factory to be instrumented.
 * @return A new service factory that provides the same dependencies but includes event notification logic.
 */
function instrumentServiceFactory<T, D extends readonly ServiceKey<any>[]>(
  instrumentation: ServiceInstrumentation,
  options: InstrumentOptions,
  delegate: ServiceFactory<any, D>,
): ServiceFactory<T, D> {
  const key = delegate.provides
  const capturePolicy = buildCapturePolicy(options, key)
  const initialize: ServiceFactory<T, D>['initialize'] = async (...args) => {
    const span = instrumentation.onInitialize({ key })
    try {
      const instance = await span.run(() => delegate.initialize(...args))
      span.end({ type: 'success' })
      return observeMethodCalls(instance, instrumentation, key, capturePolicy)
    } catch (error) {
      span.end({ type: 'failure', error })
      throw error
    }
  }

  if (delegate instanceof SingletonFactory) {
    return ServiceFactory.singleton<T, D>({
      scope: delegate.scope,
      provides: delegate.provides,
      dependsOn: delegate.dependsOn,
      initialize: initialize,
      dispose: () => {
        const span = instrumentation.onDispose({ key })
        try {
          span.run(() => delegate.dispose())
          span.end({ type: 'success' })
        } catch (error) {
          span.end({ type: 'failure', error })
          throw error
        }
      },
    })
  }

  if (delegate instanceof OneShotFactory) {
    return ServiceFactory.oneShot<T, D>({
      provides: delegate.provides,
      dependsOn: delegate.dependsOn,
      initialize: initialize,
    })
  }

  // An unknown implementation gives no way to tell a real initialization
  // from a memoized cache hit, so its lifetime semantics cannot be
  // preserved — refuse loudly rather than degrade silently.
  throw new TypeError(
    `install(): cannot instrument ${key.name} — ${delegate.constructor.name} ` +
      'is not a factory built by ServiceFactory.singleton() or ' +
      'ServiceFactory.oneShot(), so its lifetime semantics cannot be preserved.',
  )
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
 * @param capturePolicy The capture policy deciding what argument and result
 * values (if any) are delivered with each event.
 * @return A Proxy wrapping the input object, with all method calls being reported.
 */
function observeMethodCalls(
  thing: any,
  instrumentation: ServiceInstrumentation,
  key: ServiceKey<unknown>,
  capturePolicy: CapturePolicy,
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
            methodName: prop,
            args: capturePolicy.args(prop, args),
          })
          try {
            const result = invokeWithin(span, () => value.apply(target, args))
            if (result instanceof Promise) {
              return result.then(
                (resolved) => {
                  span?.end({
                    type: 'success',
                    ...capturePolicy.result(prop, resolved),
                  })
                  return resolved
                },
                (error) => {
                  span?.end({ type: 'failure', error })
                  throw error
                },
              )
            }
            span?.end({
              type: 'success',
              ...capturePolicy.result(prop, result),
            })
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
 * Invokes an operation through the OperationSpan's `run` wrapper when the
 * instrumentation returned a span, so it can establish ambient state
 * (tracing context) around the operation; invokes the operation directly
 * otherwise.
 *
 * @param span The OperationSpan returned by the instrumentation, if any.
 * @param fn The thunk performing the operation.
 * @returns The value returned by `fn`.
 */
function invokeWithin<T>(span: OperationSpan | void, fn: () => T): T {
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
