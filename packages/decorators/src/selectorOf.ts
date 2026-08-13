import { SelectorKey } from '@composed-di/core'
import { keyOf } from './keyOf.js'
import type { Constructor } from './types.js'

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
