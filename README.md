# composed-di

[![npm version](https://img.shields.io/npm/v/%40composed-di%2Fcore)](https://www.npmjs.com/package/@composed-di/core)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](#license)

A lightweight, lazy, and type-safe dependency injection library for TypeScript — no reflection metadata, no framework lock-in. Services are described as plain factories, composed into modules, and created only when they are actually requested, so a Lambda invocation or an app launch pays only for the subgraph it touches.

Prefer to declare services as classes? [`@composed-di/decorators`](packages/decorators) adds class-based registration on standard TC39 decorators — still no `reflect-metadata`, still no `experimentalDecorators`.

## Packages

| Package                                                              | Description                                                                                    |
| -------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| [`@composed-di/core`](packages/core)                                 | The DI container: keys, factories, modules, and selectors.                                     |
| [`@composed-di/decorators`](packages/decorators)                     | Class-based registration on standard TC39 decorators: lifecycle, injection, and teardown.      |
| [`@composed-di/instrumentation-core`](packages/instrumentation-core) | Framework-agnostic observability hooks for service initialization, disposal, and method calls. |
| [`@composed-di/instrumentation-otel`](packages/instrumentation-otel) | OpenTelemetry implementation that records service events as spans.                             |

## Why composed-di?

- **Lazy by default** — a service is created on its first `get()`, never before. Nothing is constructed at startup, which keeps serverless cold starts and mobile launch times proportional to what a given code path actually uses rather than to the size of the graph.
- **Type-safe** — `ServiceKey<T>` is a typed token; a factory's `initialize` receives its dependencies fully typed, in declaration order. No strings, no `any`.
- **Observability built in** — instrument any factory to trace initialization, disposal, and every method call, with opt-in argument/result capture and redaction rules for sensitive services.
- **Fail-fast validation** — `ServiceModule.from()` detects circular dependencies and missing factories at module creation, with readable traces of the broken path.
- **Explicit lifecycles** — lazily-created singletons with deterministic `dispose()`, and one-shot (transient) factories.
- **Async-native** — `initialize` may return a promise; concurrent requests for an in-flight singleton share the same initialization.
- **Runtime selection** — `SelectorKey` groups multiple implementations of an interface so a service can pick one at runtime.
- **Classes, if you want them** — an optional package registers classes directly, with the lifecycle, dependencies, and teardown declared on the class. Standard decorators only, so nothing depends on `reflect-metadata` or `experimentalDecorators`.

## Getting started

### Installation

```sh
npm install @composed-di/core
# optional, to register classes instead of writing factories by hand:
npm install @composed-di/decorators
# optional, for OpenTelemetry tracing of your services:
npm install @composed-di/instrumentation-otel @opentelemetry/api
```

Every package is [pure ESM](https://gist.github.com/sindresorhus/a39789f98801d908bbc7ff3ecc99d99c). They cannot be `require()`d from CommonJS on Node.js < 22.

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
  dependsOn: [configKey],
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
import type { Pool } from 'pg'

export const connectionKey = new ServiceKey<Pool>('Connection')
export const userRepositoryKey = new ServiceKey<UserRepository>(
  'UserRepository',
)
export const invoiceRepositoryKey = new ServiceKey<InvoiceRepository>(
  'InvoiceRepository',
)

const connectionFactory = ServiceFactory.singleton({
  provides: connectionKey,
  initialize: () => new Pool({ connectionString: process.env.DB_URL }),
  dispose: (pool) => pool.end(),
})

const userRepositoryFactory = ServiceFactory.singleton({
  provides: userRepositoryKey,
  dependsOn: [connectionKey],
  initialize: (pool) => new PostgresUserRepository(pool),
})

const invoiceRepositoryFactory = ServiceFactory.singleton({
  provides: invoiceRepositoryKey,
  dependsOn: [connectionKey],
  initialize: (pool) => new PostgresInvoiceRepository(pool),
})

export const dataModule = ServiceModule.from([
  connectionFactory,
  userRepositoryFactory,
  invoiceRepositoryFactory,
])
```

```ts
// Elsewhere in the app: compose the module, resolve by the imported key.
import { dataModule, userRepositoryKey } from '@myapp/data'

const module = ServiceModule.from([dataModule, notificationsModule])
const users = await module.get(userRepositoryKey)
```

### Sharing infrastructure between packages

Third-party resources — a database connection, a cache client, an SDK client — are shared the same way. The package that owns the resource declares its key and provides it, as `@myapp/data` does above; every other package imports that key and depends on it.

Because a module must be complete, a consuming package composes the providing module into its own:

```ts
// @myapp/reporting — a different package, the same connection.
import { dataModule, connectionKey } from '@myapp/data'

export const monthlyReportKey = new ServiceKey<MonthlyReport>('MonthlyReport')

const monthlyReportFactory = ServiceFactory.singleton({
  provides: monthlyReportKey,
  dependsOn: [connectionKey],
  initialize: (pool) => new MonthlyReport(pool),
})

export const reportingModule = ServiceModule.from([
  dataModule,
  monthlyReportFactory,
])
```

Composing both at the application root is fine — `dataModule` appears twice, the last entry providing a key wins, and one pool is created on first use and shared by everything that asked for it:

```ts
const module = ServiceModule.from([dataModule, reportingModule])
```

Depend on the module, not on the factory. `@myapp/reporting` imports `dataModule` and `connectionKey`, never `connectionFactory` — so when the connection later needs a secrets client or a logger, that dependency is satisfied inside `@myapp/data` and no consumer changes. Export the factory instead and its `dependsOn` list becomes public API: every module that registered it has to be tracked down and updated whenever the list grows, and the failure shows up in the consumer's `ServiceModule.from()` rather than yours.

Exporting a key is what makes a service substitutable. `connectionKey` is exported, so `ServiceModule.from([dataModule, fakePoolFactory])` replaces the pool — last-wins applies across the flattened graph. A key the package does not export cannot be named by a consumer at all, and therefore cannot be overridden: identity is the exported object, not the name, and declaring a second key with the same name produces a different key. Treat the keys you export as the package's substitution contract, and keep the rest internal.

### Packages that cannot choose an implementation

A `ServiceModule` is always complete: `ServiceModule.from()` requires every `dependsOn` to be satisfied within the same call. That is usually easy to arrange — a package that needs configuration can read the environment itself, or depend on a config package that does and exports a module.

It stops working when a package deliberately must _not_ choose. A notifications package used by two applications, one sending through SES and the other through Twilio, cannot export a complete module, because completing it would mean picking one. Export a function that takes the missing module instead.

```ts
// @myapp/notifications — declares the contract, provides everything but the transport.
export interface NotificationTransport {
  send(to: string, subject: string, body: string): Promise<void>
}

export const transportKey = new ServiceKey<NotificationTransport>('Transport')
export const notifierKey = new ServiceKey<Notifier>('Notifier')

// Internal: not exported, so no consumer can name it or replace it.
const templateRendererKey = new ServiceKey<TemplateRenderer>('TemplateRenderer')

const templateRendererFactory = ServiceFactory.singleton({
  provides: templateRendererKey,
  initialize: () => new HandlebarsRenderer(),
})

const notifierFactory = ServiceFactory.singleton({
  provides: notifierKey,
  dependsOn: [transportKey, templateRendererKey],
  initialize: (transport, renderer) => new Notifier(transport, renderer),
})

export const makeNotificationsModule = (transport: ServiceModule) =>
  ServiceModule.from([transport, templateRendererFactory, notifierFactory])
```

An implementation package exports no keys of its own. Its entire purpose is to satisfy `transportKey`, and its own dependencies stay internal:

```ts
// @myapp/notifications-ses
import { transportKey } from '@myapp/notifications'
import { SESClient } from '@aws-sdk/client-ses'

const sesClientKey = new ServiceKey<SESClient>('SESClient')

const sesClientFactory = ServiceFactory.singleton({
  provides: sesClientKey,
  initialize: () => new SESClient({ region: process.env.AWS_REGION }),
  dispose: (client) => client.destroy(),
})

const sesTransportFactory = ServiceFactory.singleton({
  provides: transportKey,
  dependsOn: [sesClientKey],
  initialize: (client) => new SESTransport(client),
})

export const sesTransportModule = ServiceModule.from([
  sesClientFactory,
  sesTransportFactory,
])
```

Each application picks its transport at the composition root:

```ts
// apps/web
const appModule = ServiceModule.from([
  makeNotificationsModule(sesTransportModule),
  dataModule,
])

// apps/internal-tools — same package, different transport
const toolsModule = ServiceModule.from([
  makeNotificationsModule(twilioTransportModule),
])
```

Note which way the dependency points: `@myapp/notifications` never imports the AWS SDK, and `sesClientKey` is unexported, so the client is genuinely internal to the transport package. Tests get the same mechanism for free — `makeNotificationsModule(fakeTransportModule)`, with no override and no ordering to reason about.

The one cost is that `transport: ServiceModule` promises nothing about which keys it provides. Pass the wrong module and `ServiceModule.from()` throws naming the unsatisfied key — still fail-fast, but at composition rather than at the call.

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

A singleton that depends on a one-shot factory captures that value for its entire lifetime — the one-shot runs once, during the singleton's initialization, and the result is then shared like any other singleton state. That is usually not what you want from a per-request value.

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
  dependsOn: [paymentSelectorKey],
  initialize: (payments) => new CheckoutService(payments),
})
```

### Class-based registration

Everything above is plain factories, and core stays that way. When services are already classes, [`@composed-di/decorators`](packages/decorators) moves the same three decisions — lifetime, dependencies, teardown — onto the class declaration, and `factoriesOf` turns the result back into ordinary core factories. Here is the [Quick start](#quick-start) again, keys and factories gone:

```ts
import { ServiceModule } from '@composed-di/core'
import {
  Singleton,
  Inject,
  Dispose,
  factoriesOf,
  keyOf,
} from '@composed-di/decorators'

@Singleton
class Config {
  readonly dbUrl = process.env.DB_URL!
}

@Singleton
class Database {
  // A decorated class is its own token — no ServiceKey needed.
  @Inject(Config)
  private readonly config!: Config

  // Injected fields are resolved before the rest of construction runs.
  private readonly client = createClient(this.config.dbUrl)

  query(sql: string): Promise<unknown[]> {
    return this.client.query(sql)
  }

  @Dispose
  close() {
    this.client.close()
  }
}

const module = ServiceModule.from([...factoriesOf(Config, Database)])

// Config is created first — lazily, exactly once, as before.
const db = await module.get(keyOf(Database))

module.dispose() // close() runs
```

Decorated classes take zero constructor arguments — dependencies are fields, and a required parameter is a compile error on the decorator itself. Registration stays a composition decision: decorating a class marks it, the module still has to provide it.

`@OneShot` is the other lifetime: a fresh instance on every request, owned by the requester and never disposed by the container, so `@Dispose` is `@Singleton`-only. Here is the request-id [factory](#factories) as a class:

```ts
@OneShot
class RequestId {
  readonly value = crypto.randomUUID() // new value per request
}
```

The capture caveat applies unchanged — an `@Inject` field on a singleton would hold one `RequestId` for the singleton's entire lifetime. Per-call values arrive as method arguments, or through `@Select`: [runtime selection](#runtime-selection) as a field. The selector resolves through the module on every call, so singleton members stay shared and one-shot members come fresh, which makes it the safe way for a singleton to reach one-shots. With `StripeGateway` and `PaypalGateway` decorated, each class is its own token, and checkout reads as it did with keys:

```ts
@Singleton
class CheckoutService {
  @Select<PaymentGateway>(StripeGateway, PaypalGateway)
  private readonly payments!: Selector<PaymentGateway>

  async pay(order: Order) {
    const gateway = await this.payments.get(
      order.method === 'paypal' ? keyOf(PaypalGateway) : keyOf(StripeGateway),
    )
    return gateway.charge(order)
  }
}
```

The tiers mix freely, and the [`@myapp/data` package from Keys](#keys) shows where that matters: the `pg` `Pool` is third-party code, impossible to decorate, so it keeps its hand-written key and factory, while the repositories become decorated classes (replacing their exported keys as the package's surface). `@Inject` accepts a `ServiceKey` as readily as a class, with the key's service type checked against the field's type at compile time, and `factoriesOf` spreads next to explicit factories:

```ts
// @myapp/data — the Keys example, repositories decorated.
import type { Pool } from 'pg'

export const connectionKey = new ServiceKey<Pool>('Connection')

@Singleton
export class UserRepository {
  @Inject(connectionKey)
  private readonly pool!: Pool
}

@Singleton
export class InvoiceRepository {
  @Inject(connectionKey)
  private readonly pool!: Pool
}

export const dataModule = ServiceModule.from([
  ...factoriesOf(UserRepository, InvoiceRepository),
  ServiceFactory.singleton({
    provides: connectionKey,
    initialize: () => new Pool({ connectionString: process.env.DB_URL }),
    dispose: (pool) => pool.end(),
  }),
])
```

Crossing the other way, `keyOf(Class)` returns the `ServiceKey` the lifecycle decorator minted, for anything core-shaped: `module.get` above, a hand-written factory's `dependsOn`, or the fake-database override from [Modules](#modules) — substitution is last-wins at the key, exactly as for explicit factories. (`selectorOf(StripeGateway, PaypalGateway)` is the same bridge for `@Select`'s grouping.)

```ts
const testModule = ServiceModule.from([
  module,
  // Replace the database at its own key.
  ServiceFactory.singleton({
    provides: keyOf(Database),
    initialize: () => fakeDatabase,
  }),
])
```

This is stage-3 decorators plus [decorator metadata](https://github.com/tc39/proposal-decorator-metadata), so it needs TypeScript ≥ 5.2 with `experimentalDecorators` **off** — legacy mode changes the runtime calling convention and breaks at runtime rather than at compile time, and metadata (5.2+) is how the decorators bind `@Inject` fields to their class. See the [package README](packages/decorators/README.md) for the full API, and the example package for one app written both ways: [`cafeShop.ts`](packages/example/src/cafeShop.ts) with decorators, [`cafeShopCore.ts`](packages/example/src/cafeShopCore.ts) with factories alone.

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

## Roadmap

Not yet implemented, listed here so the direction is public:

- **Opt-in eager initialization for singleton factories** — `await module.warmup()` to build selected singletons up front, so a bad connection string fails while the process is starting rather than on the first request that needs it. Lazy stays the default; long-running servers opt in, serverless and mobile do not. One-shot factories are unaffected, since there is nothing to build ahead of time.

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
