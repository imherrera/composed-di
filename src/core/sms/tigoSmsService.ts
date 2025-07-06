import { SmsService } from './smsService';

export class TigoSmsService implements SmsService {
  send(_recipient: number, _text: string) {
    throw new Error('Not yet implemented');
  }
}
