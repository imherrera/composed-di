import { ServiceKey, ServiceSelectorKey } from './serviceKey';
import { ServiceScope } from './serviceScope';
import { ServiceSelector } from './serviceSelector';

// Helper types to extract the type from ServiceKey or ServiceSelectorKey
type ServiceType<T> =
  T extends ServiceSelectorKey<infer U>
    ? ServiceSelector<U>
    : T extends ServiceKey<infer U>
      ? U
      : never;

// Helper types to convert an array/tuple of ServiceKey to tuple of their types
type DependencyTypes<T extends readonly ServiceKey<unknown>[]> = {
  [K in keyof T]: ServiceType<T[K]>;
};

export abstract class ServiceFactory<
  const T,
  const D extends readonly ServiceKey<unknown>[] = [],
> {
  abstract provides: ServiceKey<T>;
  abstract dependsOn: D;
  abstract scope?: ServiceScope;
  abstract initialize: (...dependencies: DependencyTypes<D>) => T | Promise<T>;
  abstract dispose?: () => void;

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
    dispose = () => {},
  }: {
    scope?: ServiceScope;
    provides: ServiceKey<T>;
    dependsOn?: D;
    initialize: (...dependencies: DependencyTypes<D>) => T | Promise<T>;
    dispose?: (instance: T) => void;
  }): ServiceFactory<T, D> {
    let instance: T | undefined;

    return {
      scope,
      provides,
      dependsOn,
      async initialize(...dependencies: DependencyTypes<D>): Promise<T> {
        if (instance === undefined) {
          instance = await initialize(...dependencies);
        }

        return instance;
      },
      dispose(): void {
        if (instance !== undefined) {
          dispose(instance);
          instance = undefined;
        }
      },
    };
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
    provides: ServiceKey<T>;
    dependsOn: D;
    initialize: (...dependencies: DependencyTypes<D>) => T | Promise<T>;
  }): ServiceFactory<T, D> {
    return {
      provides,
      dependsOn,
      initialize,
    };
  }
}
