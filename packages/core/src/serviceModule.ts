import { ServiceKey, SelectorKey } from './serviceKey'
import { type ServiceFactory } from './serviceFactory'
import { Selector } from './serviceSelector'
import { NoSuchFactoryError, ModuleValidationError } from './errors'

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
  private constructor(readonly factories: ServiceFactory[]) {
    checkCircularDependencies(this.factories)
    checkMissingDependencies(this.factories)
  }

  /**
   * Retrieves an instance for the given ServiceKey.
   *
   * @param key - The key of the service to retrieve.
   * @return A promise that resolves to the service instance.
   * @throws {NoSuchFactoryError} If no suitable factory is found for the given key.
   */
  public async get<T>(key: ServiceKey<T>): Promise<T> {
    const factory = this.factories.find((candidate) => {
      return isSuitable(key, candidate)
    })

    // Check if a factory to supply the requested key was not found
    if (!factory) {
      throw new NoSuchFactoryError(
        `Could not find a suitable factory for ${key.name}`,
      )
    }

    // Check if the factory has an instance already
    const instance = factory.getInstance()
    if (instance) {
      return instance.value as T
    }

    // Resolve all dependencies first
    const dependencies = await Promise.all(
      factory.dependsOn.map((dependencyKey) => {
        // If the dependency is a SelectorKey, create a Selector instance
        if (dependencyKey instanceof SelectorKey) {
          return new Selector(this, dependencyKey)
        }
        return this.get(dependencyKey)
      }),
    )

    // Call the factory to retrieve the dependency
    return factory.initialize(...dependencies)
  }

  /**
   * Retrieves the value associated with the given service key or returns null if the service is not found.
   *
   * @param key - The key used to retrieve the associated service.
   * @return A promise that resolves to the service value if found, or null if the service is not found.
   */
  public async getOrNull<T>(key: ServiceKey<T>): Promise<T | null> {
    try {
      return await this.get(key)
    } catch (error) {
      if (error instanceof NoSuchFactoryError) {
        return null
      }
      throw error
    }
  }

  /**
   * Disposes of all service factories in this module, releasing any resources
   * or instances they hold. Factories are disposed in reverse-topological
   * order, so dependents are disposed before the factories they depend on.
   *
   * @return No return value.
   */
  public dispose() {
    sortReverseTopologically(this.factories).forEach((factory) => {
      factory.dispose?.()
    })
  }

  /**
   * Creates a new `ServiceModule` instance by merging an array of `ServiceModule` or `ServiceFactory` entries.
   * If multiple factories provide the same `ServiceKey`, the last factory encountered in the list will take precedence.
   *
   * @param entries An array of `ServiceModule` or `erviceFactory` instances to be merged.
   * @return A new `ServiceModule` containing the merged factories, with duplicates resolved in a last-wins manner.
   */
  static from(entries: (ServiceModule | ServiceFactory)[]): ServiceModule {
    // Flatten entries and keep only the last factory for each ServiceKey
    const flattened = entries.flatMap((e) => {
      return e instanceof ServiceModule ? e.factories : [e]
    })

    const factoriesByKey = new Map<symbol, ServiceFactory>()
    // Later factories overwrite earlier ones (last-wins)
    for (const f of flattened) {
      factoriesByKey.set(f.provides.symbol, f)
    }

    return new ServiceModule(Array.from(factoriesByKey.values()))
  }
}

/**
 * Validates that there are no circular dependencies among the provided factories.
 *
 * @param factories The list of factories to check for cycles.
 * @throws {ModuleValidationError} If a circular dependency is detected.
 */
