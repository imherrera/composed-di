import { ServiceKey } from '@composed-di/core'
import { DecoratorValidationError } from './errors.js'
import {
  type ClassRegistration,
  type DisposeHook,
  type FieldInjection,
  type Lifecycle,
} from './metadata.js'
import type { Constructor } from './types.js'
import { PENDING_DISPOSES, PENDING_FIELDS, SERVICE_KEY } from './symbols.js'

/**
 * Owns every class registration made by the lifecycle decorators. Static
 * only, never instantiated.
 */
export class LifecycleRegistry {
  /**
   * Registrations by class, keyed by the exact class object. Subclasses are
   * never looked up through their parents. Deliberately per copy. Only the
   * stamped `ServiceKey` crosses duplicated copies of this package.
   */
  private static readonly registrations = new WeakMap<
    Constructor<object>,
    ClassRegistration
  >()

  private constructor() {
    // Static only.
  }

  /**
   * Parks an `@Inject` field on its class definition's decorator metadata
   * until the class's lifecycle decorator claims it.
   */
  static addPendingField(
    metadata: DecoratorMetadataObject | undefined,
    field: FieldInjection,
  ): void {
    LifecycleRegistry.park(metadata, PENDING_FIELDS, field)
  }

  /**
   * Parks an `@Dispose` hook on its class definition's decorator metadata
   * until the class's lifecycle decorator claims it.
   */
  static addPendingDispose(
    metadata: DecoratorMetadataObject | undefined,
    hook: DisposeHook,
  ): void {
    LifecycleRegistry.park(metadata, PENDING_DISPOSES, hook)
  }

  private static park<T>(
    metadata: DecoratorMetadataObject | undefined,
    slot: symbol,
    record: T,
  ): void {
    if (metadata === undefined) {
      throw new DecoratorValidationError(
        'decorator metadata is unavailable. Requires a compiler that implements decorator metadata (TypeScript 5.2 or later) and a defined Symbol.metadata, which importing @composed-di/decorators provides',
      )
    }
    const records = LifecycleRegistry.ownRecords<T>(metadata, slot)
    if (records === undefined) {
      metadata[slot] = [record]
    } else {
      records.push(record)
    }
  }

  private static claim<T>(
    metadata: DecoratorMetadataObject | undefined,
    slot: symbol,
  ): T[] {
    return metadata === undefined
      ? []
      : (LifecycleRegistry.ownRecords<T>(metadata, slot) ?? [])
  }

  /**
   * Reads the records under `slot` as an own property only. A metadata
   * object inherits from the base class's metadata, and records must never
   * park on or be claimed from the parent's slot.
   */
  private static ownRecords<T>(
    metadata: DecoratorMetadataObject,
    slot: symbol,
  ): T[] | undefined {
    return Object.getOwnPropertyDescriptor(metadata, slot)?.value as
      | T[]
      | undefined
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
   * Returns the {@link Inject} fields of the class and of every decorated class in
   * its prototype chain, base-first. The one registry read that crosses
   * inheritance, unlike {@link LifecycleRegistry.get} and {@link LifecycleRegistry.getServiceKey}.
   */
  static getInjectedFields(constructor: Constructor<object>): FieldInjection[] {
    const chain: FieldInjection[][] = []
    for (
      let current: object | null = constructor;
      current !== null;
      current = Object.getPrototypeOf(current)
    ) {
      const registration = LifecycleRegistry.get(current as Constructor<object>)
      if (registration) {
        chain.unshift([...registration.fields])
      }
    }
    return chain.flat()
  }

  /**
   * Returns the {@link ServiceKey} stamped on the exact class by the lifecycle
   * decorator {@link Singleton} or {@link Transient}, or undefined if it has
   * none. Reads the class's own stamp only, never one inherited from a
   * decorated base class.
   */
  static getServiceKey(
    constructor: Constructor<unknown>,
  ): ServiceKey<unknown> | undefined {
    const stamped: unknown = Object.getOwnPropertyDescriptor(
      constructor,
      SERVICE_KEY,
    )?.value
    return stamped instanceof ServiceKey ? stamped : undefined
  }

  /**
   * Records a class's lifecycle. Claims the pending `@Inject` fields and
   * `@Dispose` hook, validates them, mints the class's `ServiceKey`, and
   * stamps it under `SERVICE_KEY`.
   */
  static register(
    constructor: Constructor<object>,
    context: ClassDecoratorContext,
    lifecycle: Lifecycle,
  ): void {
    const className = context.name ?? constructor.name

    if (LifecycleRegistry.has(constructor)) {
      throw new DecoratorValidationError(
        `class ${className} already has a lifecycle decorator. Apply exactly one of @Singleton or @Transient`,
      )
    }

    const fields = LifecycleRegistry.claim<FieldInjection>(
      context.metadata,
      PENDING_FIELDS,
    )
    const seen = new Set<string | symbol>()
    for (const field of fields) {
      if (seen.has(field.name)) {
        throw new DecoratorValidationError(
          `field ${className}.${String(field.name)} has more than one @Inject decorator`,
        )
      }
      seen.add(field.name)
    }

    const disposes = LifecycleRegistry.claim<DisposeHook>(
      context.metadata,
      PENDING_DISPOSES,
    )
    if (disposes.length > 1) {
      throw new DecoratorValidationError(
        `class ${className} has more than one @Dispose method. A class has exactly one teardown`,
      )
    }
    const dispose = disposes[0]
    if (dispose !== undefined && lifecycle === 'transient') {
      throw new DecoratorValidationError(
        `class ${className} is @Transient. Transient instances are owned by their requester, so @Dispose is not allowed`,
      )
    }

    const key = new ServiceKey<unknown>(className)
    Object.defineProperty(constructor, SERVICE_KEY, { value: key })
    LifecycleRegistry.registrations.set(constructor, {
      lifecycle,
      key,
      fields,
      dispose,
    })
  }
}
