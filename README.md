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
const configKey = new ServiceKey<Config>('Config')
const databaseKey = new ServiceKey<Database>('Database')

// 2. Describe how each service is built and what it depends on.
const configFactory = ServiceFactory.singleton({
  provides: configKey,
  initialize: () => ({ dbUrl: process.env.DB_URL! }),
})

const databaseFactory = ServiceFactory.singleton({
  provides: databaseKey,
  dependsOn: [configKey] as const,
  initialize: (config) => connectToDatabase(config.dbUrl), // may be async
  dispose: (db) => db.close(),
})

// 3. Compose a module. Cycles and missing dependencies throw here, not later.
const module = ServiceModule.from([configFactory, databaseFactory])

// 4. Request services. Config is created first — lazily, exactly once.
const db = await module.get(databaseKey)

// 5. Tear everything down when you're done.
module.dispose()
```

## Core concepts

### Keys

A `ServiceKey<T>` is a typed token backed by a unique `Symbol`, so two keys with the same name never collide.

Declare a key with `new ServiceKey(...)` in the same package as the factory that provides it. Identity travels with the exported object, so no naming discipline is needed, and the package stays self-contained: it exports a single `ServiceModule` plus its keys, and consumers import both.

```ts
// @myapp/data — the whole package surface: one module + its keys.
export const userRepositoryKey = new ServiceKey<UserRepository>(
  'UserRepository',
)
export const invoiceRepositoryKey = new ServiceKey<InvoiceRepository>(
  'InvoiceRepository',
)

export const dataModule = ServiceModule.from([
  ServiceFactory.singleton({
    provides: userRepositoryKey,
    initialize: () => new PostgresUserRepository(),
  }),
  ServiceFactory.singleton({
    provides: invoiceRepositoryKey,
    initialize: () => new PostgresInvoiceRepository(),
  }),
])
```

```ts
// Elsewhere in the app: compose the module, resolve by the imported key.
import { dataModule, userRepositoryKey } from '@myapp/data'

const module = ServiceModule.from([dataModule, notificationsModule])
const users = await module.get(userRepositoryKey)
```

### Sharing infrastructure between packages

Third-party resources — a database connection, a cache client, an SDK client — are shared the same way. Give the resource a home package that declares its key and provides it; every package that needs it imports that key.

```ts
// @myapp/data — owns the connection, and the token that identifies it.
import type { Connection } from 'mongoose'

export const connectionKey = new ServiceKey<Connection>('Connection')

export const connectionModule = ServiceModule.from([
  ServiceFactory.singleton({
    provides: connectionKey,
    initialize: () => createConnection(process.env.MONGO_URL!),
    dispose: (connection) => connection.close(),
  }),
])
```

```ts
// @myapp/users and @myapp/billing both depend on it by import — one
// connection, created once, shared by every consumer.
import { connectionKey } from '@myapp/data'

export const usersModule = ServiceModule.from([
  ServiceFactory.singleton({
    provides: userRepositoryKey,
    dependsOn: [connectionKey] as const,
    initialize: (connection) => new MongoUserRepository(connection),
  }),
])
```

A package can also declare a key it does not provide, leaving the application to supply the implementation. Export the key alongside the module and document it as required — composing the module without a factory for it fails at `ServiceModule.from()`, not at request time.

### Factories

Two lifetimes are provided:

- **`ServiceFactory.singleton({...})`** — `initialize` runs on the first request; every later request shares the instance. A failed initialization is never cached, and after `dispose()` the next request builds a fresh instance.
- **`ServiceFactory.oneShot({...})`** — a fresh instance on every request, with no framework-managed cleanup; the requester owns the instance.

```ts
const requestIdFactory = ServiceFactory.oneShot({
  provides: requestIdKey,
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

const paymentSelectorKey = new SelectorKey([stripeKey, paypalKey])

class CheckoutService {
  constructor(private readonly payments: Selector<PaymentGateway>) {}

  async pay(order: Order) {
    const gateway = await this.payments.get(
      order.method === 'paypal' ? paypalKey : stripeKey,
    )
    return gateway.charge(order)
  }
}

const checkoutFactory = ServiceFactory.singleton({
  provides: checkoutKey,
  dependsOn: [paymentSelectorKey] as const,
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

Wrap your factories (or a whole module) with `OTELServiceInstrumentation` to get a span for every service initialization, disposal, module resolution, and method call — parented to whatever OTEL context is active, so they slot into your existing traces:

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
      redactionRule(vaultKey).redactAll().exclude('ping').build(),
      redactionRule(billingKey)
        .redact('chargeCard', {
          maskResult: (card) => `card ending in ${card.number.slice(-4)}`,
        })
        .build(),
    ],
  },
})
```

### Custom backends

To report to something other than OpenTelemetry, extend `ServiceInstrumentation` from `@composed-di/instrumentation-core` and implement two hooks (`lifecycleSpan`, `methodCallSpan`), each returning an `OperationSpan` that is notified when the operation finishes. See the [`@composed-di/instrumentation-core` README](packages/instrumentation-core/README.md) for the contract, and [`packages/instrumentation-otel`](packages/instrumentation-otel/src/otelServiceInstrumentation.ts) for a complete reference implementation.

## Troubleshooting

### `NoSuchFactoryError` for a key that is registered

If a key is visibly provided by a module you composed and resolution still fails, the module that declares the key was probably evaluated twice. `new ServiceKey(...)` mints a fresh `Symbol` on every evaluation, so the two copies are different keys that print the same name. Usual causes:

- the declaring package resolved to two copies in `node_modules` (check `npm ls` / `pnpm why`);
- the package was loaded once as ESM and once as CJS;
- a dev-server hot reload re-evaluated the key module while a longer-lived container kept the old key.

The fix is to make the declaring module resolve once — dedupe the dependency, pick a single module format, or rebuild the container on reload.

### Keys across separate module graphs

When two bundles genuinely never share a module graph — module federation remotes, a plugin host loading independently built plugins — no import can carry a key between them. `ServiceKey.for` covers that case: it is backed by `Symbol.for`, so the same name resolves to the same key in every bundle in the realm.

```ts
// Declared identically in the host and in each plugin bundle.
const authContextKey = ServiceKey.for<AuthContext>('@host/shell/AuthContext')
```

Two costs come with it, so prefer an imported `new ServiceKey(...)` anywhere an import is possible. The name is global to the realm, shared with every other library in the process — namespace it with the package it belongs to. And the type parameter is an unchecked assertion: two declarations of the same name with different `T` produce one key, and neither the compiler nor the runtime will object.

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
