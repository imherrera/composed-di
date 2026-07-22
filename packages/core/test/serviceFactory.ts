import { describe, it, expect } from 'vitest'
import { ServiceKey } from '../src/serviceKey'
import { ServiceFactory } from '../src/serviceFactory'
import {
  ServiceDisposedDuringInitError,
  ServiceFactoryIllegalUsageError,
} from '../src/errors'

/**
 * Test-controlled promise. Every interleaving in this suite is driven
 * deterministically: the test decides exactly when an initialization settles
 * relative to dispose() calls and to other initialize() calls. No timers,
 * nothing races the scheduler.
 */
function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

describe('SingletonServiceFactory', () => {
  describe('singleton', () => {
    it('Should be an instance of ServiceFactory', () => {
      expect(
        ServiceFactory.singleton({
          provides: new ServiceKey<string>('Key'),
          initialize: () => 'value',
        }),
      ).toBeInstanceOf(ServiceFactory)
    })
  })

  describe('initialize', () => {
    it('deduplicates concurrent initialization: one onInitialize call, same promise reference', async () => {
      const key = new ServiceKey<{ id: number }>('Key')
      const d = deferred<{ id: number }>()
      let calls = 0
      const factory = ServiceFactory.singleton({
        provides: key,
        initialize: () => {
          calls++
          return d.promise
        },
      })

      const p1 = factory.initialize()
      const p2 = factory.initialize()

      // Identical reference: the second caller joined the in-flight slot.
      expect(p2).toBe(p1)
      expect(calls).toBe(1)

      const instance = { id: 1 }
      d.resolve(instance)
      await expect(p1).resolves.toBe(instance)
    })

    // Pins the ordering guarantee that makes the hoisted-pending design safe:
    // the async wrapper's first operation is `await pending`, which always
    // suspends to a microtask — so the slot is claimed before the wrapper can
    // possibly settle, even for a plain synchronous return value.
    it('dedups within the same tick even for a synchronous initializer', async () => {
      const key = new ServiceKey<string>('Key')
      let calls = 0
      const factory = ServiceFactory.singleton({
        provides: key,
        initialize: () => {
          calls++
          return 'value'
        },
      })

      const p1 = factory.initialize()
      const p2 = factory.initialize()

      expect(p2).toBe(p1)
      expect(calls).toBe(1)
      await expect(p1).resolves.toBe('value')
    })

    // Documented dedup semantics: concurrent callers may pass different
    // dependencies; only the first caller wins, silently.
    it('ignores dependencies from later concurrent callers (first caller wins)', async () => {
      const depKey = new ServiceKey<number>('Dep')
      const key = new ServiceKey<string>('Key')
      const d = deferred<string>()
      const received: number[] = []
      const factory = ServiceFactory.singleton({
        provides: key,
        dependsOn: [depKey] as const,
        initialize: (dep) => {
          received.push(dep)
          return d.promise
        },
      })

      const p1 = factory.initialize(1)
      const p2 = factory.initialize(2)

      expect(p2).toBe(p1)
      expect(received).toEqual([1])

      d.resolve('value')
      await expect(p1).resolves.toBe('value')
    })

    it('returns the retained instance synchronously once initialization has settled', async () => {
      const key = new ServiceKey<{ id: number }>('Key')
      let calls = 0
      const factory = ServiceFactory.singleton({
        provides: key,
        initialize: () => {
          calls++
          return { id: calls }
        },
      })

      const first = await factory.initialize()

      const second = factory.initialize()
      // The retained fast path returns T itself — not a promise — and does
      // not re-invoke the initializer.
      expect(second).not.toBeInstanceOf(Promise)
      expect(second).toBe(first)
      expect(calls).toBe(1)
    })

    // Regression: the retained guard once checked the raw value (truthiness /
    // `!== undefined`), so falsy instances silently broke the singleton
    // contract and were re-created on every call. The { value } box is the
    // fix; these cases pin it, `undefined` being the nastiest.
    it.each([undefined, null, 0, '', false])(
      'retains falsy instance (%j) without re-initializing, and disposes it',
      async (falsy) => {
        const key = new ServiceKey<unknown>('Key')
        const disposed: unknown[] = []
        let calls = 0
        const factory = ServiceFactory.singleton({
          provides: key,
          initialize: () => {
            calls++
            return falsy
          },
          dispose: (instance) => disposed.push(instance),
        })

        expect(await factory.initialize()).toBe(falsy)
        expect(await factory.initialize()).toBe(falsy)
        expect(factory.initialize()).toBe(falsy) // sync retained path
        expect(calls).toBe(1)

        factory.dispose()
        expect(disposed).toEqual([falsy])

        // dispose really cleared the box: the next call re-creates.
        expect(await factory.initialize()).toBe(falsy)
        expect(calls).toBe(2)
      },
    )

    // Regression: a synchronous onInitialize throw once sequenced an internal
    // `finally` BEFORE the slot assignment, permanently caching the rejected
    // promise — every later call served it without re-running the
    // initializer. The hoisted `pending` call means the throw now escapes
    // with nothing cached. This test fails against every pre-hoist iteration.
    it('a synchronous onInitialize throw escapes synchronously and does not poison the slot', async () => {
      const key = new ServiceKey<string>('Key')
      let calls = 0
      const factory = ServiceFactory.singleton({
        provides: key,
        initialize: () => {
          calls++
          if (calls === 1) throw new Error('sync boom')
          return 'recovered'
        },
      })

      expect(() => factory.initialize()).toThrow('sync boom')
      expect(calls).toBe(1)

      // The next call must re-invoke the initializer, not serve a cached
      // rejection.
      expect(await factory.initialize()).toBe('recovered')
      expect(calls).toBe(2)
    })

    it('concurrent waiters share a failed initialization, and the next call retries', async () => {
      const key = new ServiceKey<string>('Key')
      let calls = 0
      const factory = ServiceFactory.singleton({
        provides: key,
        initialize: async () => {
          calls++
          if (calls === 1) throw new Error('async boom')
          return 'recovered'
        },
      })

      const p1 = factory.initialize()
      const p2 = factory.initialize()
      expect(p2).toBe(p1)

      await expect(p1).rejects.toThrow('async boom')
      expect(calls).toBe(1) // both waiters shared ONE failed attempt

      expect(await factory.initialize()).toBe('recovered')
      expect(calls).toBe(2)
    })

    it('recovers after onInitialize illegally calls dispose()', async () => {
      const key = new ServiceKey<string>('Key')
      let attempts = 0
      let misbehave = true
      const factory = ServiceFactory.singleton({
        provides: key,
        initialize: () => {
          attempts++
          if (misbehave) {
            misbehave = false
            factory.dispose() // throws here, at the culprit
          }
          return 'value'
        },
      })

      expect(() => factory.initialize()).toThrow(
        ServiceFactoryIllegalUsageError,
      )
      expect(attempts).toBe(1)

      // Nothing cached, guard disengaged: the retry contract holds.
      expect(await factory.initialize()).toBe('value')
      expect(attempts).toBe(2)
    })

    it('throws ServiceFactoryIllegalUsageError when onInitialize calls initialize()', () => {
      const key = new ServiceKey<string>('Key')
      const factory = ServiceFactory.singleton({
        provides: key,
        initialize: () => {
          factory.initialize()
          return 'value'
        },
      })

      expect(() => factory.initialize()).toThrow(
        ServiceFactoryIllegalUsageError,
      )
    })

    it('throws ServiceFactoryIllegalUsageError when onInitialize calls dispose()', () => {
      const key = new ServiceKey<string>('Key')
      const factory = ServiceFactory.singleton({
        provides: key,
        initialize: () => {
          factory.dispose()
          return 'value'
        },
      })

      expect(() => factory.initialize()).toThrow(
        ServiceFactoryIllegalUsageError,
      )
    })

    it('does not leave the guard engaged after a re-entrant call is rejected', async () => {
      const key = new ServiceKey<string>('Key')
      const factory = ServiceFactory.singleton({
        provides: key,
        initialize: () => {
          expect(() => factory.initialize()).toThrow(
            ServiceFactoryIllegalUsageError,
          )
          return 'value'
        },
      })

      expect(await factory.initialize()).toBe('value')
      expect(() => factory.dispose()).not.toThrow()
    })

    // Skipped — and the gap is narrower than it looks. Post-await reentry
    // cannot corrupt state: by the time the initializer's continuation runs,
    // the in-flight slot is already claimed, so an inner initialize() simply
    // joins that promise via dedup (one instance either way). The residual
    // risk is an initializer that AWAITS its own promise — a silent
    // self-deadlock, annoying but not corrupting. Catching it means tracking
    // the hook's async continuation (AsyncLocalStorage), which ties core to
    // Node and breaks bundling on runtimes like React Native. If the deadlock
    // ever bites, the path is a pluggable tracker: no-op default in core, ALS
    // implementation behind a Node-only subpath export — and this test
    // un-skips in the Node suite. The assertion below is the correct tier-2
    // semantics: the reentry happens BEFORE the init promise settles, so a
    // settled-marker ALS guard would still flag it as inside-the-hook.
    it.skip('throws ServiceFactoryIllegalUsageError when onInitialize calls initialize() after an await', async () => {
      const key = new ServiceKey<string>('Key')
      let caught: unknown
      const factory = ServiceFactory.singleton({
        provides: key,
        initialize: async () => {
          await Promise.resolve()
          try {
            factory.initialize()
          } catch (e) {
            caught = e
          }
          return 'value'
        },
      })

      expect(await factory.initialize()).toBe('value')
      expect(caught).toBeInstanceOf(ServiceFactoryIllegalUsageError)
    })
  })

  describe('dispose', () => {
    it('supports repeated dispose/initialize cycles: one fresh instance per generation', async () => {
      const key = new ServiceKey<{ gen: number }>('Key')
      const disposed: number[] = []
      let calls = 0
      const factory = ServiceFactory.singleton({
        provides: key,
        initialize: () => ({ gen: calls++ }),
        dispose: (instance) => disposed.push(instance.gen),
      })

      for (let cycle = 0; cycle < 3; cycle++) {
        const instance = await factory.initialize()
        expect(instance.gen).toBe(cycle)
        expect(factory.initialize()).toBe(instance) // retained within the cycle
        factory.dispose()
      }

      expect(calls).toBe(3)
      expect(disposed).toEqual([0, 1, 2]) // every generation torn down exactly once
    })

    it('double dispose and dispose-before-initialize never over-invoke onDispose', async () => {
      const key = new ServiceKey<string>('Key')
      const disposed: string[] = []
      const factory = ServiceFactory.singleton({
        provides: key,
        initialize: () => 'value',
        dispose: (instance) => disposed.push(instance),
      })

      factory.dispose() // nothing ever initialized: must be a silent no-op
      expect(disposed).toEqual([])

      await factory.initialize()
      factory.dispose()
      factory.dispose() // nothing retained anymore: onDispose must not re-fire
      expect(disposed).toEqual(['value'])
    })

    // Regression: dispose once ran onDispose BEFORE clearing state, so a
    // throwing teardown left the dead instance retained — and every later
    // initialize() re-served the corpse. Clear-then-call is the contract.
    it('a throwing onDispose cannot re-serve the disposed instance', async () => {
      const key = new ServiceKey<{ id: number }>('Key')
      let calls = 0
      const factory = ServiceFactory.singleton({
        provides: key,
        initialize: () => {
          calls++
          return { id: calls }
        },
        dispose: () => {
          throw new Error('teardown failed')
        },
      })

      const first = await factory.initialize()
      expect(() => factory.dispose()).toThrow('teardown failed')

      // State was cleared before the callback ran: fresh instance, not the
      // one whose teardown already (half-)executed.
      const second = await factory.initialize()
      expect(second).not.toBe(first)
      expect(second).toEqual({ id: 2 })
      expect(calls).toBe(2)
    })

    it('tears down the orphan instance and rejects waiters with ServiceDisposedDuringInitError', async () => {
      const key = new ServiceKey<{ id: number }>('Key')
      const d = deferred<{ id: number }>()
      const disposed: Array<{ id: number }> = []
      let calls = 0
      const factory = ServiceFactory.singleton({
        provides: key,
        initialize: () => {
          calls++
          return calls === 1 ? d.promise : { id: 99 }
        },
        dispose: (instance) => disposed.push(instance),
      })

      const inFlight = factory.initialize()

      factory.dispose()
      // Nothing was retained yet: onDispose must not fire during dispose
      // itself — only when the orphan actually arrives.
      expect(disposed).toEqual([])

      const orphan = { id: 1 }
      d.resolve(orphan)

      await expect(inFlight).rejects.toBeInstanceOf(
        ServiceDisposedDuringInitError,
      )
      // The late-arriving instance was handed to onDispose — not leaked.
      expect(disposed).toEqual([orphan])

      // And the factory is clean: the next call starts a fresh generation.
      expect(await factory.initialize()).toEqual({ id: 99 })
      expect(calls).toBe(2)
    })

    // Regression: the wrapper's finally once cleared the slot
    // unconditionally, so a STALE generation settling evicted a REVIVED
    // generation's in-flight promise — a third caller then started a second
    // concurrent initialization and the singleton split (two live instances,
    // one orphaned undisposed). The generation-guarded finally pins the fix.
    it('a stale generation settling cannot evict a revived generation in-flight promise', async () => {
      const key = new ServiceKey<{ gen: number }>('Key')
      const dA = deferred<{ gen: number }>()
      const dB = deferred<{ gen: number }>()
      const pendings = [dA.promise, dB.promise]
      const disposed: Array<{ gen: number }> = []
      let calls = 0
      const factory = ServiceFactory.singleton({
        provides: key,
        initialize: () => pendings[calls++]!,
        dispose: (instance) => disposed.push(instance),
      })

      const pA = factory.initialize() // generation 0, in flight
      factory.dispose() // generation 1; slot cleared
      const pB = factory.initialize() // generation 1, in flight
      expect(pB).not.toBe(pA)

      // A settles AFTER the revival.
      const orphanA = { gen: 0 }
      dA.resolve(orphanA)
      await expect(pA).rejects.toBeInstanceOf(ServiceDisposedDuringInitError)
      expect(disposed).toEqual([orphanA])

      // If A's cleanup had clobbered the slot, this third caller would start
      // a SECOND live initialization (calls would reach 3) and split the
      // singleton. It must join B instead.
      const pC = factory.initialize()
      expect(pC).toBe(pB)
      expect(calls).toBe(2)

      const instanceB = { gen: 1 }
      dB.resolve(instanceB)
      await expect(pB).resolves.toBe(instanceB)
      expect(factory.initialize()).toBe(instanceB) // retained, sync path

      // Generation 1 tears down normally after the race.
      factory.dispose()
      expect(disposed).toEqual([orphanA, instanceB])
    })

    it('an initialization that fails after a mid-flight dispose surfaces the original error and stays clean', async () => {
      const key = new ServiceKey<string>('Key')
      const d = deferred<string>()
      let calls = 0
      const factory = ServiceFactory.singleton({
        provides: key,
        initialize: () => {
          calls++
          return calls === 1 ? d.promise : 'recovered'
        },
      })

      const inFlight = factory.initialize()
      factory.dispose()
      d.reject(new Error('init failed'))

      // No instance ever existed: waiters see the initializer's own error —
      // not a disposal error — and nothing needs orphan teardown.
      await expect(inFlight).rejects.toThrow('init failed')

      expect(await factory.initialize()).toBe('recovered')
      expect(calls).toBe(2)
    })

    it('a throwing onDispose during orphan cleanup does not mask the disposal rejection', async () => {
      const key = new ServiceKey<string>('Key')
      const d = deferred<string>()
      const factory = ServiceFactory.singleton({
        provides: key,
        initialize: () => d.promise,
        dispose: () => {
          throw new Error('teardown failed')
        },
      })

      const inFlight = factory.initialize()
      factory.dispose()
      d.resolve('orphan')

      // Waiters must see the lifecycle error, not the teardown error.
      await expect(inFlight).rejects.toBeInstanceOf(
        ServiceDisposedDuringInitError,
      )
    })

    // Proves state was settled BEFORE onDispose ran, so the illegal inner
    // call could not create a zombie, and revival is clean afterward.
    it('recovers after onDispose illegally calls initialize()', async () => {
      const key = new ServiceKey<{ id: number }>('Key')
      let calls = 0
      let misbehave = true
      const factory = ServiceFactory.singleton({
        provides: key,
        initialize: () => {
          calls++
          return { id: calls }
        },
        dispose: () => {
          if (misbehave) {
            misbehave = false
            factory.initialize() // throws here, at the culprit
          }
        },
      })

      const first = await factory.initialize()
      expect(() => factory.dispose()).toThrow(ServiceFactoryIllegalUsageError)

      const second = await factory.initialize()
      expect(second).not.toBe(first)
      expect(calls).toBe(2)

      factory.dispose() // now behaves: plain teardown of the new generation
    })

    it('throws ServiceFactoryIllegalUsageError when onDispose calls initialize()', async () => {
      const key = new ServiceKey<string>('Key')
      const factory = ServiceFactory.singleton({
        provides: key,
        initialize: () => 'value',
        dispose: () => {
          factory.initialize()
        },
      })

      await factory.initialize()

      expect(() => factory.dispose()).toThrow(ServiceFactoryIllegalUsageError)
    })

    it('throws ServiceFactoryIllegalUsageError when onDispose calls dispose()', async () => {
      const key = new ServiceKey<string>('Key')
      const factory = ServiceFactory.singleton({
        provides: key,
        initialize: () => 'value',
        dispose: () => {
          factory.dispose()
        },
      })

      await factory.initialize()

      expect(() => factory.dispose()).toThrow(ServiceFactoryIllegalUsageError)
    })

    // Replaces a formerly-skipped test that asserted the OPPOSITE semantics.
    // Under the framework's temporal rule, work *scheduled* during a hook
    // becomes ordinary app code once the hook settles — so a dispose() from
    // that continuation is not illegal reentry; it is a plain double dispose
    // (benign: nothing retained, onDispose does not re-fire). Any future
    // AsyncLocalStorage-based guard must preserve this via a settled marker;
    // pure causal tainting would wrongly poison timers and reconnect loops
    // scheduled during hooks. This test also proves the dispose-side guard
    // flag is released before dispose() returns.
    it('a dispose() from work scheduled during onDispose is a benign double dispose once the hook settles', async () => {
      const key = new ServiceKey<string>('Key')
      const disposed: string[] = []
      let reentrantAttempt: Promise<unknown> = Promise.resolve()
      const factory = ServiceFactory.singleton({
        provides: key,
        initialize: () => 'value',
        dispose: (instance) => {
          disposed.push(instance)
          reentrantAttempt = (async () => {
            await Promise.resolve() // resumes strictly after dispose() returns
            try {
              factory.dispose()
              return undefined
            } catch (e) {
              return e
            }
          })()
        },
      })

      await factory.initialize()
      factory.dispose()

      expect(await reentrantAttempt).toBeUndefined()
      expect(disposed).toEqual(['value']) // teardown ran exactly once

      // And the factory is still healthy: revival works after the dance.
      expect(await factory.initialize()).toBe('value')
    })
  })
})
