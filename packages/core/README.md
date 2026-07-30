# @composed-di/core

[![npm version](https://img.shields.io/npm/v/%40composed-di%2Fcore)](https://www.npmjs.com/package/@composed-di/core)

A lightweight, lazy, and type-safe dependency injection container for TypeScript — no decorators, no reflection metadata, no framework lock-in. Services are described as plain factories, composed into modules, and created only when they are actually requested.

## Installation

```sh
npm install @composed-di/core
```

## Quick start

```ts
import { ServiceKey, ServiceFactory, ServiceModule } from '@composed-di/core'

interface Config {
  dbUrl: string
}
interface Database {
  query(sql: string): Promise<unknown[]>
  close(): void
}

// Typed keys identify each service.
const ConfigKey = new ServiceKey<Config>('Config')
const DatabaseKey = new ServiceKey<Database>('Database')

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

// Cycles and missing dependencies throw here, not at request time.
const module = ServiceModule.from([configFactory, databaseFactory])

// Config is created first — lazily, exactly once.
const db = await module.get(DatabaseKey)

module.dispose()
```

## API overview

### `ServiceKey<T>`

A typed token backed by a unique `Symbol`, so two keys with the same name never collide. `ServiceKey.for<T>(name)` instead uses the global symbol registry, producing keys that identify the same service across modules, bundles, or duplicated copies of this library.

### `ServiceFactory`

Two lifetimes:

- **`ServiceFactory.singleton({...})`** — `initialize` runs on the first request; every later request shares the instance. Concurrent requests during an in-flight initialization share the same promise, a failed initialization is never cached, and after `dispose()` the next request builds a fresh instance.
- **`ServiceFactory.oneShot({...})`** — a fresh instance on every request, with no framework-managed cleanup; the requester owns the instance.

`dependsOn` is a tuple of keys; `initialize` receives the resolved services fully typed, in declaration order.

### `ServiceModule`

`ServiceModule.from()` accepts factories and other modules, flattening them into one container. When two entries provide the same key, the last one wins — handy for overriding real services with fakes in tests. It validates the whole graph at creation, throwing `ModuleValidationError` on circular or missing dependencies.

- `module.get(key)` — resolves a service, initializing it and its dependencies on demand. Throws `NoSuchFactoryError` if nothing provides the key.
- `module.getOrNull(key)` — same, but resolves to `null` for unprovided keys.
- `module.dispose()` — tears down every factory's retained instances.

### `SelectorKey<T>` and `Selector<T>`

A `SelectorKey` groups several implementations of one interface. A factory that depends on it receives a `Selector<T>` and picks an implementation at runtime with `selector.get(key)`.

### Visualization

`createMermaidGraph` / `printMermaidGraph` and `createDotGraph` / `printDotGraph` render the module's dependency graph for [Mermaid](https://mermaid.live/) or Graphviz viewers.

### Errors

`ModuleValidationError`, `NoSuchFactoryError`, `SingletonDisposedDuringInitError`, and `FactoryReentrancyError` — each is documented at its definition in [`src/errors.ts`](src/errors.ts).

## Observability

Instrument factories or whole modules — spans for initialization, disposal, resolution, and every method call — with [`@composed-di/instrumentation-otel`](../instrumentation-otel) (OpenTelemetry) or a custom backend built on [`@composed-di/instrumentation-core`](../instrumentation-core).

## Documentation

See the [repository README](../../README.md) for the full guide. The source is thoroughly documented with TSDoc, starting at [`src/index.ts`](src/index.ts).

## License

MIT
