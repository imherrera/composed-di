// The global names this package claims. Every entry is backed by the global
// symbol registry so that duplicated copies of this package agree on it.
// Membership rule: global coordination points only, nothing else.
//
// The cross-copy guarantee is key-only. Duplicated copies agree on a class's
// stamped `ServiceKey`, so decorated classes work as tokens everywhere.
// Everything else (registrations, the field stash) is per copy: a copy's
// `factoryOf` constructs only classes its own decorators registered.

// TypeScript populates `context.metadata` only when `Symbol.metadata` is
// defined, and no engine defines it natively yet.
;(Symbol as { metadata?: symbol }).metadata ??= Symbol.for('Symbol.metadata')

/**
 * The symbol under which a lifecycle decorator stamps the class's own
 * `ServiceKey`.
 */
export const SERVICE_KEY = Symbol.for('__service_key__')

/**
 * The decorator-metadata slots where member decorators park their records
 * until the class's lifecycle decorator claims them. Metadata is shared by
 * exactly the decorators of one class definition, so a record can never
 * reach another class.
 */
export const PENDING_FIELDS = Symbol.for('__pending_fields__')
export const PENDING_DISPOSES = Symbol.for('__pending_disposes__')
