import { ServiceKey } from './serviceKey'
import { ServiceScope } from './serviceScope'
import { DependencyTypes } from './types'
import { SingletonServiceFactory } from './singletonServiceFactory'

/**
 * Abstract class representing a service factory, which defines the structure for instantiating and managing
 * the lifecycle of a service within a given scope. Subclasses are responsible for providing specific implementations
 * of service initialization and disposal.
 *
 * @template T The type of the service created by the factory.
 * @template D A tuple type of `ServiceKey<unknown>` representing the dependencies required by the service.
 */
export abstract class ServiceFactory<
  const T,
  const D extends readonly ServiceKey<unknown>[] = [],
> {
  abstract provides: ServiceKey<T>
  abstract dependsOn: D
  abstract scope?: ServiceScope
  abstract initialize(...dependencies: DependencyTypes<D>): T | Promise<T>
  abstract dispose(): void

  /**
   * Creates a singleton service factory that ensures a single instance of the provided service is initialized
   * and used throughout the scope lifecycle.
   */
  static singleton<
    const T,
    const D extends readonly ServiceKey<unknown>[] = [],
  >({
    scope,
    provides,
    dependsOn = [] as unknown as D,
    initialize,
    dispose = undefined,
  }: {
    scope?: ServiceScope
    provides: ServiceKey<T>
    dependsOn?: D
    initialize: (...dependencies: DependencyTypes<D>) => T | Promise<T>
    dispose?: (instance: T) => void
  }): ServiceFactory<T, D> {
    return new SingletonServiceFactory(
      scope,
      provides,
      dependsOn,
      initialize,
      dispose,
    )
  }

  /**
   * Creates a one-shot service factory that initializes a new instance of the provided service
   * every time it is requested.
   */
  static oneShot<const T, const D extends readonly ServiceKey<unknown>[] = []>({
    provides,
    dependsOn,
    initialize,
  }: {
    provides: ServiceKey<T>
    dependsOn: D
    initialize: (...dependencies: DependencyTypes<D>) => T | Promise<T>
  }): ServiceFactory<T, D> {
    return {
      provides,
      dependsOn,
      initialize,
      dispose: () => {},
    }
  }
}
