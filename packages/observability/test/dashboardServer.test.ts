import { describe, it, expect } from 'vitest'
import { ServiceDashboard } from '../src/dashboardServer'
import { SpanEvent } from '../src/events'

const graph = {
  nodes: [{ name: 'Database' }],
  edges: [],
}

const call = (
  id: number,
  method: string,
  durationMs: number,
  error: string | null = null,
): SpanEvent[] => [
  {
    type: 'start',
    id,
    parentId: null,
    name: `Database.${method}`,
    service: 'Database',
    method,
    kind: 'call',
    time: 1000 + id,
  },
  { type: 'end', id, time: 1000 + id, durationMs, error },
]

describe('ServiceDashboard per-method stats', () => {
  it('should aggregate calls, errors, and durations per method', () => {
    const dashboard = new ServiceDashboard()
    dashboard.registerGraph(graph)

    dashboard.ingest([
      ...call(1, 'query', 10),
      ...call(2, 'query', 30),
      ...call(3, 'insert', 5, 'kaput'),
    ])

    const stats = dashboard.snapshot().services['Database']
    expect(stats.methods).toEqual({
      query: { calls: 2, errors: 0, totalMs: 40, lastMs: 30 },
      insert: { calls: 1, errors: 1, totalMs: 5, lastMs: 5 },
    })
    expect(stats.calls).toBe(3)
  })

  it('should keep at-the-time method stats in the recent-events buffer', () => {
    const dashboard = new ServiceDashboard()
    dashboard.registerGraph(graph)

    dashboard.ingest(call(1, 'query', 10))
    const afterFirst = dashboard.snapshot().recent.at(-1)!.stats!
    dashboard.ingest(call(2, 'query', 30))

    expect(afterFirst.methods['query']).toEqual({
      calls: 1,
      errors: 0,
      totalMs: 10,
      lastMs: 10,
    })
  })

  it('should resolve args from the start span onto end wire events', () => {
    const dashboard = new ServiceDashboard()
    dashboard.registerGraph(graph)

    dashboard.ingest([
      {
        type: 'start',
        id: 1,
        parentId: null,
        name: 'Database.query',
        service: 'Database',
        method: 'query',
        kind: 'call',
        time: 1000,
        args: '["u7"]',
      },
      {
        type: 'end',
        id: 1,
        time: 1002,
        durationMs: 2,
        error: null,
        result: '"row:u7"',
      },
    ])

    const [startWire, endWire] = dashboard.snapshot().recent
    expect(startWire.args).toBe('["u7"]')
    expect(endWire.args).toBe('["u7"]')
    expect(endWire.span).toMatchObject({ result: '"row:u7"' })
  })
})
