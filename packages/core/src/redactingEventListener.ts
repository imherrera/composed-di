import type {
  DisposeContext,
  EventOutcome,
  EventSpan,
  InitializeContext,
  MethodCallContext,
  ServiceModuleListener,
} from './serviceModuleListener';
import type { ServiceKey } from './serviceKey';

/**
 * The placeholder that replaces redacted values in event contexts and
 * outcomes.
 */
export const REDACTED_VALUE = '[redacted]';

/**
 * Marks a service — or specific properties of it — as sensitive, so the
 * values flowing through its events are replaced with {@link REDACTED_VALUE}.
 */
export interface RedactionRule<T> {
  /**
   * The service key whose values must be redacted. Matched by key
   * identity, like everywhere else in the container.
   */
  key: ServiceKey<T>;

  /**
   * Property names to redact. Optional: when omitted, ALL properties of
   * the service are redacted, along with its initialize result (the
   * service instance itself may carry credentials or config).
   */
  properties?: Extract<keyof T, string>[];
}

export function redactionRule<T>(key: ServiceKey<T>, properties?: Extract<keyof T, string>[]): RedactionRule<T> {
  return { key, properties };
}

/**
 * A ServiceEventListener decorator that redacts sensitive values before
 * they reach the wrapped listener. Works with any implementation via
 * delegation: arguments in MethodCallContext and success values in
 * EventOutcome are replaced with {@link REDACTED_VALUE}, so the delegate
 * never sees the sensitive data — whatever it captures or exports is
 * already scrubbed.
 *
 * Failure outcomes are passed through unchanged so error reporting keeps
 * working; keep secrets out of error messages at the throwing site.
 *
 * @example
 * ```ts
 * const listener = new RedactingEventListener(
 *   new OTELEventListener({ captureArguments: true, captureResults: true }),
 *   [
 *     { key: SecretClientKey }, // whole service is sensitive
 *     { key: VaultKey, properties: ['getSecret'] }, // only these calls
 *   ],
 * );
 * ```
 */
export class RedactingEventListener implements ServiceModuleListener {
  constructor(
    private readonly delegate: ServiceModuleListener,
    private readonly rules: readonly RedactionRule<any>[],
  ) {}

  onInitialize(context: InitializeContext): EventSpan | void {
    // The initialize result is the service instance itself, so it is
    // redacted only when the whole service is sensitive — a rule without
    // `properties`.
    return redactSpan(
      this.delegate.onInitialize?.(context),
      this.isRedacted(context.key),
    );
  }

  onDispose(context: DisposeContext): EventSpan | void {
    // Dispose carries no arguments and no result value; nothing to redact.
    return this.delegate.onDispose?.(context);
  }

  onMethodCall(context: MethodCallContext): EventSpan | void {
    const redacted = this.isRedacted(context.key, context.functionName);
    const span = this.delegate.onMethodCall?.(
      redacted
        ? // Replace each argument rather than the whole array, so the
          // delegate still sees the call's arity.
          { ...context, args: context.args.map(() => REDACTED_VALUE) }
        : context,
    );
    return redactSpan(span, redacted);
  }

  private isRedacted(key: ServiceKey<any>, propertyName?: string): boolean {
    return this.rules.some(
      (rule) =>
        rule.key === key &&
        // A rule without `properties` redacts everything on the key,
        // including initialize — where no property name is passed —
        // while a rule with `properties` matches only those calls.
        (rule.properties === undefined ||
          (propertyName !== undefined &&
            rule.properties?.includes(propertyName))),
    );
  }
}

/**
 * Wraps the delegate's EventSpan so success values are redacted before
 * `end` sees them. `run` (and any future fields) pass through untouched.
 */
function redactSpan(
  span: EventSpan | void,
  redacted: boolean,
): EventSpan | void {
  if (!redacted || !span?.end) {
    return span;
  }
  const end = span.end.bind(span);
  return {
    ...span,
    end: (outcome: EventOutcome) =>
      end(
        outcome.type === 'success'
          ? { type: 'success', value: REDACTED_VALUE }
          : outcome,
      ),
  };
}
