import type { ServiceKey } from './serviceKey.js'

/**
 * A key that groups multiple {@link ServiceKey} of the same type, allowing a service to
 * depend on a selector that can retrieve any of the grouped services,
 * this enables runtime selection between multiple implementations of the same interface.
 */
export class SelectorKey<T> {
    /**
     * Creates a new SelectorKey that groups the provided service keys.
     *
     * @param values An array of ServiceKeys that this selector can provide access to.
     *               All keys must be registered in the ServiceModule for dependency validation to pass.
     */
    constructor(readonly values: ServiceKey<T>[]) {}
}

/**
 * Renamed to {@link SelectorKey}. This alias is kept for backwards compatibility
 * and will be removed in a future release.
 *
 * @deprecated Renamed to {@link SelectorKey}.
 * */
export const ServiceSelectorKey = SelectorKey

/**
 * Renamed to {@link SelectorKey}. This alias is kept for backwards compatibility
 * and will be removed in a future release.
 *
 * @deprecated Renamed to {@link SelectorKey}.
 * */
export type ServiceSelectorKey<T> = SelectorKey<T>
