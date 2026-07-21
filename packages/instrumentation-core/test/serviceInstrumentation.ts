import { describe, expect, it } from 'vitest'
import { ServiceFactory, ServiceKey, ServiceModule } from '@composed-di/core'
import {
  DisposeContext,
  InitializeContext,
  MethodCallContext,
  OperationOutcome,
  OperationSpan,
  ServiceInstrumentation,
} from '../src'

/**
 * Records every event as `<service>.<operation>:<phase>` so tests can
 * assert on what install() reported and how often.
 */
class RecordingListener extends ServiceInstrumentation {
  readonly events: string[] = []

  initializeSpan({ key }: InitializeContext): OperationSpan {
    return this.span(`${key.name}.initialize`)
  }

  disposeSpan({ key }: DisposeContext): OperationSpan {
    return this.span(`${key.name}.dispose`)
  }

  methodCallSpan({ key, methodName }: MethodCallContext): OperationSpan {
    return this.span(`${key.name}.${methodName}`)
  }

  count(event: string): number {
    return this.events.filter((e) => e === event).length
  }

  private span(name: string): OperationSpan {
    this.events.push(`${name}:start`)
    return {
      run: (fn) => fn(),
      end: (outcome: OperationOutcome) =>
        this.events.push(
          `${name}:${outcome.type === 'success' ? 'end' : 'error'}`,
        ),
    }
  }
}

describe('install() lifetime dispatch', () => {
  describe('singleton delegates', () => {
    it('should preserve identity across get() calls and initialize once', async () => {
      const Key = new ServiceKey<{ id: number }>('singleton')
      let counter = 0
      const factory = ServiceFactory.singleton({
        provides: Key,
        initialize: () => ({ id: ++counter }),
      })
      const recorder = new RecordingListener()
      const module = ServiceModule.from(recorder.install([factory]))

      const a = await module.get(Key)
      const b = await module.get(Key)
      expect(a).toBe(b)
      expect(counter).toBe(1)
      // Repeat gets are cache hits inside the delegate, not
      // initializations — they must not be reported as one.
      expect(recorder.count('singleton.initialize:start')).toBe(1)
    })

    it('should report dispose and tear down the delegate', async () => {
      const Key = new ServiceKey<{ x: number }>('singleton')
      let disposed = false
      const factory = ServiceFactory.singleton({
        provides: Key,
        initialize: () => ({ x: 1 }),
        dispose: () => {
          disposed = true
        },
      })
      const recorder = new RecordingListener()
      const module = ServiceModule.from(recorder.install([factory]))

      await module.get(Key)
      module.dispose()
      expect(disposed).toBe(true)
      expect(recorder.count('singleton.dispose:start')).toBe(1)
      expect(recorder.count('singleton.dispose:end')).toBe(1)
    })

    it('should initialize a fresh instance after dispose()', async () => {
      const Key = new ServiceKey<{ id: number }>('singleton')
      let counter = 0
      const factory = ServiceFactory.singleton({
        provides: Key,
        initialize: () => ({ id: ++counter }),
      })
      const recorder = new RecordingListener()
      const module = ServiceModule.from(recorder.install([factory]))

      const before = await module.get(Key)
      module.dispose()
      const after = await module.get(Key)
      expect(before).not.toBe(after)
      expect(after.id).toBe(2)
      expect(recorder.count('singleton.initialize:start')).toBe(2)
    })
  })

  describe('one-shot delegates', () => {
    it('should initialize on every get() and observe each instance', async () => {
      const Key = new ServiceKey<{ id(): number }>('oneShot')
      let counter = 0
      const factory = ServiceFactory.oneShot({
        provides: Key,
        initialize: () => {
          const id = ++counter
          return { id: () => id }
        },
      })
      const recorder = new RecordingListener()
      const module = ServiceModule.from(recorder.install([factory]))

      const a = await module.get(Key)
      const b = await module.get(Key)
      // install() must not impose singleton semantics on a one-shot
      // delegate: each get() produces (and reports) a fresh instance.
      expect(a).not.toBe(b)
      expect(a.id()).toBe(1)
      expect(b.id()).toBe(2)
      expect(recorder.count('oneShot.initialize:start')).toBe(2)
      expect(recorder.count('oneShot.id:start')).toBe(2)
    })
  })

  describe('already-instrumented factories', () => {
    it('should pass through factories it already wrapped instead of double-reporting', async () => {
      const Key = new ServiceKey<{ ping(): string }>('svc')
      const factory = ServiceFactory.singleton({
        provides: Key,
        initialize: () => ({ ping: () => 'pong' }),
      })
      const recorder = new RecordingListener()
      const once = recorder.install([factory])
      const twice = recorder.install(once)

      // The second install must not wrap again: same factory, and every
      // operation reported exactly once.
      expect(twice[0]).toBe(once[0])
      const module = ServiceModule.from(twice)
      const svc = await module.get(Key)
      svc.ping()
      expect(recorder.count('svc.initialize:start')).toBe(1)
      expect(recorder.count('svc.ping:start')).toBe(1)
    })

    it("should skip instrumented factories arriving via a ServiceModule's factories", async () => {
      const Key = new ServiceKey<{ x: number }>('svc')
      const factory = ServiceFactory.singleton({
        provides: Key,
        initialize: () => ({ x: 1 }),
      })
      const recorder = new RecordingListener()
      const instrumentedModule = ServiceModule.from(recorder.install([factory]))
      const module = ServiceModule.from(
        recorder.install(instrumentedModule.factories),
      )

      await module.get(Key)
      expect(recorder.count('svc.initialize:start')).toBe(1)
    })
  })

  describe('unknown implementations', () => {
    it('should reject factories whose lifetime cannot be determined', () => {
      const Key = new ServiceKey<{ x: number }>('rogue')
      const handcrafted: ServiceFactory<{ x: number }, []> = {
        provides: Key,
        dependsOn: [],
        scope: undefined,
        initialize: () => ({ x: 1 }),
        dispose: () => {},
      }
      const recorder = new RecordingListener()

      // A handcrafted factory gives no way to tell a real initialization
      // from a memoized cache hit, so install() refuses it loudly instead
      // of silently changing its semantics.
      expect(() => recorder.install([handcrafted])).toThrow(
        /Cannot instrument factory .* for rogue/,
      )
    })
  })
})
