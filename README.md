# composed-di

[![npm version](https://img.shields.io/npm/v/%40composed-di%2Fcore)](https://www.npmjs.com/package/@composed-di/core)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](#license)

A lightweight, lazy, and type-safe dependency injection library for TypeScript — no decorators, no reflection metadata, no framework lock-in. Services are described as plain factories, composed into modules, and created only when they are actually requested.

## Packages

| Package                                                              | Description                                                                                    |
| -------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| [`@composed-di/core`](packages/core)                                 | The DI container: keys, factories, modules, selectors, and graph visualization.                |
| [`@composed-di/instrumentation-core`](packages/instrumentation-core) | Framework-agnostic observability hooks for service initialization, disposal, and method calls. |
| [`@composed-di/instrumentation-otel`](packages/instrumentation-otel) | OpenTelemetry implementation that records service events as spans.                             |

## Why composed-di?

- **Lazy initialization** — a service is created on its first `get()`, never before. Dependencies are resolved recursively, in order.
- **Type-safe** — `ServiceKey<T>` is a typed token; a factory's `initialize` receives its dependencies fully typed, in declaration order. No strings, no `any`.
- **Fail-fast validation** — `ServiceModule.from()` detects circular dependencies and missing factories at module creation, with readable traces of the broken path.
- **Explicit lifecycles** — lazily-created singletons with deterministic `dispose()`, and one-shot (transient) factories.
- **Async-native** — `initialize` may return a promise; concurrent requests for an in-flight singleton share the same initialization.
- **Runtime selection** — `SelectorKey` groups multiple implementations of an interface so a service can pick one at runtime.
- **Observability built in** — instrument any factory to trace initialization, disposal, and every method call, with opt-in argument/result capture and redaction rules for sensitive services.
- **Visualization** — generate [Mermaid](https://mermaid.live/) or Graphviz DOT diagrams of your dependency graph.

## Getting started

### Installation

```sh
npm install @composed-di/core
# optional, for OpenTelemetry tracing of your services:
npm install @composed-di/instrumentation-otel @opentelemetry/api
```

### Quick start

```ts
import { ServiceKey, ServiceFactory, ServiceModule } from '@composed-di/core'

interface Config {
  dbUrl: string
}
interface Database {
  query(sql: string): Promise<unknown[]>
  close(): void
}

// 1. Declare typed keys — unique tokens that identify each service.
const ConfigKey = new ServiceKey<Config>('Config')
const DatabaseKey = new ServiceKey<Database>('Database')

// 2. Describe how each service is built and what it depends on.
const configFactory = ServiceFactory.singleton({
  provides: ConfigKey,
  initialize: () => ({ dbUrl: process.env.DB_URL! }),
})

const databaseFactory = ServiceFactory.singleton({
  provides: DatabaseKey,
  dependsOn: [ConfigKey] as const,
  initialize: (config) => connectToDatabase(config.dbUrl), // may be async
  dispose: (db) => db.close(),
})

// 3. Compose a module. Cycles and missing dependencies throw here, not later.
const module = ServiceModule.from([configFactory, databaseFactory])

// 4. Request services. Config is created first — lazily, exactly once.
const db = await module.get(DatabaseKey)

// 5. Tear everything down when you're done.
module.dispose()
```

## Core concepts

### Keys

A `ServiceKey<T>` is a typed token backed by a unique `Symbol`, so two keys with the same name never collide. When you _want_ keys to be shared across modules or bundles, use the global-registry variant:

```ts
const LoggerKey = ServiceKey.for<Logger>('my-app/Logger') // same symbol everywhere
```

### Factories

Two lifetimes are provided:

- **`ServiceFactory.singleton({...})`** — `initialize` runs on the first request; every later request shares the instance. A failed initialization is never cached, and after `dispose()` the next request builds a fresh instance.
- **`ServiceFactory.oneShot({...})`** — a fresh instance on every request, with no framework-managed cleanup; the requester owns the instance.

```ts
const requestIdFactory = ServiceFactory.oneShot({
  provides: RequestIdKey,
  initialize: () => crypto.randomUUID(), // new value per request
})
```

### Modules

`ServiceModule.from()` accepts factories _and other modules_, flattening them into one container. When two entries provide the same key, the last one wins — handy for overriding real services with fakes in tests:

```ts
const testModule = ServiceModule.from([productionModule, fakeDatabaseFactory])
```

`module.get(key)` resolves a service (throws `NoSuchFactoryError` if nothing provides the key); `module.getOrNull(key)` returns `null` instead for optional services.

### Runtime selection

A `SelectorKey<T>` groups several implementations of the same interface. A factory that depends on one receives a `Selector<T>` and chooses at runtime:

```ts
import { Selector, SelectorKey } from '@composed-di/core'

const PaymentSelectorKey = new SelectorKey([StripeKey, PaypalKey])

class CheckoutService {
  constructor(private readonly payments: Selector<PaymentGateway>) {}

  async pay(order: Order) {
    const gateway = await this.payments.get(
      order.method === 'paypal' ? PaypalKey : StripeKey,
    )
    return gateway.charge(order)
  }
}

const checkoutFactory = ServiceFactory.singleton({
  provides: CheckoutKey,
  dependsOn: [PaymentSelectorKey] as const,
  initialize: (payments) => new CheckoutService(payments),
})
```

### Visualizing the graph

```ts
import { printMermaidGraph, printDotGraph } from '@composed-di/core'

printMermaidGraph(module) // paste into https://mermaid.live/
printDotGraph(module) // paste into a Graphviz viewer
```

## Observability

### OpenTelemetry

Wrap your factories (or a whole module) with `OTELServiceInstrumentation` to get a span for every service initialization, disposal, and method call — parented to whatever OTEL context is active, so they slot into your existing traces:

```ts
import { ServiceModule } from '@composed-di/core'
import { OTELServiceInstrumentation } from '@composed-di/instrumentation-otel'

const instrumentation = new OTELServiceInstrumentation() // uses the global tracer provider

const module = instrumentation.install(
  ServiceModule.from([configFactory, databaseFactory]),
)
```

### Capturing arguments and results

Nothing is captured by default — runtime values may be large or secret. Opt in per `install()`, and scrub sensitive services with redaction rules:

```ts
import { redactionRule } from '@composed-di/instrumentation-core'

const module = instrumentation.install(baseModule, {
  capture: {
    arguments: true,
    results: true,
    redactionRules: [
      redactionRule(VaultKey).redactAll().exclude('ping').build(),
      redactionRule(BillingKey)
        .redact('chargeCard', {
          maskResult: (card) => `card ending in ${card.number.slice(-4)}`,
        })
        .build(),
    ],
  },
})
```

### Custom backends

To report to something other than OpenTelemetry, extend `ServiceInstrumentation` from `@composed-di/instrumentation-core` and implement three hooks (`initializeSpan`, `disposeSpan`, `methodCallSpan`), each returning an `OperationSpan` that is notified when the operation finishes. See [`packages/instrumentation-otel`](packages/instrumentation-otel/src/otelServiceInstrumentation.ts) for a complete reference implementation.

## Development

This is a [pnpm](https://pnpm.io/) workspace:

```sh
pnpm install     # install dependencies
pnpm build       # type-check and build all packages (tsc --build)
pnpm test        # run the vitest suite
pnpm lint        # oxlint
pnpm fmt:check   # oxfmt
```

## Getting help

- **Bugs and feature requests** — open an issue on [GitHub](https://github.com/imherrera/composed-di/issues).
- **API reference** — the source is thoroughly documented with TSDoc; start at [`packages/core/src/index.ts`](packages/core/src/index.ts).

## Maintainers

Maintained by [Juan Herrera](https://github.com/imherrera). Contributions are welcome — open an issue to discuss a change before submitting a pull request.

## License

[MIT](https://opensource.org/licenses/MIT)
