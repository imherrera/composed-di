// @ts-ignore
import { ServiceSelector } from './serviceSelector'

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
 *   log: (msg: string) => void;
 * }
 *
 * const LoggerKey = new ServiceKey<Logger>('Logger');
 *
 * // Use with ServiceFactory and ServiceModule
 * const loggerFactory = ServiceFactory.singleton({
 *   provides: LoggerKey,
 *   dependsOn: [],
 *   initialize: () => console,
 * });
 *
 * const module = ServiceModule.from([loggerFactory]);
 * const logger = await module.get(LoggerKey);
 * ```
 */
export class ServiceKey<T> {
  /**
   * Phantom field that brands this key with the service type `T`.
   * Exists only at the type level (`declare` emits no runtime code) and
   * prevents keys of different service types from being interchangeable.
   */
  declare private readonly _type: T

  /**
   * A unique symbol that identifies this service key.
   * Used internally for identity comparison between keys.
   */
  public readonly symbol: symbol

  /**
   * Creates a new ServiceKey with the given name.
   *
   * @param name A human-readable name for the service, used in error messages and debugging.
   */
  constructor(public readonly name: string) {
    this.symbol = Symbol(name)
  }

  /**
   * Creates a new instance of `ServiceKey` with the specified name.
   *
   * @param name - The name associated with the `ServiceKey` instance.
   * @return A new `ServiceKey` instance of the specified type.
   */
  static for<T>(name: string): ServiceKey<T> {
    return new ServiceKey<T>(name)
  }

  /**
   * Creates a new instance of ServiceSelectorKey using the provided keys.
   *
   * @param keys - An array of ServiceKey objects to be used for creating the ServiceSelectorKey.
   * @return A new instance of ServiceSelectorKey constructed with the specified keys.
   */
  static from<T>(...keys: ServiceKey<T>[]): ServiceSelectorKey<T> {
    return new ServiceSelectorKey<T>(keys)
  }
}

/**
 * A specialized ServiceKey that groups multiple ServiceKeys of the same type,
 * allowing a service to depend on a selector that can retrieve any of the grouped services.
 *
 * When used in a factory's `dependsOn` array, the factory's `initialize` callback
 * receives a `ServiceSelector<T>` instance instead of a direct service instance.
 * This enables runtime selection between multiple implementations of the same interface.
 *
 * @template T The common type shared by all service keys in this selector.
 *
 * @example
 * ```ts
 * interface Logger {
 *   log: (msg: string) => void;
 * }
 *
 * const ConsoleLoggerKey = new ServiceKey<Logger>('ConsoleLogger');
 * const FileLoggerKey = new ServiceKey<Logger>('FileLogger');
 *
 * // Group multiple logger implementations under one selector
 * const LoggerSelectorKey = new ServiceSelectorKey<Logger>([
 *   ConsoleLoggerKey,
 *   FileLoggerKey,
 * ]);
 *
 * // Use in a factory's dependsOn array
 * const appFactory = ServiceFactory.singleton({
 *   provides: AppKey,
 *   dependsOn: [LoggerSelectorKey] as const,
 *   initialize: (loggerSelector: ServiceSelector<Logger>) => {
 *     // loggerSelector.get(ConsoleLoggerKey) or loggerSelector.get(FileLoggerKey)
 *     return new App(loggerSelector);
 *   },
 * });
 * ```
 */
export class ServiceSelectorKey<T> extends ServiceKey<ServiceSelector<T>> {
  /**
   * Creates a new ServiceSelectorKey that groups the provided service keys.
   *
   * @param values An array of ServiceKeys that this selector can provide access to.
   *               All keys must be registered in the ServiceModule for dependency validation to pass.
   */
  constructor(readonly values: ServiceKey<T>[]) {
    super(`[${values.map((key) => key.name).join(',')}]`)
  }
}
