import { describe, it, expect, beforeEach } from 'vitest'
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  ReadableSpan,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base'
import {
  context as otelContext,
  SpanStatusCode,
  trace,
} from '@opentelemetry/api'
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks'
import { ServiceFactory, ServiceKey, ServiceModule } from '@composed-di/core'
import { OTELServiceInstrumentation } from '../src/otelServiceInstrumentation.js'

let exporter: InMemorySpanExporter
let provider: BasicTracerProvider

beforeEach(() => {
  exporter = new InMemorySpanExporter()
  provider = new BasicTracerProvider({
    spanProcessors: [new SimpleSpanProcessor(exporter)],
  })
  // The instrumentation resolves its tracer from the global provider, so
  // re-register per test (the API keeps the first global otherwise).
  trace.disable()
  trace.setGlobalTracerProvider(provider)
  // Nesting relies on the ambient OTEL context, which only propagates when
  // a context manager is registered (NodeSDK does this in real setups).
  otelContext.setGlobalContextManager(
    new AsyncLocalStorageContextManager().enable(),
  )
})

const makeListener = () => new OTELServiceInstrumentation()

const spans = () => exporter.getFinishedSpans()
const byName = (name: string) => {
  const span = spans().find((s) => s.name === name)
  expect(span, `expected a span named ${name}`).toBeDefined()
  return span!
}
const spanIdOf = (span: ReadableSpan) => span.spanContext().spanId
const parentIdOf = (span: ReadableSpan) =>
  span.parentSpanContext?.spanId ??
  (span as unknown as { parentSpanId?: string }).parentSpanId

