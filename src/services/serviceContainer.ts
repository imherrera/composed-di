import { ServiceKey } from './serviceKey.ts';
import { ServiceFactory } from './serviceFactory.ts';
import { ServiceProvider } from './serviceProvider.ts';
import { ServiceRegistry } from './serviceRegistry.ts';

export class ServiceContainer implements ServiceProvider, ServiceRegistry {
  private factories: ServiceFactory<unknown>[] = [];

  public retrieve<T>(key: ServiceKey<T>): Promise<T> {
    const factory = this.factories.find((f) => f.key.symbol === key.symbol);
    if (factory && isSuitable(key, factory)) {
      return factory.create();
    }

    throw new Error(`Could not find a suitable factory for ${key}`);
  }

  public register(factory: ServiceFactory<unknown>): void {
    const isRegistered = this.factories.some(
      (f) => f.key.symbol === factory.key.symbol,
    );
    if (!isRegistered) {
      this.factories.push(factory);
    }
  }
}

function isSuitable<T>(
  key: ServiceKey<T>,
  factory: ServiceFactory<unknown>,
): factory is ServiceFactory<T> {
  return factory?.key === key;
}
