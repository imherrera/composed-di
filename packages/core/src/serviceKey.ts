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
 * const loggerKey = new ServiceKey<Logger>('Logger');
 * const loggerFactory = ServiceFactory.singleton({
 *   provides: loggerKey,
 *   initialize: () => console,
 * });
 *
 * const module = ServiceModule.from([loggerFactory]);
 * const logger = await module.get(loggerKey);
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

  /**
   * Creates a `ServiceKey` backed by the global symbol registry, making it
   * compatible with any other key created via `ServiceKey.for` with the same name.
   *
   * Key identity is determined by the underlying {@link symbol}, not by object
   * reference. This method uses `Symbol.for(name)`, which searches the global
   * symbol registry for a symbol registered under `name` and reuses it if found
   * (registering it on first use). As a result, every `ServiceKey.for('X')` call
   * — even across modules, bundles, or duplicated copies of this library —
   * produces keys that identify the same service.
   *
   * This is the opposite guarantee of `new ServiceKey(name)`, which creates a
   * fresh `Symbol(name)` each time and is therefore always unique, even when
   * names collide.
   *
   * Because the registry is keyed only by the name string, choose names unlikely
   * to collide (e.g., namespaced like `'my-app/Logger'`). Note that the type
   * parameter `T` is not part of the identity: two `for` calls with the same
   * name but different `T` silently alias the same service.
   *
   * @template T The type of service this key identifies.
   * @param name The name used to look up (or register) the shared symbol in the
   *             global symbol registry; also used in error messages and debugging.
   * @return A `ServiceKey` whose symbol is `Symbol.for(name)`, interchangeable
   *         with any other key created by this method with the same name.
   *
   * @example
   * ```ts
   * const keyA = ServiceKey.for<Logger>('Logger');
   * const keyB = ServiceKey.for<Logger>('Logger');
   * keyA.symbol === keyB.symbol; // true — both keys resolve the same service
   *
   * const keyC = new ServiceKey<Logger>('Logger');
   * keyA.symbol === keyC.symbol; // false — the constructor always creates a unique key
   * ```
   */
  static for<T>(name: string): ServiceKey<T> {
    return new ServiceKey<T>(name, Symbol.for(name))
  }
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
 *   log: (msg: string) => void;
 * }
 *
 * const consoleLoggerKey = new ServiceKey<Logger>('ConsoleLogger');
 * const fileLoggerKey = new ServiceKey<Logger>('FileLogger');
 *
 * // Group multiple logger implementations under one selector
 * const loggerSelectorKey = new SelectorKey<Logger>([
 *   consoleLoggerKey,
 *   fileLoggerKey,
 * ]);
 *
 * // Use in a factory's dependsOn array
 * const appKey = new ServiceKey<App>('App');
 * const appFactory = ServiceFactory.singleton({
 *   provides: appKey,
 *   dependsOn: [loggerSelectorKey] as const,
 *   initialize: (loggerSelector: Selector<Logger>) => {
 *     // loggerSelector.get(consoleLoggerKey) or loggerSelector.get(fileLoggerKey)
 *     return new App(loggerSelector);
 *   },
 * });
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
