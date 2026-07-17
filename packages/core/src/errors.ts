/**
 * Error thrown when there is an issue during the initialization or configuration of a ServiceModule.
 * This can include circular dependencies or missing dependencies that are detected during module creation.
 */
export class ServiceModuleInitError extends Error {
  name = 'ServiceModuleInitError'
}

/**
 * Error thrown when a requested service cannot be found within the ServiceModule.
 */
export class ServiceFactoryNotFoundError extends Error {
  name = 'ServiceFactoryNotFoundError'
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
export class ServiceFactoryIllegalUsageError extends Error {
  name = 'ServiceFactoryIllegalUsageError'
}
