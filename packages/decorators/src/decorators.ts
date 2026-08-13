import { SelectorKey, ServiceKey, type Selector } from '@composed-di/core'
import { keyOf } from './keyOf.js'
import { LifecycleRegistry } from './lifecycleRegistry.js'
import type { Constructor, ServiceToken } from './types.js'
import { DecoratorValidationError } from './errors.js'
import { activeFieldStash, type FieldInjection } from './metadata.js'

/**
 * Identifies a class that will be instantiated only once and shared every time it is requested.
 *
 * This decorator is not inherited.
 */
export function Singleton<C extends Constructor<object>>(
  constructor: C,
  context: ClassDecoratorContext<C>,
): void {
  assertStandardContext('Singleton', context)
  LifecycleRegistry.register(constructor, context, 'singleton')
}

/**
 * Identifies a class that will be instantiated every time it is requested.
 *
 * This decorator is not inherited.
 */
export function Transient<C extends Constructor<object>>(
  constructor: C,
  context: ClassDecoratorContext<C>,
): void {
  assertStandardContext('Transient', context)
  LifecycleRegistry.register(constructor, context, 'transient')
}

/**
 * Identifies a method as the class's teardown. The method will be called exactly once when the module disposes of a retained instance.
 *
 * This decorator is not inherited and only applicable for {@link Singleton} classes.
 */
export function Dispose<This>(
  _method: (this: This) => void,
  context: ClassMethodDecoratorContext<This, (this: This) => void>,
): void {
  assertStandardContext('Dispose', context)
  if (context.static) {
    throw new DecoratorValidationError(
      `@Dispose cannot be applied to the static method ${String(context.name)}`,
    )
  }
  LifecycleRegistry.addPendingDispose(context.metadata, {
    name: context.name,
    invoke: (instance) => {
      context.access.get(instance as This).call(instance as This)
    },
  })
}

/**
 * Identifies injectable class properties. An injectable property may have any access modifier (public, private, protected).
 * The properties are injected before the constructor body runs, so they are already usable there.
 *
 * This decorator makes the class constructible only through a module.
 * Constructing it manually throws {@link DecoratorValidationError}.
 */
export function Inject<T>(token: ServiceToken<T>) {
  const key = token instanceof ServiceKey ? token : keyOf(token)

  return function <This>(
    _value: undefined,
    context: ClassFieldDecoratorContext<This, T>,
  ): (this: This, initial: T) => T {
    return inject('Inject', key, context)
  }
}

/**
 * Declares that a field receives a {@link Selector} over the given type.
 *
 * The arguments can be {@link ServiceKey} or decorated classes, mixed freely.
 */
export function Select<T>(...tokens: [ServiceToken<T>, ...ServiceToken<T>[]]) {
  const key = new SelectorKey<T>(
    tokens.map((token) => (token instanceof ServiceKey ? token : keyOf(token))),
  )

  return function <This>(
    _value: undefined,
    context: ClassFieldDecoratorContext<This, Selector<T>>,
  ): (this: This, initial: Selector<T>) => Selector<T> {
    return inject('Select', key, context)
  }
}

/**
 * Registers `key` as a pending field injection for the class being defined
 * and returns the field initializer that pulls the resolved instance from
 * the active stash. This is the machinery shared by `@Inject` and `@Select`.
 */
function inject<This, T>(
  decorator: string,
  key: ServiceKey<T>,
  context: ClassFieldDecoratorContext<This, T>,
): (this: This, initial: T) => T {
  assertStandardContext(decorator, context)

  if (context.static) {
    throw new DecoratorValidationError(
      `@${decorator}(${key.name}) cannot be applied to the static field ${String(context.name)}`,
    )
  }
  const field: FieldInjection = { name: context.name, key }
  LifecycleRegistry.addPendingField(context.metadata, field)

  return function (this: This, _initial: T): T {
    const owner = (this as object).constructor.name
    const label = `${owner}.${String(context.name)}`

    const stash = activeFieldStash()
    if (stash === undefined) {
      throw new DecoratorValidationError(
        `${label}: @${decorator} fields are resolved by a ServiceModule. Retrieve ${owner} through the module instead of constructing it with new`,
      )
    }
    if (!stash.values.has(field)) {
      throw new DecoratorValidationError(
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
    throw new DecoratorValidationError(
      `@${decorator} was invoked with the legacy decorator protocol (experimentalDecorators). Compile with standard ECMAScript decorators`,
    )
  }
}
