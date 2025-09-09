import { ServiceKey } from './serviceKey';

export interface ServiceProvider {
  get<T>(key: ServiceKey<T>): Promise<T>;
}
