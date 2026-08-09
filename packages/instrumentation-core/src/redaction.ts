import type { ServiceKey } from '@composed-di/core'

/**
 * The placeholder that replaces a redacted value when no custom
 * transform is given for it.
 */
export const REDACTED_VALUE = '[REDACTED]'

/**
 * Custom masking for one included property, narrowed to the exact
 * method named when {@link RedactionRuleBuilder.redact} is called.
 * Omitting a side fully blanks it with {@link REDACTED_VALUE}. Providing
 * one lets you report a partial mask instead (e.g. the last 4 digits of
 * a card number). Both always return a `string`, the masked
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
 * that property, optionally with a custom mask. `redacted: false` (from
 * {@link RedactionRuleBuilder.exclude}) forces it to be left untouched
 * regardless of `redactAll`.
 */
interface PropertyOverride {
  redacted: boolean
  maskArgs?: (...args: any[]) => string
  maskResult?: (result: any) => string
}

/**
 * Marks a service (or specific properties of it) as sensitive, so the
 * values flowing through its events are redacted. Passed to
 * {@link ServiceInstrumentation.install} via the capture options' `redact` list and applied
 * centrally, after the capture flags. Values a rule matches are scrubbed
 * before the instrumentation ever sees them, and when capture is off
 * there is nothing to redact. Returned by
 * {@link RedactionRuleBuilder.build}, which is the only way to construct
 * one. The `redactAll`/per-property merge logic lives entirely inside
 * `maskArgs`/`maskResult`, so callers never need to know how a rule
 * reached its decision, only what to do with it.
 */
export interface RedactionRule<T> {
  readonly key: ServiceKey<T>

  /**
   * The args to report for a call to `methodName`. Unchanged if not
   * redacted, otherwise blanked or run through a custom `maskArgs`.
   */
  maskArgs(methodName: string, args: readonly unknown[]): readonly unknown[]

  /**
   * The value to report for a method call's success outcome. Unchanged
   * if not redacted, otherwise blanked or run through a custom
   * `maskResult`.
   */
  maskResult(methodName: string, result: unknown): unknown
}

/**
 * Fluent, single-key rule builder returned by {@link redactionRule}.
 * `redactAll`, `redact`, and `exclude` all merge into the same rule.
 * Call them in any combination, in any order. The more specific
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
 * ]
 * ```
 */
export class RedactionRuleBuilder<T> {
  private redactAllFlag = false
  private hasRedact = false
  private readonly overrides: Record<string, PropertyOverride> = {}

  constructor(private readonly key: ServiceKey<T>) {}

  /** Redacts every property by default. */
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
    // `exclude` alone never redacts anything. At least one call to
    // `redactAll`/`redact` is required for this rule to have any effect.
    if (!this.hasRedact) {
      throw new Error(
        `redactionRule(${this.key.name}) has no effect. Call .redactAll() and/or .redact(...) ` +
          'before .build(), because .exclude() alone never redacts anything.',
      )
    }

    const redactAllFlag = this.redactAllFlag
    const overrides = this.overrides

    return {
      key: this.key,
      maskArgs(methodName, args) {
        const override = overrides[methodName]
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
      maskResult(methodName, result) {
        const override = overrides[methodName]
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

/**
 * Creates and returns a new RedactionRuleBuilder instance for the specified service key.
 *
 * @param key - The service key associated with the redaction rule to be built.
 * @return A new instance of RedactionRuleBuilder for constructing redaction rules.
 */
export function redactionRule<T>(key: ServiceKey<T>): RedactionRuleBuilder<T> {
  return new RedactionRuleBuilder(key)
}
