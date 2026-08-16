import type { DependencyKey, ServiceKey } from '@composed-di/core'

/**
 * The lifecycles a class decorator can declare, mirroring the two factory
 * shapes in `@composed-di/core`.
 */
export type Lifecycle = 'singleton' | 'transient'

/**
 * A single `@Inject` or `@Select` field. Pairs the decorated field with the key
 * that resolves it, which is a `SelectorKey` for a `@Select` field.
 */
export interface FieldInjection {
    readonly name: string | symbol
    readonly key: DependencyKey<unknown>
}

/**
 * An `@Dispose` teardown hook. Pairs the method it decorates with an
 * invoker that calls it on an instance.
 */
export interface DisposeHook {
    readonly name: string | symbol
    readonly invoke: (instance: object) => void
}

/**
 * Everything a lifecycle decorator records about a class. Holds the declared
 * lifecycle, the `ServiceKey` minted for the class, its `@Inject` fields,
 * and its `@Dispose` hook if it has one.
 */
export interface ClassRegistration {
    readonly lifecycle: Lifecycle
    readonly key: ServiceKey<unknown>
    readonly fields: readonly FieldInjection[]
    readonly dispose?: DisposeHook | undefined
}

/**
 * The dependencies resolved for the class currently being constructed by
 * `factoryOf`, keyed by field. Each `@Inject` field is its own
 * request, so two fields of the same transient key hold distinct instances.
 * `consumed` lets `factoryOf` verify afterwards that every resolved
 * value actually reached its field.
 */
export interface FieldStash {
    readonly values: Map<FieldInjection, unknown>
    readonly consumed: Set<FieldInjection>
}

// Per-copy state by design. The cross-copy guarantee is key-only (see
// symbols.ts). A stash writer and its readers always share one module
// instance, because `factoryOf` constructs only classes registered by its
// own copy, whose field initializers came from that same copy's decorators.
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
