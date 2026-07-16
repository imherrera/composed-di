import { AsyncLocalStorage } from 'node:async_hooks'
import { performance } from 'node:perf_hooks'
import { ServiceInstrumentation } from '@composed-di/instrumentation-core'
import type {
  DisposeContext,
  OperationSpan,
  InitializeContext,
  MethodCallContext,
} from '@composed-di/instrumentation-core'
import { SpanEvent, SpanKind } from './events'

/** The span context propagated across sync and async call boundaries. */
interface SpanContext {
  id: number
}

export interface DashboardInstrumentationOptions {
  /** Longest serialized value kept; longer ones are truncated. Default 200. */
  maxValueLength?: number
}

/**
 * A ServiceInstrumentation that turns service events into structured
 * start/end span events for the realtime dashboard.
 *
 * - Uses AsyncLocalStorage to link spans to the span that was active when
 *   they started, which lets the dashboard draw cross-service call edges
 *   (e.g. UserService.getUser -> Database.query). The observed operation
 *   is invoked through the span's `run` wrapper, so the context is scoped
 *   to the operation and its async continuations.
 * - Emits events synchronously to subscribers; it never buffers.
 *
 * Arguments and results are serialized onto spans exactly when
 * `instrument()` (inherited from ServiceInstrumentation) delivers them —
 * capture and redaction policy live in the InstrumentOptions, not here.
 * Pass `capture: { arguments: true, results: true }` there to see values
 * in the dashboard.
 */
export class DashboardInstrumentation extends ServiceInstrumentation {
  private readonly context = new AsyncLocalStorage<SpanContext>()
  private readonly listeners = new Set<(event: SpanEvent) => void>()
  private nextId = 1
  private readonly maxValueLength: number

  constructor({ maxValueLength = 200 }: DashboardInstrumentationOptions = {}) {
    super()
    this.maxValueLength = maxValueLength
  }

  /**
   * Subscribes to span events.
   *
   * @returns A function that removes the subscription.
   */
  subscribe(listener: (event: SpanEvent) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  onInitialize({ key }: InitializeContext): OperationSpan {
    return this.startSpan(key.name, 'initialize', 'initialize')
  }

  onDispose({ key }: DisposeContext): OperationSpan {
    return this.startSpan(key.name, 'dispose', 'dispose')
  }

  onMethodCall({ key, methodName, args }: MethodCallContext): OperationSpan {
    // Args are present exactly when argument capture is enabled in the
    // InstrumentOptions; they arrive already redacted.
    return this.startSpan(
      key.name,
      methodName,
      'call',
      args ? this.serialize(args) : undefined,
    )
  }

  private startSpan(
    service: string,
    method: string,
    kind: SpanKind,
    args?: string,
  ): OperationSpan {
    const id = this.nextId++
    const parent = this.context.getStore()

    this.emit({
      type: 'start',
      id,
      parentId: parent?.id ?? null,
      name: `${service}.${method}`,
      service,
      method,
      kind,
      time: Date.now(),
      args,
    })

    const startedAt = performance.now()
    let ended = false
    const end = (error: string | null, result?: string) => {
      if (ended) return
      ended = true
      this.emit({
        type: 'end',
        id,
        time: Date.now(),
        durationMs: performance.now() - startedAt,
        error,
        result,
      })
    }

    return {
      // Running the operation inside this span's context makes it the
      // parent of any spans started within.
      run: (fn) => this.context.run({ id }, fn),
      end: (outcome) => {
        if (outcome.type === 'failure') {
          end(errorMessage(outcome.error))
        } else {
          // A value is present exactly when result capture is enabled in
          // the InstrumentOptions; it arrives already redacted.
          end(
            null,
            'value' in outcome ? this.serialize(outcome.value) : undefined,
          )
        }
      },
    }
  }

  private serialize(value: unknown): string {
    let text: string
    try {
      text = JSON.stringify(value) ?? String(value)
    } catch {
      text = '[unserializable]'
    }
    return text.length > this.maxValueLength
      ? text.slice(0, this.maxValueLength) + '…'
      : text
  }

  private emit(event: SpanEvent): void {
    this.listeners.forEach((listener) => listener(event))
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
