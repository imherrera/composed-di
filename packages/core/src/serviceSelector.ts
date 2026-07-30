import { ServiceKey, SelectorKey } from './serviceKey'
import type { ServiceModule } from './serviceModule'

/**
 * A runtime selector that provides access to multiple service implementations of the same type.
 *
 * A `Selector` is automatically created and injected when a factory depends on a
 * `SelectorKey<T>`. It allows the dependent service to dynamically choose which
 * implementation to use at runtime, rather than being bound to a single implementation
 * at configuration time.
 *
 * @template T The common type shared by all services accessible through this selector.
 *
 * @example
 * ```ts
 * // In a factory that depends on SelectorKey
 * const appFactory = ServiceFactory.singleton({
 *   provides: AppKey,
 *   dependsOn: [LoggerSelectorKey] as const,
 *   initialize: (loggerSelector: Selector<Logger>) => {
 *     return {
 *       logWithConsole: async () => {
 *         const logger = await loggerSelector.get(ConsoleLoggerKey);
 *         logger.log('Using console logger');
 *       },
 *       logWithFile: async () => {
 *         const logger = await loggerSelector.get(FileLoggerKey);
 *         logger.log('Using file logger');
 *       },
 *     };
 *   },
 * });
 * ```
 */
export class Selector<T> {
  /**
   * Creates a new Selector instance.
   *
   * Note: Selector instances are created automatically by ServiceModule
   * when resolving dependencies. You typically don't need to create them manually.
   *
   * @param key The SelectorKey that defines which services can be selected.
   * @param module The ServiceModule used to resolve the selected service.
   */
  constructor(
    private readonly module: ServiceModule,
    private readonly key: SelectorKey<T>,
  ) {}

  /**
   * Retrieves a service instance by its key from the available services in this selector.
   *
   * The key must be one of the keys that were included in the `SelectorKey`
   * used to create this selector.
   *
   * @param key The ServiceKey identifying which service implementation to retrieve.
   * @returns A Promise that resolves to the requested service instance.
   *
   * @example
   * ```ts
   * const logger = await loggerSelector.get(ConsoleLoggerKey);
   * logger.log('Hello!');
   * ```
   */
  get(key: ServiceKey<T>): Promise<T> {
    if (this.key.values.some((k) => k === key)) {
      return this.module.get(key)
    } else {
      throw new Error(
        `ServiceKey(name=${key.name}) is not listed on SelectorKey(name=${this.key.name})`,
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
