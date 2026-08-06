/**
 * Error thrown by `syntheticFactory` when the given class has no lifecycle decorator.
 *
 * Only classes marked with `@Singleton` or `@OneShot` can be registered — the
 * decorator is what declares the lifecycle and mints the class's `ServiceKey`.
 * Subclasses do not inherit the parent's decorator; each registered class must
 * be marked in its own right.
 */
export class MissingLifecycleError extends Error {
  name = 'MissingLifecycleError'
}

/**
 * Error thrown when a class receives more than one lifecycle decorator — both
 * `@Singleton` and `@OneShot`, or the same decorator twice.
 *
 * A class has exactly one lifecycle; apply exactly one lifecycle decorator.
 */
export class DuplicateLifecycleError extends Error {
  name = 'DuplicateLifecycleError'
}

/**
 * Error thrown when `@OnDispose` is misused: applied to a static method,
 * applied more than once in the same class, applied to a class whose method
 * metadata does not match (the telltale of a missing lifecycle decorator),
 * or applied to a `@OneShot` class — one-shot instances are owned by their
 * requester, so the container never disposes them.
 */
export class DisposeHookError extends Error {
  name = 'DisposeHookError'
}

/**
 * Error thrown when an `@Inject` field cannot be initialized correctly: the
 * class was constructed with `new` outside of a `ServiceModule`, a field was
 * decorated more than once, `@Inject` was applied to a static field, or the
 * class's recorded field metadata does not match what construction actually
 * ran (the telltale of `@Inject` fields on a class that is missing its
 * lifecycle decorator).
 *
 * Always indicates a bug in how the class is declared or constructed — fix
 * the declaration rather than catching this at runtime.
 */
export class FieldInjectionError extends Error {
  name = 'FieldInjectionError'
}
