# lazy-di

A lightweight, lazy, and typesafe dependency injection library for TypeScript.

## Features

- **Lazy Initialization**: Services are only created when they are actually needed.
- **Type-Safe**: Full TypeScript support with typed keys and dependency resolution.
- **Circular Dependency Detection**: Validates your dependency graph at module creation.
- **Flexible Scoping**: Support for singletons, transient (one-shot) services, and custom scopes.
- **Runtime Selection**: Dynamically choose between multiple implementations of the same interface.
- **Async Support**: Native support for asynchronous service initialization.
- **Visualization**: Built-in support for generating Mermaid and DOT diagrams of your dependency graph.

## Installation

```bash
npm install lazy-di
```

## Quick Start

### 1. Define your Service Keys

Service keys are typed tokens that identify your services. They ensure type safety when injecting and retrieving services.

```typescript
import { ServiceKey } from 'lazy-di';

interface Database {
  query: (sql: string) => Promise<any>;
}

export const DatabaseKey = new ServiceKey<Database>('Database');

interface UserService {
  getUser: (id: string) => Promise<any>;
}

export const UserServiceKey = new ServiceKey<UserService>('UserService');
```

### 2. Create Service Factories

Factories define how services are created and what they depend on. `lazy-di` supports both singleton (created once) and one-shot (created every time) services.

```typescript
import { ServiceFactory } from 'lazy-di';
import { DatabaseKey, UserServiceKey } from './keys';

const databaseFactory = ServiceFactory.singleton({
  provides: DatabaseKey,
  initialize: () => {
    console.log('Initializing Database...');
    return {
      query: async (sql) => ({ id: '1', name: 'John Doe' }),
    };
  },
});

const userServiceFactory = ServiceFactory.singleton({
  provides: UserServiceKey,
  dependsOn: [DatabaseKey],
  initialize: (db) => {
    // db is automatically typed as Database
    return {
      getUser: (id) => db.query(`SELECT * FROM users WHERE id = ${id}`),
    };
  },
});
```

### 3. Create a Service Module and Get Services

A `ServiceModule` aggregates factories and manages their lifecycle.

```typescript
import { ServiceModule } from 'lazy-di';

const module = ServiceModule.from([
  databaseFactory,
  userServiceFactory
]);

// At this point, no services have been initialized.

// This will initialize Database and then UserService lazily.
const userService = await module.get(UserServiceKey);
const user = await userService.getUser('1');
```

## Public API

### `ServiceKey<T>`

A unique identifier for a service of type `T`.

```typescript
const MyKey = new ServiceKey<MyInterface>('MyService');
```

### `ServiceFactory`

#### `ServiceFactory.singleton(options)`
Creates a factory for a service that is instantiated only once.

- `provides`: The `ServiceKey` this factory satisfies.
- `dependsOn`: (Optional) An array of `ServiceKey`s this service depends on.
- `initialize`: A function that creates the service instance. It receives the resolved dependencies as arguments. Can return a Promise.
- `dispose`: (Optional) A function called when the service is disposed.
- `scope`: (Optional) A `ServiceScope` for grouping services.

#### `ServiceFactory.oneShot(options)`
Creates a factory for a service that is instantiated every time it is requested.

### `ServiceModule`

#### `ServiceModule.from(entries)`
Creates a module from an array of factories or other `ServiceModule` instances. It automatically detects circular dependencies and missing dependencies.

#### `module.get(key)`
Retrieves a service instance. Returns a `Promise<T>`.

#### `module.dispose(scope?)`
Disposes of services. If a `scope` is provided, only services in that scope are disposed.

### `ServiceSelectorKey<T>` and `ServiceSelector<T>`

Useful for choosing between multiple implementations of the same interface at runtime.

```typescript
const LoggerSelectorKey = new ServiceSelectorKey<Logger>([
  ConsoleLoggerKey,
  FileLoggerKey,
]);

const AppFactory = ServiceFactory.singleton({
  provides: AppKey,
  dependsOn: [LoggerSelectorKey],
  initialize: (loggerSelector) => {
    return {
      run: async (useFile: boolean) => {
        const logger = await loggerSelector.get(
          useFile ? FileLoggerKey : ConsoleLoggerKey
        );
        logger.log('Running...');
      }
    };
  }
});
```

### `ServiceScope`

Used to group services for collective disposal.

```typescript
const MyScope = new ServiceScope('MyScope');
```

## Visualization

Visualize your dependency graph using Mermaid or DOT format.

```typescript
import { printMermaidGraph, printDotGraph } from 'lazy-di';

// Outputs a Mermaid diagram string
printMermaidGraph(module);

// Outputs a DOT diagram string
printDotGraph(module);
```

## Error Handling

- `ServiceModuleInitError`: Thrown during `ServiceModule.from()` if the dependency graph is invalid (circular or missing dependencies).
- `ServiceFactoryNotFoundError`: Thrown by `module.get()` if a requested key is not registered.

## License

MIT