function checkCircularDependencies(factories: ServiceFactory[]) {
  const factoryMap = new Map<symbol, ServiceFactory>()
  for (const f of factories) {
    factoryMap.set(f.provides.symbol, f)
  }

  const visited = new Set<symbol>()
  const stack = new Set<symbol>()

  function walk(factory: ServiceFactory, path: string[]) {
    const symbol = factory.provides.symbol

    if (stack.has(symbol)) {
      const cycle = [...path, factory.provides.name]
      const frames = cycle.slice(0, -1).map((name, index) => {
        const edge = `${name} factory depends on ${cycle[index + 1]}`
        return index === cycle.length - 2 ? `${edge} (circular)` : edge
      })
      throw new ModuleValidationError(
        `Circular dependency detected:\n${frames.map((frame) => `    ${frame}`).join('\n')}`,
      )
    }

    if (visited.has(symbol)) {
      return
    }

    visited.add(symbol)
    stack.add(symbol)

    for (const depKey of factory.dependsOn) {
      const keysToCheck =
        depKey instanceof SelectorKey ? depKey.values : [depKey]

      for (const key of keysToCheck) {
        const depFactory = factoryMap.get(key.symbol)
        if (depFactory) {
          walk(depFactory, [...path, factory.provides.name])
        }
      }
    }

    stack.delete(symbol)
  }

  for (const factory of factories) {
    walk(factory, [])
  }
}

/**
 * Validates that all dependencies of a given factory are present in the list of factories.
 *
 * @param factories The list of available factories in the module.
 * @throws {ModuleValidationError} If any dependency is missing.
 */
function checkMissingDependencies(factories: ServiceFactory[]) {
  const issues = factories.reduce((acc, factory) => {
    const frames: string[] = []

    factory.dependsOn.forEach((dependencyKey) => {
      // For SelectorKey, trace each contained key that is not registered
      if (dependencyKey instanceof SelectorKey) {
        dependencyKey.values.forEach((key) => {
          if (!isRegistered(key, factories)) {
            frames.push(key.name)
          }
        })
      } else if (!isRegistered(dependencyKey, factories)) {
        frames.push(dependencyKey.name)
      }
    })

    if (frames.length !== 0) {
      acc.push(
        `${factory.provides.name} factory will fail to initialize because it depends on service keys that no factory provides:\n${frames.map((frame) => `    ${frame}`).join('\n')}`,
      )
    }

    return acc
  }, new Array<string>())

  if (issues.length > 0) {
    throw new ModuleValidationError(issues.join('\n\n'))
  }
}

/**
 * Sorts factories in reverse-topological order, so every factory appears
 * before the factories it depends on. Assumes the graph is acyclic, which
 * module creation already guarantees.
 *
 * @param factories The list of factories to sort.
 * @returns A new array with the factories in dependents-first order.
 */
function sortReverseTopologically(
  factories: ServiceFactory[],
): ServiceFactory[] {
  const factoryMap = new Map<symbol, ServiceFactory>()
  for (const f of factories) {
    factoryMap.set(f.provides.symbol, f)
  }

  const visited = new Set<symbol>()
  const sorted = new Array<ServiceFactory>(factories.length)
  let nextSlot = factories.length

  function walk(factory: ServiceFactory) {
    const symbol = factory.provides.symbol
    if (visited.has(symbol)) {
      return
    }
    visited.add(symbol)

    for (const depKey of factory.dependsOn) {
      const keysToCheck =
        depKey instanceof SelectorKey ? depKey.values : [depKey]

      for (const key of keysToCheck) {
        const depFactory = factoryMap.get(key.symbol)
        if (depFactory) {
          walk(depFactory)
        }
      }
    }

    // Post-order fills dependencies toward the back, leaving earlier slots
    // for their dependents
    sorted[--nextSlot] = factory
  }

  for (const factory of factories) {
    walk(factory)
  }

  return sorted
}

/**
 * Checks if a ServiceKey is registered among the provided factories.
 *
 * @param key The ServiceKey to look for.
 * @param factories The list of factories to search in.
 * @returns True if a factory provides the given key, false otherwise.
 */
function isRegistered(key: ServiceKey<unknown>, factories: ServiceFactory[]) {
  return factories.some((factory) => factory.provides?.symbol === key?.symbol)
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
  factory: ServiceFactory,
): factory is ServiceFactory<T, D> {
  return factory?.provides?.symbol === key?.symbol
}
