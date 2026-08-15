/**
 * A typed token used to identify and retrieve a service from a {@link ServiceModule}.
 *
 * ServiceKey acts as a unique identifier for a service type, allowing type-safe
 * dependency injection. Each key has a unique symbol to ensure identity comparison
 * works correctly even if two keys have the same name.
 */
export class ServiceKey<T> {
  /**
   * Phantom field that brands this key with the service type `T`.
   * Exists only at the type level (`declare` emits no runtime code) and
   * prevents keys of different service types from being interchangeable.
   */
  declare protected readonly _type: T

  /**
   * Creates a new ServiceKey with the given name.
   *
   * @param name A human-readable name for the service, used in error messages and debugging.
   * @param symbol A unique symbol that identifies this service key. Used internally for identity comparison between keys.
   */
  constructor(
    public readonly name: string,
    public readonly symbol: symbol = Symbol(name),
  ) {}
}
