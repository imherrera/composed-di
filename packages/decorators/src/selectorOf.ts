import { SelectorKey } from '@composed-di/core'
import { keyOf } from './keyOf'
import type { Constructor } from './types'

/**
 * Creates a `SelectorKey` grouping the keys of the given decorated classes,
 * for runtime selection among implementations of a shared type.
 *
 * @param constructors The classes to group. Each must carry a lifecycle decorator.
 * @return A `SelectorKey` over the classes' own keys.
 * @throws {MissingLifecycleError} If any class has no lifecycle decorator.
 */
export function selectorOf<T>(
  ...constructors: [Constructor<T>, ...Constructor<T>[]]
): SelectorKey<T> {
  return new SelectorKey(constructors.map((constructor) => keyOf(constructor)))
}
