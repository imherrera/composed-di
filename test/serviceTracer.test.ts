import { describe, it, expect } from 'vitest';
import { ServiceModule } from '../src/serviceModule';
import { ServiceKey } from '../src/serviceKey';
import { ServiceFactory } from '../src/serviceFactory';
import { ServiceScope } from '../src/serviceScope';
import { ServiceTracer } from '../src/serviceTracer';

// Records every span name so tests can assert on what was traced.
const makeTracer = (calls: string[]): ServiceTracer => ({
  trace<T>(fnName: string, fn: () => T): T {
    calls.push(fnName);
    return fn();
  },
});

// Tests marked `it.fails` document known open issues: they assert the
// desired behavior and currently fail. When an issue is fixed, vitest
// reports the test as "expected to fail but passed" — remove the `.fails`
// modifier to turn it into a regression test.
describe('ServiceTracer', () => {
  describe('resolution through a traced module', () => {
    it('should resolve the service instance, not undefined', async () => {
      const Key = new ServiceKey<{ greet(): string }>('svc');
      const factory = ServiceFactory.singleton({
        provides: Key,
        initialize: () => ({ greet: () => 'hi' }),
      });
      const module = ServiceModule.from([factory], makeTracer([]));

      const svc = await module.get(Key);
      expect(svc).toBeDefined();
      expect(svc.greet()).toBe('hi');
    });

    it('should record a qualified span for initialization', async () => {
      const Key = new ServiceKey<{ greet(): string }>('svc');
      const factory = ServiceFactory.singleton({
        provides: Key,
        initialize: () => ({ greet: () => 'hi' }),
      });
      const calls: string[] = [];
      const module = ServiceModule.from([factory], makeTracer(calls));

      await module.get(Key);
      expect(calls).toContain('svc.initialize');
    });

    it('should record a span for each method call', async () => {
      const Key = new ServiceKey<{ greet(): string }>('svc');
      const factory = ServiceFactory.singleton({
        provides: Key,
        initialize: () => ({ greet: () => 'hi' }),
      });
      const calls: string[] = [];
      const module = ServiceModule.from([factory], makeTracer(calls));

      const svc = await module.get(Key);
      svc.greet();
      // Accepts both the current bare name and a future qualified name.
      expect(calls.filter((c) => c.endsWith('greet'))).toHaveLength(1);
    });

    it('should propagate return values and errors of traced methods', async () => {
      const Key = new ServiceKey<{
        ok(): number;
        boom(): never;
        later(): Promise<string>;
      }>('svc');
      const factory = ServiceFactory.singleton({
        provides: Key,
        initialize: () => ({
          ok: () => 42,
          boom: () => {
            throw new Error('boom');
          },
          later: async () => 'done',
        }),
      });
      const module = ServiceModule.from([factory], makeTracer([]));

      const svc = await module.get(Key);
      expect(svc.ok()).toBe(42);
      expect(() => svc.boom()).toThrow('boom');
      await expect(svc.later()).resolves.toBe('done');
    });

    it('should not wrap services of an untraced module', async () => {
      const instance = { greet: () => 'hi' };
      const Key = new ServiceKey<typeof instance>('svc');
      const factory = ServiceFactory.singleton({
        provides: Key,
        initialize: () => instance,
      });
      const module = ServiceModule.from([factory]);

      await expect(module.get(Key)).resolves.toBe(instance);
    });
  });

  describe('singleton semantics', () => {
    it('should preserve identity across get() calls and initialize once', async () => {
      const Key = new ServiceKey<{ id: number }>('singleton');
      let counter = 0;
      const factory = ServiceFactory.singleton({
        provides: Key,
        initialize: () => ({ id: ++counter }),
      });
      const module = ServiceModule.from([factory], makeTracer([]));

      const a = await module.get(Key);
      const b = await module.get(Key);
      expect(a).toBe(b);
      expect(a.id).toBe(1);
      expect(counter).toBe(1);
    });
  });

  describe('non-object services', () => {
    it('should pass primitive-valued services through untouched', async () => {
      const Key = new ServiceKey<string>('config');
      const factory = ServiceFactory.singleton({
        provides: Key,
        initialize: () => 'value1',
      });
      const module = ServiceModule.from([factory], makeTracer([]));

      await expect(module.get(Key)).resolves.toBe('value1');
    });
  });

  describe('disposal', () => {
    it('should dispose scoped factories through the wrapper', async () => {
      const scope = new ServiceScope('request');
      const Key = new ServiceKey<{ x: number }>('scoped');
      let disposed = false;
      const factory: ServiceFactory<{ x: number }, []> = {
        provides: Key,
        dependsOn: [],
        scope,
        initialize: () => ({ x: 1 }),
        dispose: () => {
          disposed = true;
        },
      };
      const calls: string[] = [];
      const module = ServiceModule.from([factory], makeTracer(calls));

      await module.get(Key);
      module.dispose(scope);
      expect(disposed).toBe(true);
      expect(calls).toContain('scoped.dispose');
    });

    // Untraced modules call delegate.dispose unconditionally; the traced
    // wrapper gates it behind the singleton cache, silently skipping
    // disposal of services that were never requested.
    it.fails('should dispose delegates even when the service was never resolved', async () => {
      const Key = new ServiceKey<{ x: number }>('eager');
      let disposed = false;
      const factory: ServiceFactory<{ x: number }, []> = {
        provides: Key,
        dependsOn: [],
        scope: undefined,
        initialize: () => ({ x: 1 }),
        dispose: () => {
          disposed = true;
        },
      };
      const module = ServiceModule.from([factory], makeTracer([]));

      module.dispose();
      expect(disposed).toBe(true);
    });
  });

  describe('known issues (remove .fails as each is fixed)', () => {
    // The get trap allocates a fresh closure per property access, which
    // breaks cached method references and listener deduplication.
    it.fails('should return the same function for repeated method access', async () => {
      const Key = new ServiceKey<{ foo(): number }>('svc');
      const factory = ServiceFactory.singleton({
        provides: Key,
        initialize: () => ({ foo: () => 1 }),
      });
      const module = ServiceModule.from([factory], makeTracer([]));

      const svc = await module.get(Key);
      expect(svc.foo).toBe(svc.foo);
    });

    // Methods are invoked with the raw target as receiver, so a method
    // returning `this` hands back the unwrapped instance and the rest of
    // the chain escapes tracing.
    it.fails('should keep tracing methods chained off `this`-returning methods', async () => {
      class Builder {
        parts: string[] = [];
        with(p: string): this {
          this.parts.push(p);
          return this;
        }
        build(): string {
          return this.parts.join('-');
        }
      }
      const Key = new ServiceKey<Builder>('builder');
      const factory = ServiceFactory.singleton({
        provides: Key,
        initialize: () => new Builder(),
      });
      const calls: string[] = [];
      const module = ServiceModule.from([factory], makeTracer(calls));

      const svc = await module.get(Key);
      expect(svc.with('a').build()).toBe('a');
      expect(calls.filter((c) => c.endsWith('build'))).toHaveLength(1);
    });

    // ServiceModule.from re-wraps factories of an already-traced module,
    // producing two proxy layers and duplicate spans per call.
    it.fails('should not double-trace when composing an already traced module', async () => {
      const Key = new ServiceKey<{ foo(): number }>('svc');
      const factory = ServiceFactory.singleton({
        provides: Key,
        initialize: () => ({ foo: () => 1 }),
      });
      const calls: string[] = [];
      const tracer = makeTracer(calls);
      const inner = ServiceModule.from([factory], tracer);
      const outer = ServiceModule.from([inner], tracer);

      const svc = await outer.get(Key);
      svc.foo();
      expect(calls.filter((c) => c.endsWith('foo'))).toHaveLength(1);
    });

    // Method spans are bare property names; lifecycle spans are qualified.
    // Spans from different services are indistinguishable in a trace viewer.
    it.fails('should qualify method spans with the service name', async () => {
      const Key = new ServiceKey<{ greet(): string }>('svc');
      const factory = ServiceFactory.singleton({
        provides: Key,
        initialize: () => ({ greet: () => 'hi' }),
      });
      const calls: string[] = [];
      const module = ServiceModule.from([factory], makeTracer(calls));

      const svc = await module.get(Key);
      svc.greet();
      expect(calls).toContain('svc.greet');
    });

    // makeTraceable always builds a singleton wrapper, so one-shot
    // delegates are initialized once and cached instead of per request.
    it.fails('should initialize one-shot delegates on every get()', async () => {
      const Key = new ServiceKey<{ id: number }>('oneShot');
      let counter = 0;
      const factory = ServiceFactory.oneShot({
        provides: Key,
        dependsOn: [],
        initialize: () => ({ id: ++counter }),
      });
      const module = ServiceModule.from([factory], makeTracer([]));

      await module.get(Key);
      await module.get(Key);
      expect(counter).toBe(2);
    });
  });
});
