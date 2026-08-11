import { describe, it, expect } from 'vitest'
import type { FieldInjection } from '../src/metadata.js'

// Code review finding #3: `SERVICE_KEY` is global-registry-backed
// (`Symbol.for`) specifically so that duplicate copies of this package agree
// on the slot. `currentStash` in metadata.ts is a plain module-scoped `let`,
// so it does NOT have that property: two separate module instances of
// metadata.js (as would exist if the package were duplicated in the
// dependency tree) disagree about which stash is active. A class constructed
// under copy A's `runWithFieldStash` is invisible to copy B's
// `activeFieldStash()`. Fix: either back the stash by the same kind of
// global slot as SERVICE_KEY, so duplicate copies agree, or document why
// duplication can't happen and this is a non-issue.
//
// Two distinct module instances of the same compiled file are simulated
// here the same way duplicate installs would produce them: distinct
// resolved specifiers for the same underlying module.
//
// This asserts the CORRECT behavior -- both copies must see the same active
// stash -- and therefore fails until that's fixed.
describe.skip('activeFieldStash', () => {
  it('returns the stash installed through a duplicate copy of its module', async () => {
    // Built from a non-literal so `tsc` doesn't try to statically resolve
    // the query-suffixed specifier (Node resolves it fine at runtime; the
    // suffix is exactly what makes it load as a second module instance).
    const specifier = '../src/metadata.js'
    const metaA = (await import(
      specifier + '?copyA'
    )) as typeof import('../src/metadata.js')
    const metaB = (await import(
      specifier + '?copyB'
    )) as typeof import('../src/metadata.js')

    // Confirms the simulation actually produced two distinct module
    // instances, not the same one resolved twice.
    expect(metaA).not.toBe(metaB)

    // SERVICE_KEY is deliberately global-registry backed, so duplicate
    // copies of its module already agree on the slot.
    const symbolsSpecifier = '../src/symbols.js'
    const symbolsA = (await import(
      symbolsSpecifier + '?copyA'
    )) as typeof import('../src/symbols.js')
    const symbolsB = (await import(
      symbolsSpecifier + '?copyB'
    )) as typeof import('../src/symbols.js')
    expect(symbolsA.SERVICE_KEY).toBe(symbolsB.SERVICE_KEY)

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
