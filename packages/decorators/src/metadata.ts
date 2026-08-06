import type { ServiceKey } from '@composed-di/core'

/**
 * The symbol under which a lifecycle decorator stamps the class's own
 * `ServiceKey`. Backed by the global symbol registry, so duplicated copies
 * of this package agree on the slot.
 */
export const classKey = Symbol.for('__service_key__')

/**
 * The lifecycles a class decorator can declare, mirroring the two factory
 * shapes in `@composed-di/core`.
 */
export type Lifecycle = 'singleton' | 'oneShot'

/**
 * A single `@Inject` field: the property it decorates and the key that
 * resolves it.
 */
export interface FieldInjection {
  readonly name: string | symbol
  readonly key: ServiceKey<unknown>
}

/**
 * An `@OnDispose` teardown hook: the method it decorates and an invoker that
 * calls it on an instance.
 */
export interface DisposeHook {
  readonly name: string | symbol
  readonly isPrivate: boolean
  readonly invoke: (instance: object) => void
}

/**
 * Everything a lifecycle decorator records about a class: the declared
 * lifecycle, the `ServiceKey` minted for the class, its `@Inject` fields,
 * and its `@OnDispose` hook if it has one.
 */
export interface ClassRegistration {
  readonly lifecycle: Lifecycle
  readonly key: ServiceKey<unknown>
  readonly fields: readonly FieldInjection[]
  readonly dispose?: DisposeHook
}

/**
 * The dependencies resolved for the class currently being constructed by
 * `syntheticFactory`, keyed by field — each `@Inject` field is its own
 * request, so two fields of the same one-shot key hold distinct instances.
 * `consumed` lets `syntheticFactory` verify afterwards that every resolved
 * value actually reached its field.
 */
export interface FieldStash {
  readonly values: Map<FieldInjection, unknown>
  readonly consumed: Set<FieldInjection>
}

let currentStash: FieldStash | undefined

/**
 * Runs `construct` with `stash` visible to `@Inject` field initializers.
 * Construction is synchronous, so save/restore is enough even when factories
 * nest.
 */
export function runWithFieldStash<T>(stash: FieldStash, construct: () => T): T {
  const previous = currentStash
  currentStash = stash
  try {
    return construct()
  } finally {
    currentStash = previous
  }
}

export function activeFieldStash(): FieldStash | undefined {
  return currentStash
}
