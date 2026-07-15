import type {
  DisposeContext,
  EventOutcome,
  EventSpan,
  InitializeContext,
  MethodCallContext,
  ServiceInstrumentation,
} from './serviceInstrumentation'
import type { ServiceKey } from '@composed-di/core'

/**
 * The placeholder that replaces a redacted value when no custom
 * transform is given for it.
 */
export const REDACTED_VALUE = '[REDACTED]'

/**
 * Custom masking for one included property, narrowed to the exact
 * method named when {@link RedactionRuleBuilder.redact} is called.
 * Omitting a side fully blanks it with {@link REDACTED_VALUE}; providing
 * one lets you report a partial mask instead (e.g. the last 4 digits of
 * a card number) — both always return a `string`, the masked
 * representation to report in place of the real value.
 */
export type Mask<T, K extends Extract<keyof T, string>> = T[K] extends (
  ...args: infer A
) => infer R
  ? {
      maskArgs?: (...args: A) => string
      maskResult?: (result: R) => string
    }
  : never

/**
 * Per-property override, layered on top of a rule's `redactAll` default.
 * `redacted: true` (from {@link RedactionRuleBuilder.redact}) redacts
 * that property, optionally with a custom mask; `redacted: false` (from
 * {@link RedactionRuleBuilder.exclude}) forces it to be left untouched
 * regardless of `redactAll`.
 */
interface PropertyOverride {
  redacted: boolean
  maskArgs?: (...args: any[]) => string
  maskResult?: (result: any) => string
}

/**
 * Marks a service — or specific properties of it — as sensitive, so the
 * values flowing through its events are redacted. Returned by
 * {@link RedactionRuleBuilder.build}, which is the only way to construct
 * one — the `redactAll`/per-property merge logic lives entirely inside
 * `maskArgs`/`maskResult`, so callers never need to know how a rule
 * reached its decision, only what to do with it.
 */
export interface RedactionRule<T> {
  readonly key: ServiceKey<T>

  /**
   * The args to report for a call to `functionName`: unchanged if not
   * redacted, otherwise blanked or run through a custom `maskArgs`.
   */
  maskArgs(functionName: string, args: readonly unknown[]): readonly unknown[]

  /**
   * The value to report for a success outcome: unchanged if not
   * redacted, otherwise blanked or run through a custom `maskResult`.
   * Omit `functionName` to ask about the initialize result (the service
   * instance itself), which only the rule's `redactAll` default touches.
   */
  maskResult(functionName: string | undefined, result: unknown): unknown
}

/**
 * Fluent, single-key rule builder returned by {@link redactionRule}.
 * `redactAll`, `redact`, and `exclude` all merge into the same rule —
 * call them in any combination, in any order; the more specific
 * per-property calls (`redact`/`exclude`) always win over the blanket
 * `redactAll` default for the properties they name.
 *
 * @example
 * ```ts
 * const rules = [
 *   redactionRule(SecretClientKey)
 *     .redactAll()
 *     .build(), // whole service is sensitive
 *   redactionRule(BillingKey)
 *     .redactAll()
 *     .redact('chargeCard', { maskResult: (card) => `card ending in ${card.number.slice(-4)}` })
 *     .exclude('ping') // redact everything except this, with one custom mask
 *     .build(),
 *   redactionRule(VaultKey)
 *     .redact('getSecret')
 *     .build(), // only this call, nothing else
 * ];
 * ```
 */
export class RedactionRuleBuilder<T> {
  private redactAllFlag = false
  private hasRedact = false
  private readonly overrides: Record<string, PropertyOverride> = {}

  constructor(private readonly key: ServiceKey<T>) {}

  /** Redacts every property, plus the initialize result, by default. */
  redactAll(): this {
    this.redactAllFlag = true
    this.hasRedact = true
    return this
  }

  /**
   * Marks one property (method) as redacted, with optional custom
   * masking. Call repeatedly for several properties. Overrides
   * `redactAll`/`exclude` for this specific property.
   */
  redact<K extends Extract<keyof T, string>>(name: K, mask?: Mask<T, K>): this {
    this.overrides[name] = { redacted: true, ...mask }
    this.hasRedact = true
    return this
  }

