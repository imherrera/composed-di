import { describe, it, expect, vi } from 'vitest';
import { ServiceModule } from '../src/serviceModule';
import { ServiceKey, ServiceSelectorKey } from '../src/serviceKey';
import { ServiceFactory } from '../src/serviceFactory';
import { ServiceScope } from '../src/serviceScope';
import {
  ServiceFactoryNotFoundError,
  ServiceModuleInitError,
} from '../src/errors';

describe('ServiceModule', () => {
  describe('from', () => {
    it('should create a module from a list of factories', () => {
      const Key1 = new ServiceKey<string>('Key1');
      const factory1 = ServiceFactory.oneShot({
        provides: Key1,
        dependsOn: [],
        initialize: () => 'value1',
      });

      const module = ServiceModule.from([factory1]);
      expect(module).toBeInstanceOf(ServiceModule);
      expect(module.factories).toContain(factory1);
    });

    it('should create a module from other modules', () => {
      const Key1 = new ServiceKey<string>('Key1');
      const factory1 = ServiceFactory.oneShot({
        provides: Key1,
        dependsOn: [],
        initialize: () => 'value1',
      });
      const module1 = ServiceModule.from([factory1]);

      const Key2 = new ServiceKey<string>('Key2');
      const factory2 = ServiceFactory.oneShot({
        provides: Key2,
        dependsOn: [],
        initialize: () => 'value2',
      });

      const combinedModule = ServiceModule.from([module1, factory2]);
      expect(combinedModule.factories).toHaveLength(2);
      expect(combinedModule.factories).toContain(factory1);
      expect(combinedModule.factories).toContain(factory2);
    });

    it('should implement last-wins deduplication', async () => {
      const Key1 = new ServiceKey<string>('Key1');
      const factory1a = ServiceFactory.oneShot({
        provides: Key1,
        dependsOn: [],
        initialize: () => 'value1a',
      });
      const factory1b = ServiceFactory.oneShot({
        provides: Key1,
        dependsOn: [],
        initialize: () => 'value1b',
      });

      const module = ServiceModule.from([factory1a, factory1b]);
      expect(module.factories).toHaveLength(1);
      expect(module.factories[0]).toBe(factory1b);
      expect(await module.get(Key1)).toBe('value1b');
    });

    it('should throw error on recursive dependencies', () => {
      const Key1 = new ServiceKey<string>('Key1');
      const factory1 = ServiceFactory.oneShot({
        provides: Key1,
        dependsOn: [Key1],
        initialize: () => 'value1',
      });

      expect(() => ServiceModule.from([factory1])).toThrow(
        'Circular dependency detected: Key1 -> Key1',
      );
    });

    it('should throw error on missing dependencies', () => {
      const Key1 = new ServiceKey<string>('Key1');
      const Key2 = new ServiceKey<string>('Key2');
      const factory1 = ServiceFactory.oneShot({
        provides: Key1,
        dependsOn: [Key2],
        initialize: () => 'value1',
      });

      expect(() => ServiceModule.from([factory1])).toThrow(
        'Key1 will fail because it depends on:\n  -> Key2',
      );
    });

    it('should throw error on missing dependencies in ServiceSelectorKey', () => {
      const Key1 = new ServiceKey<string>('Key1');
      const Key2 = new ServiceKey<string>('Key2');
      const SelectorKey = new ServiceSelectorKey<string>([Key2]);
      
      const factory1 = ServiceFactory.oneShot({
        provides: Key1,
        dependsOn: [SelectorKey],
        initialize: () => 'value1',
      });

      expect(() => ServiceModule.from([factory1])).toThrow(
        'Key1 will fail because it depends on:\n  -> Key2',
      );
    });

    it('should detect circular dependencies deeper than 1 level during creation', () => {
      const Key1 = new ServiceKey<string>('Key1');
      const Key2 = new ServiceKey<string>('Key2');
      
      const factory1 = ServiceFactory.oneShot({
        provides: Key1,
        dependsOn: [Key2],
        initialize: () => 'value1',
      });
      
      const factory2 = ServiceFactory.oneShot({
        provides: Key2,
        dependsOn: [Key1],
        initialize: () => 'value2',
      });

      expect(() => ServiceModule.from([factory1, factory2])).toThrow(
        'Circular dependency detected: Key1 -> Key2 -> Key1',
      );
    });

    it('should detect deep circular dependencies (3+ levels)', () => {
      const Key1 = new ServiceKey<string>('Key1');
      const Key2 = new ServiceKey<string>('Key2');
      const Key3 = new ServiceKey<string>('Key3');
      
      const f1 = ServiceFactory.oneShot({ provides: Key1, dependsOn: [Key2], initialize: () => '' });
      const f2 = ServiceFactory.oneShot({ provides: Key2, dependsOn: [Key3], initialize: () => '' });
      const f3 = ServiceFactory.oneShot({ provides: Key3, dependsOn: [Key1], initialize: () => '' });

      expect(() => ServiceModule.from([f1, f2, f3])).toThrow(
        'Circular dependency detected: Key1 -> Key2 -> Key3 -> Key1',
      );
    });

    it('should detect circular dependencies involving ServiceSelectorKey', () => {
      const Key1 = new ServiceKey<string>('Key1');
      const Key2 = new ServiceKey<string>('Key2');
      const SelectorKey = new ServiceSelectorKey<string>([Key2]);
      
      const factory1 = ServiceFactory.oneShot({
        provides: Key1,
        dependsOn: [SelectorKey],
        initialize: () => 'value1',
      });
      
      const factory2 = ServiceFactory.oneShot({
        provides: Key2,
        dependsOn: [Key1],
        initialize: () => 'value2',
      });

      expect(() => ServiceModule.from([factory1, factory2])).toThrow(
        'Circular dependency detected: Key1 -> Key2 -> Key1',
      );
    });
  });

  describe('get', () => {
    it('should resolve a simple service', async () => {
      const Key1 = new ServiceKey<string>('Key1');
      const factory1 = ServiceFactory.oneShot({
        provides: Key1,
        dependsOn: [],
        initialize: () => 'value1',
      });

      const module = ServiceModule.from([factory1]);
      const value = await module.get(Key1);
      expect(value).toBe('value1');
    });

    it('should resolve a service with dependencies', async () => {
      const Key1 = new ServiceKey<string>('Key1');
      const Key2 = new ServiceKey<string>('Key2');
      
      const factory1 = ServiceFactory.oneShot({
        provides: Key1,
        dependsOn: [],
        initialize: () => 'value1',
      });
      
      const factory2 = ServiceFactory.oneShot({
        provides: Key2,
        dependsOn: [Key1],
        initialize: (val1) => `value2-${val1}`,
      });

      const module = ServiceModule.from([factory1, factory2]);
      const value = await module.get(Key2);
      expect(value).toBe('value2-value1');
    });

    it('should resolve deep dependencies', async () => {
      const Key1 = new ServiceKey<string>('Key1');
      const Key2 = new ServiceKey<string>('Key2');
      const Key3 = new ServiceKey<string>('Key3');
      
      const factory1 = ServiceFactory.oneShot({
        provides: Key1,
        dependsOn: [],
        initialize: () => '1',
      });
      
      const factory2 = ServiceFactory.oneShot({
        provides: Key2,
        dependsOn: [Key1],
        initialize: (v1) => `2-${v1}`,
      });

      const factory3 = ServiceFactory.oneShot({
        provides: Key3,
        dependsOn: [Key2],
        initialize: (v2) => `3-${v2}`,
      });

      const module = ServiceModule.from([factory1, factory2, factory3]);
      expect(await module.get(Key3)).toBe('3-2-1');
    });

    it('should throw error when factory is not found', async () => {
      const Key1 = new ServiceKey<string>('Key1');
      const module = ServiceModule.from([]);
      
      await expect(module.get(Key1)).rejects.toThrow(ServiceFactoryNotFoundError);
    });

    it('should respect singleton scope', async () => {
      const Key1 = new ServiceKey<{ id: number }>('Key1');
      let counter = 0;
      const factory1 = ServiceFactory.singleton({
        provides: Key1,
        dependsOn: [],
        initialize: () => ({ id: ++counter }),
      });

      const module = ServiceModule.from([factory1]);
      const val1 = await module.get(Key1);
      const val2 = await module.get(Key1);
      
      expect(val1).toBe(val2);
      expect(val1.id).toBe(1);
      expect(counter).toBe(1);
    });

    it('should respect oneShot scope', async () => {
      const Key1 = new ServiceKey<{ id: number }>('Key1');
      let counter = 0;
      const factory1 = ServiceFactory.oneShot({
        provides: Key1,
        dependsOn: [],
        initialize: () => ({ id: ++counter }),
      });

      const module = ServiceModule.from([factory1]);
      const val1 = await module.get(Key1);
      const val2 = await module.get(Key1);
      
      expect(val1).not.toBe(val2);
      expect(val1.id).toBe(1);
      expect(val2.id).toBe(2);
      expect(counter).toBe(2);
    });

    it('should resolve ServiceSelectorKey', async () => {
      const Key1 = new ServiceKey<string>('Key1');
      const Key2 = new ServiceKey<string>('Key2');
      const SelectorKey = new ServiceSelectorKey<string>([Key1, Key2]);
      
      const factory1 = ServiceFactory.oneShot({
        provides: Key1,
        dependsOn: [],
        initialize: () => 'value1',
      });
      const factory2 = ServiceFactory.oneShot({
        provides: Key2,
        dependsOn: [],
        initialize: () => 'value2',
      });
      
      const factoryApp = ServiceFactory.oneShot({
        provides: new ServiceKey<string>('App'),
        dependsOn: [SelectorKey],
        initialize: async (selector) => {
          const v1 = await selector.get(Key1);
          const v2 = await selector.get(Key2);
          return `${v1}+${v2}`;
        },
      });

      const module = ServiceModule.from([factory1, factory2, factoryApp]);
      expect(await module.get(factoryApp.provides)).toBe('value1+value2');
    });

    it('should handle errors in factory initialization', async () => {
      const Key1 = new ServiceKey<string>('Key1');
      const factory1 = ServiceFactory.oneShot({
        provides: Key1,
        dependsOn: [],
        initialize: () => {
          throw new Error('Init error');
        },
      });

      const module = ServiceModule.from([factory1]);
      await expect(module.get(Key1)).rejects.toThrow('Init error');
    });

    it('should handle concurrent requests for the same singleton', async () => {
      const Key1 = new ServiceKey<string>('Key1');
      let initCount = 0;
      const factory1 = ServiceFactory.singleton({
        provides: Key1,
        dependsOn: [],
        initialize: async () => {
          await new Promise((resolve) => setTimeout(resolve, 10));
          initCount++;
          return 'value1';
        },
      });

      const module = ServiceModule.from([factory1]);
      const [val1, val2] = await Promise.all([
        module.get(Key1),
        module.get(Key1),
      ]);

      expect(val1).toBe('value1');
      expect(val2).toBe('value1');
      expect(initCount).toBe(1);
    });
  });

  describe('dispose', () => {
    it('should call dispose on all factories when no scope is provided', async () => {
      const Key1 = new ServiceKey<string>('Key1');
      const dispose1 = vi.fn();
      const factory1 = ServiceFactory.singleton({
        provides: Key1,
        dependsOn: [],
        initialize: () => 'value1',
        dispose: dispose1,
      });

      const Key2 = new ServiceKey<string>('Key2');
      const dispose2 = vi.fn();
      const factory2 = ServiceFactory.singleton({
        provides: Key2,
        dependsOn: [],
        initialize: () => 'value2',
        dispose: dispose2,
      });

      const module = ServiceModule.from([factory1, factory2]);
      
      // Initialize them
      await module.get(Key1);
      await module.get(Key2);
      
      module.dispose();
      
      expect(dispose1).toHaveBeenCalled();
      expect(dispose2).toHaveBeenCalled();
    });

    it('should call dispose only on factories in the specified scope', async () => {
      const Scope1 = { name: 'Scope1' } as ServiceScope;
      const Scope2 = { name: 'Scope2' } as ServiceScope;
      
      const Key1 = new ServiceKey<string>('Key1');
      const dispose1 = vi.fn();
      const factory1 = ServiceFactory.singleton({
        scope: Scope1,
        provides: Key1,
        dependsOn: [],
        initialize: () => 'value1',
        dispose: dispose1,
      });

      const Key2 = new ServiceKey<string>('Key2');
      const dispose2 = vi.fn();
      const factory2 = ServiceFactory.singleton({
        scope: Scope2,
        provides: Key2,
        dependsOn: [],
        initialize: () => 'value2',
        dispose: dispose2,
      });

      const module = ServiceModule.from([factory1, factory2]);
      
      await module.get(Key1);
      await module.get(Key2);
      
      module.dispose(Scope1);
      
      expect(dispose1).toHaveBeenCalled();
      expect(dispose2).not.toHaveBeenCalled();
    });
    
    it('should not fail if factory has no dispose method', () => {
      const Key1 = new ServiceKey<string>('Key1');
      const factory1 = ServiceFactory.oneShot({
        provides: Key1,
        dependsOn: [],
        initialize: () => 'value1',
      });

      const module = ServiceModule.from([factory1]);
      expect(() => module.dispose()).not.toThrow();
    });
  });
});
