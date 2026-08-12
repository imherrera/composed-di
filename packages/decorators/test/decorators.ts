import { describe, it, expect } from 'vitest'
import { ServiceKey, ServiceModule } from '@composed-di/core'
import { Singleton, Inject } from '../src/decorators.js'
import { factoryOf } from '../src/factory.js'
import { DecoratorValidationError } from '../src/errors.js'

describe('Inject', () => {
  // Code review finding #5: `@Inject` used to park its field in a global
  // pending buffer that the NEXT lifecycle-decorated class drained,
  // regardless of whether that field was actually declared on it. A class
  // left undecorated by mistake silently donated its fields to whichever
  // decorated class happened to be defined next. Fixed by parking records
  // on the class definition's own decorator metadata, which no other class
  // can reach. The next two cases pin the fix.
  it('does not donate a field of a class missing its lifecycle decorator to the next decorated class', () => {
    const fooKey = new ServiceKey<string>('Foo')

    class Undecorated {
      @Inject(fooKey)
      private readonly foo!: string

      read(): string {
        return this.foo
      }
    }
    void Undecorated // never gets @Singleton/@Transient -- the actual bug

    @Singleton
    class Real {}

    const factory = factoryOf(Real)
    // Real declared no @Inject fields of its own, so it must depend on
    // nothing -- not on Foo, which belongs to Undecorated.
    expect(factory.dependsOn).toEqual([])
  })

  it('does not make ServiceModule.from demand a provider for a graph that never needed it', () => {
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

  it('rejects two fields injecting the same @Singleton class', () => {
    @Singleton
    class Grinder {}

    const defineBarista = () => {
      @Singleton
      class Barista {
        @Inject(Grinder)
        readonly primary!: Grinder

        @Inject(Grinder)
        readonly backup!: Grinder
      }
      void Barista
    }

    expect(defineBarista).toThrow(DecoratorValidationError)
    expect(defineBarista).toThrow(/\[primary, backup\] inject the same/)
  })

  // Code review finding #1: static properties inherit through the
  // constructor's prototype chain, so an undecorated subclass resolves its
  // parent's stamped SERVICE_KEY by ordinary lookup. `@Inject` must reject
  // the subclass token instead of silently injecting the parent.
  it('rejects an undecorated subclass token instead of silently injecting the parent', () => {
    @Singleton
    class Real {}

    class Sub extends Real {}

    expect(() => {
      class Consumer {
        @Inject(Sub)
        readonly dep!: InstanceType<typeof Sub>
      }
      void Consumer
    }).toThrow(DecoratorValidationError)
  })
})
