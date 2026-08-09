import type { ServiceKey, SelectorKey } from './serviceKey'
import {
  SingletonDisposedDuringInitError,
  FactoryReentrancyError,
} from './errors'
import type { Selector } from './serviceSelector'

type DependencyType<T> =
  T extends SelectorKey<infer U>
    ? Selector<U>
    : T extends ServiceKey<infer U>
      ? U
      : never

// Helper types to convert an array/tuple of ServiceKey to tuple of their types
type DependencyTypes<T extends readonly ServiceKey<unknown>[]> = {
  [K in keyof T]: DependencyType<T[K]>
}

/**
 * The component responsible for creating services. Install it into a `ServiceModule`
 * to be used.
 *
 * @template T The type of the service created by the factory.
 * @template D A tuple of `ServiceKey`s describing the dependencies required by the
 * service, in the order {@link initialize} expects them.
 */
export abstract class ServiceFactory<
  const T = unknown,
  const D extends readonly ServiceKey<unknown>[] = readonly ServiceKey<any>[],
> {
  /**
   * The key under which this factory's service is registered and requested.
   * */
  abstract provides: ServiceKey<T>

  /**
   * The complete list of services this factory needs, resolved by the module and passed
   * to {@link initialize} in declaration order.
   */
  abstract dependsOn: D

  /**
   * Creates the service instance.
   *
   * Called by the `ServiceModule` with dependencies resolved per {@link dependsOn};
   */
  abstract initialize(...dependencies: DependencyTypes<D>): T | Promise<T>

  /**
   * Returns the retained instance if this factory currently holds one, or
   * `undefined` if no instance is retained.
   */
  abstract getInstance(): { readonly value: T } | undefined

  /**
   * Tears down whatever {@link initialize} retained (if anything at all). A subsequent {@link initialize}
   * produces a fresh instance.
   *
   * Synchronous by design: the container does not await teardown, so asynchronous
   * cleanup must be scheduled fire-and-forget from here.
   */
  abstract dispose(): void

  /**
   * Creates a lazily initialized singleton: `initialize` runs on the first request and
   * the instance is shared by every request thereafter; a failed `initialize` is never
   * cached, and after `dispose()` the next request initializes a fresh instance.
   *
   * @example
   * ```typescript
   * const databaseKey = new ServiceKey<DbClient>('Database')
   *
   * const database = ServiceFactory.singleton({
   *   provides: databaseKey,
   *   dependsOn: [configKey],
   *   initialize: (config) => DbClient.connect(config.dbUrl),
   *   dispose: (client) => client.close(),
   * })
   * ```
   */
  static singleton<
    const T,
    const D extends readonly ServiceKey<unknown>[] = [],
  >({
    provides,
    dependsOn = [] as unknown as D,
    initialize,
    dispose = () => {},
  }: Omit<ServiceFactory<T, D>, 'dispose' | 'dependsOn' | 'getInstance'> & {
    dispose?: (instance: T) => void
    dependsOn?: D
  }): ServiceFactory<T, D> {
    return new SingletonFactory(provides, dependsOn, initialize, dispose)
  }

  /**
   * Creates a factory that builds a **fresh instance on every request** — no caching
   * and no deduplication.
   *
   * One-shot services have no framework-managed lifecycle: `dispose` is a no-op, so
   * instances are untouched by `module.dispose(...)` — cleanup belongs entirely to
   * whoever requested the instance.
   *
   * @example
   * ```typescript
   * const requestIdKey = new ServiceKey<string>('RequestId')
   * const requestId = ServiceFactory.oneShot({
   *   provides: requestIdKey,
   *   initialize: () => crypto.randomUUID(), // fresh value per request
   * })
   * ```
   */
  static oneShot<const T, const D extends readonly ServiceKey<unknown>[] = []>({
    provides,
    dependsOn = [] as unknown as D,
    initialize,
  }: Omit<ServiceFactory<T, D>, 'dispose' | 'dependsOn' | 'getInstance'> & {
    dependsOn?: D
  }): ServiceFactory<T, D> {
    return new OneShotFactory(provides, dependsOn, initialize)
  }
}

