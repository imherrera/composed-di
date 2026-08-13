import { ServiceFactory, type ServiceKey } from '@composed-di/core'
import { DecoratorValidationError } from './errors.js'
import { LifecycleRegistry } from './lifecycleRegistry.js'
import type { Constructor } from './types.js'
import { runWithFieldStash, type FieldStash } from './metadata.js'

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
