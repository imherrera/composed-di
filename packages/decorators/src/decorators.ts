import { ServiceKey } from '@composed-di/core'
import { keyOf } from './keyOf'
import { LifecycleRegistry } from './lifecycleRegistry'
import type { Constructor, ServiceToken } from './types'
import { DisposeHookError, FieldInjectionError } from './errors'
import { activeFieldStash, type FieldInjection } from './metadata'

/**
 * Declares a class as a **singleton** service: once registered with
 * `syntheticFactory`, the first request constructs the instance and every
 * request thereafter shares it.
 *
 * The decorator also mints the class's `ServiceKey` and stamps it under
 * `classKey`, making the class itself usable as a token — in
 * `module.get` and in `@Inject`.
 *
 * This is a standard TC39 class decorator: no `experimentalDecorators` or
 * metadata emission is required.
 *
 * @example
 * ```typescript
 * @Singleton
 * class GasolineTank implements EngineTank {
 *   consume(): void {}
 * }
 *
 * const module = ServiceModule.from([syntheticFactory(GasolineTank)])
 * const tank = await module.get(GasolineTank)
 * ```
 */
export function Singleton<C extends Constructor<object>>(
  constructor: C,
  context: ClassDecoratorContext<C>,
): void {
  LifecycleRegistry.register(constructor, context, 'singleton')
}

/**
 * Declares a class as a **one-shot** service: once registered with
 * `syntheticFactory`, every request constructs a fresh instance — no caching,
 * no deduplication, and no framework-managed disposal (cleanup belongs
 * entirely to whoever requested the instance).
 *
 * The decorator also mints the class's `ServiceKey` and stamps it under
 * `classKey`, making the class itself usable as a token — in
 * `module.get` and in `@Inject`.
 *
 * This is a standard TC39 class decorator: no `experimentalDecorators` or
 * metadata emission is required.
 */
export function OneShot<C extends Constructor<object>>(
  constructor: C,
  context: ClassDecoratorContext<C>,
): void {
  LifecycleRegistry.register(constructor, context, 'oneShot')
}

/**
 * Marks a method as the class's teardown: when the module disposes the
 * singleton, this method is called on the retained instance. Exactly one per
 * class, instance methods only, and only on `@Singleton` classes — one-shot
 * instances are never disposed by the container.
 *
 * @example
 * ```typescript
 * @Singleton
 * class Database {
 *   @OnDispose
 *   close() {
 *     this.connection.end()
 *   }
 * }
 * ```
 */
export function OnDispose<This>(
  _method: (this: This) => void,
  context: ClassMethodDecoratorContext<This, (this: This) => void>,
): void {
  if (context.static) {
    throw new DisposeHookError(
      `@OnDispose cannot be applied to the static method ${String(context.name)}`,
    )
  }
  LifecycleRegistry.addPendingDispose({
    name: context.name,
    isPrivate: context.private,
    invoke: (instance) => {
      context.access.get(instance as This).call(instance as This)
    },
  })
}

/**
 * Declares that a field receives a service resolved from the module: the
 * token's service becomes the field's value during construction, before the
 * constructor body runs, so it is already usable there.
 *
 * The token's service type is checked against the field's type at compile
 * time. Tokens are either `ServiceKey`s (required for interface-typed fields,
 * since interfaces erase at runtime) or classes that already carry a
 * lifecycle decorator.
 *
 * A class with `@Inject` fields is constructible only through a
 * `ServiceModule`: constructing it manually with `new` throws
 * {@link FieldInjectionError}. It must also carry `@Singleton` or `@OneShot`,
 * which is what claims the fields recorded here.
 *
 * Each field is its own request: two fields injecting the same `@OneShot`
 * class receive distinct instances, owned by the injecting class. Two fields
 * injecting the same `@Singleton` class are a definition-time error — they
 * could only share one instance.
 *
 * This is a standard TC39 field decorator: no `experimentalDecorators` or
 * metadata emission is required.
 *
 * @example
 * ```typescript
 * @Singleton
 * class Car {
 *   @Inject(engineKey)
 *   readonly engine!: Engine
 * }
 * ```
 */
export function Inject<T>(token: ServiceToken<T>) {
  const key = token instanceof ServiceKey ? token : keyOf(token)

  return function <This>(
    _value: undefined,
    context: ClassFieldDecoratorContext<This, T>,
  ): (this: This, initial: T) => T {
    if (context.static) {
      throw new FieldInjectionError(
        `@Inject(${key.name}) cannot be applied to the static field ${String(context.name)}`,
      )
    }
    const field: FieldInjection = { name: context.name, key }
    LifecycleRegistry.addPendingField(field)

    return function (this: This, _initial: T): T {
      const owner = (this as object).constructor.name
      const label = `${owner}.${String(context.name)}`

      const stash = activeFieldStash()
      if (stash === undefined) {
        throw new FieldInjectionError(
          `${label}: @Inject fields are resolved by a ServiceModule — retrieve ${owner} through the module instead of constructing it with new`,
        )
      }
      if (!stash.values.has(field)) {
        throw new FieldInjectionError(
          `${label}: no resolved instance for ${key.name} — the field is not part of the class registration (is the class's lifecycle decorator missing?)`,
        )
      }

      stash.consumed.add(field)
      return stash.values.get(field) as T
    }
  }
}
