import { SelectorKey, ServiceKey, type Selector } from '@composed-di/core'
import { keyOf } from './keyOf.js'
import { LifecycleRegistry } from './lifecycleRegistry.js'
import type { Constructor, ServiceToken } from './types.js'
import {
  DisposeHookError,
  FieldInjectionError,
  LegacyDecoratorError,
} from './errors.js'
import { activeFieldStash, type FieldInjection } from './metadata.js'

/**
 * Declares a class as a **singleton** service. Once registered with
 * `factoryOf`, the first request constructs the instance and every
 * request thereafter shares it.
 *
 * A decorated class is itself usable as a token in `@Inject`, `@Select`,
 * and `selectorOf`. `keyOf` returns its `ServiceKey` for `ServiceModule.get`.
 *
 * @example
 * ```typescript
 * @Singleton
 * class GasolineTank implements EngineTank {
 *   consume(): void {}
 * }
 *
 * const module = ServiceModule.from([factoryOf(GasolineTank)])
 * const tank = await module.get(keyOf(GasolineTank))
 * ```
 */
export function Singleton<C extends Constructor<object>>(
  constructor: C,
  context: ClassDecoratorContext<C>,
): void {
  assertStandardContext('Singleton', context)
  LifecycleRegistry.register(constructor, context, 'singleton')
}

/**
 * Declares a class as a **one-shot** service. Once registered with
 * `factoryOf`, every request constructs a fresh instance, with no caching,
 * no deduplication, and no framework-managed disposal (cleanup belongs
 * entirely to whoever requested the instance).
 *
 * A decorated class is itself usable as a token in `@Inject`, `@Select`,
 * and `selectorOf`. `keyOf` returns its `ServiceKey` for `ServiceModule.get`.
 */
export function OneShot<C extends Constructor<object>>(
  constructor: C,
  context: ClassDecoratorContext<C>,
): void {
  assertStandardContext('OneShot', context)
  LifecycleRegistry.register(constructor, context, 'oneShot')
}

/**
 * Marks a method as the class's teardown. When the module disposes of the
 * singleton, this method is called on the retained instance. Exactly one per
 * class, instance methods only, and only on {@link Singleton} classes, since
 * the module never disposes of one-shot instances.
 *
 * @example
 * ```typescript
 * @Singleton
 * class Database {
 *   @Dispose
 *   close() {
 *     this.connection.end()
 *   }
 * }
 * ```
 */
export function Dispose<This>(
  _method: (this: This) => void,
  context: ClassMethodDecoratorContext<This, (this: This) => void>,
): void {
  assertStandardContext('Dispose', context)
  if (context.static) {
    throw new DisposeHookError(
      `@Dispose cannot be applied to the static method ${String(context.name)}`,
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
 * Declares that a field receives a service resolved from the module. The
 * token's service becomes the field's value during construction, before the
 * constructor body runs, so it is already usable there.
 *
 * This decorator makes the class constructible only through a module.
 * Constructing it manually with `new` throws {@link FieldInjectionError}.
 *
 * Each field is its own request. Two fields injecting the same {@link OneShot}
 * class receive distinct instances, owned by the injecting class. Two fields
 * injecting the same {@link Singleton} class are a definition-time error because
 * they could only share one instance.
 *
 * @example
 * ```typescript
 * @Singleton
 * class CafeShop {
 *   // We can inject a decorated class directly
 *   @Inject(Barista)
 *   readonly engine!: Barista
 *
 *   // We can inject a key provided by a factory
 *   @Inject(grinderKey)
 *   readonly barista!: Grinder
 * }
 * ```
 */
export function Inject<T>(token: ServiceToken<T>) {
  const key = token instanceof ServiceKey ? token : keyOf(token)

  return function <This>(
    _value: undefined,
    context: ClassFieldDecoratorContext<This, T>,
  ): (this: This, initial: T) => T {
    return injectedField('Inject', key, context)
  }
}

/**
 * Declares that a field receives a `Selector` over the given services. The
 * tokens' keys are grouped under one `SelectorKey`, and the field's value
 * picks among them per call, at runtime.
 *
 * Tokens are `ServiceKey`s or decorated classes, mixed freely. Unlike a
 * one-shot injected directly, the selector is safe in a singleton field. It
 * resolves a fresh instance on every call instead of capturing one.
 *
 * @example
 * ```typescript
 * @Singleton
 * class CafeShop {
 *   @Select<Beans>(ArabicaBeans, RobustaBeans)
 *   private readonly roasts!: Selector<Beans>
 * }
 * ```
 */
export function Select<T>(...tokens: [ServiceToken<T>, ...ServiceToken<T>[]]) {
  const key = new SelectorKey<T>(
    tokens.map((token) => (token instanceof ServiceKey ? token : keyOf(token))),
  )

  return function <This>(
    _value: undefined,
    context: ClassFieldDecoratorContext<This, Selector<T>>,
  ): (this: This, initial: Selector<T>) => Selector<T> {
    return injectedField('Select', key, context)
  }
}

/**
 * Registers `key` as a pending field injection for the class being defined
 * and returns the field initializer that pulls the resolved instance from
 * the active stash. This is the machinery shared by `@Inject` and `@Select`.
 */
function injectedField<This, T>(
  decorator: string,
  key: ServiceKey<T>,
  context: ClassFieldDecoratorContext<This, T>,
): (this: This, initial: T) => T {
  assertStandardContext(decorator, context)
  if (context.static) {
    throw new FieldInjectionError(
      `@${decorator}(${key.name}) cannot be applied to the static field ${String(context.name)}`,
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
        `${label}: @${decorator} fields are resolved by a ServiceModule. Retrieve ${owner} through the module instead of constructing it with new`,
      )
    }
    if (!stash.values.has(field)) {
      throw new FieldInjectionError(
        `${label}: no resolved instance for ${key.name}. The field is not part of the class registration (is the class's lifecycle decorator missing?)`,
      )
    }

    stash.consumed.add(field)
    return stash.values.get(field) as T
  }
}

/**
 * Rejects calls made with the legacy decorator protocol, which passes a
 * property key or `undefined` where the standard protocol passes a context
 * object.
 */
function assertStandardContext(decorator: string, context: unknown): void {
  if (typeof context !== 'object' || context === null) {
    throw new LegacyDecoratorError(
      `@${decorator} was invoked with the legacy decorator protocol (experimentalDecorators). Compile with standard ECMAScript decorators`,
    )
  }
}