  /**
   * Marks one or more properties as explicitly NOT redacted, overriding
   * `redactAll` for just these.
   */
  exclude(...names: Extract<keyof T, string>[]): this {
    for (const name of names) {
      this.overrides[name] = { redacted: false }
    }
    return this
  }

  build(): RedactionRule<any> {
    // `exclude` alone never redacts anything — at least one call to
    // `redactAll`/`redact` is required for this rule to have any effect.
    if (!this.hasRedact) {
      throw new Error(
        `redactionRule(${this.key.name}) has no effect: call .redactAll() and/or .redact(...) ` +
          'before .build() — .exclude() alone never redacts anything.',
      )
    }

    const redactAllFlag = this.redactAllFlag
    const overrides = this.overrides

    return {
      key: this.key,
      maskArgs(functionName, args) {
        const override = overrides[functionName]
        const redacted = override ? override.redacted : redactAllFlag
        if (!redacted) {
          return args
        }
        return override?.maskArgs
          ? // A custom mask reports one string for the whole call,
            // rather than a value per argument.
            [override.maskArgs(...args)]
          : // Replace each argument rather than the whole array, so the
            // delegate still sees the call's arity.
            args.map(() => REDACTED_VALUE)
      },
      maskResult(functionName, result) {
        const override =
          functionName === undefined ? undefined : overrides[functionName]
        const redacted = override ? override.redacted : redactAllFlag
        if (!redacted) {
          return result
        }
        return override?.maskResult
          ? override.maskResult(result)
          : REDACTED_VALUE
      },
    } as RedactionRule<any>
  }
}

export function redactionRule<T>(key: ServiceKey<T>): RedactionRuleBuilder<T> {
  return new RedactionRuleBuilder(key)
}

/**
 * A ServiceInstrumentation decorator that redacts sensitive values before
 * they reach the wrapped instrumentation. Works with any implementation via
 * delegation: arguments in MethodCallContext and success values in
 * EventOutcome are replaced (wholesale, or via a custom transform)
 * before the delegate ever sees them — whatever it captures or exports
 * is already scrubbed.
 *
 * Failure outcomes are passed through unchanged so error reporting keeps
 * working; keep secrets out of error messages at the throwing site.
 *
 * @example
 * ```ts
 * const instrumentation = new RedactingInstrumentation(
 *   new OTELInstrumentation({ captureArguments: true, captureResults: true }),
 *   [
 *     redactionRule(SecretClientKey).redactAll().build(), // whole service is sensitive
 *     redactionRule(VaultKey).redact('getSecret').build(), // only this call
 *     redactionRule(HealthKey).redactAll().exclude('ping').build(), // everything but this call
 *   ],
 * );
 * ```
 */
export class RedactingInstrumentation implements ServiceInstrumentation {
  constructor(
    private readonly delegate: ServiceInstrumentation,
    private readonly rules: readonly RedactionRule<any>[],
  ) {}

  onInitialize(context: InitializeContext): EventSpan | void {
    const rule = this.rules.find((r) => r.key === context.key)
    return redactSpan(this.delegate.onInitialize?.(context), rule)
  }

  onDispose(context: DisposeContext): EventSpan | void {
    // Dispose carries no arguments and no result value; nothing to redact.
    return this.delegate.onDispose?.(context)
  }

  onMethodCall(context: MethodCallContext): EventSpan | void {
    const rule = this.rules.find((r) => r.key === context.key)
    const span = this.delegate.onMethodCall?.(
      rule
        ? {
            ...context,
            args: rule.maskArgs(context.functionName, context.args),
          }
        : context,
    )
    return redactSpan(span, rule, context.functionName)
  }
}

/**
 * Wraps the delegate's EventSpan so success values are redacted before
 * `end` sees them, by delegating to the rule's `maskResult`. `run` (and
 * any future fields) pass through untouched. `functionName` is omitted
 * for the initialize result (the instance itself).
 */
function redactSpan(
  span: EventSpan | void,
  rule: RedactionRule<any> | undefined,
  functionName?: string,
): EventSpan | void {
  if (!rule || !span) {
    return span
  }
  const end = span.end.bind(span)
  return {
    ...span,
    end: (outcome: EventOutcome) =>
      end(
        outcome.type === 'success'
          ? {
              type: 'success',
              value: rule.maskResult(functionName, outcome.value),
            }
          : outcome,
      ),
  }
}
