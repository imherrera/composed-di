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
   * Factories excluded from instrumentation by {@link ServiceInstrumentation.optOut},
   * shared across every instrumentation instance and backend: a factory
   * opted out here is skipped by install(), regardless of which
   * ServiceInstrumentation wraps it.
   */
  private static readonly optedOut = new WeakSet<ServiceFactory>()

  /**
   * Factories produced by this instrumentation's install(), so overlapping
   * installs pass them through unchanged instead of wrapping them twice
   * (which would report every operation twice).
   */
  private readonly instrumented = new WeakSet<ServiceFactory>()

  /**
   * Called when initialization of a service starts.
   *
   * @param context - Identifies the service being initialized.
   * @returns The span to notify when initialization finishes.
   */
  abstract onInitialize(context: InitializeContext): OperationSpan

  /**
   * Called when disposal of a service starts.
   *
   * @param context - Identifies the service being disposed.
   * @returns The span to notify when disposal finishes.
   */
  abstract onDispose(context: DisposeContext): OperationSpan

  /**
   * Called when a method call on a service instance starts.
   *
   * @param context - Identifies the service and method, and carries the
   * call's arguments when argument capture is enabled.
   * @returns The span to notify when the call finishes — for methods that
   * return a promise, when that promise settles.
   */
  abstract onMethodCall(context: MethodCallContext): OperationSpan

  /**
   * Wraps a service factory so this instrumentation observes the service
   * it provides: {@link ServiceInstrumentation.onInitialize | onInitialize},
   * {@link ServiceInstrumentation.onDispose | onDispose}, and
   * {@link ServiceInstrumentation.onMethodCall | onMethodCall} fire for
   * its lifecycle and method calls.
   *
   * @remarks
   * The service instance is wrapped in a Proxy to observe method calls,
   * and errors are rethrown after being reported, so behavior is
   * otherwise unchanged.
   *
   * Two kinds of factories are returned as-is instead of being wrapped:
   * factories excluded via {@link ServiceInstrumentation.optOut | optOut},
   * and factories this instrumentation itself produced — so overlapping
   * installs never double-report an operation. The latter makes layered
   * composition safe: a base module can install instrumentation where it
   * is defined, and a higher-level module can install over everything it
   * aggregates without tracking what is already wrapped.
   *
   * @param factory - The factory to wrap.
   * @param options - What runtime values (arguments, results) are
   * captured and how they are redacted before reaching this
   * instrumentation; nothing is captured when omitted.
   * @returns The wrapped factory — or `factory` itself when it is opted
   * out or already wrapped — ready to be composed into a ServiceModule.
   */
  install(factory: ServiceFactory, options?: InstrumentOptions): ServiceFactory
  /**
   * Wraps each of the given service factories: the array form of
   * {@link ServiceInstrumentation.install | install}, convenient for
   * instrumenting many factories — or a whole module — at once.
   *
   * @example Wrapping factories, with a capture policy
   * ```ts
   * const module = ServiceModule.from(
   *   otel.install([db, cache, api], {
   *     capture: {
   *       arguments: true,
   *       results: true,
   *       redactionRules: [redactionRule(VaultKey).redact('getSecret').build()],
   *     },
   *   }),
   * );
   * ```
   *
   * @example Instrumenting an already-built module as a whole
   * ```ts
   * const handlerModule = ServiceModule.from(otel.install(PaymentsModule.factories));
   * ```
   *
   * @param factories - The factories to wrap.
   * @param options - What runtime values (arguments, results) are
   * captured and how they are redacted before reaching this
   * instrumentation; nothing is captured when omitted.
   * @returns A new array in which each factory is wrapped, subject to the
   * single-factory overload's rules, ready for `ServiceModule.from`.
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

    if (
      ServiceInstrumentation.isOptedOut(input) ||
      this.isInstrumented(input)
    ) {
      return input
    }

    const instrumentedFactory = instrumentServiceFactory(this, options, input)
    this.instrumented.add(instrumentedFactory)
    return instrumentedFactory
  }

  /**
   * Excludes the given factories from instrumentation: every
   * {@link ServiceInstrumentation.install | install} — by any
   * instrumentation — returns them unchanged instead of wrapping them.
   *
   * @remarks
   * Opting out is preventive, not retroactive: it stops future installs
   * from wrapping a factory, but never removes instrumentation already
   * applied — a wrapper that is opted out keeps reporting through its
   * existing layers. To exclude a factory entirely, opt it out before the
   * first install.
   *
   * @param input - The factory or factories to exclude; a single factory
   * may be passed without the array.
   * @returns The same `input`, so a factory can be opted out inline where
   * it is defined or installed.
   */
  static optOut<E extends ServiceFactory | ServiceFactory[]>(input: E): E {
    if (!Array.isArray(input)) {
      ServiceInstrumentation.optedOut.add(input)
    } else {
      input.forEach((factory) => {
        ServiceInstrumentation.optedOut.add(factory)
      })
    }

    return input
  }

  /**
   * Whether the factory has been excluded from instrumentation via
   * {@link ServiceInstrumentation.optOut | optOut}.
   *
   * @param factory - The factory to check.
   * @returns `true` when install() returns the factory unchanged instead
   * of wrapping it.
   */
  static isOptedOut(factory: ServiceFactory): boolean {
    return ServiceInstrumentation.optedOut.has(factory)
  }

  /**
   * Whether the factory is a wrapper produced by an earlier
   * {@link ServiceInstrumentation.install | install} of this
   * instrumentation.
   *
   * @param factory - The factory to check.
   * @returns `true` when the factory already reports to this
   * instrumentation, in which case install() returns it unchanged rather
   * than wrapping it a second time.
   */
  isInstrumented(factory: ServiceFactory): boolean {
    return this.instrumented.has(factory)
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

  // The class name qualifies method calls in events, but only for named
  // classes: plain object literals and null-prototype objects report no
  // class name, so instrumentations fall back to the service key.
  const name = thing.constructor?.name
  const className = name && name !== 'Object' ? name : undefined

  return new Proxy(thing, {
    get(target, prop) {
      const value = Reflect.get(target, prop)
      if (typeof value === 'function' && typeof prop === 'string') {
        return (...args: unknown[]) => {
          const span = instrumentation.onMethodCall({
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
