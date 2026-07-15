import type { ServiceKey } from '@composed-di/core';

/**
 * A handle representing a single in-flight operation (initialization,
 * disposal, or method call), returned by a ServiceInstrumentation when the
 * operation starts.
 *
 * `end` is invoked exactly once when the operation finishes, so
 * implementations can close over per-call state (a start time, a span
 * handle, a correlation id) without any bookkeeping to pair concurrent
 * start/finish events.
 */
export interface EventSpan {
  /**
   * Wrapper around the operation itself. The instrumented factory invokes
   * the operation as `run(() => operation())`, so the instrumentation can
   * establish ambient state that the operation body and its async
   * continuations inherit — this is what lets spans of nested service
   * calls form a parent-child hierarchy.
   *
   * Implementations must invoke `fn` exactly once, synchronously, and
   * return its result unchanged (for async operations, the promise itself).
   * `end` is still delivered separately when the operation finishes.
   *
   * @param fn - A thunk that performs the operation.
   * @return The value returned by `fn`.
   */
  run<T>(fn: () => T): T;

  /**
   * Invoked exactly once when the operation finishes, whether it succeeded
   * or failed. For methods that return a promise, this fires when the
   * promise settles, not when the method returns. On failure, the error is
   * rethrown to the caller after this is invoked.
   *
   * Whether to retain or log the outcome is the implementation's choice;
   * values are passed by reference, so implementations must not mutate them.
   *
   * @param outcome - How the operation finished, and its value or error.
   * @return void
   */
  end(outcome: EventOutcome): void;
}

/**
 * How an operation finished, delivered to EventSpan.end: `success` carries
 * the value produced by the operation (the return or resolved value for
 * method calls, the service instance for initialize, undefined for
 * dispose); `failure` carries the error that was thrown or rejected.
 */
export type EventOutcome =
  { type: 'success'; value: unknown } | { type: 'failure'; error: unknown };

/**
 * Context of a service initialization, delivered to onInitialize.
 * Future fields are added here rather than as extra parameters.
 */
export interface InitializeContext {
  /**
   * The unique identifier of the service that is being initialized.
   */
  key: ServiceKey<unknown>;
}

/**
 * Context of a service disposal, delivered to onDispose.
 * Future fields are added here rather than as extra parameters.
 */
export interface DisposeContext {
  /**
   * The unique identifier of the service that is being disposed.
   */
  key: ServiceKey<unknown>;
}

/**
 * Context of a method invocation, delivered to onMethodCall.
 * Future fields are added here rather than as extra parameters.
 */
export interface MethodCallContext {
  /**
   * The unique identifier of the service the method belongs to.
   */
  key: ServiceKey<unknown>;

  /**
   * The name of the class implementing the service (the instance's
   * constructor name), which may differ from `key.name`. Undefined for
   * services that are not instances of a named class, such as plain
   * object literals.
   */
  className?: string;

  /**
   * The name of the method that is being called.
   */
  functionName: string;

  /**
   * The arguments the method was invoked with, passed by reference;
   * implementations must not mutate them.
   */
  args: readonly unknown[];
}

/**
 * Interface for instrumenting services wrapped by {@link instrument}.
 * Implement this interface to observe lifecycle events and method calls
 * of the instrumented services.
 *
 * Instrumentation is strictly observational: implementations see every
 * operation but must never alter it — see the EventSpan contract.
 *
 * Each method is invoked when the corresponding operation starts and may
 * return an EventSpan that is notified when that operation finishes.
 * Returning nothing opts out of completion tracking for that call.
 */
export interface ServiceInstrumentation {
  /**
   * Invoked at the start of the initialization process for a specific service.
   *
   * @param context - Context of the initialization, including the service key.
   * @return An EventSpan notified when initialization finishes, or void.
   */
  onInitialize?(context: InitializeContext): EventSpan | void;

  /**
   * Invoked when the disposal process for a service starts.
   *
   * @param context - Context of the disposal, including the service key.
   * @return An EventSpan notified when disposal finishes, or void.
   */
  onDispose?(context: DisposeContext): EventSpan | void;

  /**
   * Invoked when a method call starts on a service instance.
   *
   * @param context - Context of the invocation, including the service key,
   * the method name, and its arguments.
   * @return An EventSpan notified when the call finishes, or void.
   */
  onMethodCall?(context: MethodCallContext): EventSpan | void;
}
