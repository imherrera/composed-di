# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- **`@composed-di/decorators`** — two fields of a class may `@Inject` the same singleton. Declaring two fields that injected the same singleton on a class used to throw `DecoratorValidationError` at class definition, both fields now receive the one shared instance.

[unreleased]: https://github.com/imherrera/composed-di/compare/master...develop
