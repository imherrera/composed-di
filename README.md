# lazy-di

A tiny, type-friendly dependency injection helper for composing services via keys and factories.

It provides:
- ServiceKey<T>: a typed token used to identify a service
- ServiceFactory<T>: a contract to create a service (with static methods `singleton` and `oneShot`)
- ServiceModule: a resolver that wires factories, validates dependencies, and provides services

ServiceModule will:
- detect recursive dependencies (a factory that depends on its own key)
- detect missing dependencies (a factory that depends on keys that have no factory)

## Install

Install from npm:

- npm: `npm install composed-di`
- pnpm: `pnpm add composed-di`
- yarn: `yarn add composed-di`

If you're working on this repo locally, build artifacts are generated under `dist/` by running:

```
npm run build
```

## Usage

Below is a minimal example using the public API.

```ts
import {
  ServiceKey,
  ServiceModule,
  ServiceFactory,
} from 'composed-di'; // when developing this repo locally, import from './src'

// 1) Define service types
interface Config {
  baseUrl: string;
}

interface Logger {
  info: (msg: string) => void;
}

class App {
  constructor(private config: Config, private logger: Logger) {}
  start() {
    this.logger.info(`Starting with baseUrl=${this.config.baseUrl}`);
  }
}

// 2) Create keys
const ConfigKey = new ServiceKey<Config>('Config');
const LoggerKey = new ServiceKey<Logger>('Logger');
const AppKey = new ServiceKey<App>('App');

// 3) Create factories (singleton or one-shot)
const configFactory = ServiceFactory.singleton({
  provides: ConfigKey,
  dependsOn: [],
  initialize: () => {
    return { baseUrl: 'https://api.example.com' } satisfies Config;
  },
});

const loggerFactory = ServiceFactory.singleton({
  provides: LoggerKey,
  dependsOn: [],
  initialize: () => {
    return console as unknown as Logger;
  },
});

const appFactory = ServiceFactory.oneShot({
  provides: AppKey,
  dependsOn: [ConfigKey, LoggerKey],
  initialize: (config, logger) => {
    return new App(config, logger);
  },
});

// 4) Compose a module (you can pass factories and/or other ServiceModule instances)
const module = ServiceModule.from([configFactory, loggerFactory, appFactory]);

// 5) Resolve and use
(async () => {
  const app = await module.get(AppKey);
  app.start();
})();
```

Notes:
- `ServiceModule.get` resolves dependencies recursively, so factories can depend on other services.
- If a dependency is missing or recursive, `ServiceModule` throws with a helpful error message.

## Visualizing Dependencies

The library includes utilities to generate a DOT graph representation of your service dependencies, which can be visualized using Graphviz tools.

```ts
import { ServiceModule, printDotGraph, createDotGraph } from 'composed-di';

// After creating your ServiceModule
const module = ServiceModule.from([configFactory, loggerFactory, appFactory]);

// Option 1: Print the DOT graph to console with instructions
printDotGraph(module);

// Option 2: Generate DOT graph with custom options
const dotGraph = createDotGraph(module, {
  direction: 'LR',  // 'TB' (top-bottom), 'LR' (left-right), 'BT', 'RL'
  title: 'My Service Dependencies',
  highlightLeaves: true,  // Highlight services with no dependencies (green)
  highlightRoots: true,   // Highlight services with no dependents (orange)
});
console.log(dotGraph);
```

The generated DOT notation can be visualized using:
- [GraphvizOnline](https://dreampuf.github.io/GraphvizOnline/)
- [Edotor](https://edotor.net/)

## API

- `class ServiceKey<T>(name: string)` - Creates a typed token to identify a service
- `abstract class ServiceFactory<T, D extends readonly ServiceKey<unknown>[]>` with:
  - `provides: ServiceKey<T>` - The service key this factory provides
  - `dependsOn: D` - Array of service keys this factory depends on
  - `initialize(...dependencies)` - Creates the service instance
  - `dispose(instance)` - Cleans up the service instance
  - `static singleton({ provides, dependsOn?, initialize, dispose? })` - Creates a singleton factory
  - `static oneShot({ provides, dependsOn, initialize, dispose? })` - Creates a one-shot factory
- `class ServiceModule` with:
  - `static from(factoriesOrModules)` - Creates a module from factories and/or other modules
  - `async get(key)` - Resolves and returns a service by its key
- `createDotGraph(module, options?)` - Generates DOT notation graph from a ServiceModule
- `printDotGraph(module)` - Prints DOT graph to console with visualization instructions

