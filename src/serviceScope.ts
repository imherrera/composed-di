export class ServiceScope {
  readonly symbol: symbol;

  constructor(readonly name: string) {
    this.symbol = Symbol(name);
  }
}
