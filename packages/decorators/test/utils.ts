import { describe, it, expect } from 'vitest'
import { Singleton } from '../src/decorators.js'
import { keyOf } from '../src/utils.js'
import { DecoratorValidationError } from '../src/errors.js'
import { SERVICE_KEY } from '../src/internal/symbols.js'

// Code review finding #1: static properties inherit through the constructor's
// prototype chain, so `class Sub extends Real {}` can see `Real`'s stamped
// SERVICE_KEY via ordinary property lookup. `keyOf` must read its OWN
// property only (or consult the registry), never the inherited one, or
// `keyOf(Sub)` would silently return `Real`'s key instead of throwing.
describe('keyOf', () => {
    it('throws for an undecorated subclass instead of inheriting the base class key through the prototype chain', () => {
        @Singleton
        class Real {}

        class Sub extends Real {}

        // Sanity check pinning the exact hazard: ordinary property access on the
        // subclass constructor DOES resolve the base class's stamped key via the
        // prototype chain. `keyOf` must not read the property this way.
        expect((Sub as unknown as Record<symbol, unknown>)[SERVICE_KEY]).toBe(
            (Real as unknown as Record<symbol, unknown>)[SERVICE_KEY],
        )

        expect(() => keyOf(Sub)).toThrow(DecoratorValidationError)
        expect(() => keyOf(Sub)).toThrow(/no lifecycle decorator/)

        // The base class itself must still resolve correctly.
        expect(keyOf(Real)).toBeDefined()
    })
})
