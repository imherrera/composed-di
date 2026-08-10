# @composed-di/decorators

[![npm version](https://img.shields.io/npm/v/%40composed-di%2Fdecorators)](https://www.npmjs.com/package/@composed-di/decorators)

Class-based registration for [`@composed-di/core`](../core), built on standard TC39 decorators — still no `experimentalDecorators`, no `reflect-metadata`, no metadata emission. The class declaration carries everything: lifecycle, dependencies, and teardown. The module only composes.

## Installation

```sh
npm install @composed-di/core @composed-di/decorators
```

This package is [pure ESM](https://gist.github.com/sindresorhus/a39789f98801d908bbc7ff3ecc99d99c). It cannot be `require()`d from CommonJS on Node.js < 22.

## Requirements

- TypeScript ≥ 5.0.
- `experimentalDecorators` must be **off**. This package uses standard decorators; legacy mode changes their runtime calling convention, so mixing them breaks at runtime, not compile time.
- Any transpiler with stage-3 decorator support works: tsc, esbuild ≥ 0.21, swc, babel with the `2023-05` decorators plugin.

## Quick start

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
class EspressoMachine {
  pullShot(): void {}
}

@Singleton
class Barista {
  // A decorated class is its own token — no ServiceKey needed.
  @Inject(EspressoMachine)
  private readonly machine!: EspressoMachine

  serveEspresso() {
    this.machine.pullShot()
  }

  @Dispose
  clockOut() {}
}

const cafe = ServiceModule.from([...factoriesOf(Barista, EspressoMachine)])

// The barista is hired lazily, on the first order — and only one is hired.
const barista = await cafe.get(keyOf(Barista))
barista.serveEspresso()

cafe.dispose() // closing time: clockOut() runs
```

## API overview

### `@Singleton` and `@OneShot`

The lifecycle lives on the class. `@Singleton` classes are built on first request and shared thereafter; `@OneShot` classes are built fresh on every request and never cached — the requester owns the instance.

```ts
// Beans are consumed, not kept: a fresh dose per request.
@OneShot
class ArabicaBeans implements Beans {
  readonly grams = 18
}
```

Decorated classes take **zero constructor arguments** — dependencies are declared as fields. A required parameter is a compile error on the decorator itself. The decorator also mints the class's `ServiceKey`, making the class usable as a token in `@Inject`, `@Select`, and the `-Of` bridges — `module.get` is core API and takes the key, via `keyOf`.

### `@Inject`

Declares that a field receives a service, resolved before the constructor body runs — so injected fields are already usable there. The idiom is a fixed unit:

```ts
@Singleton
class Barista {
  // Interface-typed dependency: interfaces erase, so it is identified by a
  // ServiceKey. The key's service type is checked against the field's type
  // at compile time.
  @Inject(grinderKey)
  private readonly grinder!: Grinder

  // Class-typed dependency: the decorated class is the token.
  @Inject(EspressoMachine)
  private readonly machine!: EspressoMachine
}
```

The `!` is TypeScript's syntax for a true statement — the field is assigned by machinery the checker cannot see. A class with `@Inject` fields is constructible only through a module; `new Barista()` throws.

Each field is its own request: two fields injecting the same `@OneShot` class receive two distinct instances, while two fields injecting the same `@Singleton` class are a definition-time error — they could only share one instance.

Don't inject a one-shot into a singleton field — that would capture a single instance forever. Pass it per call, or inject a selector (below):

```ts
serveEspresso(beans: Beans): CuppaCoffee {
  // beans arrive with the order, not as a field
}
```

### `@Dispose`

Marks the class's teardown, called on the retained instance when the module disposes. Exactly one per class, instance methods only, `@Singleton` only — one-shot instances are never disposed by the container.

```ts
@Singleton
class EspressoMachine {
  @Dispose
  backflush() {} // runs on cafe.dispose()
}
```

### `factoryOf(Class)` and `factoriesOf(...Classes)`

`factoryOf` turns a decorated class into an ordinary core `ServiceFactory`: the key from the decorator, the lifecycle from the decorator, the dependencies from the `@Inject` fields, the teardown from `@Dispose`. Registration stays a composition decision — decoration marks the class, the module provides it. `factoriesOf` is the variadic form, for registering several classes in one entry — mixed compositions spread it next to explicit factories:

```ts
const cafe = ServiceModule.from([
  ...factoriesOf(CafeShop, Barista, EspressoMachine, ArabicaBeans),
  ServiceFactory.singleton({
    provides: grinderKey,
    initialize: () => new BurrGrinder(),
  }),
])
```

Every call creates a fresh factory, so singletons are scoped to the composition: two modules built from `factoryOf(Barista)` hold two independent baristas.

### `keyOf(Class)`

Returns the `ServiceKey` the lifecycle decorator minted — the class's address. It is how decorated classes are retrieved, and how anything key-shaped can point at them:

```ts
const barista = await cafe.get(keyOf(Barista))
```

Throws `MissingLifecycleError` for an undecorated class.

`keyOf` is for crossing into core API — `module.get`, a factory's `provides` or `dependsOn`. Inside `@Inject` and `@Select`, pass the class directly: `@Inject(keyOf(Barista))` means the same as `@Inject(Barista)`, with an extra call standing in the way.

### `@Select`

Declares a field that receives a core `Selector` over several services — for picking an implementation per call at runtime. Tokens are decorated classes or `ServiceKey`s, mixed freely. Unlike the one-shots themselves, the selector is safe in a singleton: it resolves a fresh instance on every call instead of capturing one.

```ts
@Singleton
class CafeShop {
  // The menu of roasts.
  @Select<Beans>(ArabicaBeans, RobustaBeans)
  private readonly roasts!: Selector<Beans>

  async order(roast: 'arabica' | 'robusta'): Promise<CuppaCoffee> {
    const beans = await this.roasts.get(
      roast === 'arabica' ? keyOf(ArabicaBeans) : keyOf(RobustaBeans),
    )
    return this.barista.serveEspresso(beans)
  }
}
```

### `selectorOf(...Classes)`

Mints the same grouping as a standalone `SelectorKey`, for core-tier composition — a hand-written factory's `dependsOn`, or anywhere key-shaped. `@Select(A, B)` is the field idiom; `selectorOf(A, B)` is the bridge (a `SelectorKey` is a `ServiceKey`, so `@Inject(selectorOf(...))` is equivalent, just less direct).

## Testing

Substitution happens at the key, not the constructor. `ServiceModule.from` is last-wins, so a test composes the real module plus overrides for the edges it fakes — and `dispose()` is a true reset between tests:

```ts
const testCafe = ServiceModule.from([
  cafe,
  // Replace the machine at its own address.
  ServiceFactory.singleton({
    provides: keyOf(EspressoMachine),
    initialize: () => fakeMachine,
  }),
])

afterEach(() => testCafe.dispose()) // fresh singletons per test
```

## When to use the explicit tier instead

A class is decorated if and only if `factoryOf` registers it. Classes the tier rules out — required constructor parameters, several instances of one class, a lifecycle decided per module — stay undecorated and use a plain `ServiceKey` with a hand-written factory. The tiers meet at keys, in both directions:

```ts
// Explicit tier: constructor injection, key-identified.
const legacyAdapterKey = new ServiceKey<LegacyAdapter>('LegacyAdapter')

// Decorated classes consume it like any other key.
@Singleton
class Garage {
  @Inject(legacyAdapterKey)
  private readonly adapter!: LegacyAdapter
}
```

## Full example

The complete café — every feature above in one running file — lives at [`packages/example/src/cafeShop.ts`](../example/src/cafeShop.ts), with a decorator-free twin ([`cafeShopCore.ts`](../example/src/cafeShopCore.ts)) for comparison.

## Errors

`MissingLifecycleError`, `DuplicateLifecycleError`, `DisposeHookError`, and `FieldInjectionError` — each is documented at its definition in [`src/errors.ts`](src/errors.ts). All fire at class-definition or registration time where possible; nothing waits for a request to tell you the declaration is wrong.

## License

MIT
