import { ServiceFactory, type ServiceKey, SelectorKey } from '@composed-di/core'
import type { Constructor } from './types.js'
import { DecoratorValidationError } from './errors.js'
import { LifecycleRegistry } from './internal/lifecycleRegistry.js'
import { runWithFieldStash, type FieldStash } from './internal/metadata.js'

/**
 * Creates a factory for a class marked with {@link Singleton} or {@link Transient} you must register the factory into a {@link ServiceModule}.
 *
 * @throws {DecoratorValidationError} If the class has no lifecycle decorator.
 * @throws {TypeError} If the class declares required constructor parameters.
 */
export function factoryOf<C extends Constructor<object>>(
  constructor: C,
): ServiceFactory<InstanceType<C>> {
  const registration = LifecycleRegistry.get(constructor)
  if (!registration) {
    throw new DecoratorValidationError(
      `class ${constructor.name} has no lifecycle decorator. Apply @Singleton or @Transient to register it with factoryOf`,
    )
  }
  if (constructor.length > 0) {
    throw new TypeError(
      `class ${constructor.name} declares required constructor parameters. Decorator-registered classes take dependencies through @Inject fields only`,
    )
  }

  const injectedFields = LifecycleRegistry.getInjectedFields(constructor)
  const dependsOn = injectedFields.map((field) => field.key)

  const initialize = (...dependencies: unknown[]) => {
    const stash: FieldStash = {
      values: new Map(),
      consumed: new Set(),
    }

    injectedFields.forEach((field, index) => {
      stash.values.set(field, dependencies[index])
    })

    const instance = runWithFieldStash(stash, () => new constructor())

    if (stash.consumed.size !== stash.values.size) {
      const missed = injectedFields
        .filter((field) => !stash.consumed.has(field))
        .map((field) => String(field.name))
      throw new DecoratorValidationError(
        `class ${constructor.name}: the @Inject fields [${missed.join(', ')}] were resolved but never read during construction. This is an internal composed-di invariant violation, not a class declaration issue -- please file a bug report with a minimal repro`,
      )
    }

    return instance as InstanceType<C>
  }

  const provides = registration.key as ServiceKey<InstanceType<C>>

  if (registration.lifecycle === 'transient') {
    return ServiceFactory.transient({ provides, dependsOn, initialize })
  }

  return ServiceFactory.singleton({
    provides,
    dependsOn,
    initialize,
    dispose: registration.dispose?.invoke,
  })
}

/**
 * Creates a factory for each of the given decorated classes, in
 * order. The variadic companion of {@link factoryOf}, useful to register
 * several classes in one {@link ServiceModule} instance.
 *
 * @param constructors The classes to register. Each must carry a lifecycle decorator.
 * @return One factory per class.
 * @throws {DecoratorValidationError} If any class has no lifecycle decorator.
 */
export function factoriesOf(
  ...constructors: [Constructor<object>, ...Constructor<object>[]]
): ServiceFactory[] {
  return constructors.map((constructor) => factoryOf(constructor))
}

/**
 * Returns the key of a decorated class. Reads the class's own key only,
 * so a subclass never inherits its parent's.
 *
 * @param constructor The class to read the key from.
 * @return The class's own key.
 * @throws {DecoratorValidationError} If the class has no lifecycle decorator.
 */
export function keyOf<T>(constructor: Constructor<T>): ServiceKey<T> {
  const key = LifecycleRegistry.getServiceKey(constructor)
  if (key === undefined) {
    throw new DecoratorValidationError(
      `class ${constructor.name} has no lifecycle decorator. Apply @Singleton or @Transient before using it as a token`,
    )
  }
  return key as ServiceKey<T>
}

/**
 * Creates a selector key for runtime selection among implementations of a shared type.
 *
 * @param constructors The classes to group. Each must carry a lifecycle decorator.
 * @return A selector key over the classes' own keys.
 * @throws {DecoratorValidationError} If any class has no lifecycle decorator.
 */
export function selectorOf<T>(
  ...constructors: [Constructor<T>, ...Constructor<T>[]]
): SelectorKey<T> {
  return new SelectorKey(constructors.map((constructor) => keyOf(constructor)))
}
