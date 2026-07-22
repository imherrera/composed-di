# @composed-di

A lightweight, lazy, and typesafe dependency injection library for TypeScript.

## Features

- **Lazy Initialization**: Services are only created when they are actually needed.
- **Type-Safe**: Full TypeScript support with typed keys and dependency resolution.
- **Circular Dependency Detection**: Validates your dependency graph at module creation.
- **Flexible Scoping**: Support for singletons, transient (one-shot) services, and custom scopes.
- **Runtime Selection**: Dynamically choose between multiple implementations of the same interface.
- **Async Support**: Native support for asynchronous service initialization.
- **Visualization**: Built-in support for generating Mermaid and DOT diagrams of your dependency graph.
