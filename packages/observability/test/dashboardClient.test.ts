import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { ServiceFactory, ServiceKey, ServiceModule } from '@composed-di/core'
import { DashboardClient } from '../src/dashboardClient'
import { SpanEnd, SpanEvent, SpanStart } from '../src/events'

interface RecordedRequest {
  path: string
  body: any
}

let requests: RecordedRequest[]

beforeEach(() => {
  requests = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit) => {
      requests.push({
        path: new URL(url).pathname,
        body: JSON.parse(init.body as string),
      })
      return new Response('{}', { status: 200 })
    }),
  )
})

afterEach(() => {
  vi.unstubAllGlobals()
})

const makeClient = () => new DashboardClient({ url: 'http://localhost:4321' })

const exportedEvents = (): SpanEvent[] =>
  requests
    .filter((r) => r.path === '/v1/events')
    .flatMap((r) => r.body.events as SpanEvent[])

const startByName = (name: string): SpanStart => {
  const start = exportedEvents().find(
    (e): e is SpanStart => e.type === 'start' && e.name === name,
  )
  expect(start, `expected a start event named ${name}`).toBeDefined()
  return start!
}

const endOf = (start: SpanStart): SpanEnd => {
  const end = exportedEvents().find(
    (e): e is SpanEnd => e.type === 'end' && e.id === start.id,
  )
  expect(end, `expected an end event for span ${start.name}`).toBeDefined()
  return end!
}

const echoFactory = () => {
  const Key = new ServiceKey<{ echo(v: string): string }>('svc')
  const factory = ServiceFactory.singleton({
    provides: Key,
    initialize: () => ({ echo: (v: string) => 'got:' + v }),
  })
  return { Key, factory }
}

describe('DashboardClient', () => {
  it('should export initialize and method call span events', async () => {
    const client = makeClient()
    const Key = new ServiceKey<{ greet(): string }>('svc')
    const factory = ServiceFactory.singleton({
      provides: Key,
      initialize: () => ({ greet: () => 'hi' }),
    })
    const module = ServiceModule.from(
      client.instrumentation.instrument([factory]),
    )

    const svc = await module.get(Key)
    svc.greet()
    await client.flush()

    const init = startByName('svc.initialize')
    expect(init.kind).toBe('initialize')
    const call = startByName('svc.greet')
    expect(call.kind).toBe('call')
    // Every start has a matching end.
    const ends = exportedEvents().filter((e) => e.type === 'end')
    expect(ends.map((e) => e.id).toSorted()).toEqual(
      [init.id, call.id].toSorted(),
    )
  })

  it('should register the module graph before events once attached', async () => {
    const client = makeClient()
    const Key = new ServiceKey<{ greet(): string }>('svc')
    const factory = ServiceFactory.singleton({
      provides: Key,
      initialize: () => ({ greet: () => 'hi' }),
    })
    const module = ServiceModule.from(
      client.instrumentation.instrument([factory]),
    )
    client.attach(module)

    const svc = await module.get(Key)
    svc.greet()
    await client.flush()

    expect(requests[0].path).toBe('/v1/graph')
    expect(requests[0].body.nodes).toEqual([{ name: 'svc' }])
    expect(exportedEvents().length).toBeGreaterThan(0)
  })

  it('should link nested service calls through parentId', async () => {
    const client = makeClient()
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
    const module = ServiceModule.from(
      client.instrumentation.instrument([db, users]),
    )

    const svc = await module.get(UserKey)
    await svc.getUser(7)
    await client.flush()

    const getUser = startByName('UserService.getUser')
    const query = startByName('Database.query')
    expect(query.parentId).toBe(getUser.id)
  })

  it('should report failures on the end event', async () => {
    const client = makeClient()
    const Key = new ServiceKey<{ boom(): never }>('svc')
    const factory = ServiceFactory.singleton({
      provides: Key,
      initialize: () => ({
        boom: () => {
          throw new Error('kaput')
        },
      }),
    })
    const module = ServiceModule.from(
      client.instrumentation.instrument([factory]),
    )

    const svc = await module.get(Key)
    expect(() => svc.boom()).toThrow('kaput')
    await client.flush()

    const boom = startByName('svc.boom')
    const end = exportedEvents().find(
      (e) => e.type === 'end' && e.id === boom.id,
    )
    expect(end).toMatchObject({ error: 'kaput' })
  })

  it('should capture serialized arguments and results on call spans when opted in', async () => {
    const client = makeClient()
    const { Key, factory } = echoFactory()
    const module = ServiceModule.from(
      client.instrumentation.instrument([factory], {
        captureArguments: true,
        captureResults: true,
      }),
    )

    const svc = await module.get(Key)
    svc.echo('hi')
    await client.flush()

    const call = startByName('svc.echo')
    expect(call.args).toBe('["hi"]')
    expect(endOf(call).result).toBe('"got:hi"')
    // Lifecycle spans carry neither: initialize takes no arguments, and
    // its outcome never carries a value.
    const init = startByName('svc.initialize')
    expect(init.args).toBeUndefined()
    expect(endOf(init).result).toBeUndefined()
  })

  it('should omit arguments and results by default', async () => {
    const client = makeClient()
    const { Key, factory } = echoFactory()
    const module = ServiceModule.from(
      client.instrumentation.instrument([factory]),
    )

    const svc = await module.get(Key)
    svc.echo('hi')
    await client.flush()

    const call = startByName('svc.echo')
    expect(call.args).toBeUndefined()
    expect(endOf(call).result).toBeUndefined()
  })

  it('should truncate long serialized values', async () => {
    const client = new DashboardClient({
      url: 'http://localhost:4321',
      maxValueLength: 10,
    })
    const { Key, factory } = echoFactory()
    const module = ServiceModule.from(
      client.instrumentation.instrument([factory], {
        captureArguments: true,
      }),
    )

    const svc = await module.get(Key)
    svc.echo('x'.repeat(50))
    await client.flush()

    const call = startByName('svc.echo')
    expect(call.args).toHaveLength(11) // 10 chars + ellipsis
    expect(call.args!.endsWith('…')).toBe(true)
  })

  it('should stop exporting after close', async () => {
    const client = makeClient()
    const Key = new ServiceKey<{ greet(): string }>('svc')
    const factory = ServiceFactory.singleton({
      provides: Key,
      initialize: () => ({ greet: () => 'hi' }),
    })
    const module = ServiceModule.from(
      client.instrumentation.instrument([factory]),
    )

    const svc = await module.get(Key)
    await client.close()
    const exportedBefore = exportedEvents().length

    svc.greet()
    await client.flush()
    expect(exportedEvents().length).toBe(exportedBefore)
  })
})
