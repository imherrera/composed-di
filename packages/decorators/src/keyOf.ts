import type { ServiceKey } from '@composed-di/core'
import { DecoratorValidationError } from './errors.js'
import { LifecycleRegistry } from './lifecycleRegistry.js'
import type { Constructor } from './types.js'

/**
 * Returns the key of a decorated class. Reads the class's own key only,
 * so a subclass never inherits its parent's.
 *
 * @param constructor The class to read the key from.
 * @return The class's own key.
 * @throws {DecoratorValidationError} If the class has no lifecycle decorator.
 */
export function keyOf<T>(constructor: Constructor<T>): ServiceKey<T> {
  const serviceKey = LifecycleRegistry.getServiceKey(constructor)
  if (serviceKey === undefined) {
    throw new DecoratorValidationError(
      `class ${constructor.name} has no lifecycle decorator. Apply @Singleton or @Transient before using it as a token`,
    )
  }
  return serviceKey as ServiceKey<T>
}
