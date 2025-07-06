import { ServiceKey } from './serviceKey';

export interface ServiceProvider {
  inject<T>(key: ServiceKey<T>): Promise<T>;
}
