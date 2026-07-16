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
import {
  OTELInstrumentation,
  OTELInstrumentationOptions,
} from '../src/otelInstrumentation'

let exporter: InMemorySpanExporter
let provider: BasicTracerProvider

beforeEach(() => {
  exporter = new InMemorySpanExporter()
  provider = new BasicTracerProvider({
    spanProcessors: [new SimpleSpanProcessor(exporter)],
  })
  // Nesting relies on the ambient OTEL context, which only propagates when
  // a context manager is registered (NodeSDK does this in real setups).
  otelContext.setGlobalContextManager(
    new AsyncLocalStorageContextManager().enable(),
  )
})

const makeListener = (options: Partial<OTELInstrumentationOptions> = {}) =>
  new OTELInstrumentation({ tracer: provider.getTracer('test'), ...options })

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
    const Key = new ServiceKey<{ greet(): string }>('svc')
    const factory = ServiceFactory.singleton({
      provides: Key,
      initialize: () => ({ greet: () => 'hi' }),
    })
    const module = ServiceModule.from(makeListener().instrument([factory]))

    const svc = await module.get(Key)
    svc.greet()

    const init = byName('ServiceFactory[svc].initialize')
    expect(init.attributes).toMatchObject({
      'code.function.name': 'ServiceFactory.initialize',
      'composed_di.service.key': 'svc',
      'composed_di.service.event': 'initialize',
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
    const Key = new ServiceKey<GreeterImpl>('greeter')
    const factory = ServiceFactory.singleton({
      provides: Key,
      initialize: () => new GreeterImpl(),
    })
    const module = ServiceModule.from(makeListener().instrument([factory]))

    const svc = await module.get(Key)
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
    const Key = new ServiceKey<{ x: number }>('svc')
    const factory: ServiceFactory<{ x: number }, []> = {
      provides: Key,
      dependsOn: [],
      scope: undefined,
      initialize: () => ({ x: 1 }),
      dispose: () => {},
    }
    const module = ServiceModule.from(makeListener().instrument([factory]))

    await module.get(Key)
    module.dispose()
    expect(byName('ServiceFactory[svc].dispose').attributes).toMatchObject({
      'composed_di.service.event': 'dispose',
    })
  })

  it('should fall back to the global tracer provider when no tracer is given', async () => {
    // Re-register per test: the API keeps the first global otherwise.
    trace.disable()
    trace.setGlobalTracerProvider(provider)
    try {
      const Key = new ServiceKey<{ greet(): string }>('svc')
      const factory = ServiceFactory.singleton({
        provides: Key,
        initialize: () => ({ greet: () => 'hi' }),
      })
      const module = ServiceModule.from(
        new OTELInstrumentation().instrument([factory]),
      )

      const svc = await module.get(Key)
      svc.greet()
      expect(byName('svc.greet').attributes).toMatchObject({
        'composed_di.service.event': 'call',
      })
    } finally {
      trace.disable()
    }
  })

  it('should parent nested service calls across async boundaries', async () => {
    const DbKey = new ServiceKey<{ query(sql: string): Promise<string> }>(
      'Database',
    )
    const UserKey = new ServiceKey<{ getUser(id: number): Promise<string> }>(
      'UserService',
    )
    const db = ServiceFactory.singleton({
      provides: DbKey,
      initialize: () => ({ query: async (sql: string) => `row:${sql}` }),
    })
    const users = ServiceFactory.singleton({
      provides: UserKey,
      dependsOn: [DbKey],
      initialize: (database) => ({
        getUser: (id: number) => database.query(`u${id}`),
      }),
    })
    const module = ServiceModule.from(makeListener().instrument([db, users]))

    const svc = await module.get(UserKey)
    await svc.getUser(7)

    const getUser = byName('UserService.getUser')
    const query = byName('Database.query')
    expect(parentIdOf(query)).toBe(spanIdOf(getUser))
    expect(query.spanContext().traceId).toBe(getUser.spanContext().traceId)
  })

  it('should mark failed operations with ERROR status and the exception', async () => {
    const Key = new ServiceKey<{ boom(): never }>('svc')
    const factory = ServiceFactory.singleton({
      provides: Key,
      initialize: () => ({
        boom: () => {
          throw new Error('kaput')
        },
      }),
    })
    const module = ServiceModule.from(makeListener().instrument([factory]))

    const svc = await module.get(Key)
    expect(() => svc.boom()).toThrow('kaput')

    const span = byName('svc.boom')
    expect(span.status.code).toBe(SpanStatusCode.ERROR)
    expect(span.status.message).toBe('kaput')
    expect(span.attributes['error.type']).toBe('Error')
    expect(span.events.some((e) => e.name === 'exception')).toBe(true)
  })

  it('should set error.type to _OTHER for non-Error throws', async () => {
    const Key = new ServiceKey<{ boom(): never }>('svc')
    const factory = ServiceFactory.singleton({
      provides: Key,
      initialize: () => ({
        boom: () => {
          throw 'string kaput'
        },
      }),
    })
    const module = ServiceModule.from(makeListener().instrument([factory]))

    const svc = await module.get(Key)
    expect(() => svc.boom()).toThrow('string kaput')

    const span = byName('svc.boom')
    expect(span.status.code).toBe(SpanStatusCode.ERROR)
    expect(span.attributes['error.type']).toBe('_OTHER')
  })

  it('should end async method spans when the promise settles', async () => {
    const Key = new ServiceKey<{ fail(): Promise<never> }>('svc')
    const factory = ServiceFactory.singleton({
      provides: Key,
      initialize: () => ({
        fail: async () => {
          throw new Error('async kaput')
        },
      }),
    })
    const module = ServiceModule.from(makeListener().instrument([factory]))

    const svc = await module.get(Key)
    await expect(svc.fail()).rejects.toThrow('async kaput')
    expect(byName('svc.fail').status.code).toBe(SpanStatusCode.ERROR)
  })

  it('should not capture arguments or results by default', async () => {
    const Key = new ServiceKey<{ add(a: number, b: number): number }>('svc')
    const factory = ServiceFactory.singleton({
      provides: Key,
      initialize: () => ({ add: (a: number, b: number) => a + b }),
    })
    const module = ServiceModule.from(makeListener().instrument([factory]))

    const svc = await module.get(Key)
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
    const Key = new ServiceKey<{ add(a: number, b: number): number }>('svc')
    const factory = ServiceFactory.singleton({
      provides: Key,
      initialize: () => ({ add: (a: number, b: number) => a + b }),
    })
    const module = ServiceModule.from(
      makeListener().instrument([factory], {
        captureArguments: true,
        captureResults: true,
      }),
    )

    const svc = await module.get(Key)
    svc.add(2, 3)
    const span = byName('svc.add')
    expect(span.attributes['composed_di.service.function.arguments']).toBe(
      '[2,3]',
    )
    expect(span.attributes['composed_di.service.function.result']).toBe('5')
  })
})
