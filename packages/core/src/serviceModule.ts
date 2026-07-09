import { ServiceKey, ServiceSelectorKey } from './serviceKey';
import { ServiceFactory } from './serviceFactory';
import { ServiceScope } from './serviceScope';
import { ServiceSelector } from './serviceSelector';
import { ServiceFactoryNotFoundError, ServiceModuleInitError } from './errors';
import type { ServiceEventListener } from './serviceEventListener';

type GenericFactory = ServiceFactory<unknown, readonly ServiceKey<any>[]>;
type GenericKey = ServiceKey<any>;

/**
 * ServiceModule is a container for service factories and manages dependency resolution.
 *
 * It provides a way to retrieve service instances based on their ServiceKey,
 * ensuring that all dependencies are resolved and initialized in the correct order.
 * It also handles circular dependency detection and missing dependency validation
 * at the time of module creation.
 */
export class ServiceModule {
  /**
   * Private constructor to enforce module creation through the `static from` method.
   *
   * @param factories An array of service factories that this module will manage.
   */
  private constructor(readonly factories: GenericFactory[]) {
    checkCircularDependencies(this.factories);
    factories.forEach((factory) => {
      checkMissingDependencies(factory, this.factories);
    });
  }

  /**
   * Retrieves an instance for the given ServiceKey.
   *
   * @param key - The key of the service to retrieve.
   * @return A promise that resolves to the service instance.
   * @throws {ServiceFactoryNotFoundError} If no suitable factory is found for the given key.
   */
  public async get<T>(key: ServiceKey<T>): Promise<T> {
    const factory = this.factories.find((factory: GenericFactory) => {
      return isSuitable(key, factory);
    });

    // Check if a factory to supply the requested key was not found
    if (!factory) {
      throw new ServiceFactoryNotFoundError(
        `Could not find a suitable factory for ${key.name}`,
      );
    }

    // Resolve all dependencies first
    const dependencies = await Promise.all(
      factory.dependsOn.map((dependencyKey: ServiceKey<unknown>) => {
        // If the dependency is a ServiceSelectorKey, create a ServiceSelector instance
        if (dependencyKey instanceof ServiceSelectorKey) {
          return new ServiceSelector(this, dependencyKey);
        }
        return this.get(dependencyKey);
      }),
    );

    // Call the factory to retrieve the dependency
    return factory.initialize(...dependencies);
  }

  /**
   * Retrieves the value associated with the given service key or returns null if the service is not found.
   *
   * @param key - The key used to retrieve the associated service.
   * @return A promise that resolves to the service value if found, or null if the service is not found.
   */
  public async getOrNull<T>(key: ServiceKey<T>): Promise<T | null> {
    try {
      return await this.get(key);
    } catch (error) {
      if (error instanceof ServiceFactoryNotFoundError) {
        return null;
      }
      throw error;
    }
  }

  /**
   * Disposes of service factories within the specified scope or all factories if no scope is provided.
   *
   * This method is useful for cleaning up resources and instances held by service factories,
   * such as singleton factories, as they may hold database connections or other resources that need to be released.
   *
   * @param scope The scope to filter the factories to be disposed.
   * If not provided, all factories are disposed of.
   * @return No return value.
   */
  public dispose(scope?: ServiceScope) {
    const factories = scope
      ? this.factories.filter((f) => f.scope === scope)
      : this.factories;

    factories.forEach((factory) => factory.dispose?.());
  }

  /**
   * Creates a new ServiceModule instance by aggregating and deduplicating a list of
   * ServiceModule or GenericFactory instances.
   * If multiple factories provide the same
   * ServiceKey, the last one in the list takes precedence.
   *
   * When a listener is provided, every factory is wrapped with instrumentation:
   * the listener is notified when a service is initialized or disposed and when
   * a method is called on a service instance, and may return an EventSpan per
   * operation to observe its completion. Service instances are wrapped in a
   * Proxy to observe method calls, and errors are rethrown after being
   * reported, so behavior is otherwise unchanged.
   *
   * @param entries - An array of ServiceModule or GenericFactory
   * instances to be processed into a single ServiceModule.
   * @param listener - An optional ServiceEventListener notified of service
   * lifecycle events and method calls in the resulting module.
   * @return A new ServiceModule containing the deduplicated factories.
   * @throws {ServiceModuleInitError} If circular or missing dependencies are detected during module creation.
   */
  static from(
    entries: (ServiceModule | GenericFactory)[],
    listener?: ServiceEventListener,
  ): ServiceModule {
    // Flatten entries and keep only the last factory for each ServiceKey
    const flattened = entries.flatMap((e) =>
      e instanceof ServiceModule ? e.factories : [e],
    );

    const byKey = new Map<symbol, GenericFactory>();
    // Later factories overwrite earlier ones (last-wins)
    for (const f of flattened) {
      byKey.set(f.provides.symbol, f);
    }

    if (listener) {
      return new ServiceModule(
        Array.from(byKey.values()).map((factory) => {
          return makeObservable(listener, factory);
        }),
      );
    }

    return new ServiceModule(Array.from(byKey.values()));
  }
}

/**
 * Validates that there are no circular dependencies among the provided factories.
 *
 * @param factories The list of factories to check for cycles.
 * @throws {ServiceModuleInitError} If a circular dependency is detected.
 */
