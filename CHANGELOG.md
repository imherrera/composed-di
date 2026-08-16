# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **@composed-di/core** — `DependencyKey<T>`, the union of `ServiceKey<T>` and `SelectorKey<T>`.

### Changed

- **@composed-di/core** — `ServiceModule.get`/`getOrNull` no longer accept a `SelectorKey`. Passing one is now a compile time error instead of compiling and throwing `NoSuchFactoryError` at runtime.
- **@composed-di/decorators** — `@Inject(selectorOf(...))` is now a compile time error. Use `@Select(...)`.
- **@composed-di/decorators** — two fields of a class may `@Inject` the same singleton. Declaring two fields that injected the same singleton on a class used to throw `DecoratorValidationError` at class definition, both fields now receive the one shared instance.

[unreleased]: https://github.com/imherrera/composed-di/compare/master...develop
