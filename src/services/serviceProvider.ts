import { ServiceKey } from './serviceKey.ts';

export interface ServiceProvider {
  retrieve<T>(key: ServiceKey<T>): Promise<T>;
}