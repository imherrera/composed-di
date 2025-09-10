# composed-di

A tiny, type-friendly dependency injection helper for composing services via keys and factories.

It provides:
- ServiceKey<T>: a typed token used to identify a service
- ServiceFactory<T>: a contract to create a service (with helpers singletonFactory and oneShotFactory)
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
  singletonFactory,
  oneShotFactory,
} from 'composed-di'; // when developing this repo locally, import from './src/index'

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
const configFactory = singletonFactory({
  provides: ConfigKey,
  dependsOn: [] as const,
  async initialize() {
    return { baseUrl: 'https://api.example.com' } satisfies Config;
  },
});

const loggerFactory = singletonFactory({
  provides: LoggerKey,
  dependsOn: [] as const,
  async initialize() {
    return console as unknown as Logger;
  },
});

const appFactory = oneShotFactory({
  provides: AppKey,
  dependsOn: [ConfigKey, LoggerKey] as const,
  async initialize(config, logger) {
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
- Use `as const` on your `dependsOn` list to preserve tuple types and keep constructor parameters strongly typed.
- `ServiceModule.get` resolves dependencies recursively, so factories can depend on other services.
- If a dependency is missing or recursive, `ServiceModule` throws with a helpful error message.

## API

- `class ServiceKey<T>(name: string)`
- `interface ServiceFactory<T, D extends readonly ServiceKey<unknown>[]>` with `provides`, `dependsOn`, `initialize`, `dispose`
- `singletonFactory({ provides, dependsOn?, initialize, dispose? })`
- `oneShotFactory({ provides, dependsOn, initialize, dispose? })`
- `class ServiceModule` with `static from(factoriesOrModules)`, `get(key)`
- `type ServiceProvider` with `get(key)` (implemented by ServiceModule)

