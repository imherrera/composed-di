import { ServiceKey } from '../../../lib/serviceKey';
import { SmsService } from '../smsService';
import { singletonFactory } from '../../../lib/serviceFactory';
import process from 'node:process';
import { NoOpSmsService } from '../noOpSmsService';
import { TigoSmsService } from '../tigoSmsService';
import { LOGGER } from '../../logger/di/loggerModule';
import { Logger } from '../../logger/logger';

export const SMS_SERVICE = new ServiceKey<SmsService>('SmsService');

export const SmsServiceFactory = singletonFactory({
  provides: SMS_SERVICE,
  dependsOn: [LOGGER],
  initialize(logger: Logger): Promise<SmsService> {
    logger.info('Initializing SmsService');
    // Since the create method is async, we could instantiate a different
    // implementation on demand by retrieving some configuration from a db
    // or a config file.
    if (process.env.environment === 'dev') {
      return Promise.resolve(new NoOpSmsService());
    } else {
      return Promise.resolve(new TigoSmsService());
    }
  },
});
