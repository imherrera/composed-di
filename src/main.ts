import { ServiceModule } from './lib/serviceModule';
import { ServiceProvider } from './lib/serviceProvider';
import { SMS_SERVICE, SmsServiceFactory } from './core/sms/di/smsModule';
import { LOGGER, LoggerFactory } from './core/logger/di/loggerModule';
import { EmailAlertLogger } from './core/logger/emailAlertLogger';

const authModule = ServiceModule.from([SmsServiceFactory, LoggerFactory]);

function module(
  module: ServiceModule,
  fn: (event: object, context: Context) => void,
) {
  return (event: object, context: object) => {
    fn(event, { services: module, ...context });
  };
}

const handler = module(authModule, login);

(async function () {
  await deeplyNestedFunction({ services: authModule });
  const logger = await authModule.inject(LOGGER);
  if (logger instanceof EmailAlertLogger) {
    await logger.flush();
  }
  console.log('Done');
})();

async function deeplyNestedFunction(context: Context) {
  await login({}, context);
}

interface Context {
  services: ServiceProvider;
}

async function login(request: any, context: Context) {
  const state = authorize(request);
  const logger = await context.services.inject(LOGGER);
  if (state === 'DEVICE_CHANGED') {
    logger.info('Device changed');
    // With the service key we get type safety/inference and navigate to definition for free,
    // there is no magic no annotations, we can see all the
    // factories that provide this dependency and see all places where this is retrieved.
    const sms = await context.services.inject(SMS_SERVICE);
    logger.debug('Sending sms');
    try {
      sms.send(971233149, 'Hola Juan, tu pin es 22222');
    } catch (e) {
      logger.error('Error sending sms', e);
    }

    // Retrieving the service a second time would have virtually zero cost if the
    // underlying factory provides a singleton.
    const sms1 = await context.services.inject(SMS_SERVICE);
  }

  return;
}

function authorize(_request: any): 'OK' | 'DEVICE_CHANGED' {
  return 'DEVICE_CHANGED';
}