function checkCircularDependencies(factories: GenericFactory[]) {
  const factoryMap = new Map<symbol, GenericFactory>();
  for (const f of factories) {
    factoryMap.set(f.provides.symbol, f);
  }

  const visited = new Set<symbol>();
  const stack = new Set<symbol>();

  function walk(factory: GenericFactory, path: string[]) {
    const symbol = factory.provides.symbol;

    if (stack.has(symbol)) {
      const cyclePath = [...path, factory.provides.name].join(' -> ');
      throw new ServiceModuleInitError(
        `Circular dependency detected: ${cyclePath}`,
      );
    }

    if (visited.has(symbol)) {
      return;
    }

    visited.add(symbol);
    stack.add(symbol);

    for (const depKey of factory.dependsOn) {
      const keysToCheck =
        depKey instanceof ServiceSelectorKey ? depKey.values : [depKey];

      for (const key of keysToCheck) {
        const depFactory = factoryMap.get(key.symbol);
        if (depFactory) {
          walk(depFactory, [...path, factory.provides.name]);
        }
      }
    }

    stack.delete(symbol);
  }

  for (const factory of factories) {
    walk(factory, []);
  }
}

/**
 * Validates that all dependencies of a given factory are present in the list of factories.
 *
 * @param factory The factory whose dependencies are to be checked.
 * @param factories The list of available factories in the module.
 * @throws {ServiceModuleInitError} If any dependency is missing.
 */
function checkMissingDependencies(
  factory: GenericFactory,
  factories: GenericFactory[],
) {
  const missingDependencies: GenericKey[] = [];

  factory.dependsOn.forEach((dependencyKey: GenericKey) => {
    // For ServiceSelectorKey, check all contained keys are registered
    if (dependencyKey instanceof ServiceSelectorKey) {
      dependencyKey.values.forEach((key) => {
        if (!isRegistered(key, factories)) {
          missingDependencies.push(key);
        }
      });
    } else if (!isRegistered(dependencyKey, factories)) {
      missingDependencies.push(dependencyKey);
    }
  });

  if (missingDependencies.length === 0) {
    return;
  }

  const dependencyList = missingDependencies
    .map((dependencyKey) => ` -> ${dependencyKey.name}`)
    .join('\n');
  throw new ServiceModuleInitError(
    `${factory.provides.name} will fail because it depends on:\n ${dependencyList}`,
  );
}

/**
 * Checks if a ServiceKey is registered among the provided factories.
 *
 * @param key The ServiceKey to look for.
 * @param factories The list of factories to search in.
 * @returns True if a factory provides the given key, false otherwise.
 */
function isRegistered(key: GenericKey, factories: GenericFactory[]) {
  return factories.some((factory) => factory.provides?.symbol === key?.symbol);
}

/**
 * Determines if a factory is suitable for providing a specific ServiceKey.
 *
 * @param key The ServiceKey being requested.
 * @param factory The factory to check.
 * @returns True if the factory provides the key, false otherwise.
 */
function isSuitable<T, D extends readonly ServiceKey<any>[]>(
  key: ServiceKey<T>,
  factory: ServiceFactory<any, D>,
): factory is ServiceFactory<T, D> {
  return factory?.provides?.symbol === key?.symbol;
}

/**
 * Wraps a given service factory with instrumentation to notify a listener of
 * lifecycle events and method calls.
 *
 * For each of initialize, dispose, and method calls, the listener is invoked
 * at the start of the operation and may return an EventSpan whose `end` or
 * `error` is called when the operation finishes. Errors are rethrown after
 * being reported.
 *
 * @param listener The listener notified of lifecycle and method call events.
 * @param delegate The original service factory to be instrumented.
 * @return A new service factory that provides the same dependencies but includes event notification logic.
 */
function makeObservable<T, D extends readonly ServiceKey<any>[]>(
  listener: ServiceEventListener,
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
        const span = listener.onDispose?.({ key });
        try {
          dispose();
        } catch (error) {
          span?.error?.(error);
          throw error;
        }
        span?.end?.();
      }
    },
    initialize: async (...args) => {
      const span = listener.onInitialize?.({ key });
      try {
        const instance = observeMethodCalls(
          await delegate.initialize(...args),
          listener,
          key,
        );
        span?.end?.({ result: instance });
        return instance;
      } catch (error) {
        span?.error?.(error);
        throw error;
      }
    },
  });
}

/**
 * Wraps an object with a Proxy to notify the listener of method calls.
 *
 * Methods returning a promise report end/error when the promise settles,
 * not when the method returns.
 *
 * @param thing The object whose method calls need to be observed.
 * @param listener The listener notified of method call events.
 * @param key The service key used to identify the service in events.
 * @return A Proxy wrapping the input object, with all method calls being reported.
 */
function observeMethodCalls(
  thing: any,
  listener: ServiceEventListener,
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
          const span = listener.onMethodCall?.({
            key,
            className,
            methodName: prop,
            args,
          });
          try {
            const result = value.apply(target, args);
            if (result instanceof Promise) {
              return result.then(
                (resolved) => {
                  span?.end?.({ result: resolved });
                  return resolved;
                },
                (error) => {
                  span?.error?.(error);
                  throw error;
                },
              );
            }
            span?.end?.({ result });
            return result;
          } catch (error) {
            span?.error?.(error);
            throw error;
          }
        };
      }
      return value;
    },
  });
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
