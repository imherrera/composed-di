export interface ServiceTracer {
  trace<T>(fnName: string, fn: () => T): T;
}
