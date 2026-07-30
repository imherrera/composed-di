# @composed-di/instrumentation-core

[![npm version](https://img.shields.io/npm/v/%40composed-di%2Finstrumentation-core)](https://www.npmjs.com/package/@composed-di/instrumentation-core)

Framework-agnostic observability for [`@composed-di/core`](../core): a small contract for observing every lifecycle operation and method call of your services, without touching the services themselves.

Looking for OpenTelemetry support? Use [`@composed-di/instrumentation-otel`](../instrumentation-otel), which is built on this package. Install this package directly when you want to report to a different backend (logs, metrics, a test recorder).

## Installation

```sh
npm install @composed-di/instrumentation-core
```

## How it works

`ServiceInstrumentation.install()` wraps factories (or a whole module) and returns instrumented replacements — the originals are never mutated. Compose the wrapped versions instead:

```ts
const instrumentation = new MyInstrumentation()

// A whole module: factories are wrapped, and the module's own
// get/getOrNull/dispose are reported too.
const module = instrumentation.install(
  ServiceModule.from([configFactory, dbFactory]),
)

// Or individual factories / arrays of factories.
const factories = instrumentation.install([configFactory, dbFactory])
```

Installing the same factory twice with the same instrumentation is a no-op — it is passed through unchanged rather than double-reported.

Only factories created with `ServiceFactory.singleton()` or `ServiceFactory.oneShot()` can be instrumented; handcrafted `ServiceFactory` implementations are rejected with a `TypeError`, because their lifetime semantics cannot be preserved.

## What gets reported

Two hooks cover everything:

- **`lifecycleSpan(context)`** — a lifecycle operation is starting. `context.event` is one of:

  | Event                | Meaning                                                                 |
  | -------------------- | ----------------------------------------------------------------------- |
  | `factory_initialize` | A factory is creating its service instance.                             |
  | `factory_dispose`    | A factory is tearing down its retained instance.                        |
  | `module_get`         | An instrumented module is resolving `get(key)`, dependencies included.  |
  | `module_get_or_null` | Same, for `getOrNull(key)` — a `null` miss is a success, not a failure. |
  | `module_dispose`     | An instrumented module is disposing all factories (no single `key`).    |

  Every event carries the `ServiceKey` it concerns, except `module_dispose`.

- **`methodCallSpan(context)`** — a method is being called on a service instance (instances returned by instrumented factories are proxied). The context carries the service key, the method name, the implementing class name when there is one, and — only when capture is enabled — the arguments.

Both hooks return an **`OperationSpan`**:

```ts
interface OperationSpan {
  // Wraps the operation itself, so you can establish ambient state
  // (e.g. tracing context) that nested operations inherit.
  run<T>(fn: () => T): T
  // Called exactly once when the operation finishes. For async methods,
  // when the promise settles.
  end(outcome: OperationOutcome): void
}
```

`end` receives `{ type: 'success', value? }` or `{ type: 'failure', error }`. Because each operation gets its own span object, per-call state (start time, span handle, correlation id) is just a closure — no bookkeeping to pair concurrent starts and finishes.

## Writing an instrumentation

```ts
import {
  LifecycleContext,
  MethodCallContext,
  OperationSpan,
  ServiceInstrumentation,
} from '@composed-di/instrumentation-core'

class LoggingInstrumentation extends ServiceInstrumentation {
  lifecycleSpan(context: LifecycleContext): OperationSpan {
    return this.span(`${context.key?.name ?? 'module'}.${context.event}`)
  }

  methodCallSpan(context: MethodCallContext): OperationSpan {
    return this.span(`${context.key.name}.${context.methodName}`)
  }

  private span(name: string): OperationSpan {
    const startedAt = performance.now()
    return {
      run: (fn) => fn(), // no ambient state to establish
      end: (outcome) => {
        const ms = (performance.now() - startedAt).toFixed(1)
        console.log(`${name} ${outcome.type} in ${ms}ms`)
      },
    }
  }
}
```

Instrumentation is strictly observational: implementations see every operation but must never alter it — `run` must invoke its thunk exactly once, synchronously, and return the result unchanged.

## Capturing arguments and results

Nothing is captured by default: runtime values may be large or contain secrets, and they end up wherever the instrumentation exports them. Capture policy is decided at `install()`, never by the instrumentation itself — what a subclass receives is exactly what it is allowed to record:

```ts
import { redactionRule } from '@composed-di/instrumentation-core'

const module = instrumentation.install(baseModule, {
  capture: {
    arguments: true, // deliver method args as MethodCallContext.args
    results: true, // deliver return values on the success outcome
    redactionRules: [
      // Blank everything this service sees...
      redactionRule(VaultKey).redactAll().exclude('ping').build(),
      // ...or mask specific methods with custom output.
      redactionRule(BillingKey)
        .redact('chargeCard', {
          maskResult: (card) => `card ending in ${card.number.slice(-4)}`,
        })
        .build(),
    ],
  },
})
```

Redaction runs after the capture flags: matched values are blanked with `'[REDACTED]'` (or run through the rule's custom mask) before the instrumentation ever sees them, and rules cannot re-enable delivery that capture has turned off.

## Documentation

See the [repository README](../../README.md) for the full guide, and [`@composed-di/instrumentation-otel`](../instrumentation-otel/src/otelServiceInstrumentation.ts) for a complete reference implementation.

## License

MIT
