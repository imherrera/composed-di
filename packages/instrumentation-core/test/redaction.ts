import { describe, it, expect } from 'vitest'
import { ServiceFactory, ServiceKey, ServiceModule } from '@composed-di/core'
import {
  CaptureOptions,
  redactionRule,
  LifecycleContext,
  OperationOutcome,
  MethodCallContext,
  ServiceInstrumentation,
  ServiceLifecycleEvent,
} from '../src'

// Deliberately not derived via Parameters<install>: on an overloaded
// method that resolves to the last overload (ServiceModule), while these
// tests always install arrays of factories.
type Entries = ServiceFactory[]

interface RecordedEvent {
  type: ServiceLifecycleEvent | 'call'
  key?: ServiceKey<unknown>
  methodName?: string
  args?: readonly unknown[]
  outcome?: OperationOutcome
  ranWithin?: boolean
}

/**
 * An instrumentation that records every context and outcome it is handed,
 * so tests can assert on exactly what crossed the capture and redaction
 * boundary in instrument().
 */
class RecordingListener extends ServiceInstrumentation {
  readonly events: RecordedEvent[] = []

  lifecycleSpan(context: LifecycleContext) {
    return this.record({ type: context.event, key: context.key })
  }

  methodCallSpan(context: MethodCallContext) {
    return this.record({
      type: 'call',
      key: context.key,
      methodName: context.methodName,
      args: context.args,
    })
  }

  private record(event: RecordedEvent) {
    this.events.push(event)
    return {
      run: <T>(fn: () => T): T => {
        event.ranWithin = true
        return fn()
      },
      end: (outcome: OperationOutcome) => {
        event.outcome = outcome
      },
    }
  }

  find(type: RecordedEvent['type'], methodName?: string): RecordedEvent {
    const event = this.events.find(
      (e) =>
        e.type === type &&
        (methodName === undefined || e.methodName === methodName),
    )
    expect(event, `expected a recorded ${type} event`).toBeDefined()
    return event!
  }
}

const secretKey = new ServiceKey<{
  getSecret(name: string): string
  listSecretNames(): string[]
}>('SecretClient')

const secretFactory = () =>
  ServiceFactory.singleton({
    provides: secretKey,
    initialize: () => ({
      getSecret: (name: string) => `value-of-${name}`,
      listSecretNames: () => ['db-password'],
    }),
  })

/** instrumentation.instrument() with capture fully on, so redaction has values to work on. */
const observe = (
  instrumentation: ServiceInstrumentation,
  entries: Entries,
  options: Omit<CaptureOptions, 'arguments' | 'results'> = {},
) =>
  instrumentation.install(entries, {
    capture: { arguments: true, results: true, ...options },
  })

