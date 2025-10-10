import { ServiceKey } from './ServiceKey';
import { ServiceFactory } from './ServiceFactory';

export class ServiceModule {
  readonly factories: ServiceFactory<any, any>[] = [];

  constructor(
    factories: Set<ServiceFactory<unknown, readonly ServiceKey<unknown>[]>>,
  ) {
    this.factories = Array.from(factories);
    this.factories.forEach((factory) => {
      checkRecursiveDependencies(factory);
      checkMissingDependencies(factory, this.factories);
    });
  }

  public async get<T>(key: ServiceKey<T>): Promise<T> {
    const factory = this.factories.find((factory) => {
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

  static from(
    entries: (ServiceModule | ServiceFactory<unknown, readonly ServiceKey<unknown>[]>)[],
  ): ServiceModule {
    return new ServiceModule(
      new Set(
        entries.flatMap((e) => {
          if (e instanceof ServiceModule) {
            return e.factories;
          } else {
            return [e];
          }
        }),
      ),
    );
  }
}

function checkRecursiveDependencies(
  factory: ServiceFactory<unknown, readonly ServiceKey<unknown>[]>,
) {
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
  factory: ServiceFactory<unknown, readonly ServiceKey<unknown>[]>,
  factories: ServiceFactory<unknown>[],
) {
  const missingDependencies = factory.dependsOn.filter(
    (dependencyKey: ServiceKey<any>) => {
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

function isRegistered(
  key: ServiceKey<unknown>,
  factories: ServiceFactory<unknown>[],
) {
  return factories.some((factory) => factory.provides === key);
}

function isSuitable<T, D extends readonly ServiceKey<unknown>[]>(
  key: ServiceKey<T>,
  factory: ServiceFactory<unknown, D>,
): factory is ServiceFactory<T, D> {
  return factory?.provides === key;
}
