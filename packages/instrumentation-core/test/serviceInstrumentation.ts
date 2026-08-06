import { describe, expect, it } from 'vitest'
import {
  ServiceFactory,
  ServiceKey,
  ServiceModule,
  SingletonDisposedDuringInitError,
} from '@composed-di/core'
import {
  LifecycleContext,
  MethodCallContext,
  OperationOutcome,
  OperationSpan,
  ServiceInstrumentation,
} from '../src'

/**
 * Records every event as `<service>.<operation>:<phase>` so tests can
 * assert on what install() reported and how often. Delivered method-call
 * contexts and final outcomes are kept verbatim for value assertions.
 */
class RecordingListener extends ServiceInstrumentation {
  readonly events: string[] = []
  readonly methodContexts: MethodCallContext[] = []
  readonly outcomes = new Map<string, OperationOutcome>()

  lifecycleSpan(context: LifecycleContext): OperationSpan {
    return this.span(
      context.key ? `${context.key.name}.${context.event}` : context.event,
    )
  }

  methodCallSpan(context: MethodCallContext): OperationSpan {
    this.methodContexts.push(context)
    return this.span(`${context.key.name}.${context.methodName}`)
  }

  count(event: string): number {
    return this.events.filter((e) => e === event).length
  }

  private span(name: string): OperationSpan {
    this.events.push(`${name}:start`)
    return {
      run: (fn) => fn(),
      end: (outcome: OperationOutcome) => {
        this.outcomes.set(name, outcome)
        this.events.push(
          `${name}:${outcome.type === 'success' ? 'end' : 'error'}`,
        )
      },
    }
  }
}

/** Lets the module's dependency resolution and factory microtasks run. */
const flushTasks = () => new Promise((resolve) => setTimeout(resolve, 0))

