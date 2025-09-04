// @ts-ignore
export class ServiceKey<T> {
  private readonly symbol: symbol;

  constructor(public readonly name: string) {
    this.symbol = Symbol(name);
  }
}
