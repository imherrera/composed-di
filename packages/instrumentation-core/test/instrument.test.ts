import { AsyncLocalStorage } from 'node:async_hooks'
import { describe, it, expect } from 'vitest'
import {
  ServiceFactory,
  ServiceKey,
  ServiceModule,
  ServiceScope,
} from '@composed-di/core'
import {
  OperationSpan,
  ServiceInstrumentation,
} from '../src/serviceInstrumentation'

// Records every event as `<service>.<operation>:<phase>` so tests can
// assert on what was observed.
const makeListener = (events: string[]): ServiceInstrumentation => {
  const span = (name: string): OperationSpan => {
    events.push(`${name}:start`)
    return {
      run: (fn) => fn(),
      end: (outcome) =>
        events.push(`${name}:${outcome.type === 'success' ? 'end' : 'error'}`),
    }
  }
  return Object.assign(new ServiceInstrumentation(), {
    onInitialize: ({ key }) => span(`${key.name}.initialize`),
    onDispose: ({ key }) => span(`${key.name}.dispose`),
    onMethodCall: ({ key, methodName }) => span(`${key.name}.${methodName}`),
  } satisfies Partial<ServiceInstrumentation>)
}

// Tests marked `it.fails` document known open issues: they assert the
// desired behavior and currently fail. When an issue is fixed, vitest
// reports the test as "expected to fail but passed" — remove the `.fails`
// modifier to turn it into a regression test.
describe('instrument', () => {
  describe('resolution through an observed module', () => {
    it('should resolve the service instance, not undefined', async () => {
      const Key = new ServiceKey<{ greet(): string }>('svc')
      const factory = ServiceFactory.singleton({
        provides: Key,
        initialize: () => ({ greet: () => 'hi' }),
      })
      const module = ServiceModule.from(makeListener([]).instrument([factory]))

      const svc = await module.get(Key)
      expect(svc).toBeDefined()
      expect(svc.greet()).toBe('hi')
    })

    it('should report start and end events for initialization', async () => {
      const Key = new ServiceKey<{ greet(): string }>('svc')
      const factory = ServiceFactory.singleton({
        provides: Key,
        initialize: () => ({ greet: () => 'hi' }),
      })
      const events: string[] = []
      const module = ServiceModule.from(
        makeListener(events).instrument([factory]),
      )

      await module.get(Key)
      expect(events).toContain('svc.initialize:start')
      expect(events).toContain('svc.initialize:end')
    })

    it('should report start and end events for each method call', async () => {
      const Key = new ServiceKey<{ greet(): string }>('svc')
      const factory = ServiceFactory.singleton({
        provides: Key,
        initialize: () => ({ greet: () => 'hi' }),
      })
      const events: string[] = []
      const module = ServiceModule.from(
        makeListener(events).instrument([factory]),
      )

      const svc = await module.get(Key)
      svc.greet()
      expect(events.filter((e) => e === 'svc.greet:start')).toHaveLength(1)
      expect(events.filter((e) => e === 'svc.greet:end')).toHaveLength(1)
    })

    it('should propagate return values and errors of observed methods', async () => {
      const Key = new ServiceKey<{
        ok(): number
        boom(): never
        later(): Promise<string>
      }>('svc')
      const factory = ServiceFactory.singleton({
        provides: Key,
        initialize: () => ({
          ok: () => 42,
          boom: () => {
            throw new Error('boom')
          },
          later: async () => 'done',
        }),
      })
      const module = ServiceModule.from(makeListener([]).instrument([factory]))

      const svc = await module.get(Key)
      expect(svc.ok()).toBe(42)
      expect(() => svc.boom()).toThrow('boom')
      await expect(svc.later()).resolves.toBe('done')
    })

    it('should not wrap services of an unobserved module', async () => {
      const instance = { greet: () => 'hi' }
      const Key = new ServiceKey<typeof instance>('svc')
      const factory = ServiceFactory.singleton({
        provides: Key,
        initialize: () => instance,
      })
      const module = ServiceModule.from([factory])

      await expect(module.get(Key)).resolves.toBe(instance)
    })
  })

  describe('initialize outcome', () => {
    it('should never carry a value, even with result capture on', async () => {
      const Key = new ServiceKey<{ greet(): string }>('svc')
      const factory = ServiceFactory.singleton({
        provides: Key,
        initialize: () => ({ greet: () => 'hi' }),
      })
      let outcome: unknown
      const listener = Object.assign(new ServiceInstrumentation(), {
        onInitialize: () => ({
          run: (fn) => fn(),
          end: (o) => {
            outcome = o
          },
        }),
      } satisfies Partial<ServiceInstrumentation>)
      const module = ServiceModule.from(
        listener.instrument([factory], { capture: { results: true } }),
      )

      await module.get(Key)
      // The initialize "result" is the service instance, which is not
      // useful information to report.
      expect(outcome).toEqual({ type: 'success' })
    })
  })

  describe('span correlation', () => {
    it('should pair start and finish per call under concurrent invocations', async () => {
      const Key = new ServiceKey<{ fetch(delay: number): Promise<number> }>(
        'svc',
      )
      const factory = ServiceFactory.singleton({
        provides: Key,
        initialize: () => ({
          fetch: (delay: number) =>
            new Promise<number>((resolve) =>
              setTimeout(() => resolve(delay), delay),
            ),
        }),
      })
      const events: string[] = []
      let seq = 0
      const listener = Object.assign(new ServiceInstrumentation(), {
        onMethodCall: ({ methodName }) => {
          const id = ++seq
          events.push(`${methodName}#${id}:start`)
          return {
            run: (fn) => fn(),
            end: () => events.push(`${methodName}#${id}:end`),
          }
        },
      } satisfies Partial<ServiceInstrumentation>)
      const module = ServiceModule.from(listener.instrument([factory]))

      const svc = await module.get(Key)
      await Promise.all([svc.fetch(30), svc.fetch(5)])
      // The slow first call finishes last, and each end still reports
      // against its own span.
      expect(events).toEqual([
        'fetch#1:start',
        'fetch#2:start',
        'fetch#2:end',
        'fetch#1:end',
      ])
    })
  })

  describe('method arguments and return values', () => {
    it('should deliver arguments and the return or resolved value', async () => {
      const Key = new ServiceKey<{
        add(a: number, b: number): number
        fetch(id: string): Promise<string>
      }>('svc')
      const factory = ServiceFactory.singleton({
        provides: Key,
        initialize: () => ({
          add: (a: number, b: number) => a + b,
          fetch: async (id: string) => `record:${id}`,
        }),
      })
      const observed: { method: string; args: unknown[]; result: unknown }[] =
        []
      const listener = Object.assign(new ServiceInstrumentation(), {
        onMethodCall: (context) => ({
          run: (fn) => fn(),
          end: (outcome) =>
            observed.push({
              method: context.methodName,
              args: [...(context.args ?? [])],
              result: outcome.type === 'success' ? outcome.value : undefined,
            }),
        }),
      } satisfies Partial<ServiceInstrumentation>)
      const module = ServiceModule.from(
        listener.instrument([factory], {
          capture: { arguments: true, results: true },
        }),
      )

      const svc = await module.get(Key)
      svc.add(2, 3)
      await svc.fetch('42')
      expect(observed).toEqual([
        { method: 'add', args: [2, 3], result: 5 },
        { method: 'fetch', args: ['42'], result: 'record:42' },
      ])
    })
  })

  describe('class name', () => {
    it('should deliver the constructor name for class-based services', async () => {
      class GreeterImpl {
        greet(): string {
          return 'hi'
        }
      }
      const Key = new ServiceKey<GreeterImpl>('greeter')
      const factory = ServiceFactory.singleton({
        provides: Key,
        initialize: () => new GreeterImpl(),
      })
      const classNames: (string | undefined)[] = []
      const listener = Object.assign(new ServiceInstrumentation(), {
        onMethodCall: ({ className }) => {
          classNames.push(className)
        },
      } satisfies Partial<ServiceInstrumentation>)
      const module = ServiceModule.from(listener.instrument([factory]))

      const svc = await module.get(Key)
      svc.greet()
      expect(classNames).toEqual(['GreeterImpl'])
    })

    it('should leave className undefined for plain object literals', async () => {
      const Key = new ServiceKey<{ greet(): string }>('svc')
      const factory = ServiceFactory.singleton({
        provides: Key,
        initialize: () => ({ greet: () => 'hi' }),
      })
      const classNames: (string | undefined)[] = []
      const listener = Object.assign(new ServiceInstrumentation(), {
        onMethodCall: ({ className }) => {
          classNames.push(className)
        },
      } satisfies Partial<ServiceInstrumentation>)
      const module = ServiceModule.from(listener.instrument([factory]))

      const svc = await module.get(Key)
      svc.greet()
      expect(classNames).toEqual([undefined])
    })
  })

  describe('error events', () => {
    it('should report an error event when initialization throws', async () => {
      const Key = new ServiceKey<{ x: number }>('svc')
      const factory = ServiceFactory.singleton({
        provides: Key,
        initialize: () => {
          throw new Error('init failed')
        },
      })
      const events: string[] = []
      const module = ServiceModule.from(
        makeListener(events).instrument([factory]),
      )

      await expect(module.get(Key)).rejects.toThrow('init failed')
      expect(events).toContain('svc.initialize:start')
      expect(events).toContain('svc.initialize:error')
      expect(events).not.toContain('svc.initialize:end')
    })

    it('should report an error event when a method throws synchronously', async () => {
      const Key = new ServiceKey<{ boom(): never }>('svc')
      const factory = ServiceFactory.singleton({
        provides: Key,
        initialize: () => ({
          boom: () => {
            throw new Error('boom')
          },
        }),
      })
      const events: string[] = []
      const module = ServiceModule.from(
        makeListener(events).instrument([factory]),
      )

      const svc = await module.get(Key)
      expect(() => svc.boom()).toThrow('boom')
      expect(events).toContain('svc.boom:error')
      expect(events).not.toContain('svc.boom:end')
    })

    it('should report an error event when an async method rejects', async () => {
      const Key = new ServiceKey<{ fail(): Promise<never> }>('svc')
      const factory = ServiceFactory.singleton({
        provides: Key,
        initialize: () => ({
          fail: async () => {
            throw new Error('async boom')
          },
        }),
      })
      const events: string[] = []
      const module = ServiceModule.from(
        makeListener(events).instrument([factory]),
      )

      const svc = await module.get(Key)
      await expect(svc.fail()).rejects.toThrow('async boom')
      expect(events).toContain('svc.fail:error')
      expect(events).not.toContain('svc.fail:end')
    })
  })

  describe('singleton semantics', () => {
    it('should preserve identity across get() calls and initialize once', async () => {
      const Key = new ServiceKey<{ id: number }>('singleton')
      let counter = 0
      const factory = ServiceFactory.singleton({
        provides: Key,
        initialize: () => ({ id: ++counter }),
      })
      const module = ServiceModule.from(makeListener([]).instrument([factory]))

      const a = await module.get(Key)
      const b = await module.get(Key)
      expect(a).toBe(b)
      expect(a.id).toBe(1)
      expect(counter).toBe(1)
    })
  })

  describe('non-object services', () => {
    it('should pass primitive-valued services through untouched', async () => {
      const Key = new ServiceKey<string>('config')
      const factory = ServiceFactory.singleton({
        provides: Key,
        initialize: () => 'value1',
      })
      const module = ServiceModule.from(makeListener([]).instrument([factory]))

      await expect(module.get(Key)).resolves.toBe('value1')
    })
  })

  describe('disposal', () => {
    it('should dispose scoped factories through the wrapper', async () => {
      const scope = new ServiceScope('request')
      const Key = new ServiceKey<{ x: number }>('scoped')
      let disposed = false
      const factory: ServiceFactory<{ x: number }, []> = {
        provides: Key,
        dependsOn: [],
        scope,
        initialize: () => ({ x: 1 }),
        dispose: () => {
          disposed = true
        },
      }
      const events: string[] = []
      const module = ServiceModule.from(
        makeListener(events).instrument([factory]),
      )

      await module.get(Key)
      module.dispose(scope)
      expect(disposed).toBe(true)
      expect(events).toContain('scoped.dispose:start')
      expect(events).toContain('scoped.dispose:end')
    })

    // Unobserved modules call delegate.dispose unconditionally; the observed
    // wrapper gates it behind the singleton cache, silently skipping
    // disposal of services that were never requested.
    it.fails('should dispose delegates even when the service was never resolved', async () => {
      const Key = new ServiceKey<{ x: number }>('eager')
      let disposed = false
      const factory: ServiceFactory<{ x: number }, []> = {
        provides: Key,
        dependsOn: [],
        scope: undefined,
        initialize: () => ({ x: 1 }),
        dispose: () => {
          disposed = true
        },
      }
      const module = ServiceModule.from(makeListener([]).instrument([factory]))

      module.dispose()
      expect(disposed).toBe(true)
    })
  })

  describe('known issues (remove .fails as each is fixed)', () => {
    // The get trap allocates a fresh closure per property access, which
    // breaks cached method references and listener deduplication.
    it.fails('should return the same function for repeated method access', async () => {
      const Key = new ServiceKey<{ foo(): number }>('svc')
      const factory = ServiceFactory.singleton({
        provides: Key,
        initialize: () => ({ foo: () => 1 }),
      })
      const module = ServiceModule.from(makeListener([]).instrument([factory]))

      const svc = await module.get(Key)
      expect(svc.foo).toBe(svc.foo)
    })

    // Methods are invoked with the raw target as receiver, so a method
    // returning `this` hands back the unwrapped instance and the rest of
    // the chain escapes observation.
    it.fails('should keep observing methods chained off `this`-returning methods', async () => {
      class Builder {
        parts: string[] = []
        with(p: string): this {
          this.parts.push(p)
          return this
        }
        build(): string {
          return this.parts.join('-')
        }
      }
      const Key = new ServiceKey<Builder>('builder')
      const factory = ServiceFactory.singleton({
        provides: Key,
        initialize: () => new Builder(),
      })
      const events: string[] = []
      const module = ServiceModule.from(
        makeListener(events).instrument([factory]),
      )

      const svc = await module.get(Key)
      expect(svc.with('a').build()).toBe('a')
      expect(events.filter((e) => e === 'builder.build:start')).toHaveLength(1)
    })

    // instrument() re-wraps factories of an already-instrumented module,
    // producing two proxy layers and duplicate events per call.
    it.fails('should not report duplicate events when composing an already observed module', async () => {
      const Key = new ServiceKey<{ foo(): number }>('svc')
      const factory = ServiceFactory.singleton({
        provides: Key,
        initialize: () => ({ foo: () => 1 }),
      })
      const events: string[] = []
      const listener = makeListener(events)
      const inner = ServiceModule.from(listener.instrument([factory]))
      const outer = ServiceModule.from(listener.instrument([inner]))

      const svc = await outer.get(Key)
      svc.foo()
      expect(events.filter((e) => e === 'svc.foo:start')).toHaveLength(1)
    })

    // makeObservable always builds a singleton wrapper, so one-shot
    // delegates are initialized once and cached instead of per request.
    it.fails('should initialize one-shot delegates on every get()', async () => {
      const Key = new ServiceKey<{ id: number }>('oneShot')
      let counter = 0
      const factory = ServiceFactory.oneShot({
        provides: Key,
        dependsOn: [],
        initialize: () => ({ id: ++counter }),
      })
      const module = ServiceModule.from(makeListener([]).instrument([factory]))

      await module.get(Key)
      await module.get(Key)
      expect(counter).toBe(2)
    })
  })

  describe('run wrapper', () => {
    it('should invoke the operation through run exactly once and pass the result through', async () => {
      const calls: string[] = []
      const listener = Object.assign(new ServiceInstrumentation(), {
        onMethodCall: () => ({
          run: <T>(fn: () => T): T => {
            calls.push('run')
            return fn()
          },
          end: () => calls.push('end'),
        }),
      } satisfies Partial<ServiceInstrumentation>)
      const Key = new ServiceKey<{ greet(): string }>('svc')
      const factory = ServiceFactory.singleton({
        provides: Key,
        initialize: () => ({ greet: () => 'hi' }),
      })
      const module = ServiceModule.from(listener.instrument([factory]))

      const svc = await module.get(Key)
      expect(svc.greet()).toBe('hi')
      expect(calls).toEqual(['run', 'end'])
    })

    it('should let run establish ambient state visible to nested calls', async () => {
      const als = new AsyncLocalStorage<string>()
      const ambientAtStart: (string | undefined)[] = []
      const listener = Object.assign(new ServiceInstrumentation(), {
        onMethodCall: ({ methodName }) => {
          ambientAtStart.push(als.getStore())
          return {
            run: <T>(fn: () => T): T => als.run(methodName, fn),
            end: () => {},
          }
        },
      } satisfies Partial<ServiceInstrumentation>)
      const DbKey = new ServiceKey<{ query(): Promise<string> }>('db')
      const UserKey = new ServiceKey<{ getUser(): Promise<string> }>('users')
      const db = ServiceFactory.singleton({
        provides: DbKey,
        initialize: () => ({ query: async () => 'row' }),
      })
      const users = ServiceFactory.singleton({
        provides: UserKey,
        dependsOn: [DbKey],
        initialize: (database) => ({ getUser: () => database.query() }),
      })
      const module = ServiceModule.from(listener.instrument([db, users]))

      const svc = await module.get(UserKey)
      await svc.getUser()
      expect(ambientAtStart).toEqual([undefined, 'getUser'])
    })
  })
})
