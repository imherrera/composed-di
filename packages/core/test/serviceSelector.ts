import { describe, it, expect } from 'vitest'
import { ServiceKey, SelectorKey } from '../src/serviceKey'
import { ServiceFactory } from '../src/serviceFactory'
import { ServiceModule } from '../src/serviceModule'
import { Selector } from '../src/serviceSelector'
import { ModuleValidationError } from '../src'

interface Logger {
  type: string
  log: (msg: string) => void
}

interface ConsoleLogger extends Logger {
  type: 'console'
}

interface FileLogger extends Logger {
  type: 'file'
}

// Create service keys for different logger implementations
const consoleLoggerKey = new ServiceKey<ConsoleLogger>('ConsoleLogger')
const fileLoggerKey = new ServiceKey<FileLogger>('FileLogger')

// Create a SelectorKey that groups both logger keys
const loggerSelectorKey = new SelectorKey<Logger>([
  consoleLoggerKey,
  fileLoggerKey,
])

// Create factories for the logger implementations
const consoleLoggerFactory = ServiceFactory.singleton({
  provides: consoleLoggerKey,
  dependsOn: [],
  initialize: (): ConsoleLogger => ({
    type: 'console',
    log: (msg: string) => console.log(`[Console] ${msg}`),
  }),
})

const fileLoggerFactory = ServiceFactory.singleton({
  provides: fileLoggerKey,
  dependsOn: [],
  initialize: (): FileLogger => ({
    type: 'file',
    log: (msg: string) => console.log(`[File] ${msg}`),
  }),
})

// Service that depends on the LoggerSelectorKey
interface App {
  useLogger: (key: ServiceKey<Logger>) => Promise<void>
  getLogger: (key: ServiceKey<Logger>) => Promise<Logger>
}

const appKey = new ServiceKey<App>('App')

const appFactory = ServiceFactory.singleton({
  provides: appKey,
  dependsOn: [loggerSelectorKey],
  initialize: (loggerSelector): App => {
    return {
      useLogger: async (key: ServiceKey<Logger>) => {
        const logger = await loggerSelector.get(key)
        logger.log('Hello from App!')
      },
      getLogger: async (key: ServiceKey<Logger>) => {
        return await loggerSelector.get(key)
      },
    }
  },
})

describe('SelectorKey Implementation', () => {
  it('should create ServiceModule with SelectorKey dependency', () => {
    const module = ServiceModule.from([
      consoleLoggerFactory,
      fileLoggerFactory,
      appFactory,
    ])
    expect(module).toBeDefined()
  })

  it('should resolve App service with Selector dependency', async () => {
    const module = ServiceModule.from([
      consoleLoggerFactory,
      fileLoggerFactory,
      appFactory,
    ])
    const app = await module.get(appKey)
    expect(app).toBeDefined()
    expect(app.useLogger).toBeDefined()
    expect(app.getLogger).toBeDefined()
  })

  it('should use Selector to get ConsoleLogger', async () => {
    const module = ServiceModule.from([
      consoleLoggerFactory,
      fileLoggerFactory,
      appFactory,
    ])
    const app = await module.get(appKey)
    const logger = await app.getLogger(consoleLoggerKey)
    expect(logger).toBeDefined()
    expect(logger.type).toBe('console')
  })

  it('should use Selector to get FileLogger', async () => {
    const module = ServiceModule.from([
      consoleLoggerFactory,
      fileLoggerFactory,
      appFactory,
    ])
    const app = await module.get(appKey)
    const logger = await app.getLogger(fileLoggerKey)
    expect(logger).toBeDefined()
    expect(logger.type).toBe('file')
  })

  it('should detect missing dependency for SelectorKey', () => {
    const missingLoggerKey = new ServiceKey<Logger>('MissingLogger')
    const selectorWithMissing = new SelectorKey<Logger>([
      consoleLoggerKey,
      missingLoggerKey,
    ])

    const appWithMissingFactory = ServiceFactory.singleton({
      provides: new ServiceKey<App>('AppWithMissing'),
      dependsOn: [selectorWithMissing],
      initialize: (_selector: Selector<Logger>): App => ({
        useLogger: async () => {},
        getLogger: async () => ({ type: '', log: () => {} }),
      }),
    })

    expect(() => {
      ServiceModule.from([consoleLoggerFactory, appWithMissingFactory])
    }).toThrow(ModuleValidationError)
  })
})
