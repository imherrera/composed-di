// @ts-ignore
export class ServiceKey<T> {
  readonly symbol: symbol;

  constructor(name: string) {
    this.symbol = Symbol(name);
  }
}