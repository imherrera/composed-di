import type { ServiceKey } from '@composed-di/core'

/**
 * A concrete, zero-argument class constructor whose instances are of type
 * `T` — the decorator tier's contract: dependencies come through `@Inject`
 * fields only.
 */
export type Constructor<T> = new () => T

/**
 * Anything that can identify a service: a `ServiceKey`, or a class marked
 * with a lifecycle decorator.
 */
export type ServiceToken<T> = ServiceKey<T> | Constructor<T>
