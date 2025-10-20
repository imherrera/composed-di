import { ServiceKey } from './ServiceKey';
import { ServiceFactory } from './ServiceFactory';

type GenericFactory = ServiceFactory<unknown, readonly ServiceKey<unknown>[]>;
type GenericKey = ServiceKey<unknown>;

export class ServiceModule {
  private constructor(readonly factories: GenericFactory[]) {
    factories.forEach((factory) => {
      checkRecursiveDependencies(factory);
      checkMissingDependencies(factory, this.factories);
    });
  }

  public async get<T>(key: ServiceKey<T>): Promise<T> {
    const factory = this.factories.find((factory: GenericFactory) => {
      return isSuitable(key, factory);
    });

    // Check if a factory to supply the requested key was not found
    if (!factory) {
      throw new Error(`Could not find a suitable factory for ${key.name}`);
    }

    // Resolve all dependencies first
    const dependencies = await Promise.all(
      factory.dependsOn.map((dependencyKey: ServiceKey<unknown>) => {
        return this.get(dependencyKey);
      }),
    );

    // Call the factory to retrieve the dependency
    return factory.initialize(...dependencies);
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
    throw new Error(
      'Recursive dependency detected on: ' + factory.provides.name,
    );
  }
}

function checkMissingDependencies(
  factory: GenericFactory,
  factories: GenericFactory[],
) {
  const missingDependencies = factory.dependsOn.filter(
    (dependencyKey: GenericKey) => {
      return !isRegistered(dependencyKey, factories);
    },
  );
  if (missingDependencies.length === 0) {
    return;
  }

  const dependencyList = missingDependencies
    .map((dependencyKey) => ` -> ${dependencyKey.name}`)
    .join('\n');
  throw new Error(
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