/**
 * A `OneShotFactory` builds a fresh instance on every request and retains none of
 * them, so it has no lifecycle of its own: `dispose` is a no-op — the caller of
 * each request owns that instance's cleanup entirely.
 *
 * @template T - The type of the service instances built by this factory.
 * @template D - A tuple of `ServiceKey` types that represent the dependencies this factory relies on.
 */
export class OneShotFactory<
  const T,
  const D extends readonly ServiceKey<unknown>[] = [],
> extends ServiceFactory<T, D> {
  constructor(
    readonly provides: ServiceKey<T>,
    readonly dependsOn: D,
    readonly onInitialize: ServiceFactory<T, D>['initialize'],
  ) {
    super()
  }

  initialize(...dependencies: DependencyTypes<D>): T | Promise<T> {
    return this.onInitialize(...dependencies)
  }

  getInstance(): { readonly value: T } | undefined {
    return undefined
  }

  dispose(): void {
    // Nothing retained, nothing to tear down.
  }
}

/**
 * A `SingletonFactory` manages the lifecycle of a singleton service instance. It ensures
 * that only one instance of the service is created and reuses that same instance across requests.
 *
 * It extends the `ServiceFactory` class to include additional behavior for managing singleton services.
 *
 * @template T - The type of the service instance managed by this factory.
 * @template D - A tuple of `ServiceKey` types that represent the dependencies this factory relies on.
 */
export class SingletonFactory<
  const T,
  const D extends readonly ServiceKey<unknown>[] = [],
> extends ServiceFactory<T, D> {
  private promisedInstance: Promise<T> | undefined
  private retainedInstance: { value: T } | undefined
  private generation = 0
  private isRunningHook = false

  constructor(
    readonly provides: ServiceKey<T>,
    readonly dependsOn: D,
    readonly onInitialize: ServiceFactory<T, D>['initialize'],
    readonly onDispose: ((instance: T) => void) | undefined,
  ) {
    super()
  }

  /**
   * Returns the retained instance if the singleton is warm, or `undefined` if
   * no instance is currently retained.
   */
  getInstance(): { readonly value: T } | undefined {
    return this.retainedInstance
  }

  initialize(...dependencies: DependencyTypes<D>): Promise<T> | T {
    if (this.retainedInstance !== undefined) {
      return this.retainedInstance.value
    }
    if (this.promisedInstance !== undefined) {
      return this.promisedInstance
    }

    if (this.isRunningHook) {
      throw new FactoryReentrancyError(
        `SingletonServiceFactory(provides=${this.provides.name}): initialize() cannot be called re-entrantly from onInitialize or onDispose`,
      )
    }

    const generation = this.generation

    // Invoke synchronously: if onInitialize throws right away, the error
    // escapes before anything is cached, and the next call retries.
    this.isRunningHook = true
    let pending: Promise<T> | T
    try {
      pending = this.onInitialize(...dependencies)
    } finally {
      this.isRunningHook = false
    }

    this.promisedInstance = (async () => {
      try {
        const newInstance = await pending

        if (this.generation !== generation) {
          // Scope was disposed (and possibly revived) while we were in flight:
          // this instance belongs to a dead generation. Tear it down and reject.
          try {
            this.isRunningHook = true
            this.onDispose?.(newInstance)
          } catch {
            // teardown failure must not mask the disposal rejection
          } finally {
            this.isRunningHook = false
          }
          throw new SingletonDisposedDuringInitError(
            `SingletonServiceFactory[provides=${this.provides.name}]: disposed during initialization`,
          )
        }

        this.retainedInstance = { value: newInstance }
        return newInstance
      } finally {
        // Only clear the slot if we still belong to the current generation —
        // a dispose/revive may have installed a newer init's promise here.
        if (this.generation === generation) {
          this.promisedInstance = undefined
        }
      }
    })()

    return this.promisedInstance
  }

  dispose(): void {
    if (this.isRunningHook) {
      throw new FactoryReentrancyError(
        `SingletonServiceFactory(provides=${this.provides.name}): dispose() cannot be called re-entrantly from onInitialize or onDispose`,
      )
    }

    // Capture the current instance
    const instance = this.retainedInstance
    this.generation += 1
    this.promisedInstance = undefined
    this.retainedInstance = undefined

    if (instance) {
      this.isRunningHook = true
      try {
        this.onDispose?.(instance.value)
      } finally {
        this.isRunningHook = false
      }
    }
  }
}
