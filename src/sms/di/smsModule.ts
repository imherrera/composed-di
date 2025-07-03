import { ServiceKey } from '../../services/serviceKey.ts';
import { SmsService } from '../smsService.ts';
import { ServiceFactory } from '../../services/serviceFactory.ts';
import process from 'node:process';
import { NoOpSmsService } from '../noOpSmsService.ts';
import { TigoSmsService } from '../tigoSmsService.ts';

export const SMS_SERVICE_KEY = new ServiceKey<SmsService>('SmsService');

export function smsServiceFactory(): ServiceFactory<SmsService> {
  let instance: SmsService | undefined;

  return {
    key: SMS_SERVICE_KEY,
    dependsOn: [],
    // TODO: allow create to access dependencies declared in `dependsOn`
    create(): Promise<SmsService> {
      // fast-path
      if (instance) {
        return Promise.resolve(instance);
      }

      // TIP! This could come from a db config
      if (process.env.environment === 'dev') {
        instance = new NoOpSmsService();
      } else {
        instance = new TigoSmsService();
      }

      // Here we would do our async initialization if needed
      return Promise.resolve(instance);
    },
  };
}
