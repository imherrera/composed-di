/**
 * Error thrown by {@link ServiceModule.from} when the given factories cannot form a valid
 * module. Either the dependency graph contains a cycle, or a factory depends on a
 * key that no factory in the module provides.
 *
 * Always indicates a bug in the module composition. Fix the factory graph rather
 * than catching this at runtime.
 */
export class ModuleValidationError extends Error {
  override name = 'ModuleValidationError'
}

/**
 * Error thrown by {@link ServiceModule.get} when no factory in the module provides the
 * requested key.
 *
 * Catch this to treat a service as optional, or use {@link ServiceModule.getOrNull},
 * which catches it for you and returns `null` instead.
 */
export class NoSuchFactoryError extends Error {
  override name = 'NoSuchFactoryError'
}

/**
 * Error thrown by {@link Selector.get} when the requested key is not among the keys
 * grouped by the selector's {@link SelectorKey}.
 *
 * Always indicates a bug in the caller. {@link Selector.keys} lists what can be requested.
 */
export class NoSuchKeyError extends Error {
  override name = 'NoSuchKeyError'
}

/**
 * Error thrown by a factory when {@link ServiceModule.dispose} is called while the instance
 * is still being initialized. The pending {@link ServiceFactory.initialize} promise rejects with this
 * error, and the abandoned instance is passed to the factory's {@link ServiceFactory.dispose} callback so
 * nothing leaks.
 *
 * This is a race, not necessarily a bug. Disposing a module during shutdown can
 * legitimately interrupt an in-flight {@link ServiceModule.get}. Callers may treat it as a cancellation
 * signal.
 */
export class InitializationAbortedError extends Error {
  override name = 'InitializationAbortedError'
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

/**
 * Renamed to {@link InitializationAbortedError}. This alias is kept for backwards compatibility
 * and will be removed in a future release.
 *
 * @deprecated Renamed to {@link InitializationAbortedError}.
 * */
export const SingletonDisposedDuringInitError = InitializationAbortedError

/**
 * Renamed to {@link InitializationAbortedError}. This alias is kept for backwards compatibility
 * and will be removed in a future release.
 *
 * @deprecated Renamed to {@link InitializationAbortedError}.
 * */
export type SingletonDisposedDuringInitError = InitializationAbortedError
