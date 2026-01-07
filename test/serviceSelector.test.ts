import { describe, it, expect } from 'vitest';
import { ServiceKey, ServiceSelectorKey } from '../src/serviceKey';
import { ServiceFactory } from '../src/serviceFactory';
import { ServiceModule } from '../src/serviceModule';
import { ServiceSelector } from '../src/serviceSelector';

// Test: ServiceSelectorKey can be used in dependsOn array and provides ServiceSelector instance

interface Logger {
  type: string;
  log: (msg: string) => void;
}

interface ConsoleLogger extends Logger {
  type: 'console';
}

interface FileLogger extends Logger {
  type: 'file';
}

// Create service keys for different logger implementations
const ConsoleLoggerKey = new ServiceKey<ConsoleLogger>('ConsoleLogger');
const FileLoggerKey = new ServiceKey<FileLogger>('FileLogger');

// Create a ServiceSelectorKey that groups both logger keys
const LoggerSelectorKey = new ServiceSelectorKey<Logger>([
  ConsoleLoggerKey,
  FileLoggerKey,
]);

// Create factories for the logger implementations
const consoleLoggerFactory = ServiceFactory.singleton({
  provides: ConsoleLoggerKey,
  dependsOn: [],
  initialize: (): ConsoleLogger => ({
    type: 'console',
    log: (msg: string) => console.log(`[Console] ${msg}`),
  }),
});

const fileLoggerFactory = ServiceFactory.singleton({
  provides: FileLoggerKey,
  dependsOn: [],
  initialize: (): FileLogger => ({
    type: 'file',
    log: (msg: string) => console.log(`[File] ${msg}`),
  }),
});

// Service that depends on the LoggerSelectorKey
interface App {
  useLogger: (key: ServiceKey<Logger>) => Promise<void>;
  getLogger: (key: ServiceKey<Logger>) => Promise<Logger>;
}

const AppKey = new ServiceKey<App>('App');

const appFactory = ServiceFactory.singleton({
  provides: AppKey,
  dependsOn: [LoggerSelectorKey],
  initialize: (loggerSelector): App => {
    return {
      useLogger: async (key: ServiceKey<Logger>) => {
        const logger = await loggerSelector.get(key);
        logger.log('Hello from App!');
      },
      getLogger: async (key: ServiceKey<Logger>) => {
        return await loggerSelector.get(key);
      },
    };
  },
});

describe('ServiceSelectorKey Implementation', () => {
  it('should create ServiceModule with ServiceSelectorKey dependency', () => {
    const module = ServiceModule.from([
      consoleLoggerFactory,
      fileLoggerFactory,
      appFactory,
    ]);
    expect(module).toBeDefined();
  });

  it('should resolve App service with ServiceSelector dependency', async () => {
    const module = ServiceModule.from([
      consoleLoggerFactory,
      fileLoggerFactory,
      appFactory,
    ]);
    const app = await module.get(AppKey);
    expect(app).toBeDefined();
    expect(app.useLogger).toBeDefined();
    expect(app.getLogger).toBeDefined();
  });

  it('should use ServiceSelector to get ConsoleLogger', async () => {
    const module = ServiceModule.from([
      consoleLoggerFactory,
      fileLoggerFactory,
      appFactory,
    ]);
    const app = await module.get(AppKey);
    const logger = await app.getLogger(ConsoleLoggerKey);
    expect(logger).toBeDefined();
    expect(logger.type).toBe('console');
  });

  it('should use ServiceSelector to get FileLogger', async () => {
    const module = ServiceModule.from([
      consoleLoggerFactory,
      fileLoggerFactory,
      appFactory,
    ]);
    const app = await module.get(AppKey);
    const logger = await app.getLogger(FileLoggerKey);
    expect(logger).toBeDefined();
    expect(logger.type).toBe('file');
  });

  it('should detect missing dependency for ServiceSelectorKey', () => {
    const MissingLoggerKey = new ServiceKey<Logger>('MissingLogger');
    const selectorWithMissing = new ServiceSelectorKey<Logger>([
      ConsoleLoggerKey,
      MissingLoggerKey,
    ]);

    const appWithMissingFactory = ServiceFactory.singleton({
      provides: new ServiceKey<App>('AppWithMissing'),
      dependsOn: [selectorWithMissing],
      initialize: (_selector: ServiceSelector<Logger>): App => ({
        useLogger: async () => {},
        getLogger: async () => ({ type: '', log: () => {} }),
      }),
    });

    expect(() => {
      ServiceModule.from([consoleLoggerFactory, appWithMissingFactory]);
    }).toThrow('MissingLogger');
  });
});
