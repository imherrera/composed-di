/**
 * Error thrown when a ServiceModule fails validation at creation time.
 * This can include circular dependencies or missing dependencies among the module's factories.
 */
export class ModuleValidationError extends Error {
  name = 'ModuleValidationError'
}

/**
 * Error thrown when a requested service cannot be found within the ServiceModule.
 */
export class NoSuchFactoryError extends Error {
  name = 'NoSuchFactoryError'
}

/**
 * Represents an error thrown when a service is disposed of during its initialization process.
 *
 * This error typically indicates a logic or lifecycle issue where a service is destroyed or cleaned up
 * before it has fully completed its initialization. It is useful for catching cases where resource management
 * conflicts arise during the service setup phase.
 */
export class ServiceDisposedDuringInitError extends Error {
  name = 'ServiceDisposedDuringInitError'
}

/**
 * Error thrown when a service factory lifecycle hook (`onInitialize` or `onDispose`) attempts to
 * re-enter the factory by calling `initialize` or `dispose` on itself.
 *
 * Re-entrant calls of this kind would corrupt the factory's internal bookkeeping (e.g. the cached
 * instance or generation counter), so they are rejected outright.
 */
export class FactoryReentrancyError extends Error {
  name = 'FactoryReentrancyError'
}

/**
 * Renamed to {@link ModuleValidationError}. This alias is kept for backwards compatibility
 * and will be removed in a future release.
 *
 * @deprecated Renamed to {@link ModuleValidationError}.
 * */
export const ServiceModuleInitError = ModuleValidationError

/**
 * Renamed to {@link ModuleValidationError}. This alias is kept for backwards compatibility
 * and will be removed in a future release.
 *
 * @deprecated Renamed to {@link ModuleValidationError}.
 * */
export type ServiceModuleInitError = ModuleValidationError

/**
 * Renamed to {@link NoSuchFactoryError}. This alias is kept for backwards compatibility
 * and will be removed in a future release.
 *
 * @deprecated Renamed to {@link NoSuchFactoryError}.
 * */
export const ServiceFactoryNotFoundError = NoSuchFactoryError

/**
 * Renamed to {@link NoSuchFactoryError}. This alias is kept for backwards compatibility
 * and will be removed in a future release.
 *
 * @deprecated Renamed to {@link NoSuchFactoryError}.
 * */
export type ServiceFactoryNotFoundError = NoSuchFactoryError
