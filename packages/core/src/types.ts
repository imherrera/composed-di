// Helper types to extract the type from ServiceKey or ServiceSelectorKey
import { ServiceKey, ServiceSelectorKey } from './serviceKey'
import { ServiceSelector } from './serviceSelector'

export type ServiceType<T> =
  T extends ServiceSelectorKey<infer U>
    ? ServiceSelector<U>
    : T extends ServiceKey<infer U>
      ? U
      : never

// Helper types to convert an array/tuple of ServiceKey to tuple of their types
export type DependencyTypes<T extends readonly ServiceKey<unknown>[]> = {
  [K in keyof T]: ServiceType<T[K]>
}
