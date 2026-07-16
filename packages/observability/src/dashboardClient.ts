import { ServiceModule } from '@composed-di/core'
import {
  DashboardInstrumentation,
  DashboardInstrumentationOptions,
} from './dashboardInstrumentation'
import { SpanEvent } from './events'
import { ModuleGraph, moduleGraph } from './moduleGraph'

export interface DashboardClientOptions extends DashboardInstrumentationOptions {
  /** Base URL of the standalone dashboard server, e.g. "http://localhost:4321". */
  url: string
  /** How long to buffer events before exporting a batch. Default 250ms. */
  flushIntervalMs?: number
  /** Export immediately once this many events are buffered. Default 64. */
  maxBatchSize?: number
  /** Events kept while the server is unreachable; oldest are dropped. Default 5000. */
  maxQueueSize?: number
  /**
   * Called when an export fails. Defaults to a single console.warn per
   * failure streak; exports never throw into application code.
   */
  onError?: (error: Error) => void
}

/**
 * Exports service observability to a standalone dashboard server, the way
 * an OpenTelemetry SDK exports spans to a collector.
 *
 * The application owns only this client: wrap the factories with this
 * client's `instrumentation.instrument()`, then `attach` the module to
 * register its dependency graph with the server. Span events are buffered
 * and shipped in batches; export failures are retried on the next flush
 * and never affect the application.
 *
 * @example
 * ```ts
 * const client = new DashboardClient({ url: 'http://localhost:4321' });
 * const module = ServiceModule.from(
 *   client.instrumentation.instrument(factories, {
 *     // Show call arguments and results in the dashboard; leave these
 *     // off when values may contain secrets.
 *     capture: { arguments: true, results: true },
 *   }),
 * );
 * client.attach(module);
 * ```
 */
export class DashboardClient {
  /** Call `.instrument()` on this to wrap the factories composing the module. */
  readonly instrumentation: DashboardInstrumentation

  private readonly url: string
  private readonly flushIntervalMs: number
  private readonly maxBatchSize: number
  private readonly maxQueueSize: number
  private readonly onError: (error: Error) => void

  private queue: SpanEvent[] = []
  private graph: ModuleGraph | null = null
  private graphSent = false
  private timer: NodeJS.Timeout | null = null
  /** Serializes exports so events reach the server in order. */
  private exporting: Promise<void> = Promise.resolve()
  private warned = false
  private closed = false

  constructor({
    url,
    flushIntervalMs = 250,
    maxBatchSize = 64,
    maxQueueSize = 5000,
    onError,
    ...instrumentationOptions
  }: DashboardClientOptions) {
    this.instrumentation = new DashboardInstrumentation(instrumentationOptions)
    this.url = url.replace(/\/$/, '')
    this.flushIntervalMs = flushIntervalMs
    this.maxBatchSize = maxBatchSize
    this.maxQueueSize = maxQueueSize
    this.onError =
      onError ??
      ((error) => {
        if (this.warned) return
        this.warned = true
        console.warn(
          `[composed-di] dashboard export to ${this.url} failed (will keep retrying): ${error.message}`,
        )
      })
    this.instrumentation.subscribe((event) => this.enqueue(event))
  }

  /**
   * Registers the module's dependency graph with the dashboard server.
   */
  attach(module: ServiceModule): this {
    this.graph = moduleGraph(module)
    this.graphSent = false
    void this.flush()
    return this
  }

  /** Exports everything buffered so far. Resolves once the attempt finishes. */
  flush(): Promise<void> {
    this.exporting = this.exporting.then(() => this.export())
    return this.exporting
  }

  /** Flushes remaining events and stops the export timer. */
  async close(): Promise<void> {
    this.closed = true
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    await this.flush()
  }

  private enqueue(event: SpanEvent): void {
    if (this.closed) return
    this.queue.push(event)
    if (this.queue.length > this.maxQueueSize) {
      this.queue.splice(0, this.queue.length - this.maxQueueSize)
    }
    if (this.queue.length >= this.maxBatchSize) {
      void this.flush()
      return
    }
    this.scheduleFlush(this.flushIntervalMs)
  }

  private scheduleFlush(delayMs: number): void {
    if (this.timer || this.closed) return
    this.timer = setTimeout(() => {
      this.timer = null
      void this.flush()
    }, delayMs)
    this.timer.unref?.()
  }

  private async export(): Promise<void> {
    // The graph must reach the server before any events that reference it.
    if (this.graph && !this.graphSent) {
      if ((await this.post('/v1/graph', this.graph)) !== 'ok') {
        this.retryLater()
        return
      }
      this.graphSent = true
    }
    let reRegistrations = 0
    while (this.queue.length > 0) {
      const batch = this.queue.slice(0, this.maxBatchSize)
      const result = await this.post('/v1/events', { events: batch })
      // A restarted server lost the graph — re-register and resend the batch.
      if (result === 'graph-required' && this.graph && reRegistrations < 3) {
        reRegistrations += 1
        this.graphSent = false
        if ((await this.post('/v1/graph', this.graph)) !== 'ok') {
          this.retryLater()
          return
        }
        this.graphSent = true
        continue
      }
      if (result !== 'ok') {
        this.retryLater()
        return
      }
      this.queue.splice(0, batch.length)
    }
  }

  /** After a failed export, retry even if no new events arrive. */
  private retryLater(): void {
    if (this.queue.length > 0 || (this.graph && !this.graphSent)) {
      this.scheduleFlush(Math.max(this.flushIntervalMs, 2000))
    }
  }

  private async post(
    path: string,
    body: unknown,
  ): Promise<'ok' | 'graph-required' | 'failed'> {
    try {
      const response = await fetch(this.url + path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (response.status === 409) return 'graph-required'
      if (!response.ok) {
        throw new Error(`server responded ${response.status}`)
      }
      this.warned = false
      return 'ok'
    } catch (error) {
      this.onError(error instanceof Error ? error : new Error(String(error)))
      return 'failed'
    }
  }
}
