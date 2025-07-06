import { singletonFactory } from '../../../lib/serviceFactory';
import { ServiceKey } from '../../../lib/serviceKey';
import { EmailAlertLogger } from '../emailAlertLogger';
import { Logger } from '../logger';

export const LOGGER = new ServiceKey<Logger>('Logger');

export const LoggerFactory = singletonFactory({
  provides: LOGGER,
  initialize: () => {
    return Promise.resolve(new EmailAlertLogger(100, ['juanhr454@gmail.com']));
  },
});
