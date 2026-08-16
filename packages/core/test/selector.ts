import { describe, it, expect } from 'vitest'
import {
    NoSuchKeyError,
    type Selector,
    SelectorKey,
    ServiceFactory,
    ServiceKey,
    ServiceModule,
} from '../src/index.js'

describe('Selector', () => {
    describe('get', () => {
        it('Should throw an error when requested a key it does not group', async () => {
            const k1 = new ServiceKey<string>('k1')
            const f1 = ServiceFactory.transient({
                provides: k1,
                initialize: () => 'v1',
            })
            const k2 = new ServiceKey<string>('k2')
            const f2 = ServiceFactory.transient({
                provides: k2,
                initialize: () => 'v2',
            })
            const k3 = new ServiceKey<string>('k3')
            const f3 = ServiceFactory.transient({
                provides: k3,
                initialize: () => 'v3',
            })

            // A selector is built for the factory that declares it, so the only way to
            // get hold of one is to have that factory hand it back
            const passthroughKey = new ServiceKey<Selector<string>>(
                'Passthrough',
            )
            const passthrough = ServiceFactory.transient({
                provides: passthroughKey,
                dependsOn: [new SelectorKey([k1, k2])],
                initialize: (selector) => selector,
            })

            const m = ServiceModule.from([f1, f2, f3, passthrough])
            const selector = await m.get(passthroughKey)

            expect(() => selector.get(k3)).toThrow(NoSuchKeyError)
        })
    })
})
