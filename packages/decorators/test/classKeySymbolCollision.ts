import { describe, it, expect } from 'vitest'
import { Singleton } from '../src/decorators.js'
import { classKey } from '../src/metadata.js'

// Code review finding #2: `classKey` is `Symbol.for('__service_key__')`, a
// process-global, unnamespaced registry key. Any other writer in the
// dependency tree that happens to stamp the same generic symbol onto a class
// collides with us. Because `LifecycleRegistry.register` stamps the property
// with `Object.defineProperty` (non-configurable by default), a second
// writer on a class it doesn't own gets a raw `TypeError`, not a
// `DecoratorValidationError`. Suggested fix: namespace the symbol, e.g.
// `Symbol.for('@composed-di/decorators#classKey')`, so accidental collisions
// with unrelated code become effectively impossible.
//
// These assert the CORRECT behavior and therefore fail until that's fixed.
describe('classKey global symbol namespacing', () => {
  it('must not be the bare, unnamespaced __service_key__ symbol', () => {
    expect(classKey.description).not.toBe('__service_key__')
    expect(classKey).not.toBe(Symbol.for('__service_key__'))
  })

  it('must not collide with unrelated code that happens to stamp the old generic slot', () => {
    const genericSlot = Symbol.for('__service_key__')

    class Foreign {}
    // Simulates unrelated code elsewhere in the tree stamping the generic,
    // pre-fix slot for its own unrelated purposes -- not our (namespaced)
    // classKey, so it must not be able to block our registration.
    Object.defineProperty(Foreign, genericSlot, { value: 'not-ours' })

    const context = { name: 'Foreign' } as unknown as ClassDecoratorContext<
      typeof Foreign
    >

    expect(() => Singleton(Foreign, context)).not.toThrow()
  })
})
