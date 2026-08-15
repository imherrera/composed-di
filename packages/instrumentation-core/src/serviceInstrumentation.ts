import {
  TransientFactory,
  ServiceFactory,
  SingletonFactory,
  ServiceKey,
  ServiceModule,
  type DependencyKey,
} from '@composed-di/core'
import type {
  InstrumentOptions,
  LifecycleContext,
  MethodCallContext,
  OperationSpan,
} from './types.js'

/**
 * Base class for observing services. Extend it and implement the hooks to
 * be notified of lifecycle operations (a factory initializing or disposing
 * a service, a module resolving or disposing) and of method calls on
 * service instances.
 *
 * @remarks
 * A subclass never touches services directly. Passing factories through
 * {@link ServiceInstrumentation.install | install} returns wrapped
 * factories that report to this instrumentation. Compose those into the
 * ServiceModule in place of the originals.
 *
 * Each hook is called when its operation starts and returns an
 * {@link OperationSpan}, whose `end` is invoked once when that operation
 * finishes.
 *
 * Instrumentation is strictly observational. Subclasses see every
 * operation but must never alter it. See the OperationSpan contract.
 */
export abstract class ServiceInstrumentation {
  /**
   * Factories produced by this instrumentation's install(), so overlapping
   * installs pass them through unchanged instead of wrapping them twice
   * (which would report every operation twice).
   */
  private readonly instrumentedFactories = new WeakSet<ServiceFactory>()

  /**
   * Called when a lifecycle operation starts. Lifecycle operations are a
   * factory initializing or disposing its service, and a module resolving
   * (`get` / `getOrNull`) or disposing.
   *
   * @param context - Which operation started and, except for module
   * disposal, the service it concerns.
   * @returns The span to notify when the operation finishes.
   */
  abstract lifecycleSpan(context: LifecycleContext): OperationSpan

  /**
   * Called when a method call on a service instance starts.
   *
   * @param context - Identifies the service and method, and carries the
   * call's arguments when argument capture is enabled.
   * @returns The span to notify when the call finishes. For methods that
   * return a promise, that is when the promise settles.
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
   * @returns The instrumented factory to compose in place of `factory`,
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
    factories: ReadonlyArray<ServiceFactory>,
    options?: InstrumentOptions,
  ): ServiceFactory[]
  /**
   * Creates and returns a new instrumented module. Its factories are
   * instrumented as by the array overload, and the module's own `get`,
   * `getOrNull` and `dispose` are reported as `module_get` /
   * `module_get_or_null` / `module_dispose` lifecycle operations.
   *
   * @example
   * ```ts
   * const serviceInstrumentation = new OTELServiceInstrumentation()
   * const module = serviceInstrumentation.install(databaseModule)
   * ```
   *
   * @param module - The module whose services to observe.
   * @param options - What runtime values (arguments, results) are
   * captured and how they are redacted before reaching this
   * instrumentation (nothing is captured by default).
   * @returns The instrumented module to use in place of `module`.
   */
  install(module: ServiceModule, options?: InstrumentOptions): ServiceModule
  install(
    input: ServiceModule | ServiceFactory | ReadonlyArray<ServiceFactory>,
    options: InstrumentOptions = {},
  ): ServiceModule | ServiceFactory | ServiceFactory[] {
    if (input instanceof ServiceModule) {
      const module = ServiceModule.from(this.install(input.factories, options))
      return instrumentServiceModule(this, module)
    }

    const isFactories = (arg: any): arg is ReadonlyArray<ServiceFactory> =>
      Array.isArray(arg)
    if (isFactories(input)) {
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
 * The capture policy of one instrumented factory. Resolves what to report
 * for a call's arguments and result, combining the capture flags with the
 * factory's redaction rule (if any). This is the single place that
 * decides visibility. Instrumentations record what they receive and
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
   * The result to deliver with a method call's success outcome. The
   * (possibly redacted) value, wrapped so spreading it into the outcome
   * preserves the value-presence contract. A captured `undefined` return
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

function instrumentServiceFactory<
  T,
  D extends readonly DependencyKey<unknown>[],
>(
  instrumentation: ServiceInstrumentation,
  options: InstrumentOptions,
  delegate: ServiceFactory<T, D>,
): ServiceFactory<T, D> {
  const key = delegate.provides
  const capturePolicy = buildCapturePolicy(options, key)
  const initialize: ServiceFactory<T, D>['initialize'] = async (...args) => {
    const span = instrumentation.lifecycleSpan({
      event: 'factory_initialize',
      key,
    })
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
      provides: delegate.provides,
      dependsOn: delegate.dependsOn,
      initialize: initialize,
      dispose: () => {
        const span = instrumentation.lifecycleSpan({
          event: 'factory_dispose',
          key,
        })
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

  if (delegate instanceof TransientFactory) {
    return ServiceFactory.transient<T, D>({
      provides: delegate.provides,
      dependsOn: delegate.dependsOn,
      initialize: initialize,
    })
  }

  // An unknown implementation gives no way to tell a real initialization
  // from a memoized cache hit, so its lifetime semantics cannot be
  // preserved. Refuse loudly rather than degrade silently.
  throw new TypeError(
    `Cannot instrument factory ${delegate.constructor.name} for ${key.name}. ` +
      'Factories must be created with ServiceFactory.singleton() or ' +
      'ServiceFactory.transient(); custom ServiceFactory implementations cannot be instrumented.',
  )
}

/**
 * Wraps a module so its public entry points are reported to the
 * instrumentation. `get` and `getOrNull` are reported as `module_get` /
 * `module_get_or_null` spans around the whole resolution, dependencies
 * included, and `dispose` as a `module_dispose` span around the teardown
 * of every factory. A `getOrNull` miss ends its span successfully.
 * Returning null is that operation working as intended, not a failure.
 * Everything else, including the factories array, is served by the
 * module untouched.
 */
function instrumentServiceModule(
  instrumentation: ServiceInstrumentation,
  module: ServiceModule,
): ServiceModule {
  const resolution = async <T>(
    event: 'module_get' | 'module_get_or_null',
    key: ServiceKey<unknown>,
    resolve: () => Promise<T>,
  ): Promise<T> => {
    const span = instrumentation.lifecycleSpan({ event, key })
    try {
      const instance = await span.run(resolve)
      span.end({ type: 'success' })
      return instance
    } catch (error) {
      span.end({ type: 'failure', error })
      throw error
    }
  }

  const get = <T>(key: ServiceKey<T>): Promise<T> =>
    resolution('module_get', key, () => module.get(key))

  const getOrNull = <T>(key: ServiceKey<T>): Promise<T | null> =>
    resolution('module_get_or_null', key, () => module.getOrNull(key))

  const dispose = (): void => {
    const span = instrumentation.lifecycleSpan({ event: 'module_dispose' })
    try {
      span.run(() => module.dispose())
      span.end({ type: 'success' })
    } catch (error) {
      span.end({ type: 'failure', error })
      throw error
    }
  }

  return new Proxy(module, {
    get(target, prop) {
      if (prop === 'get') {
        return get
      }
      if (prop === 'getOrNull') {
        return getOrNull
      }
      if (prop === 'dispose') {
        return dispose
      }
      return Reflect.get(target, prop)
    },
  })
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
