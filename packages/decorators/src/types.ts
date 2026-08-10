import type { ServiceKey } from '@composed-di/core'

/**
 * A concrete, zero-argument class constructor whose instances are of type
 * `T`. Zero arguments is the decorator tier's contract. Dependencies come
 * through `@Inject` fields only.
 */
export type Constructor<T> = new () => T

/**
 * Anything that can identify a service. Either a `ServiceKey`, or a class
 * marked with a lifecycle decorator.
 */
export type ServiceToken<T> = ServiceKey<T> | Constructor<T>
