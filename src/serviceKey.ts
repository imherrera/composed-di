// @ts-ignore
export class ServiceKey<T> {
  public readonly symbol: symbol;

  constructor(public readonly name: string) {
    this.symbol = Symbol(name);
  }
}
