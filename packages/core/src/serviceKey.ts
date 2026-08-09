import type { Selector } from './serviceSelector'

/**
 * A typed token used to identify and retrieve a service from a ServiceModule.
 *
 * ServiceKey acts as a unique identifier for a service type, allowing type-safe
 * dependency injection. Each key has a unique symbol to ensure identity comparison
 * works correctly even if two keys have the same name.
 *
 * @template T The type of service this key identifies.
 *
 * @example
 * ```ts
 * interface Logger {
 *   info: (msg: string) => void
 * }
 *
 * // Unique key definition
 * const loggerKey = new ServiceKey<Logger>('Logger')
 * const loggerFactory = ServiceFactory.singleton({
 *   provides: loggerKey,
 *   initialize: () => console,
 * })
 *
 * const module = ServiceModule.from([loggerFactory])
 * const logger = await module.get(loggerKey)
 * ```
 */
export class ServiceKey<T> {
  /**
   * Phantom field that brands this key with the service type `T`.
   * Exists only at the type level (`declare` emits no runtime code) and
   * prevents keys of different service types from being interchangeable.
   */
  declare protected readonly _type: T

  /**
   * Creates a new ServiceKey with the given name.
   *
   * @param name A human-readable name for the service, used in error messages and debugging.
   * @param symbol A unique symbol that identifies this service key. Used internally for identity comparison between keys.
   */
  constructor(
    public readonly name: string,
    public readonly symbol: symbol = Symbol(name),
  ) {}
}

/**
 * A specialized ServiceKey that groups multiple ServiceKeys of the same type,
 * allowing a service to depend on a selector that can retrieve any of the grouped services.
 *
 * When used in a factory's `dependsOn` array, the factory's `initialize` callback
 * receives a `Selector<T>` instance instead of a direct service instance.
 * This enables runtime selection between multiple implementations of the same interface.
 *
 * @template T The common type shared by all service keys in this selector.
 *
 * @example
 * ```ts
 * interface Logger {
 *   log: (msg: string) => void
 * }
 *
 * const consoleLoggerKey = new ServiceKey<Logger>('ConsoleLogger')
 * const fileLoggerKey = new ServiceKey<Logger>('FileLogger')
 *
 * // Group multiple logger implementations under one selector
 * const loggerSelectorKey = new SelectorKey<Logger>([
 *   consoleLoggerKey,
 *   fileLoggerKey,
 * ])
 *
 * // Use in a factory's dependsOn array
 * const appKey = new ServiceKey<App>('App')
 * const appFactory = ServiceFactory.singleton({
 *   provides: appKey,
 *   dependsOn: [loggerSelectorKey] as const,
 *   initialize: (loggerSelector: Selector<Logger>) => {
 *     // loggerSelector.get(consoleLoggerKey) or loggerSelector.get(fileLoggerKey)
 *     return new App(loggerSelector)
 *   },
 * })
 * ```
 */
export class SelectorKey<T> extends ServiceKey<Selector<T>> {
  /**
   * Creates a new SelectorKey that groups the provided service keys.
   *
   * @param values An array of ServiceKeys that this selector can provide access to.
   *               All keys must be registered in the ServiceModule for dependency validation to pass.
   */
  constructor(readonly values: ServiceKey<T>[]) {
    super(`[${values.map((key) => key.name).join(',')}]`)
  }
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
