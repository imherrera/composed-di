import { describe, it, expect, vi } from 'vitest'
import { ServiceModule } from '../src/serviceModule'
import { ServiceKey, SelectorKey } from '../src/serviceKey'
import { ServiceFactory } from '../src/serviceFactory'
import { ServiceScope } from '../src/serviceScope'
import {
  NoSuchFactoryError,
  ModuleValidationError,
} from '../src/errors'

describe('ServiceModule', () => {
  describe('from', () => {
    it('should create a module from a list of factories', () => {
      const key1 = new ServiceKey<string>('Key1')
      const factory1 = ServiceFactory.oneShot({
        provides: key1,
        initialize: () => 'value1',
      })

      const module = ServiceModule.from([factory1])
      expect(module).toBeInstanceOf(ServiceModule)
      expect(module.factories).toContain(factory1)
    })

    it('should create a module from other modules', () => {
      const key1 = new ServiceKey<string>('Key1')
      const factory1 = ServiceFactory.oneShot({
        provides: key1,
        initialize: () => 'value1',
      })
      const module1 = ServiceModule.from([factory1])

      const key2 = new ServiceKey<string>('Key2')
      const factory2 = ServiceFactory.oneShot({
        provides: key2,
        initialize: () => 'value2',
      })

      const combinedModule = ServiceModule.from([module1, factory2])
      expect(combinedModule.factories).toHaveLength(2)
      expect(combinedModule.factories).toContain(factory1)
      expect(combinedModule.factories).toContain(factory2)
    })

    it('should implement last-wins deduplication', async () => {
      const key1 = new ServiceKey<string>('Key1')
      const factory1a = ServiceFactory.oneShot({
        provides: key1,
        initialize: () => 'value1a',
      })
      const factory1b = ServiceFactory.oneShot({
        provides: key1,
        initialize: () => 'value1b',
      })

      const module = ServiceModule.from([factory1a, factory1b])
      expect(module.factories).toHaveLength(1)
      expect(module.factories[0]).toBe(factory1b)
      expect(await module.get(key1)).toBe('value1b')
    })

    it('should throw error on recursive dependencies', () => {
      const key1 = new ServiceKey<string>('Key1')
      const factory1 = ServiceFactory.oneShot({
        provides: key1,
        dependsOn: [key1],
        initialize: () => 'value1',
      })

      expect(() => ServiceModule.from([factory1])).toThrow(
        ModuleValidationError,
      )
    })

    it('should throw error on missing dependencies', () => {
      const key1 = new ServiceKey<string>('Key1')
      const key2 = new ServiceKey<string>('Key2')
      const factory1 = ServiceFactory.oneShot({
        provides: key1,
        dependsOn: [key2],
        initialize: () => 'value1',
      })

      expect(() => ServiceModule.from([factory1])).toThrow(
        ModuleValidationError,
      )
    })

    it('should throw error on missing dependencies in SelectorKey', () => {
      const key1 = new ServiceKey<string>('Key1')
      const key2 = new ServiceKey<string>('Key2')
      const key2Selector = new SelectorKey<string>([key2])

      const factory1 = ServiceFactory.oneShot({
        provides: key1,
        dependsOn: [key2Selector],
        initialize: () => 'value1',
      })

      expect(() => ServiceModule.from([factory1])).toThrow(
        ModuleValidationError,
      )
    })

    it('should detect circular dependencies deeper than 1 level during creation', () => {
      const key1 = new ServiceKey<string>('Key1')
      const key2 = new ServiceKey<string>('Key2')

      const factory1 = ServiceFactory.oneShot({
        provides: key1,
        dependsOn: [key2],
        initialize: () => 'value1',
      })

      const factory2 = ServiceFactory.oneShot({
        provides: key2,
        dependsOn: [key1],
        initialize: () => 'value2',
      })

      expect(() => ServiceModule.from([factory1, factory2])).toThrow(
        ModuleValidationError,
      )
    })

    it('should detect deep circular dependencies (3+ levels)', () => {
      const key1 = new ServiceKey<string>('Key1')
      const key2 = new ServiceKey<string>('Key2')
      const key3 = new ServiceKey<string>('Key3')

      const f1 = ServiceFactory.oneShot({
        provides: key1,
        dependsOn: [key2],
        initialize: () => '',
      })
      const f2 = ServiceFactory.oneShot({
        provides: key2,
        dependsOn: [key3],
        initialize: () => '',
      })
      const f3 = ServiceFactory.oneShot({
        provides: key3,
        dependsOn: [key1],
        initialize: () => '',
      })

      expect(() => ServiceModule.from([f1, f2, f3])).toThrow(
        ModuleValidationError,
      )
    })

    it('should detect circular dependencies involving SelectorKey', () => {
      const key1 = new ServiceKey<string>('Key1')
      const key2 = new ServiceKey<string>('Key2')
      const key2Selector = new SelectorKey<string>([key2])

      const factory1 = ServiceFactory.oneShot({
        provides: key1,
        dependsOn: [key2Selector],
        initialize: () => 'value1',
      })

      const factory2 = ServiceFactory.oneShot({
        provides: key2,
        dependsOn: [key1],
        initialize: () => 'value2',
      })

      expect(() => ServiceModule.from([factory1, factory2])).toThrow(
        ModuleValidationError,
      )
    })
  })

  describe('get', () => {
    it('should resolve a simple service', async () => {
      const key1 = new ServiceKey<string>('Key1')
      const factory1 = ServiceFactory.oneShot({
        provides: key1,
        initialize: () => 'value1',
      })

      const module = ServiceModule.from([factory1])
      const value = await module.get(key1)
      expect(value).toBe('value1')
    })

    it('should resolve a service with dependencies', async () => {
      const key1 = new ServiceKey<string>('Key1')
      const key2 = new ServiceKey<string>('Key2')

      const factory1 = ServiceFactory.oneShot({
        provides: key1,
        initialize: () => 'value1',
      })

      const factory2 = ServiceFactory.oneShot({
        provides: key2,
        dependsOn: [key1],
        initialize: (val1) => `value2-${val1}`,
      })

      const module = ServiceModule.from([factory1, factory2])
      const value = await module.get(key2)
      expect(value).toBe('value2-value1')
    })

    it('should resolve deep dependencies', async () => {
      const key1 = new ServiceKey<string>('Key1')
      const key2 = new ServiceKey<string>('Key2')
      const key3 = new ServiceKey<string>('Key3')

      const factory1 = ServiceFactory.oneShot({
        provides: key1,
        initialize: () => '1',
      })

      const factory2 = ServiceFactory.oneShot({
        provides: key2,
        dependsOn: [key1],
        initialize: (v1) => `2-${v1}`,
      })

      const factory3 = ServiceFactory.oneShot({
        provides: key3,
        dependsOn: [key2],
        initialize: (v2) => `3-${v2}`,
      })

      const module = ServiceModule.from([factory1, factory2, factory3])
      expect(await module.get(key3)).toBe('3-2-1')
    })

    it('should throw error when factory is not found', async () => {
      const key1 = new ServiceKey<string>('Key1')
      const module = ServiceModule.from([])

      await expect(module.get(key1)).rejects.toThrow(
        NoSuchFactoryError,
      )
    })

    it('should respect singleton scope', async () => {
      const key1 = new ServiceKey<{ id: number }>('Key1')
      let counter = 0
      const factory1 = ServiceFactory.singleton({
        provides: key1,
        initialize: () => ({ id: ++counter }),
      })

      const module = ServiceModule.from([factory1])
      const val1 = await module.get(key1)
      const val2 = await module.get(key1)

      expect(val1).toBe(val2)
      expect(val1.id).toBe(1)
      expect(counter).toBe(1)
    })

    it('should respect oneShot scope', async () => {
      const key1 = new ServiceKey<{ id: number }>('Key1')
      let counter = 0
      const factory1 = ServiceFactory.oneShot({
        provides: key1,
        initialize: () => ({ id: ++counter }),
      })

      const module = ServiceModule.from([factory1])
      const val1 = await module.get(key1)
      const val2 = await module.get(key1)

      expect(val1).not.toBe(val2)
      expect(val1.id).toBe(1)
      expect(val2.id).toBe(2)
      expect(counter).toBe(2)
    })

    it('should resolve SelectorKey', async () => {
      const key1 = new ServiceKey<string>('Key1')
      const key2 = new ServiceKey<string>('Key2')
      const valueSelector = new SelectorKey<string>([key1, key2])

      const factory1 = ServiceFactory.oneShot({
        provides: key1,
        initialize: () => 'value1',
      })
      const factory2 = ServiceFactory.oneShot({
        provides: key2,
        initialize: () => 'value2',
      })

      const factoryApp = ServiceFactory.oneShot({
        provides: new ServiceKey<string>('App'),
        dependsOn: [valueSelector],
        initialize: async (selector) => {
          const v1 = await selector.get(key1)
          const v2 = await selector.get(key2)
          return `${v1}+${v2}`
        },
      })

      const module = ServiceModule.from([factory1, factory2, factoryApp])
      expect(await module.get(factoryApp.provides)).toBe('value1+value2')
    })

    it('should handle errors in factory initialization', async () => {
      const key1 = new ServiceKey<string>('Key1')
      const factory1 = ServiceFactory.oneShot({
        provides: key1,
        initialize: () => {
          throw new Error('Init error')
        },
      })

      const module = ServiceModule.from([factory1])
      await expect(module.get(key1)).rejects.toThrow('Init error')
    })

    it('should handle concurrent requests for the same singleton', async () => {
      const key1 = new ServiceKey<string>('Key1')
      let initCount = 0
      const factory1 = ServiceFactory.singleton({
        provides: key1,
        initialize: async () => {
          await new Promise((resolve) => setTimeout(resolve, 10))
          initCount++
          return 'value1'
        },
      })

      const module = ServiceModule.from([factory1])
      const [val1, val2] = await Promise.all([
        module.get(key1),
        module.get(key1),
      ])

      expect(val1).toBe('value1')
      expect(val2).toBe('value1')
      expect(initCount).toBe(1)
    })
  })

  describe('getOrNull', () => {
    it('should return service value when factory exists', async () => {
      const key1 = new ServiceKey<string>('Key1')
      const factory1 = ServiceFactory.oneShot({
        provides: key1,
        initialize: () => 'value1',
      })

      const module = ServiceModule.from([factory1])
      const value = await module.getOrNull(key1)
      expect(value).toBe('value1')
    })

    it('should return null when factory is not found', async () => {
      const key1 = new ServiceKey<string>('Key1')
      const module = ServiceModule.from([])

      const value = await module.getOrNull(key1)
      expect(value).toBeNull()
    })

    it('should re-throw errors other than NoSuchFactoryError', async () => {
      const key1 = new ServiceKey<string>('Key1')
      const factory1 = ServiceFactory.oneShot({
        provides: key1,
        initialize: () => {
          throw new Error('Init error')
        },
      })

      const module = ServiceModule.from([factory1])
      await expect(module.getOrNull(key1)).rejects.toThrow('Init error')
    })
  })

  describe('dispose', () => {
    it('should call dispose on all factories when no scope is provided', async () => {
      const key1 = new ServiceKey<string>('Key1')
      const dispose1 = vi.fn<(instance: string) => void>()
      const factory1 = ServiceFactory.singleton({
        provides: key1,
        initialize: () => 'value1',
        dispose: dispose1,
      })

      const key2 = new ServiceKey<string>('Key2')
      const dispose2 = vi.fn<(instance: string) => void>()
      const factory2 = ServiceFactory.singleton({
        provides: key2,
        initialize: () => 'value2',
        dispose: dispose2,
      })

      const module = ServiceModule.from([factory1, factory2])

      // Initialize them
      await module.get(key1)
      await module.get(key2)

      module.dispose()

      expect(dispose1).toHaveBeenCalled()
      expect(dispose2).toHaveBeenCalled()
    })

    it('should call dispose only on factories in the specified scope', async () => {
      const scope1 = { name: 'Scope1' } as ServiceScope
      const scope2 = { name: 'Scope2' } as ServiceScope

      const key1 = new ServiceKey<string>('Key1')
      const dispose1 = vi.fn<(instance: string) => void>()
      const factory1 = ServiceFactory.singleton({
        scope: scope1,
        provides: key1,
        initialize: () => 'value1',
        dispose: dispose1,
      })

      const key2 = new ServiceKey<string>('Key2')
      const dispose2 = vi.fn<(instance: string) => void>()
      const factory2 = ServiceFactory.singleton({
        scope: scope2,
        provides: key2,
        initialize: () => 'value2',
        dispose: dispose2,
      })

      const module = ServiceModule.from([factory1, factory2])

      await module.get(key1)
      await module.get(key2)

      module.dispose(scope1)

      expect(dispose1).toHaveBeenCalled()
      expect(dispose2).not.toHaveBeenCalled()
    })

    it('should not fail if factory has no dispose method', () => {
      const key1 = new ServiceKey<string>('Key1')
      const factory1 = ServiceFactory.oneShot({
        provides: key1,
        initialize: () => 'value1',
      })

      const module = ServiceModule.from([factory1])
      expect(() => module.dispose()).not.toThrow()
    })
  })
})
