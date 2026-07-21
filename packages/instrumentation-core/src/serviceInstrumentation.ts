import {
  OneShotFactory,
  ServiceFactory,
  SingletonFactory,
  ServiceKey,
} from '@composed-di/core'
import {
  DisposeContext,
  InitializeContext,
  InstrumentOptions,
  MethodCallContext,
  OperationSpan,
} from './types'

/**
 * Base class for observing services: extend it and implement the hooks to
 * be notified when a service is initialized or disposed, and when a method
 * is called on a service instance.
 *
 * @remarks
 * A subclass never touches services directly. Passing factories through
 * {@link ServiceInstrumentation.install | install} returns wrapped
 * factories that report to this instrumentation; compose those into the
 * ServiceModule in place of the originals.
 *
 * Each hook is called when its operation starts and returns an
 * {@link OperationSpan}, whose `end` is invoked once when that operation
 * finishes.
 *
 * Instrumentation is strictly observational: subclasses see every
 * operation but must never alter it — see the OperationSpan contract.
 */
export abstract class ServiceInstrumentation {
  /**
   * Factories produced by this instrumentation's install(), so overlapping
   * installs pass them through unchanged instead of wrapping them twice
   * (which would report every operation twice).
   */
  private readonly instrumentedFactories = new WeakSet<ServiceFactory>()

  /**
   * Called when initialization of a service starts.
   *
   * @param context - Identifies the service being initialized.
   * @returns The span to notify when initialization finishes.
   */
  abstract initializeSpan(context: InitializeContext): OperationSpan

  /**
   * Called when disposal of a service starts.
   *
   * @param context - Identifies the service being disposed.
   * @returns The span to notify when disposal finishes.
   */
  abstract disposeSpan(context: DisposeContext): OperationSpan

  /**
   * Called when a method call on a service instance starts.
   *
   * @param context - Identifies the service and method, and carries the
   * call's arguments when argument capture is enabled.
   * @returns The span to notify when the call finishes — for methods that
   * return a promise, when that promise settles.
   */
  abstract methodCallSpan(context: MethodCallContext): OperationSpan

  /**
   * Creates and returns a new instrumented factory.
   *
   * @example Instrumenting one service
   * ```ts
   * const serviceInstrumentation = new OTELServiceInstrumentation()
   * const module = ServiceModule.from([serviceInstrumentation.install(databaseFactory)])
   * ```
   *
   * @param factory - The factory providing the service to observe.
   * @param options - What runtime values (arguments, results) are
   * captured and how they are redacted before reaching this
   * instrumentation (nothing is captured by default).
   * @returns The instrumented factory to compose in place of `factory` —
   * or `factory` itself when it is opted out or already instrumented.
   */
  install(factory: ServiceFactory, options?: InstrumentOptions): ServiceFactory
  /**
   * Creates and returns a new array of instrumented factories.
   *
   * @example
   * ```ts
   * const serviceInstrumentation = new OTELServiceInstrumentation()
   * const module = ServiceModule.from(serviceInstrumentation.install(databaseModule.factories))
   * ```
   *
   * @param factories - The factories providing the services to observe.
   * @param options - What runtime values (arguments, results) are
   * captured and how they are redacted before reaching this
   * instrumentation (nothing is captured by default).
   * @returns A new array of instrumented factories.
   */
  install(
    factories: ServiceFactory[],
    options?: InstrumentOptions,
  ): ServiceFactory[]
  install(
    input: ServiceFactory | ServiceFactory[],
    options: InstrumentOptions = {},
  ): ServiceFactory | ServiceFactory[] {
    if (Array.isArray(input)) {
      return input.map((factory) => this.install(factory, options))
    }

    if (this.isInstrumented(input)) {
      return input
    }

    const factory = instrumentServiceFactory(this, options, input)
    this.instrumentedFactories.add(factory)
    return factory
  }

  private isInstrumented(factory: ServiceFactory): boolean {
    return this.instrumentedFactories.has(factory)
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

function instrumentServiceFactory<T, D extends readonly ServiceKey<unknown>[]>(
  instrumentation: ServiceInstrumentation,
  options: InstrumentOptions,
  delegate: ServiceFactory<T, D>,
): ServiceFactory<T, D> {
  const key = delegate.provides
  const capturePolicy = buildCapturePolicy(options, key)
  const initialize: ServiceFactory<T, D>['initialize'] = async (...args) => {
    const span = instrumentation.initializeSpan({ key })
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
        const span = instrumentation.disposeSpan({ key })
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
    `Cannot instrument factory ${delegate.constructor.name} for ${key.name}. ` +
      'Factories must be created with ServiceFactory.singleton() or ' +
      'ServiceFactory.oneShot(); custom ServiceFactory implementations cannot be instrumented.',
  )
}

function observeMethodCalls(
  thing: unknown,
  instrumentation: ServiceInstrumentation,
  key: ServiceKey<unknown>,
  capturePolicy: CapturePolicy,
): any {
  if (typeof thing !== 'object' || thing === null) {
    return thing
  }

  // The class name qualifies method calls in events, but only for named
  // classes
  const name = thing.constructor?.name
  const className = name && name !== 'Object' ? name : undefined

  return new Proxy(thing, {
    get(target, prop) {
      const value = Reflect.get(target, prop)
      if (typeof value === 'function' && typeof prop === 'string') {
        return (...args: unknown[]) => {
          const span = instrumentation.methodCallSpan({
            key,
            className,
            methodName: prop,
            args: capturePolicy.args(prop, args),
          })

          try {
            const result = span.run(() => value.apply(target, args))
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
