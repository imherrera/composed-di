// The same café as ./cafeShop.ts, written with the core package alone and
// no decorators anywhere. Every service is a plain class wired by an explicit
// factory. This tier is always available, and it is the escape hatch for
// everything the decorator tier rules out, such as constructor parameters,
// multiple instances of one class, or lifecycles decided per module.
import {
  SelectorKey,
  ServiceFactory,
  ServiceKey,
  ServiceModule,
  type Selector,
  printMermaidGraph,
} from '@composed-di/core'

interface Grinder {
  grind(beans: Beans): Grounds
}

interface Beans {
  readonly grams: number
}

// One key per service. Without decorators, keys are declared by hand and
// typed, so a factory providing the wrong shape does not compile.
const grinderKey = new ServiceKey<Grinder>('Grinder')
const machineKey = new ServiceKey<EspressoMachine>('EspressoMachine')
const baristaKey = new ServiceKey<Barista>('Barista')
const cafeShopKey = new ServiceKey<CafeShop>('CafeShop')
const arabicaKey = new ServiceKey<Beans>('ArabicaBeans')
const robustaKey = new ServiceKey<Beans>('RobustaBeans')
const roastsKey = new SelectorKey<Beans>([arabicaKey, robustaKey])

class BurrGrinder implements Grinder {
  grind(beans: Beans): Grounds {
    return new Grounds(beans.grams)
  }
}

class ArabicaBeans implements Beans {
  readonly grams = 18
}

class RobustaBeans implements Beans {
  readonly grams = 16
}

// Values are plain in every tier, created by the domain with `new` and
// never resolved from the container.
class Grounds {
  constructor(readonly grams: number) {}
}

class EspressoShot {
  constructor(readonly volumeMl: number) {}
}

class CuppaCoffee {
  constructor(readonly shot: EspressoShot) {}
}

class EspressoMachine {
  // A 1:2 brew ratio, 18 grams in and 36 millilitres out.
  pullShot(grounds: Grounds): EspressoShot {
    return new EspressoShot(grounds.grams * 2)
  }

  // A plain method. The factory below wires it up as the dispose hook.
  backflush() {}
}

class Barista {
  // Constructor injection keeps the class completely framework-free. A test
  // can `new Barista(fakeGrinder, fakeMachine)` directly, no container
  // required.
  constructor(
    private readonly grinder: Grinder,
    private readonly machine: EspressoMachine,
  ) {}

  serveEspresso(beans: Beans): CuppaCoffee {
    const grounds = this.grinder.grind(beans)
    const shot = this.machine.pullShot(grounds)
    return new CuppaCoffee(shot)
  }

  clockOut() {}
}

class CafeShop {
  constructor(
    private readonly roasts: Selector<Beans>,
    private readonly barista: Barista,
  ) {}

  async order(roast: 'arabica' | 'robusta'): Promise<CuppaCoffee> {
    const beans = await this.roasts.get(
      roast === 'arabica' ? arabicaKey : robustaKey,
    )
    return this.barista.serveEspresso(beans)
  }
}

// Every service's needs, construction, and teardown are wired here, and
// nowhere else. `dependsOn` is compile-checked against
// `initialize`'s parameters. Wrong keys or arity do not compile.
const module = ServiceModule.from([
  ServiceFactory.singleton({
    provides: grinderKey,
    initialize: () => new BurrGrinder(),
  }),
  ServiceFactory.oneShot({
    provides: arabicaKey,
    initialize: () => new ArabicaBeans(),
  }),
  ServiceFactory.oneShot({
    provides: robustaKey,
    initialize: () => new RobustaBeans(),
  }),
  ServiceFactory.singleton({
    provides: machineKey,
    initialize: () => new EspressoMachine(),
    dispose: (machine) => machine.backflush(),
  }),
  ServiceFactory.singleton({
    provides: baristaKey,
    dependsOn: [grinderKey, machineKey],
    initialize: (grinder, machine) => new Barista(grinder, machine),
    dispose: (barista) => barista.clockOut(),
  }),
  ServiceFactory.singleton({
    provides: cafeShopKey,
    dependsOn: [roastsKey, baristaKey],
    initialize: (roasts, barista) => new CafeShop(roasts, barista),
  }),
])

export async function main() {
  // The shop opens lazily, on the first order. Staff and equipment come up
  // with it, exactly once.
  const shop = await module.get(cafeShopKey)

  // Each order picks a roast at runtime. The Selector resolves a fresh
  // one-shot dose per call, while the staff singletons stay the same.
  const single = await shop.order('arabica')
  const double = await shop.order('robusta')

  console.log(
    `arabica: ${single.shot.volumeMl}ml | robusta: ${double.shot.volumeMl}ml`,
  )
  printMermaidGraph(module)

  // At closing time the machine backflushes, the barista clocks out, and
  // the next order opens a fresh shift.
  module.dispose()
}

void main()