describe('install() lifetime dispatch', () => {
  describe('singleton delegates', () => {
    it('should preserve identity across get() calls and initialize once', async () => {
      const key = new ServiceKey<{ id: number }>('singleton')
      let counter = 0
      const factory = ServiceFactory.singleton({
        provides: key,
        initialize: () => ({ id: ++counter }),
      })
      const recorder = new RecordingListener()
      const module = ServiceModule.from(recorder.install([factory]))

      const a = await module.get(key)
      const b = await module.get(key)
      expect(a).toBe(b)
      expect(counter).toBe(1)
      // Repeat gets are cache hits inside the delegate, not
      // initializations — they must not be reported as one.
      expect(recorder.count('singleton.factory_initialize:start')).toBe(1)
    })

    it('should report dispose and tear down the delegate', async () => {
      const key = new ServiceKey<{ x: number }>('singleton')
      let disposed = false
      const factory = ServiceFactory.singleton({
        provides: key,
        initialize: () => ({ x: 1 }),
        dispose: () => {
          disposed = true
        },
      })
      const recorder = new RecordingListener()
      const module = ServiceModule.from(recorder.install([factory]))

      await module.get(key)
      module.dispose()
      expect(disposed).toBe(true)
      expect(recorder.count('singleton.factory_dispose:start')).toBe(1)
      expect(recorder.count('singleton.factory_dispose:end')).toBe(1)
    })

    it('should initialize a fresh instance after dispose()', async () => {
      const key = new ServiceKey<{ id: number }>('singleton')
      let counter = 0
      const factory = ServiceFactory.singleton({
        provides: key,
        initialize: () => ({ id: ++counter }),
      })
      const recorder = new RecordingListener()
      const module = ServiceModule.from(recorder.install([factory]))

      const before = await module.get(key)
      module.dispose()
      const after = await module.get(key)
      expect(before).not.toBe(after)
      expect(after.id).toBe(2)
      expect(recorder.count('singleton.factory_initialize:start')).toBe(2)
    })
  })

  describe('one-shot delegates', () => {
    it('should initialize on every get() and observe each instance', async () => {
      const key = new ServiceKey<{ id(): number }>('oneShot')
      let counter = 0
      const factory = ServiceFactory.oneShot({
        provides: key,
        initialize: () => {
          const id = ++counter
          return { id: () => id }
        },
      })
      const recorder = new RecordingListener()
      const module = ServiceModule.from(recorder.install([factory]))

      const a = await module.get(key)
      const b = await module.get(key)
      // install() must not impose singleton semantics on a one-shot
      // delegate: each get() produces (and reports) a fresh instance.
      expect(a).not.toBe(b)
      expect(a.id()).toBe(1)
      expect(b.id()).toBe(2)
      expect(recorder.count('oneShot.factory_initialize:start')).toBe(2)
      expect(recorder.count('oneShot.id:start')).toBe(2)
    })
  })

  describe('already-instrumented factories', () => {
    it('should pass through factories it already wrapped instead of double-reporting', async () => {
      const key = new ServiceKey<{ ping(): string }>('svc')
      const factory = ServiceFactory.singleton({
        provides: key,
        initialize: () => ({ ping: () => 'pong' }),
      })
      const recorder = new RecordingListener()
      const once = recorder.install([factory])
      const twice = recorder.install(once)

      // The second install must not wrap again: same factory, and every
      // operation reported exactly once.
      expect(twice[0]).toBe(once[0])
      const module = ServiceModule.from(twice)
      const svc = await module.get(key)
      svc.ping()
      expect(recorder.count('svc.factory_initialize:start')).toBe(1)
      expect(recorder.count('svc.ping:start')).toBe(1)
    })

    it("should skip instrumented factories arriving via a ServiceModule's factories", async () => {
      const key = new ServiceKey<{ x: number }>('svc')
      const factory = ServiceFactory.singleton({
        provides: key,
        initialize: () => ({ x: 1 }),
      })
      const recorder = new RecordingListener()
      const instrumentedModule = ServiceModule.from(recorder.install([factory]))
      const module = ServiceModule.from(
        recorder.install(instrumentedModule.factories),
      )

      await module.get(key)
      expect(recorder.count('svc.factory_initialize:start')).toBe(1)
    })
  })

  describe('unknown implementations', () => {
    it('should reject factories whose lifetime cannot be determined', () => {
      const key = new ServiceKey<{ x: number }>('rogue')
      const handcrafted: ServiceFactory<{ x: number }, []> = {
        provides: key,
        dependsOn: [],
        initialize: () => ({ x: 1 }),
        getInstance: () => undefined,
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

describe('install() overload shapes', () => {
  it('should wrap a single factory passed without an array', async () => {
    const key = new ServiceKey<{ ping(): string }>('svc')
    const factory = ServiceFactory.singleton({
      provides: key,
      initialize: () => ({ ping: () => 'pong' }),
    })
    const recorder = new RecordingListener()
    const instrumented = recorder.install(factory)

    expect(Array.isArray(instrumented)).toBe(false)
    expect(instrumented).not.toBe(factory)
    // Re-installing the wrapper in single form passes it through unchanged.
    expect(recorder.install(instrumented)).toBe(instrumented)

    const module = ServiceModule.from([instrumented])
    const svc = await module.get(key)
    svc.ping()
    expect(recorder.count('svc.factory_initialize:start')).toBe(1)
    expect(recorder.count('svc.ping:start')).toBe(1)
  })

  it('should map an array to a new array of wrappers, preserving order and keys', () => {
    const aKey = new ServiceKey<{ x: number }>('a')
    const bKey = new ServiceKey<{ y: number }>('b')
    const originals = [
      ServiceFactory.singleton({
        provides: aKey,
        initialize: () => ({ x: 1 }),
      }),
      ServiceFactory.oneShot({ provides: bKey, initialize: () => ({ y: 2 }) }),
    ]
    const recorder = new RecordingListener()
    const instrumented = recorder.install(originals)

    expect(instrumented).not.toBe(originals)
    expect(instrumented).toHaveLength(2)
    expect(instrumented[0].provides).toBe(aKey)
    expect(instrumented[1].provides).toBe(bKey)
    expect(instrumented[0]).not.toBe(originals[0])
    expect(instrumented[1]).not.toBe(originals[1])
  })

  it('should return a new observed ServiceModule for a module input', async () => {
    const key = new ServiceKey<{ ping(): string }>('svc')
    const original = ServiceModule.from([
      ServiceFactory.singleton({
        provides: key,
        initialize: () => ({ ping: () => 'pong' }),
      }),
    ])
    const recorder = new RecordingListener()
    const instrumented = recorder.install(original)

    expect(instrumented).toBeInstanceOf(ServiceModule)
    expect(instrumented).not.toBe(original)

    const svc = await instrumented.get(key)
    expect(svc.ping()).toBe('pong')
    expect(recorder.count('svc.factory_initialize:start')).toBe(1)
    expect(recorder.count('svc.ping:start')).toBe(1)
  })

  it('should leave the original module serving raw, unobserved instances', async () => {
    const key = new ServiceKey<{ ping(): string }>('svc')
    const original = ServiceModule.from([
      ServiceFactory.singleton({
        provides: key,
        initialize: () => ({ ping: () => 'pong' }),
      }),
    ])
    const recorder = new RecordingListener()
    const instrumented = recorder.install(original)

    const observed = await instrumented.get(key)
    observed.ping()
    const eventsSoFar = recorder.events.length

    // install() never mutates its input: the original module still hands
    // out the raw instance, and using it reports nothing.
    const raw = await original.get(key)
    expect(raw.ping()).toBe('pong')
    expect(raw).not.toBe(observed)
    expect(recorder.events).toHaveLength(eventsSoFar)
  })

  it('should pass through the factories of an already-instrumented module', async () => {
    const key = new ServiceKey<{ ping(): string }>('svc')
    const original = ServiceModule.from([
      ServiceFactory.singleton({
        provides: key,
        initialize: () => ({ ping: () => 'pong' }),
      }),
    ])
    const recorder = new RecordingListener()
    const once = recorder.install(original)
    const twice = recorder.install(once)

    // A new module is built, but around the same wrappers — no double
    // wrapping, every operation reported exactly once.
    expect(twice.factories[0]).toBe(once.factories[0])
    const svc = await twice.get(key)
    svc.ping()
    expect(recorder.count('svc.factory_initialize:start')).toBe(1)
    expect(recorder.count('svc.ping:start')).toBe(1)
  })
})

describe('install() initialization outcomes', () => {
  it('should end the initialize span only when an async initialize resolves', async () => {
    const key = new ServiceKey<{ ready(): boolean }>('slow')
    let resolveInit!: (instance: { ready(): boolean }) => void
    const factory = ServiceFactory.singleton({
      provides: key,
      initialize: () =>
        new Promise<{ ready(): boolean }>((resolve) => {
          resolveInit = resolve
        }),
    })
    const recorder = new RecordingListener()
    const module = ServiceModule.from(recorder.install([factory]))

    const pending = module.get(key)
    await flushTasks()
    expect(recorder.count('slow.factory_initialize:start')).toBe(1)
    expect(recorder.count('slow.factory_initialize:end')).toBe(0)

    resolveInit({ ready: () => true })
    const svc = await pending
    expect(recorder.count('slow.factory_initialize:end')).toBe(1)
    expect(svc.ready()).toBe(true)
    expect(recorder.count('slow.ready:start')).toBe(1)
  })

  it('should report a failed initialize, rethrow it, and not cache it', async () => {
    const key = new ServiceKey<{ id: number }>('flaky')
    let attempts = 0
    const factory = ServiceFactory.singleton({
      provides: key,
      initialize: () => {
        attempts += 1
        if (attempts === 1) {
          throw new Error('connection refused')
        }
        return { id: attempts }
      },
    })
    const recorder = new RecordingListener()
    const module = ServiceModule.from(recorder.install([factory]))

    await expect(module.get(key)).rejects.toThrow('connection refused')
    expect(recorder.count('flaky.factory_initialize:error')).toBe(1)
    expect(recorder.outcomes.get('flaky.factory_initialize')).toEqual({
      type: 'failure',
      error: new Error('connection refused'),
    })

    // The failure was rethrown, not cached: the next get() retries and is
    // reported as a fresh initialization.
    const svc = await module.get(key)
    expect(svc.id).toBe(2)
    expect(recorder.count('flaky.factory_initialize:start')).toBe(2)
    expect(recorder.count('flaky.factory_initialize:end')).toBe(1)
  })

  it('should report a failing dispose and rethrow its error', async () => {
    const key = new ServiceKey<{ x: number }>('svc')
    const factory = ServiceFactory.singleton({
      provides: key,
      initialize: () => ({ x: 1 }),
      dispose: () => {
        throw new Error('already closed')
      },
    })
    const recorder = new RecordingListener()
    const module = ServiceModule.from(recorder.install([factory]))
    await module.get(key)

    expect(() => module.dispose()).toThrow('already closed')
    expect(recorder.count('svc.factory_dispose:error')).toBe(1)
  })

  it('should preserve dispose-during-initialization semantics through the wrapper', async () => {
    const key = new ServiceKey<{ x: number }>('svc')
    let resolveInit!: (instance: { x: number }) => void
    let disposed = false
    const factory = ServiceFactory.singleton({
      provides: key,
      initialize: () =>
        new Promise<{ x: number }>((resolve) => {
          resolveInit = resolve
        }),
      dispose: () => {
        disposed = true
      },
    })
    const recorder = new RecordingListener()
    const module = ServiceModule.from(recorder.install([factory]))

    const pending = module.get(key)
    await flushTasks()
    module.dispose()

    resolveInit({ x: 1 })
    await expect(pending).rejects.toThrow(SingletonDisposedDuringInitError)

    // The initialization itself succeeded, and the orphaned instance was
    // immediately torn down; both operations are reported.
    expect(disposed).toBe(true)
    expect(recorder.count('svc.factory_initialize:end')).toBe(1)
    expect(recorder.count('svc.factory_dispose:start')).toBe(1)
    expect(recorder.count('svc.factory_dispose:end')).toBe(1)
  })
})

describe('install() method call outcomes', () => {
  it('should end the span with the captured value only when the promise resolves', async () => {
    const key = new ServiceKey<{ fetch(): Promise<string> }>('api')
    let resolveFetch!: (value: string) => void
    const factory = ServiceFactory.singleton({
      provides: key,
      initialize: () => ({
        fetch: () =>
          new Promise<string>((resolve) => {
            resolveFetch = resolve
          }),
      }),
    })
    const recorder = new RecordingListener()
    const module = ServiceModule.from(
      recorder.install([factory], { capture: { results: true } }),
    )

    const svc = await module.get(key)
    const call = svc.fetch()
    expect(recorder.count('api.fetch:start')).toBe(1)
    expect(recorder.count('api.fetch:end')).toBe(0)

    resolveFetch('payload')
    await expect(call).resolves.toBe('payload')
    expect(recorder.count('api.fetch:end')).toBe(1)
    expect(recorder.outcomes.get('api.fetch')).toEqual({
      type: 'success',
      value: 'payload',
    })
  })

  it('should end the span with a failure when the promise rejects', async () => {
    const key = new ServiceKey<{ fetch(): Promise<string> }>('api')
    const failure = new Error('timeout')
    const factory = ServiceFactory.singleton({
      provides: key,
      initialize: () => ({ fetch: () => Promise.reject(failure) }),
    })
    const recorder = new RecordingListener()
    const module = ServiceModule.from(recorder.install([factory]))

    const svc = await module.get(key)
    await expect(svc.fetch()).rejects.toBe(failure)
    expect(recorder.count('api.fetch:error')).toBe(1)
    expect(recorder.outcomes.get('api.fetch')).toEqual({
      type: 'failure',
      error: failure,
    })
  })
})

describe('install() contract preservation', () => {
  it('should preserve dependsOn and inject resolved dependencies into the delegate', async () => {
    const configKey = new ServiceKey<{ url: string }>('config')
    const dbKey = new ServiceKey<{ connectedTo(): string }>('db')
    const recorder = new RecordingListener()
    const instrumented = recorder.install([
      ServiceFactory.singleton({
        provides: configKey,
        initialize: () => ({ url: 'postgres://real' }),
      }),
      ServiceFactory.singleton({
        provides: dbKey,
        dependsOn: [configKey],
        initialize: (config) => ({ connectedTo: () => config.url }),
      }),
    ])
    expect(instrumented[1].dependsOn).toEqual([configKey])

    const module = ServiceModule.from(instrumented)
    const db = await module.get(dbKey)
    expect(db.connectedTo()).toBe('postgres://real')
    // The dependency is initialized (and observed) before its dependent.
    expect(
      recorder.events.indexOf('config.factory_initialize:end'),
    ).toBeLessThan(recorder.events.indexOf('db.factory_initialize:end'))
  })

  it('should report className for class instances and omit it for literals', async () => {
    class PaymentGateway {
      charge(): string {
        return 'ok'
      }
    }
    const classKey = new ServiceKey<PaymentGateway>('gateway')
    const literalKey = new ServiceKey<{ charge(): string }>('literal')
    const recorder = new RecordingListener()
    const module = ServiceModule.from(
      recorder.install([
        ServiceFactory.singleton({
          provides: classKey,
          initialize: () => new PaymentGateway(),
        }),
        ServiceFactory.singleton({
          provides: literalKey,
          initialize: () => ({ charge: () => 'ok' }),
        }),
      ]),
    )

    const gateway = await module.get(classKey)
    gateway.charge()
    const literal = await module.get(literalKey)
    literal.charge()

    const [fromClass, fromLiteral] = recorder.methodContexts
    expect(fromClass.className).toBe('PaymentGateway')
    expect(fromLiteral.className).toBeUndefined()
    // No options were given, so no arguments are delivered either.
    expect(fromClass.args).toBeUndefined()
  })

  it('should return non-object instances untouched', async () => {
    const key = new ServiceKey<string>('token')
    const factory = ServiceFactory.oneShot({
      provides: key,
      initialize: () => 'abc-123',
    })
    const recorder = new RecordingListener()
    const module = ServiceModule.from(recorder.install([factory]))

    const token = await module.get(key)
    expect(token).toBe('abc-123')
    expect(recorder.count('token.factory_initialize:end')).toBe(1)
  })
})
