import { describe, it, expect, vi } from 'vitest'
import { ServiceModule } from '../src/serviceModule.js'
import { ServiceKey } from '../src/serviceKey.js'
import { SelectorKey } from '../src/selectorKey.js'
import { ServiceFactory } from '../src/serviceFactory.js'
import { NoSuchFactoryError, ModuleValidationError } from '../src/errors.js'

describe('ServiceModule', () => {
    describe('from', () => {
        it('should create a module from a list of factories', () => {
            const key1 = new ServiceKey<string>('Key1')
            const factory1 = ServiceFactory.transient({
                provides: key1,
                initialize: () => 'value1',
            })

            const module = ServiceModule.from([factory1])
            expect(module).toBeInstanceOf(ServiceModule)
            expect(module.factories).toContain(factory1)
        })

        it('should create a module from other modules', () => {
            const key1 = new ServiceKey<string>('Key1')
            const factory1 = ServiceFactory.transient({
                provides: key1,
                initialize: () => 'value1',
            })
            const module1 = ServiceModule.from([factory1])

            const key2 = new ServiceKey<string>('Key2')
            const factory2 = ServiceFactory.transient({
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
            const factory1a = ServiceFactory.transient({
                provides: key1,
                initialize: () => 'value1a',
            })
            const factory1b = ServiceFactory.transient({
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
            const factory1 = ServiceFactory.transient({
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
            const factory1 = ServiceFactory.transient({
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

            const factory1 = ServiceFactory.transient({
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

            const factory1 = ServiceFactory.transient({
                provides: key1,
                dependsOn: [key2],
                initialize: () => 'value1',
            })

            const factory2 = ServiceFactory.transient({
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

            const f1 = ServiceFactory.transient({
                provides: key1,
                dependsOn: [key2],
                initialize: () => '',
            })
            const f2 = ServiceFactory.transient({
                provides: key2,
                dependsOn: [key3],
                initialize: () => '',
            })
            const f3 = ServiceFactory.transient({
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

            const factory1 = ServiceFactory.transient({
                provides: key1,
                dependsOn: [key2Selector],
                initialize: () => 'value1',
            })

            const factory2 = ServiceFactory.transient({
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
            const factory1 = ServiceFactory.transient({
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

            const factory1 = ServiceFactory.transient({
                provides: key1,
                initialize: () => 'value1',
            })

            const factory2 = ServiceFactory.transient({
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

            const factory1 = ServiceFactory.transient({
                provides: key1,
                initialize: () => '1',
            })

            const factory2 = ServiceFactory.transient({
                provides: key2,
                dependsOn: [key1],
                initialize: (v1) => `2-${v1}`,
            })

            const factory3 = ServiceFactory.transient({
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

            await expect(module.get(key1)).rejects.toThrow(NoSuchFactoryError)
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

        it('should respect transient scope', async () => {
            const key1 = new ServiceKey<{ id: number }>('Key1')
            let counter = 0
            const factory1 = ServiceFactory.transient({
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

        it('should not apply the warm-singleton fast path to transient factories', async () => {
            const key1 = new ServiceKey<string>('Key1')
            const key2 = new ServiceKey<{ id: number }>('Key2')

            const factory1 = ServiceFactory.transient({
                provides: key1,
                initialize: () => 'value1',
            })

            let counter = 0
            const factory2 = ServiceFactory.transient({
                provides: key2,
                dependsOn: [key1],
                initialize: () => ({ id: ++counter }),
            })

            const module = ServiceModule.from([factory1, factory2])

            // Each request must survive the fast-path check (transient factories
            // have no getInstance) and produce a fresh instance
            expect((await module.get(key2)).id).toBe(1)
            expect((await module.get(key2)).id).toBe(2)
        })

        it('should resolve SelectorKey', async () => {
            const key1 = new ServiceKey<string>('Key1')
            const key2 = new ServiceKey<string>('Key2')
            const valueSelector = new SelectorKey<string>([key1, key2])

            const factory1 = ServiceFactory.transient({
                provides: key1,
                initialize: () => 'value1',
            })
            const factory2 = ServiceFactory.transient({
                provides: key2,
                initialize: () => 'value2',
            })

            const factoryApp = ServiceFactory.transient({
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
            const factory1 = ServiceFactory.transient({
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

        it('renders the dependency chain that closes the cycle', () => {
            const userServiceKey = new ServiceKey<string>('UserService')
            const databaseKey = new ServiceKey<string>('Database')
            const configKey = new ServiceKey<string>('Config')

            const userServiceFactory = ServiceFactory.transient({
                provides: userServiceKey,
                dependsOn: [databaseKey],
                initialize: () => 'root',
            })
            const databaseFactory = ServiceFactory.transient({
                provides: databaseKey,
                dependsOn: [configKey],
                initialize: () => 'a',
            })
            const configFactory = ServiceFactory.transient({
                provides: configKey,
                dependsOn: [databaseKey],
                initialize: () => 'b',
            })

            const circularFactories = [
                userServiceFactory,
                databaseFactory,
                configFactory,
            ]

            expect(() => ServiceModule.from(circularFactories)).toThrow(
                new ModuleValidationError(
                    'Circular dependency detected:\n' +
                        '    "UserService" factory depends on "Database"\n' +
                        '    "Database" factory depends on "Config"\n' +
                        '    "Config" factory depends on "Database" <- circular',
                ),
            )
        })

        it('renders one trace frame per missing dependency', () => {
            const userServiceKey = new ServiceKey<string>('UserService')
            const configKey = new ServiceKey<string>('Config')
            const databaseKey = new ServiceKey<string>('Database')
            const consoleLoggerKey = new ServiceKey<string>('ConsoleLogger')
            const fileLoggerKey = new ServiceKey<string>('FileLogger')
            const authServiceKey = new ServiceKey<string>('AuthService')
            const authConfigKey = new ServiceKey<string>('AuthConfig')
            const loggerSelectorKey = new SelectorKey<string>([
                consoleLoggerKey,
                fileLoggerKey,
            ])

            const configFactory = ServiceFactory.transient({
                provides: configKey,
                initialize: () => 'config',
            })
            const consoleLoggerFactory = ServiceFactory.transient({
                provides: consoleLoggerKey,
                initialize: () => 'console',
            })
            const appFactory = ServiceFactory.transient({
                provides: userServiceKey,
                dependsOn: [configKey, databaseKey, loggerSelectorKey],
                initialize: () => 'app',
            })
            const authServiceFactory = ServiceFactory.transient({
                provides: authServiceKey,
                dependsOn: [authConfigKey],
                initialize: () => 'auth',
            })

            expect(() =>
                ServiceModule.from([
                    configFactory,
                    consoleLoggerFactory,
                    appFactory,
                    authServiceFactory,
                ]),
            ).toThrow(
                new ModuleValidationError(
                    'The "UserService" factory will fail to initialize because it depends on service keys that no factory provides:\n' +
                        '    "Database"\n' +
                        '    "FileLogger"\n' +
                        '\n' +
                        'The "AuthService" factory will fail to initialize because it depends on service keys that no factory provides:\n' +
                        '    "AuthConfig"',
                ),
            )
        })
    })

    describe('getOrNull', () => {
        it('should return service value when factory exists', async () => {
            const key1 = new ServiceKey<string>('Key1')
            const factory1 = ServiceFactory.transient({
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
            const factory1 = ServiceFactory.transient({
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
        it('should call dispose on all factories', async () => {
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

        it('should dispose factories in reverse-topological order', async () => {
            const configKey = new ServiceKey<string>('Config')
            const databaseKey = new ServiceKey<string>('Database')
            const appKey = new ServiceKey<string>('App')
            const disposalOrder: string[] = []

            const configFactory = ServiceFactory.singleton({
                provides: configKey,
                initialize: () => 'config',
                dispose: () => {
                    disposalOrder.push('Config')
                },
            })
            const databaseFactory = ServiceFactory.singleton({
                provides: databaseKey,
                dependsOn: [configKey],
                initialize: () => 'database',
                dispose: () => {
                    disposalOrder.push('Database')
                },
            })
            const appFactory = ServiceFactory.singleton({
                provides: appKey,
                dependsOn: [databaseKey],
                initialize: () => 'app',
                dispose: () => {
                    disposalOrder.push('App')
                },
            })

            // Registration order matches topological order, the opposite of the
            // order in which disposal must happen
            const module = ServiceModule.from([
                configFactory,
                databaseFactory,
                appFactory,
            ])
            await module.get(appKey)

            module.dispose()

            // Dependents must be disposed before their dependencies
            expect(disposalOrder).toEqual(['App', 'Database', 'Config'])
        })

        it('should not fail if factory has no dispose method', () => {
            const key1 = new ServiceKey<string>('Key1')
            const factory1 = ServiceFactory.transient({
                provides: key1,
                initialize: () => 'value1',
            })

            const module = ServiceModule.from([factory1])
            expect(() => module.dispose()).not.toThrow()
        })
    })
})
