import type { ServiceKey } from './serviceKey';

/**
 * A handle representing a single in-flight operation (initialization,
 * disposal, or method call), returned by a ServiceEventListener when the
 * operation starts.
 *
 * Exactly one of `end` or `error` is invoked when the operation finishes,
 * so implementations can close over per-call state (start time, an
 * OpenTelemetry span, a correlation id) without any bookkeeping to pair
 * concurrent start/finish events.
 */
export interface EventSpan {
  /**
   * Invoked when the operation completes successfully. For methods that
   * return a promise, this fires when the promise resolves, not when the
   * method returns.
   *
   * Whether to retain or log the outcome is the implementation's choice;
   * the value is passed by reference, so implementations must not mutate it.
   *
   * @param outcome - The outcome of the operation. Present for method call
   * spans (the return or resolved value) and initialize spans (the service
   * instance), absent for dispose spans.
   * @return void
   */
  end?(outcome?: EventOutcome): void;

  /**
   * Invoked when the operation throws or rejects. Terminal like `end`;
   * the two are mutually exclusive. The error is rethrown to the caller
   * after this is invoked.
   *
   * @param error - The error object or value that was thrown or rejected.
   * @return void
   */
  error?(error: unknown): void;
}

/**
 * The successful outcome of an operation, delivered to EventSpan.end.
 * Future fields (e.g. a correlation id) are added here rather than as
 * extra parameters.
 */
export interface EventOutcome {
  /**
   * The value produced by the operation: the return value for synchronous
   * methods, or the resolved value for methods returning a promise.
   */
  result: unknown;
}

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
  methodName: string;

  /**
   * The arguments the method was invoked with, passed by reference;
   * implementations must not mutate them.
   */
  args: readonly unknown[];
}

/**
 * Interface for listening to service events. Implement this interface to
 * observe lifecycle events and method calls of services in a module.
 *
 * Each method is invoked when the corresponding operation starts and may
 * return an EventSpan that is notified when that operation finishes.
 * Returning nothing opts out of completion tracking for that call.
 */
export interface ServiceEventListener {
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
