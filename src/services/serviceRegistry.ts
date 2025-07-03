import { ServiceFactory } from './serviceFactory.ts';

export interface ServiceRegistry {
  register(factory: ServiceFactory<unknown>): void | never;
}