describe('redaction through instrument()', () => {
  it('redact: should redact arguments and results of the named property only', async () => {
    const recorder = new RecordingListener()
    const module = ServiceModule.from(
      observe(recorder, [secretFactory()], {
        redactionRules: [redactionRule(secretKey).redact('getSecret').build()],
      }),
    )

    const svc = await module.get(secretKey)
    svc.getSecret('db-password')
    svc.listSecretNames()

    const redacted = recorder.find('call', 'getSecret')
    expect(redacted.args).toEqual(['[REDACTED]'])
    expect(redacted.outcome).toEqual({
      type: 'success',
      value: '[REDACTED]',
    })

    const open = recorder.find('call', 'listSecretNames')
    expect(open.args).toEqual([])
    expect(open.outcome).toEqual({
      type: 'success',
      value: ['db-password'],
    })
  })

  it('initialize outcomes never carry a value, so there is nothing to redact', async () => {
    const recorder = new RecordingListener()
    const module = ServiceModule.from(
      observe(recorder, [secretFactory()], {
        redactionRules: [redactionRule(secretKey).redactAll().build()],
      }),
    )

    await module.get(secretKey)

    expect(recorder.find('factory_initialize').outcome).toEqual({
      type: 'success',
    })
  })

  it('redact: multiple calls accumulate properties', async () => {
    const recorder = new RecordingListener()
    const module = ServiceModule.from(
      observe(recorder, [secretFactory()], {
        redactionRules: [
          redactionRule(secretKey)
            .redact('getSecret')
            .redact('listSecretNames')
            .build(),
        ],
      }),
    )

    const svc = await module.get(secretKey)
    svc.getSecret('db-password')
    svc.listSecretNames()

    expect(recorder.find('call', 'getSecret').outcome).toEqual({
      type: 'success',
      value: '[REDACTED]',
    })
    expect(recorder.find('call', 'listSecretNames').outcome).toEqual({
      type: 'success',
      value: '[REDACTED]',
    })
  })

  it('redactAll + exclude: should redact every property except the excluded ones', async () => {
    const recorder = new RecordingListener()
    const module = ServiceModule.from(
      observe(recorder, [secretFactory()], {
        redactionRules: [
          redactionRule(secretKey)
            .redactAll()
            .exclude('listSecretNames')
            .build(),
        ],
      }),
    )

    const svc = await module.get(secretKey)
    svc.getSecret('db-password')
    svc.listSecretNames()

    const redacted = recorder.find('call', 'getSecret')
    expect(redacted.args).toEqual(['[REDACTED]'])
    expect(redacted.outcome).toEqual({
      type: 'success',
      value: '[REDACTED]',
    })

    const open = recorder.find('call', 'listSecretNames')
    expect(open.args).toEqual([])
    expect(open.outcome).toEqual({
      type: 'success',
      value: ['db-password'],
    })
  })

  it('exclude alone (without redactAll or redact) throws: it would never redact anything', () => {
    expect(() =>
      redactionRule(secretKey).exclude('listSecretNames').build(),
    ).toThrow(/has no effect/)
  })

  it('redactAll + redact(mask) + exclude all merge into a single rule', async () => {
    const recorder = new RecordingListener()
    const module = ServiceModule.from(
      observe(recorder, [secretFactory()], {
        redactionRules: [
          redactionRule(secretKey)
            .redactAll()
            .redact('getSecret', {
              maskArgs: (name) => `masked:${name.length}`,
            })
            .exclude('listSecretNames')
            .build(),
        ],
      }),
    )

    const svc = await module.get(secretKey)
    svc.getSecret('db-password')
    svc.listSecretNames()

    // getSecret: overridden with a custom arg mask; result still fully
    // blanked since no maskResult was given.
    expect(recorder.find('call', 'getSecret').args).toEqual(['masked:11'])
    expect(recorder.find('call', 'getSecret').outcome).toEqual({
      type: 'success',
      value: '[REDACTED]',
    })
    // listSecretNames: excluded, so left untouched despite redactAll.
    expect(recorder.find('call', 'listSecretNames').outcome).toEqual({
      type: 'success',
      value: ['db-password'],
    })
  })

  it('redactAll: should redact every property', async () => {
    const recorder = new RecordingListener()
    const module = ServiceModule.from(
      observe(recorder, [secretFactory()], {
        redactionRules: [redactionRule(secretKey).redactAll().build()],
      }),
    )

    const svc = await module.get(secretKey)
    svc.getSecret('db-password')

    expect(recorder.find('call', 'getSecret').outcome).toEqual({
      type: 'success',
      value: '[REDACTED]',
    })
  })

  it('should apply a custom mask instead of blanking the value', async () => {
    const recorder = new RecordingListener()
    const module = ServiceModule.from(
      observe(recorder, [secretFactory()], {
        redactionRules: [
          redactionRule(secretKey)
            .redact('getSecret', {
              maskArgs: (name) => `masked:${name.length}`,
              maskResult: (value) => `masked:${value.length}`,
            })
            .build(),
        ],
      }),
    )

    const svc = await module.get(secretKey)
    svc.getSecret('db-password')

    const call = recorder.find('call', 'getSecret')
    expect(call.args).toEqual(['masked:11'])
    expect(call.outcome).toEqual({
      type: 'success',
      value: `masked:${'value-of-db-password'.length}`,
    })
  })

  it('a redacted property without a mask is fully blanked', async () => {
    const recorder = new RecordingListener()
    const module = ServiceModule.from(
      observe(recorder, [secretFactory()], {
        redactionRules: [redactionRule(secretKey).redact('getSecret').build()],
      }),
    )

    const svc = await module.get(secretKey)
    svc.getSecret('db-password')
    svc.listSecretNames()

    expect(recorder.find('call', 'getSecret').outcome).toEqual({
      type: 'success',
      value: '[REDACTED]',
    })
    expect(recorder.find('call', 'listSecretNames').outcome).toEqual({
      type: 'success',
      value: ['db-password'],
    })
  })

  it('build() throws when neither redactAll nor redact was called', () => {
    expect(() => redactionRule(secretKey).build()).toThrow(/has no effect/)
  })

  it('should not redact services outside the rules', async () => {
    const plainKey = new ServiceKey<{ add(a: number, b: number): number }>(
      'Calculator',
    )
    const plain = ServiceFactory.singleton({
      provides: plainKey,
      initialize: () => ({ add: (a: number, b: number) => a + b }),
    })
    const recorder = new RecordingListener()
    const module = ServiceModule.from(
      observe(recorder, [secretFactory(), plain], {
        redactionRules: [
          redactionRule(secretKey).redact('listSecretNames').build(),
        ],
      }),
    )

    const calc = await module.get(plainKey)
    calc.add(2, 3)

    const call = recorder.find('call', 'add')
    expect(call.args).toEqual([2, 3])
    expect(call.outcome).toEqual({ type: 'success', value: 5 })
  })

  it('should pass failure outcomes through unchanged', async () => {
    const boomKey = new ServiceKey<{ boom(secret: string): never }>('Boom')
    const factory = ServiceFactory.singleton({
      provides: boomKey,
      initialize: () => ({
        boom: () => {
          throw new Error('kaput')
        },
      }),
    })
    const recorder = new RecordingListener()
    const module = ServiceModule.from(
      observe(recorder, [factory], {
        redactionRules: [redactionRule(boomKey).redactAll().build()],
      }),
    )

    const svc = await module.get(boomKey)
    expect(() => svc.boom('hunter2')).toThrow('kaput')

    const call = recorder.find('call', 'boom')
    expect(call.args).toEqual(['[REDACTED]'])
    expect(call.outcome).toEqual({
      type: 'failure',
      error: new Error('kaput'),
    })
  })

  it("should preserve the instrumentation's run wrapper on redacted spans", async () => {
    const recorder = new RecordingListener()
    const module = ServiceModule.from(
      observe(recorder, [secretFactory()], {
        redactionRules: [redactionRule(secretKey).redactAll().build()],
      }),
    )

    const svc = await module.get(secretKey)
    svc.getSecret('db-password')

    expect(recorder.find('call', 'getSecret').ranWithin).toBe(true)
  })

  it('should deliver dispose events untouched (nothing to redact)', async () => {
    const factory = ServiceFactory.singleton({
      provides: new ServiceKey<{ x: number }>('svc'),
      initialize: () => ({ x: 1 }),
      dispose: () => {},
    })
    const recorder = new RecordingListener()
    const module = ServiceModule.from(
      observe(recorder, [factory], {
        redactionRules: [redactionRule(factory.provides).redactAll().build()],
      }),
    )

    await module.get(factory.provides)
    module.dispose()

    // Dispose produces no value, so its outcome never carries one.
    expect(recorder.find('factory_dispose').outcome).toEqual({
      type: 'success',
    })
  })

  describe('capture flags as the primary gate', () => {
    it('should deliver neither args nor values when capture is off, rules or not', async () => {
      const recorder = new RecordingListener()
      const module = ServiceModule.from(
        recorder.install([secretFactory()], {
          capture: {
            // Rules cannot re-enable delivery: there is nothing to redact.
            redactionRules: [
              redactionRule(secretKey)
                .redactAll()
                .exclude('listSecretNames')
                .build(),
            ],
          },
        }),
      )

      const svc = await module.get(secretKey)
      svc.getSecret('db-password')
      svc.listSecretNames()

      for (const name of ['getSecret', 'listSecretNames']) {
        const call = recorder.find('call', name)
        expect(call.args).toBeUndefined()
        expect(call.outcome).toEqual({ type: 'success' })
        expect(call.outcome && 'value' in call.outcome).toBe(false)
      }
      expect(recorder.find('factory_initialize').outcome).toEqual({
        type: 'success',
      })
    })

    it('should gate arguments and results independently', async () => {
      const recorder = new RecordingListener()
      const module = ServiceModule.from(
        recorder.install([secretFactory()], {
          capture: { arguments: true },
        }),
      )

      const svc = await module.get(secretKey)
      svc.getSecret('db-password')

      const call = recorder.find('call', 'getSecret')
      expect(call.args).toEqual(['db-password'])
      expect(call.outcome).toEqual({ type: 'success' })
    })

    it('should deliver a present value for methods that return undefined', async () => {
      const voidKey = new ServiceKey<{ fire(): void }>('Void')
      const factory = ServiceFactory.singleton({
        provides: voidKey,
        initialize: () => ({ fire: () => undefined }),
      })
      const recorder = new RecordingListener()
      const module = ServiceModule.from(
        recorder.install([factory], {
          capture: { results: true },
        }),
      )

      const svc = await module.get(voidKey)
      svc.fire()

      const outcome = recorder.find('call', 'fire').outcome!
      // Captured-but-undefined is distinguishable from not-captured.
      expect('value' in outcome).toBe(true)
      expect(outcome).toEqual({ type: 'success', value: undefined })
    })
  })
})
