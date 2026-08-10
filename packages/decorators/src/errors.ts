/**
 * Error thrown when a class declaration or its use breaks the decorators'
 * rules. The causes include a missing or duplicate lifecycle decorator, a
 * misplaced `@Dispose` or `@Inject`, a legacy decorator transform, and
 * construction of an injected class with `new`. The message names the
 * exact violation.
 *
 * Always indicates a bug in how a class is declared or used. Fix the
 * declaration rather than catching this at runtime.
 */
export class DecoratorValidationError extends Error {
  override name = 'DecoratorValidationError'
}
