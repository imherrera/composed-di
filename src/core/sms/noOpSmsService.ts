import { SmsService } from './smsService';

export class NoOpSmsService implements SmsService {
  send(recipient: number, text: string) {
    console.warn(`NoOpSmsService: Sending sms to ${recipient}: ${text}`);
  }
}
