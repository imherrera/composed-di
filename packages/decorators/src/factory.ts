import { ServiceFactory, type ServiceKey } from '@composed-di/core'
import { FieldInjectionError, MissingLifecycleError } from './errors.js'
import { LifecycleRegistry } from './lifecycleRegistry.js'
import type { Constructor } from './types.js'
import {
  runWithFieldStash,
  type FieldInjection,
  type FieldStash,
} from './metadata.js'

/**
 * Creates a `ServiceFactory` for a class marked with `@Singleton` or
 * `@OneShot`. The factory provides the class's `ServiceKey`, follows
 * the decorator's lifecycle, depends on the class's `@Inject` fields
 * (including those of decorated base classes), and tears down through its
 * `@OnDispose` method if it has one.
 *
 * Decorator-registered classes must have zero-arg constructors. Dependencies
 * are declared exclusively through `@Inject` fields.
 *
 * @example
 * ```typescript
 * @Singleton
 * class Car {
 *   @Inject(engineKey)
 *   readonly engine!: Engine
 * }
 *
 * const module = ServiceModule.from([factoryOf(Car)])
 * ```
 *
 * @throws {MissingLifecycleError} If the class has no lifecycle decorator.
 * @throws {TypeError} If the class declares required constructor parameters.
 */
export function factoryOf<C extends Constructor<object>>(
  constructor: C,
): ServiceFactory<InstanceType<C>> {
  const registration = LifecycleRegistry.get(constructor)
  if (!registration) {
    throw new MissingLifecycleError(
      `class ${constructor.name} has no lifecycle decorator. Apply @Singleton or @OneShot to register it with factoryOf`,
    )
  }
  if (constructor.length > 0) {
    throw new TypeError(
      `class ${constructor.name} declares required constructor parameters. Decorator-registered classes take dependencies through @Inject fields only`,
    )
  }

  const fields = collectFieldInjections(constructor)
  const dependsOn = fields.map((field) => field.key)

  const initialize = (...dependencies: unknown[]) => {
    const stash: FieldStash = {
      values: new Map(),
      consumed: new Set(),
    }
    fields.forEach((field, index) => {
      stash.values.set(field, dependencies[index])
    })

    const instance = runWithFieldStash(stash, () => new constructor())

    if (stash.consumed.size !== stash.values.size) {
      const missed = fields
        .filter((field) => !stash.consumed.has(field))
        .map((field) => String(field.name))
      throw new FieldInjectionError(
        `class ${constructor.name}: the @Inject fields [${missed.join(', ')}] were never initialized during construction. Their metadata does not belong to this class (is a lifecycle decorator missing on another class that uses @Inject?)`,
      )
    }

    return instance as InstanceType<C>
  }

  const provides = registration.key as ServiceKey<InstanceType<C>>

  if (registration.lifecycle === 'oneShot') {
    return ServiceFactory.oneShot({ provides, dependsOn, initialize })
  }

  return ServiceFactory.singleton({
    provides,
    dependsOn,
    initialize,
    dispose: registration.dispose?.invoke,
  })
}

/**
 * Creates a `ServiceFactory` for each of the given decorated classes, in
 * order. The variadic companion of `factoryOf`, for registering
 * several classes in one `ServiceModule.from` entry.
 *
 * @param constructors The classes to register. Each must carry a lifecycle decorator.
 * @return One factory per class.
 * @throws {MissingLifecycleError} If any class has no lifecycle decorator.
 */
export function factoriesOf(
  ...constructors: [Constructor<object>, ...Constructor<object>[]]
): ServiceFactory[] {
  return constructors.map((constructor) => factoryOf(constructor))
}

/**
 * Collects the `@Inject` fields that will initialize during construction of
 * `cls`. The class's own fields follow those of decorated base classes,
 * base-first, mirroring the order JavaScript runs field initializers in.
 *
 * Only field metadata is inherited this way. The lifecycle decorator itself
 * is not, so `factoryOf` still rejects an undecorated subclass.
 */
function collectFieldInjections(cls: Constructor<object>): FieldInjection[] {
  const chain: FieldInjection[][] = []
  for (
    let current: object | null = cls;
    current !== null;
    current = Object.getPrototypeOf(current)
  ) {
    const registration = LifecycleRegistry.get(current as Constructor<object>)
    if (registration) {
      chain.unshift([...registration.fields])
    }
  }
  return chain.flat()
}
