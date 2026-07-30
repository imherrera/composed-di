# @composed-di/instrumentation-otel

[![npm version](https://img.shields.io/npm/v/%40composed-di%2Finstrumentation-otel)](https://www.npmjs.com/package/@composed-di/instrumentation-otel)

[OpenTelemetry](https://opentelemetry.io/) instrumentation for [`@composed-di/core`](../core): every service initialization, disposal, module resolution, and method call becomes an OTEL span, parented to whatever context is active — so your services slot into your existing traces.

## Installation

```sh
npm install @composed-di/instrumentation-otel @opentelemetry/api
```

`@opentelemetry/api` (^1.9.0) is a peer dependency. Spans are created through the global tracer provider — the one `NodeSDK` (or `@opentelemetry/auto-instrumentations-node`) registers on startup — so no wiring is needed beyond having an OTEL SDK configured.

## Usage

```ts
import { ServiceModule } from '@composed-di/core'
import { OTELServiceInstrumentation } from '@composed-di/instrumentation-otel'

const instrumentation = new OTELServiceInstrumentation()

const module = instrumentation.install(
  ServiceModule.from([configFactory, databaseFactory]),
)

// Traced end to end: a ServiceModule[Database].get span, with a child
// ServiceFactory[Database].initialize span on first resolution.
const db = await module.get(DatabaseKey)

// Each method call on a resolved service is a span too, e.g. DbClient.query.
await db.query('SELECT 1')
```

`install()` also accepts a single factory or an array of factories — see [`@composed-di/instrumentation-core`](../instrumentation-core) for the wrapping semantics.

Because each span's `initialize` runs inside its parent's context, nested resolutions form the hierarchy you'd expect: `ServiceModule[Database].get` → `ServiceFactory[Database].initialize` → `ServiceFactory[Config].initialize`.

## Spans and attributes

Span names follow the operation: `ServiceModule[<key>].get` / `.getOrNull`, `ServiceModule.dispose`, `ServiceFactory[<key>].initialize` / `.dispose`, and `<ClassName>.<method>` for method calls (falling back to the key name for services that aren't named class instances).

Every span carries:

| Attribute                                | Value                                                                                                     |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `code.function.name`                     | `<ClassName>.<method>`, per OTEL semantic conventions.                                                    |
| `composed_di.service.event`              | `factory_initialize`, `factory_dispose`, `module_get`, `module_get_or_null`, `module_dispose`, or `call`. |
| `composed_di.service.key`                | The service key's name (absent on `module_dispose`, which concerns the whole module).                     |
| `composed_di.service.function.arguments` | Method call arguments, JSON-serialized. Present exactly when argument capture is enabled.                 |
| `composed_di.service.function.result`    | Method call return value, JSON-serialized. Present exactly when result capture is enabled.                |

Failures set the span status to `ERROR`, record the exception, and set `error.type` — then rethrow, unchanged, to the caller.

## Capturing arguments and results

Nothing is captured by default. Opt in at `install()`, with per-service redaction for sensitive values:

```ts
import { redactionRule } from '@composed-di/instrumentation-core'

const module = instrumentation.install(baseModule, {
  capture: {
    arguments: true,
    results: true,
    redactionRules: [redactionRule(VaultKey).redactAll().build()],
  },
})
```

Captured values are redacted before they reach this instrumentation, and land on the `composed_di.service.function.*` attributes above.

## Documentation

See the [repository README](../../README.md) for the full guide, and [`@composed-di/instrumentation-core`](../instrumentation-core) for the underlying instrumentation contract.

## License

MIT
