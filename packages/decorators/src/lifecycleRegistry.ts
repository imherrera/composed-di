import { ServiceKey } from '@composed-di/core'
import {
  DisposeHookError,
  DuplicateLifecycleError,
  FieldInjectionError,
} from './errors.js'
import {
  classKey,
  type ClassRegistration,
  type DisposeHook,
  type FieldInjection,
  type Lifecycle,
} from './metadata.js'
import type { Constructor } from './types.js'

/**
 * Owns every class registration made by the lifecycle decorators. Static
 * only, never instantiated.
 */
export class LifecycleRegistry {
  /**
   * Registrations by class, keyed by the exact class object. Subclasses are
   * never looked up through their parents.
   */
  private static readonly registrations = new WeakMap<
    Constructor<object>,
    ClassRegistration
  >()

  /**
   * Lifecycles by the symbol of the key each registration minted, so a later
   * class definition can validate its `@Inject` fields against the
   * lifecycles of already-registered classes.
   */
  private static readonly lifecycleByKeySymbol = new Map<symbol, Lifecycle>()

  /**
   * Fields recorded by `@Inject` decorators that have not yet been claimed
   * by a lifecycle decorator.
   *
   * Field decorators cannot see their class, but the decorator standard
   * applies all member decorators before the class decorator of the same
   * class definition, so `@Inject` parks each field here and `register`
   * drains the list synchronously, before any other class definition can
   * interleave.
   */
  private static readonly pendingFields: FieldInjection[] = []

  /**
   * Hooks recorded by `@OnDispose` decorators that have not yet been claimed
   * by a lifecycle decorator. Same drain discipline as {@link pendingFields}.
   */
  private static readonly pendingDisposes: DisposeHook[] = []

  private constructor() {
    // Static only.
  }

  /**
   * Parks an `@Inject` field until the class's lifecycle decorator claims it.
   */
  static addPendingField(field: FieldInjection): void {
    LifecycleRegistry.pendingFields.push(field)
  }

  /**
   * Parks an `@OnDispose` hook until the class's lifecycle decorator claims it.
   */
  static addPendingDispose(hook: DisposeHook): void {
    LifecycleRegistry.pendingDisposes.push(hook)
  }

  private static drainPendingFields(): FieldInjection[] {
    return LifecycleRegistry.pendingFields.splice(
      0,
      LifecycleRegistry.pendingFields.length,
    )
  }

  private static drainPendingDisposes(): DisposeHook[] {
    return LifecycleRegistry.pendingDisposes.splice(
      0,
      LifecycleRegistry.pendingDisposes.length,
    )
  }

  /**
   * Whether a lifecycle decorator has registered the exact class.
   */
  static has(constructor: Constructor<object>): boolean {
    return LifecycleRegistry.registrations.has(constructor)
  }

  /**
   * Returns the registration recorded for the exact class, or `undefined`
   * if it has none.
   */
  static get(constructor: Constructor<object>): ClassRegistration | undefined {
    return LifecycleRegistry.registrations.get(constructor)
  }

  /**
   * Records a class's lifecycle. Claims the pending `@Inject` fields and
   * `@OnDispose` hook, validates them, mints the class's `ServiceKey`, and
   * stamps it under `classKey`.
   */
  static register(
    constructor: Constructor<object>,
    context: ClassDecoratorContext,
    lifecycle: Lifecycle,
  ): void {
    const className = context.name ?? constructor.name

    if (LifecycleRegistry.has(constructor)) {
      throw new DuplicateLifecycleError(
        `class ${className} already has a lifecycle decorator. Apply exactly one of @Singleton or @OneShot`,
      )
    }

    const fields = LifecycleRegistry.drainPendingFields()
    const seen = new Set<string | symbol>()
    for (const field of fields) {
      if (seen.has(field.name)) {
        throw new FieldInjectionError(
          `field ${className}.${String(field.name)} has more than one @Inject decorator`,
        )
      }
      seen.add(field.name)
    }

    const namesByKey = new Map<symbol, (string | symbol)[]>()
    for (const field of fields) {
      const names = namesByKey.get(field.key.symbol) ?? []
      names.push(field.name)
      namesByKey.set(field.key.symbol, names)
    }
    for (const [symbol, names] of namesByKey) {
      if (
        names.length > 1 &&
        LifecycleRegistry.lifecycleByKeySymbol.get(symbol) === 'singleton'
      ) {
        throw new FieldInjectionError(
          `class ${className}: the fields [${names.map(String).join(', ')}] inject the same @Singleton class. They would all share one instance, so declare a single field`,
        )
      }
    }

    const disposes = LifecycleRegistry.drainPendingDisposes()
    if (disposes.length > 1) {
      throw new DisposeHookError(
        `class ${className} has more than one @OnDispose method. A class has exactly one teardown`,
      )
    }
    const dispose = disposes[0]
    if (dispose !== undefined) {
      if (lifecycle === 'oneShot') {
        throw new DisposeHookError(
          `class ${className} is @OneShot. One-shot instances are owned by their requester, so @OnDispose is not allowed`,
        )
      }
      const method = dispose.isPrivate
        ? undefined
        : Object.getOwnPropertyDescriptor(constructor.prototype, dispose.name)
            ?.value
      if (!dispose.isPrivate && typeof method !== 'function') {
        throw new DisposeHookError(
          `@OnDispose method ${String(dispose.name)} does not belong to class ${className}. Is a lifecycle decorator missing on another class?`,
        )
      }
    }

    const key = new ServiceKey<unknown>(className)
    Object.defineProperty(constructor, classKey, { value: key })
    LifecycleRegistry.registrations.set(constructor, {
      lifecycle,
      key,
      fields,
      dispose,
    })
    LifecycleRegistry.lifecycleByKeySymbol.set(key.symbol, lifecycle)
  }
}
