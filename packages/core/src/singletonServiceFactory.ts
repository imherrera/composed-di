import { ServiceKey } from './serviceKey'
import { ServiceScope } from './serviceScope'
import { ServiceFactory } from './serviceFactory'
import { DependencyTypes } from './types'
import { ServiceDisposedDuringInitError } from './errors'

/**
 * A `SingletonServiceFactory` manages the lifecycle of a singleton service instance. It ensures
 * that only one instance of the service is created and reuses that same instance across requests.
 *
 * It extends the `ServiceFactory` class to include additional behavior for managing singleton services.
 *
 * @template T - The type of the service instance managed by this factory.
 * @template D - A tuple of `ServiceKey` types that represent the dependencies this factory relies on.
 */
export class SingletonServiceFactory<
  const T,
  const D extends readonly ServiceKey<unknown>[] = [],
> extends ServiceFactory<T, D> {
  private promisedInstance: Promise<T> | undefined
  private retainedInstance: { value: T } | undefined
  private generation = 0

  constructor(
    override readonly scope: ServiceScope | undefined,
    override readonly provides: ServiceKey<T>,
    override readonly dependsOn: D,
    readonly onInitialize: ServiceFactory<T, D>['initialize'],
    readonly onDispose: ((instance: T) => void) | undefined,
  ) {
    super()
  }

  override initialize(...dependencies: DependencyTypes<D>): Promise<T> | T {
    if (this.retainedInstance !== undefined) {
      return this.retainedInstance.value
    }
    if (this.promisedInstance !== undefined) {
      return this.promisedInstance
    }

    const generation = this.generation

    // Invoke synchronously: if onInitialize throws right away, the error
    // escapes before anything is cached, and the next call retries.
    const pending = this.onInitialize(...dependencies)

    this.promisedInstance = (async () => {
      try {
        const newInstance = await pending

        if (this.generation !== generation) {
          // Scope was disposed (and possibly revived) while we were in flight:
          // this instance belongs to a dead generation. Tear it down and reject.
          try {
            this.onDispose?.(newInstance)
          } catch {
            // teardown failure must not mask the disposal rejection
          }
          throw new ServiceDisposedDuringInitError(
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

  override dispose(): void {
    // Capture the current instance
    const instance = this.retainedInstance
    this.generation += 1
    this.promisedInstance = undefined
    this.retainedInstance = undefined

    if (instance) {
      this.onDispose?.(instance.value)
    }
  }
}
