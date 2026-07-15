import { ServiceFactory, ServiceKey, ServiceModule } from '@composed-di/core';
import type { EventSpan, ServiceInstrumentation } from './serviceInstrumentation';

type GenericFactory = ServiceFactory<unknown, readonly ServiceKey<any>[]>;

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
 * const module = ServiceModule.from(instrument([db, cache, api], otel));
 * ```
 *
 * @param entries - An array of ServiceModule or factory instances to wrap.
 * @param instrumentation - The instrumentation notified of service
 * lifecycle events and method calls.
 * @return The wrapped factories, ready to be passed to ServiceModule.from.
 */
export function instrument(
  entries: (ServiceModule | GenericFactory)[],
  instrumentation: ServiceInstrumentation,
): GenericFactory[] {
  return entries
    .flatMap((e) => (e instanceof ServiceModule ? e.factories : [e]))
    .map((factory) => makeObservable(instrumentation, factory));
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
 * @param instrumentation The instrumentation notified of lifecycle and method call events.
 * @param delegate The original service factory to be instrumented.
 * @return A new service factory that provides the same dependencies but includes event notification logic.
 */
function makeObservable<T, D extends readonly ServiceKey<any>[]>(
  instrumentation: ServiceInstrumentation,
  delegate: ServiceFactory<any, D>,
): ServiceFactory<T, D> {
  const key = delegate.provides;

  return ServiceFactory.singleton({
    scope: delegate.scope,
    provides: delegate.provides,
    dependsOn: delegate.dependsOn,
    dispose: () => {
      const dispose = delegate.dispose;
      if (dispose) {
        const span = instrumentation.onDispose?.({ key });
        try {
          invokeWithin(span, dispose);
        } catch (error) {
          span?.end({ type: 'failure', error });
          throw error;
        }
        span?.end({ type: 'success', value: undefined });
      }
    },
    initialize: async (...args) => {
      const span = instrumentation.onInitialize?.({ key });
      try {
        const instance = observeMethodCalls(
          await invokeWithin(span, () => delegate.initialize(...args)),
          instrumentation,
          key,
        );
        span?.end({ type: 'success', value: instance });
        return instance;
      } catch (error) {
        span?.end({ type: 'failure', error });
        throw error;
      }
    },
  });
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
 * @return A Proxy wrapping the input object, with all method calls being reported.
 */
function observeMethodCalls(
  thing: any,
  instrumentation: ServiceInstrumentation,
  key: ServiceKey<unknown>,
): any {
  if (typeof thing !== 'object' || thing === null) {
    return thing;
  }

  const className = classNameOf(thing);

  return new Proxy(thing, {
    get(target, prop) {
      const value = Reflect.get(target, prop);
      if (typeof value === 'function' && typeof prop === 'string') {
        return (...args: unknown[]) => {
          const span = instrumentation.onMethodCall?.({
            key,
            className,
            functionName: prop,
            args,
          });
          try {
            const result = invokeWithin(span, () => value.apply(target, args));
            if (result instanceof Promise) {
              return result.then(
                (resolved) => {
                  span?.end({ type: 'success', value: resolved });
                  return resolved;
                },
                (error) => {
                  span?.end({ type: 'failure', error });
                  throw error;
                },
              );
            }
            span?.end({ type: 'success', value: result });
            return result;
          } catch (error) {
            span?.end({ type: 'failure', error });
            throw error;
          }
        };
      }
      return value;
    },
  });
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
  return span ? span.run(fn) : fn();
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
  const name = thing.constructor?.name;
  return name && name !== 'Object' ? name : undefined;
}
