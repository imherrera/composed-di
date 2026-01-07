import { ServiceKey, ServiceSelectorKey } from './serviceKey';
import { ServiceFactory } from './serviceFactory';
import { ServiceScope } from './serviceScope';
import { ServiceSelector } from './serviceSelector';
import { ServiceFactoryNotFoundError, ServiceModuleInitError } from './errors';

type GenericFactory = ServiceFactory<unknown, readonly ServiceKey<any>[]>;
type GenericKey = ServiceKey<any>;

export class ServiceModule {
  private constructor(readonly factories: GenericFactory[]) {
    factories.forEach((factory) => {
      checkRecursiveDependencies(factory);
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
   * Disposes of service factories within the specified scope or all factories if no scope is provided.
   *
   * This method is useful for cleaning up resources and instances held by service factories,
   * such as singleton factories, as they may hold database connections or other resources that need to be released.
   *
   * @param {ServiceScope} [scope] The scope to filter the factories to be disposed.
   * If not provided, all factories are disposed of.
   * @return {void} No return value.
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
   * @param {Array<ServiceModule | GenericFactory>} entries - An array of ServiceModule or GenericFactory
   * instances to be processed into a single ServiceModule.
   * @return {ServiceModule} A new ServiceModule containing the deduplicated factories.
   * @throws {ServiceModuleInitError} If circular or missing dependencies are detected during module creation.
   */
  static from(entries: (ServiceModule | GenericFactory)[]): ServiceModule {
    // Flatten entries and keep only the last factory for each ServiceKey
    const flattened = entries.flatMap((e) =>
      e instanceof ServiceModule ? e.factories : [e],
    );

    const byKey = new Map<symbol, GenericFactory>();
    // Later factories overwrite earlier ones (last-wins)
    for (const f of flattened) {
      byKey.set(f.provides.symbol, f);
    }

    return new ServiceModule(Array.from(byKey.values()));
  }
}

function checkRecursiveDependencies(factory: GenericFactory) {
  const recursive = factory.dependsOn.some((dependencyKey) => {
    return dependencyKey === factory.provides;
  });

  if (recursive) {
    throw new ServiceModuleInitError(
      'Recursive dependency detected on: ' + factory.provides.name,
    );
  }
}

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

function isRegistered(key: GenericKey, factories: GenericFactory[]) {
  return factories.some((factory) => factory.provides?.symbol === key?.symbol);
}

function isSuitable<T, D extends readonly ServiceKey<any>[]>(
  key: ServiceKey<T>,
  factory: ServiceFactory<any, D>,
): factory is ServiceFactory<T, D> {
  return factory?.provides?.symbol === key?.symbol;
}
