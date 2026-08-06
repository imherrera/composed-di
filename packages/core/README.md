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

class EspressoMachine {
  pullShot(): void {}
  backflush(): void {}
}

class Barista {
  // Constructor injection: the class is completely framework-free.
  constructor(private readonly machine: EspressoMachine) {}

  serveEspresso() {
    this.machine.pullShot()
  }

  clockOut() {}
}

// Typed keys identify each service.
const machineKey = new ServiceKey<EspressoMachine>('EspressoMachine')
const baristaKey = new ServiceKey<Barista>('Barista')

// Cycles and missing dependencies throw here, not at request time.
const cafe = ServiceModule.from([
  ServiceFactory.singleton({
    provides: machineKey,
    initialize: () => new EspressoMachine(), // may be async
    dispose: (machine) => machine.backflush(),
  }),
  ServiceFactory.singleton({
    provides: baristaKey,
    dependsOn: [machineKey],
    initialize: (machine) => new Barista(machine),
    dispose: (barista) => barista.clockOut(),
  }),
])

// The barista is hired lazily, on the first order — and only one is hired.
const barista = await cafe.get(baristaKey)
barista.serveEspresso()

cafe.dispose() // closing time: clockOut() runs, then backflush()
```

## API overview

### `ServiceKey<T>`

A typed token backed by a unique `Symbol`, so two keys with the same name never collide. With no decorators to mint identities, keys are declared by hand — and typed, so a factory providing the wrong shape does not compile:

```ts
// Grinders come in many kinds, so the service is interface-typed.
// Interfaces erase at runtime; the key is the identity.
interface Grinder {
  grind(beans: Beans): Grounds
}

const grinderKey = new ServiceKey<Grinder>('Grinder')
const machineKey = new ServiceKey<EspressoMachine>('EspressoMachine')
```

Declare keys in the same package as the factories that provide them, so the package stays self-contained: it exports a single `ServiceModule` plus its keys, and consumers import both.

### `ServiceFactory`

Two lifetimes:

- **`ServiceFactory.singleton({...})`** — `initialize` runs on the first request; every later request shares the instance. Concurrent requests during an in-flight initialization share the same promise, a failed initialization is never cached, and after `dispose()` the next request builds a fresh instance.
- **`ServiceFactory.oneShot({...})`** — a fresh instance on every request, with no framework-managed cleanup; the requester owns the instance.

```ts
// Shared: one barista for the whole café, torn down when the module disposes.
const baristaFactory = ServiceFactory.singleton({
  provides: baristaKey,
  dependsOn: [grinderKey, machineKey],
  initialize: (grinder, machine) => new Barista(grinder, machine),
  dispose: (barista) => barista.clockOut(),
})

// Owned by the requester: beans are consumed, not kept — a fresh dose per request.
const arabicaFactory = ServiceFactory.oneShot({
  provides: arabicaKey,
  initialize: () => new ArabicaBeans(),
})
```

`dependsOn` is a tuple of keys, compile-checked against `initialize`'s parameters — wrong keys or arity do not compile, and the resolved services arrive fully typed, in declaration order.

### `ServiceModule`

`ServiceModule.from()` accepts factories and other modules, flattening them into one container. It validates the whole graph at creation, throwing `ModuleValidationError` on circular or missing dependencies — composition is where mistakes surface, not the first request.

```ts
const equipment = ServiceModule.from([grinderFactory, machineFactory])
// Modules compose: nesting one merges its factories in.
const cafe = ServiceModule.from([equipment, baristaFactory])

const barista = await cafe.get(baristaKey) // initializes grinder, machine, barista
const chef = await cafe.getOrNull(pastryChefKey) // no chef on staff: null, no throw

cafe.dispose() // reverse order: the barista clocks out before the machine backflushes
```

- `module.get(key)` — resolves a service, initializing it and its dependencies on demand. Throws `NoSuchFactoryError` if nothing provides the key.
- `module.getOrNull(key)` — same, but resolves to `null` for unprovided keys.
- `module.dispose()` — tears down retained instances in reverse-topological order, so every service is disposed before the services it depends on.

When two entries provide the same key, the last one wins — the override mechanism testing builds on (below).

### `SelectorKey<T>` and `Selector<T>`

A `SelectorKey` groups several implementations of one interface. A factory that depends on it receives a `Selector<T>` and picks an implementation at runtime with `selector.get(key)`:

```ts
const arabicaKey = new ServiceKey<Beans>('ArabicaBeans')
const robustaKey = new ServiceKey<Beans>('RobustaBeans')
// The menu of roasts.
const roastsKey = new SelectorKey<Beans>([arabicaKey, robustaKey])

class CafeShop {
  constructor(
    private readonly roasts: Selector<Beans>,
    private readonly barista: Barista,
  ) {}

  async order(roast: 'arabica' | 'robusta'): Promise<CuppaCoffee> {
    const beans = await this.roasts.get(
      roast === 'arabica' ? arabicaKey : robustaKey,
    )
    return this.barista.serveEspresso(beans)
  }
}

const cafeShopFactory = ServiceFactory.singleton({
  provides: cafeShopKey,
  dependsOn: [roastsKey, baristaKey],
  initialize: (roasts, barista) => new CafeShop(roasts, barista),
})
```

The selector resolves through the module, so lifetimes hold: a singleton key yields the shared instance, a one-shot key a fresh one per call — each order gets a fresh dose of beans, while the shop itself stays a singleton. That also makes a selector the safe way for a singleton to consume one-shots without capturing a single instance forever. `selector.get` accepts only the grouped keys, and every grouped key must be provided by the module for validation to pass.

### Visualization

`createMermaidGraph` / `printMermaidGraph` and `createDotGraph` / `printDotGraph` render the module's dependency graph for [Mermaid](https://mermaid.live/) or Graphviz viewers. Options control direction and highlighting of leaves and roots; `SelectorKey` dependencies render as decision nodes with dashed edges to their implementations.

```ts
printMermaidGraph(cafe, { direction: 'LR' })
// flowchart LR
//   node0["Barista"]
//   node1["EspressoMachine"]
//   node2["Grinder"]
//
//   node0 --> node2
//   node0 --> node1
```

### Errors

`ModuleValidationError`, `NoSuchFactoryError`, `SingletonDisposedDuringInitError`, and `FactoryReentrancyError` — each is documented at its definition in [`src/errors.ts`](src/errors.ts).

## Testing

Substitution happens at the key, not the construction site. `ServiceModule.from` is last-wins, so a test composes the real module plus overrides for the edges it fakes — and `dispose()` is a true reset between tests:

```ts
const testCafe = ServiceModule.from([
  cafe,
  // Replace the machine at its own key.
  ServiceFactory.singleton({
    provides: machineKey,
    initialize: () => fakeMachine,
  }),
])

afterEach(() => testCafe.dispose()) // fresh singletons per test
```

Classes themselves stay framework-free — constructor injection means a unit test can also skip the container entirely: `new Barista(fakeGrinder, fakeMachine)`.

## Full example

The complete café — every feature above in one running file — lives at [`packages/example/src/cafeShopCore.ts`](../example/src/cafeShopCore.ts), with a decorator-based twin ([`cafeShop.ts`](../example/src/cafeShop.ts)) built on [`@composed-di/decorators`](../decorators) for comparison.

## Documentation

See the [repository README](../../README.md) for the full guide. The source is thoroughly documented with TSDoc, starting at [`src/index.ts`](src/index.ts).

## License

MIT
