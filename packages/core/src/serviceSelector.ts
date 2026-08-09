import { NoSuchKeyError } from './errors'
import { ServiceKey } from './serviceKey'
import type { ServiceModule } from './serviceModule'

/**
 * A runtime selector that provides access to multiple service implementations of the same type.
 *
 * A `Selector` is automatically created and injected when a factory depends on a
 * `SelectorKey<T>`. It allows the dependent service to dynamically choose which
 * implementation to use at runtime, rather than being bound to a single implementation
 * at configuration time.
 */
export class Selector<T> {
  /**
   * Creates a new Selector instance.
   *
   * Note: Selector instances are created automatically by ServiceModule
   * when resolving dependencies. You typically don't need to create them manually.
   *
   * @param module The ServiceModule used to resolve the selected service.
   * @param keys The ServiceKeys that can be selected through this selector.
   */
  constructor(
    private readonly module: ServiceModule,
    public readonly keys: readonly ServiceKey<T>[],
  ) {}

  /**
   * Retrieves a service instance by its key from the available services in this selector.
   *
   * The key must be one of the keys that were included in the `SelectorKey`
   * used to create this selector.
   *
   * @param key The ServiceKey identifying which service implementation to retrieve.
   * @returns A Promise that resolves to the requested service instance.
   * @throws {NoSuchKeyError} If the key is not among this selector's keys.
   *
   * @example
   * ```ts
   * // `loggers: Selector<Logger>` is injected into factories that declare
   * // `dependsOn: [loggerSelectorKey]`
   * const key = loggers.keys.find((k) => k.name === 'FileLogger')!;
   * const logger = await loggers.get(key);
   * logger.log('Resolved by name at runtime');
   * ```
   */
  get(key: ServiceKey<T>): Promise<T> {
    if (this.keys.some((k) => k === key)) {
      return this.module.get(key)
    } else {
      throw new NoSuchKeyError(
        `Could not find ${key.name} among this Selector's keys ([${this.keys.map((k) => k.name).join(',')}])`,
      )
    }
  }
}

/**
 * Renamed to {@link Selector}. This alias is kept for backwards compatibility
 * and will be removed in a future release.
 *
 * @deprecated Renamed to {@link Selector}.
 * */
export const ServiceSelector = Selector

/**
 * Renamed to {@link Selector}. This alias is kept for backwards compatibility
 * and will be removed in a future release.
 *
 * @deprecated Renamed to {@link Selector}.
 * */
export type ServiceSelector<T> = Selector<T>
