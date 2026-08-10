import { ServiceKey } from '@composed-di/core'
import type { RedactionRule } from './redaction.js'

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
export interface OperationSpan {
  /**
   * Wrapper around the operation itself. The instrumented factory invokes
   * the operation as `run(() => operation())`, so the instrumentation can
   * establish ambient state that the operation body and its async
   * continuations inherit. This is what lets spans of nested service
   * calls form a parent-child hierarchy.
   *
   * Implementations must invoke `fn` exactly once, synchronously, and
   * return its result unchanged (for async operations, the promise itself).
   * `end` is still delivered separately when the operation finishes.
   *
   * @param fn - A thunk that performs the operation.
   * @return The value returned by `fn`.
   */
  run<T>(fn: () => T): T

  /**
   * Invoked exactly once when the operation finishes, whether it succeeded
   * or failed. For methods that return a promise, this fires when the
   * promise settles, not when the method returns. On failure, the error is
   * rethrown to the caller after this is invoked.
   *
   * Whether to retain or log the outcome is the implementation's choice.
   * Values are passed by reference, so implementations must not mutate them.
   *
   * @param outcome - How the operation finished, and its value or error.
   * @return void
   */
  end(outcome: OperationOutcome): void
}

/**
 * How an operation finished, delivered to OperationSpan.end. `success` may
 * carry the return or resolved value of a method call (initialize and
 * dispose outcomes never carry one). `failure` carries the error that was
 * thrown or rejected.
 *
 * Whether `value` is present is decided by {@link ServiceInstrumentation.install},
 * not by the implementation. It is absent unless result capture is enabled
 * in the InstrumentOptions, and holds the redacted value when a redaction
 * rule matches. Implementations must record the value exactly when it is
 * present (`'value' in outcome`) and must not record any result when it
 * is absent. A captured `undefined` return is delivered as a present
 * `value: undefined`.
 */
export type OperationOutcome =
  | { type: 'success'; value?: unknown }
  | { type: 'failure'; error: unknown }

/**
 * The lifecycle operations reported to
 * {@link ServiceInstrumentation.lifecycleSpan}. `factory_*` events are the
 * operations of an instrumented factory on its one service, `module_*`
 * events are the public entry points of an instrumented ServiceModule.
 */
export type ServiceLifecycleEvent =
  | 'factory_initialize'
  | 'factory_dispose'
  | 'module_get'
  | 'module_get_or_null'
  | 'module_dispose'

/**
 * Context of a lifecycle operation, delivered to lifecycleSpan.
 * Future fields are added here rather than as extra parameters.
 *
 * Every event carries the key of the service it concerns except
 * `module_dispose`, which tears down every factory in the module and so
 * has no single key (each factory's own teardown is still reported as a
 * keyed `factory_dispose`).
 */
export type LifecycleContext =
  | {
      /**
       * Which lifecycle operation is starting.
       */
      event: Exclude<ServiceLifecycleEvent, 'module_dispose'>

      /**
       * The unique identifier of the service the operation concerns.
       */
      key: ServiceKey<unknown>
    }
  | {
      event: 'module_dispose'
      key?: undefined
    }

/**
 * Context of a method invocation, delivered to onMethodCall.
 * Future fields are added here rather than as extra parameters.
 */
export interface MethodCallContext {
  /**
   * The unique identifier of the service the method belongs to.
   */
  key: ServiceKey<unknown>

  /**
   * The name of the class implementing the service (the instance's
   * constructor name), which may differ from `key.name`. Undefined for
   * services that are not instances of a named class, such as plain
   * object literals.
   */
  className?: string | undefined

  /**
   * The name of the method that is being called.
   */
  methodName: string

  /**
   * The arguments to report for this call, passed by reference.
   * Implementations must not mutate them.
   *
   * Whether they are present is decided by {@link ServiceInstrumentation.install},
   * not by the implementation. Absent unless argument capture is enabled in
   * the InstrumentOptions, and already redacted when a redaction rule
   * matches. Implementations must record the arguments exactly when present
   * and must not record any arguments when absent.
   */
  args?: readonly unknown[] | undefined
}

/**
 * What runtime values are delivered to the instrumentation, and how they
 * are scrubbed first. Nothing is captured by default. Values may be large
 * or contain secrets, and they end up wherever the instrumentation
 * exports them.
 */
export interface CaptureOptions {
  /**
   * Deliver method arguments to the instrumentation (as
   * MethodCallContext.args). When off, the instrumentation never sees the
   * arguments at all.
   */
  arguments?: boolean

  /**
   * Deliver method call return / resolved values to the instrumentation
   * (as the success outcome's `value`). When off, the instrumentation
   * never sees the values at all. Initialize and dispose outcomes never
   * carry a value. The service instance is not useful information to
   * report.
   */
  results?: boolean

  /**
   * Per-service redaction applied to whatever the capture flags let
   * through. Matched arguments and success values are blanked (or run
   * through the rule's custom mask) before the instrumentation sees them.
   * The capture flags are the primary gate. When capture is off there is
   * nothing to redact, and rules cannot re-enable delivery.
   */
  redactionRules?: readonly RedactionRule<any>[]
}

/**
 * Configuration for {@link ServiceInstrumentation.install}. Capture
 * policy lives here, not in the ServiceInstrumentation subclasses. What a
 * subclass receives is exactly what it is allowed to record, so no
 * subclass carries its own capture flags or redaction logic.
 */
export interface InstrumentOptions {
  /**
   * What runtime values (arguments, results) reach the instrumentation,
   * and the redaction applied to them first. Nothing is captured when
   * omitted.
   */
  capture?: CaptureOptions
}