describe('OTELInstrumentation', () => {
  it('should record initialize and method call spans with attributes', async () => {
    const key = new ServiceKey<{ greet(): string }>('svc')
    const factory = ServiceFactory.singleton({
      provides: key,
      initialize: () => ({ greet: () => 'hi' }),
    })
    const module = ServiceModule.from(makeListener().install([factory]))

    const svc = await module.get(key)
    svc.greet()

    const init = byName('ServiceFactory<svc>.initialize')
    expect(init.attributes).toMatchObject({
      'code.function.name': 'ServiceFactory.initialize',
      'composed_di.service.key': 'svc',
      'composed_di.service.event': 'factory_initialize',
    })
    const call = byName('svc.greet')
    expect(call.attributes).toMatchObject({
      'code.function.name': 'svc.greet',
      'composed_di.service.key': 'svc',
      'composed_di.service.event': 'call',
    })
    expect(call.attributes['composed_di.method']).toBeUndefined()
  })

  it('should qualify code.function.name with the class name when the service is class-based', async () => {
    class GreeterImpl {
      greet(): string {
        return 'hi'
      }
    }
    const key = new ServiceKey<GreeterImpl>('greeter')
    const factory = ServiceFactory.singleton({
      provides: key,
      initialize: () => new GreeterImpl(),
    })
    const module = ServiceModule.from(makeListener().install([factory]))

    const svc = await module.get(key)
    svc.greet()

    // Both the span name and code.function.name point at the implementing
    // class when one is available.
    const call = byName('GreeterImpl.greet')
    expect(call.attributes).toMatchObject({
      'code.function.name': 'GreeterImpl.greet',
      'composed_di.service.key': 'greeter',
      'composed_di.service.event': 'call',
    })
  })

  it('should record dispose spans', async () => {
    const key = new ServiceKey<{ x: number }>('svc')
    const factory = ServiceFactory.singleton({
      provides: key,
      initialize: () => ({ x: 1 }),
      dispose: () => {},
    })
    const module = ServiceModule.from(makeListener().install([factory]))

    await module.get(key)
    module.dispose()
    expect(byName('ServiceFactory<svc>.dispose').attributes).toMatchObject({
      'composed_di.service.event': 'factory_dispose',
    })
  })

  it('should fall back to the global tracer provider when no tracer is given', async () => {
    // Re-register per test, since the API keeps the first global otherwise.
    trace.disable()
    trace.setGlobalTracerProvider(provider)
    try {
      const key = new ServiceKey<{ greet(): string }>('svc')
      const factory = ServiceFactory.singleton({
        provides: key,
        initialize: () => ({ greet: () => 'hi' }),
      })
      const module = ServiceModule.from(
        new OTELServiceInstrumentation().install([factory]),
      )

      const svc = await module.get(key)
      svc.greet()
      expect(byName('svc.greet').attributes).toMatchObject({
        'composed_di.service.event': 'call',
      })
    } finally {
      trace.disable()
    }
  })

  it('should parent nested service calls across async boundaries', async () => {
    const dbKey = new ServiceKey<{ query(sql: string): Promise<string> }>(
      'Database',
    )
    const userKey = new ServiceKey<{ getUser(id: number): Promise<string> }>(
      'UserService',
    )
    const db = ServiceFactory.singleton({
      provides: dbKey,
      initialize: () => ({ query: async (sql: string) => `row:${sql}` }),
    })
    const users = ServiceFactory.singleton({
      provides: userKey,
      dependsOn: [dbKey],
      initialize: (database) => ({
        getUser: (id: number) => database.query(`u${id}`),
      }),
    })
    const module = ServiceModule.from(makeListener().install([db, users]))

    const svc = await module.get(userKey)
    await svc.getUser(7)

    const getUser = byName('UserService.getUser')
    const query = byName('Database.query')
    expect(parentIdOf(query)).toBe(spanIdOf(getUser))
    expect(query.spanContext().traceId).toBe(getUser.spanContext().traceId)
  })

  it('should mark failed operations with ERROR status and the exception', async () => {
    const key = new ServiceKey<{ boom(): never }>('svc')
    const factory = ServiceFactory.singleton({
      provides: key,
      initialize: () => ({
        boom: () => {
          throw new Error('kaput')
        },
      }),
    })
    const module = ServiceModule.from(makeListener().install([factory]))

    const svc = await module.get(key)
    expect(() => svc.boom()).toThrow('kaput')

    const span = byName('svc.boom')
    expect(span.status.code).toBe(SpanStatusCode.ERROR)
    expect(span.status.message).toBe('kaput')
    expect(span.attributes['error.type']).toBe('Error')
    expect(span.events.some((e) => e.name === 'exception')).toBe(true)
  })

  it('should set error.type to _OTHER for non-Error throws', async () => {
    const key = new ServiceKey<{ boom(): never }>('svc')
    const factory = ServiceFactory.singleton({
      provides: key,
      initialize: () => ({
        boom: () => {
          throw 'string kaput'
        },
      }),
    })
    const module = ServiceModule.from(makeListener().install([factory]))

    const svc = await module.get(key)
    expect(() => svc.boom()).toThrow('string kaput')

    const span = byName('svc.boom')
    expect(span.status.code).toBe(SpanStatusCode.ERROR)
    expect(span.attributes['error.type']).toBe('_OTHER')
  })

  it('should end async method spans when the promise settles', async () => {
    const key = new ServiceKey<{ fail(): Promise<never> }>('svc')
    const factory = ServiceFactory.singleton({
      provides: key,
      initialize: () => ({
        fail: async () => {
          throw new Error('async kaput')
        },
      }),
    })
    const module = ServiceModule.from(makeListener().install([factory]))

    const svc = await module.get(key)
    await expect(svc.fail()).rejects.toThrow('async kaput')
    expect(byName('svc.fail').status.code).toBe(SpanStatusCode.ERROR)
  })

  it('should not capture arguments or results by default', async () => {
    const key = new ServiceKey<{ add(a: number, b: number): number }>('svc')
    const factory = ServiceFactory.singleton({
      provides: key,
      initialize: () => ({ add: (a: number, b: number) => a + b }),
    })
    const module = ServiceModule.from(makeListener().install([factory]))

    const svc = await module.get(key)
    svc.add(2, 3)
    const span = byName('svc.add')
    expect(
      span.attributes['composed_di.service.function.arguments'],
    ).toBeUndefined()
    expect(
      span.attributes['composed_di.service.function.result'],
    ).toBeUndefined()
  })

  it('should capture arguments and results when opted in', async () => {
    const key = new ServiceKey<{ add(a: number, b: number): number }>('svc')
    const factory = ServiceFactory.singleton({
      provides: key,
      initialize: () => ({ add: (a: number, b: number) => a + b }),
    })
    const module = ServiceModule.from(
      makeListener().install([factory], {
        capture: { arguments: true, results: true },
      }),
    )

    const svc = await module.get(key)
    svc.add(2, 3)
    const span = byName('svc.add')
    expect(span.attributes['composed_di.service.function.arguments']).toBe(
      '[2,3]',
    )
    expect(span.attributes['composed_di.service.function.result']).toBe('5')
  })
})
