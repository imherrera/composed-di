import { describe, it, expect } from 'vitest'
import { Singleton, Inject } from '../src/decorators.js'
import { keyOf } from '../src/keyOf.js'
import { DecoratorValidationError } from '../src/errors.js'
import { classKey } from '../src/metadata.js'

// Code review finding #1: static properties inherit through the constructor's
// prototype chain, so `class Sub extends Real {}` can see `Real`'s stamped
// classKey via ordinary property lookup. `keyOf` must read its OWN property
// only (or consult the registry), never the inherited one, or `keyOf(Sub)`
// would silently return `Real`'s key instead of throwing, and `@Inject(Sub)`
// would inject a `Real` instance under `Sub`'s name.
describe('keyOf on an undecorated subclass of a decorated class', () => {
  it('throws instead of inheriting the base class key through the prototype chain', () => {
    @Singleton
    class Real {}

    class Sub extends Real {}

    // Sanity check pinning the exact hazard: ordinary property access on the
    // subclass constructor DOES resolve the base class's stamped key via the
    // prototype chain. `keyOf` must not read the property this way.
    expect((Sub as unknown as Record<symbol, unknown>)[classKey]).toBe(
      (Real as unknown as Record<symbol, unknown>)[classKey],
    )

    expect(() => keyOf(Sub)).toThrow(DecoratorValidationError)
    expect(() => keyOf(Sub)).toThrow(/no lifecycle decorator/)

    // The base class itself must still resolve correctly.
    expect(keyOf(Real)).toBeDefined()
  })

  it('rejects @Inject on an undecorated subclass instead of silently injecting the parent', () => {
    @Singleton
    class Real {}

    class Sub extends Real {}

    expect(() => {
      class Consumer {
        @Inject(Sub)
        readonly dep!: InstanceType<typeof Sub>
      }
      void Consumer
    }).toThrow(DecoratorValidationError)
  })
})
