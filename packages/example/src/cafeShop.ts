import {
  ServiceFactory,
  ServiceKey,
  ServiceModule,
  type Selector,
  printMermaidGraph,
} from '@composed-di/core'
import {
  Inject,
  OneShot,
  OnDispose,
  Singleton,
  keyOf,
  factoriesOf,
  selectorOf,
} from '@composed-di/decorators'

// Grinders come in many kinds — burr, blade, hand-crank — so the service is
// interface-typed. Interfaces erase at runtime, so it can only be identified
// by a ServiceKey.
interface Grinder {
  grind(beans: Beans): Grounds
}

const grinderKey = new ServiceKey<Grinder>('Grinder')

class BurrGrinder implements Grinder {
  grind(beans: Beans): Grounds {
    return new Grounds(beans.grams)
  }
}

interface Beans {
  readonly grams: number
}

// One-shot services are built fresh on every request and never cached —
// beans are consumed, not kept. The requester owns the instance, so one-shot
// classes cannot have @OnDispose.
@OneShot
class ArabicaBeans implements Beans {
  readonly grams = 18
}

// Each decorated class is its own token, even when implementations share an
// interface. Twice the caffeine, half the subtlety.
@OneShot
class RobustaBeans implements Beans {
  readonly grams = 16
}

// Everything the ingredients pass through is a plain value, not a service:
// values are created by the domain with `new`, never resolved from the
// container. Only the equipment and staff live in the module.
class Grounds {
  constructor(readonly grams: number) {}
}

class EspressoShot {
  constructor(readonly volumeMl: number) {}
}

class CuppaCoffee {
  constructor(readonly shot: EspressoShot) {}
}

@Singleton
class EspressoMachine {
  // A 1:2 brew ratio: 18 grams in, 36 millilitres out. The spent grounds go
  // to the knock box — only the coffee leaves the machine.
  pullShot(grounds: Grounds): EspressoShot {
    return new EspressoShot(grounds.grams * 2)
  }

  // Teardown: called on the retained instance when the module disposes.
  // Backflush the group head at closing.
  @OnDispose
  backflush() {}
}

@Singleton
class Barista {
  // Interface-typed dependency: injected by key. The key's service type is
  // checked against the field's type at compile time.
  @Inject(grinderKey)
  private readonly grinder!: Grinder

  // Class-typed dependency: EspressoMachine is its own token because it has
  // a lifecycle decorator — no ServiceKey needed.
  @Inject(EspressoMachine)
  private readonly machine!: EspressoMachine

  // Beans arrive with the order, not as an @Inject field: a singleton
  // injecting a one-shot would capture a single dose forever.
  serveEspresso(beans: Beans): CuppaCoffee {
    const grounds = this.grinder.grind(beans)
    const shot = this.machine.pullShot(grounds)
    return new CuppaCoffee(shot)
  }

  @OnDispose
  clockOut() {}
}

@Singleton
class CafeShop {
  // selectorOf groups decorated classes of a shared type under one key — the
  // menu of roasts. Injecting it yields a Selector: pick the implementation
  // per call, at runtime. Unlike the beans themselves, the selector is safe
  // in a singleton — it resolves a fresh one-shot on every call instead of
  // capturing one.
  @Inject(selectorOf<Beans>(ArabicaBeans, RobustaBeans))
  private readonly roasts!: Selector<Beans>

  @Inject(Barista)
  private readonly barista!: Barista

  async order(roast: 'arabica' | 'robusta'): Promise<CuppaCoffee> {
    const beans = await this.roasts.get(
      roast === 'arabica' ? keyOf(ArabicaBeans) : keyOf(RobustaBeans),
    )
    return this.barista.serveEspresso(beans)
  }
}

const module = ServiceModule.from([
  // Decorated classes register as themselves — lifecycle from the
  // decorators, dependencies from the @Inject fields, teardown from
  // @OnDispose: the class declaration says everything.
  ...factoriesOf(
    CafeShop,
    Barista,
    EspressoMachine,
    ArabicaBeans,
    RobustaBeans,
  ),
  // Interface-typed services are still registered with an explicit factory.
  ServiceFactory.singleton({
    provides: grinderKey,
    initialize: () => new BurrGrinder(),
  }),
])

export async function main() {
  // The shop opens lazily, on the first order — staff and equipment come up
  // with it, exactly once.
  const shop = await module.get(keyOf(CafeShop))

  // Each order picks a roast at runtime; the Selector resolves a fresh
  // one-shot dose per call, while the staff singletons stay the same.
  const single = await shop.order('arabica')
  const double = await shop.order('robusta')

  console.log(
    `arabica: ${single.shot.volumeMl}ml | robusta: ${double.shot.volumeMl}ml`,
  )
  printMermaidGraph(module)

  // Closing time: the machine backflushes, the barista clocks out, and the
  // next order opens a fresh shift.
  module.dispose()
}

void main()
