import { describe, it, expect } from 'vitest'
import type { FieldInjection } from '../src/metadata.js'

// Code review finding #3: `classKey` is global-registry-backed
// (`Symbol.for`) specifically so that duplicate copies of this package agree
// on the slot. `currentStash` in metadata.ts is a plain module-scoped `let`,
// so it does NOT have that property: two separate module instances of
// metadata.js (as would exist if the package were duplicated in the
// dependency tree) disagree about which stash is active. A class constructed
// under copy A's `runWithFieldStash` is invisible to copy B's
// `activeFieldStash()`. Fix: either back the stash by the same kind of
// global slot as classKey, so duplicate copies agree, or document why
// duplication can't happen and this is a non-issue.
//
// Two distinct module instances of the same compiled file are simulated
// here the same way duplicate installs would produce them: distinct
// resolved specifiers for the same underlying module.
//
// This asserts the CORRECT behavior -- both copies must see the same active
// stash -- and therefore fails until that's fixed.
describe('field stash visibility across duplicate module instances', () => {
  it('must be visible across duplicate copies, like the global-registry-backed classKey', async () => {
    // Built from a non-literal so `tsc` doesn't try to statically resolve
    // the query-suffixed specifier (Node resolves it fine at runtime; the
    // suffix is exactly what makes it load as a second module instance).
    const specifier = '../src/metadata.js'
    const metaA = (await import(specifier + '?copyA')) as typeof import('../src/metadata.js')
    const metaB = (await import(specifier + '?copyB')) as typeof import('../src/metadata.js')

    // Confirms the simulation actually produced two distinct module
    // instances, not the same one resolved twice.
    expect(metaA).not.toBe(metaB)

    // classKey is deliberately global-registry backed, so duplicate copies
    // already agree on the slot.
    expect(metaA.classKey).toBe(metaB.classKey)

    // The active stash must agree across copies too.
    const stash = {
      values: new Map<FieldInjection, unknown>(),
      consumed: new Set<FieldInjection>(),
    }
    metaA.runWithFieldStash(stash, () => {
      expect(metaA.activeFieldStash()).toBe(stash)
      expect(metaB.activeFieldStash()).toBe(stash)
    })
  })
})
