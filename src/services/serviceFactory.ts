// @ts-ignore
import { ServiceKey } from './serviceKey.ts';

export interface ServiceFactory<T> {
  key: ServiceKey<T>;
  dependsOn: ServiceKey<unknown>[];

  create(): Promise<T>;
}