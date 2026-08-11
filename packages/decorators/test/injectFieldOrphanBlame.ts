import { describe, it, expect } from 'vitest'
import { ServiceKey, ServiceModule } from '@composed-di/core'
import { Singleton, Inject } from '../src/decorators.js'
import { factoryOf } from '../src/factory.js'

// Code review finding #5: `@Inject` parks its field in a pending buffer that
// the NEXT lifecycle-decorated class drains, regardless of whether that
// field was actually declared on it. A class left undecorated by mistake
// silently donates its fields to whichever decorated class happens to be
// defined next.
//
// These assert the CORRECT behavior -- Real never declared @Inject(fooKey),
// so it must not end up depending on it -- and therefore fail until that's
// fixed. (They are not currently expected to pass; they exist to prove the
// bug and go green once it's addressed.)
describe('an @Inject field on a class missing its lifecycle decorator', () => {
  it('must not be absorbed into the next decorated class as one of its dependencies', () => {
    const fooKey = new ServiceKey<string>('Foo')

    class Undecorated {
      @Inject(fooKey)
      private readonly foo!: string

      read(): string {
        return this.foo
      }
    }
    void Undecorated // never gets @Singleton/@OneShot -- the actual bug

    @Singleton
    class Real {}

    const factory = factoryOf(Real)
    // Real declared no @Inject fields of its own, so it must depend on
    // nothing -- not on Foo, which belongs to Undecorated.
    expect(factory.dependsOn).toEqual([])
  })

  it('must not make ServiceModule.from demand a provider for a graph that never needed it', () => {
    const fooKey = new ServiceKey<string>('Foo')

    class Undecorated {
      @Inject(fooKey)
      private readonly foo!: string

      read(): string {
        return this.foo
      }
    }
    void Undecorated

    @Singleton
    class Real {}

    // Real has no real dependencies, so composing a module with just Real
    // must succeed without providing a Foo factory.
    expect(() => ServiceModule.from([factoryOf(Real)])).not.toThrow()
  })
})
