/**
 * Error thrown by `ServiceModule.from` when the given factories cannot form a valid
 * module: the dependency graph contains a cycle, or a factory depends on a key that
 * no factory in the module provides.
 *
 * Always indicates a bug in the module composition — fix the factory graph rather
 * than catching this at runtime.
 */
export class ModuleValidationError extends Error {
  name = 'ModuleValidationError'
}

/**
 * Error thrown by `ServiceModule.get` when no factory in the module provides the
 * requested key.
 *
 * Catch this to treat a service as optional — or use `ServiceModule.getOrNull`,
 * which catches it for you and returns `null` instead.
 */
export class NoSuchFactoryError extends Error {
  name = 'NoSuchFactoryError'
}

/**
 * Error thrown by a singleton factory when `dispose()` is called while the instance
 * is still being initialized: the pending `initialize()` promise rejects with this
 * error, and the abandoned instance is passed to the factory's `dispose` callback so
 * nothing leaks.
 *
 * This is a race, not necessarily a bug — disposing a module during shutdown can
 * legitimately interrupt an in-flight `get()`. Callers may treat it as a cancellation
 * signal; a later `initialize()` starts fresh.
 */
export class SingletonDisposedDuringInitError extends Error {
  name = 'SingletonDisposedDuringInitError'
}

/**
 * Error thrown by a singleton factory when the `initialize` or `dispose` callback
 * supplied to `ServiceFactory.singleton` synchronously re-enters the factory by
 * calling its `initialize()` or `dispose()` method.
 *
 * Re-entrant calls would corrupt the factory's in-flight state, so they are rejected
 * outright.
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
