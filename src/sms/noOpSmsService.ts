import { SmsService } from './smsService.ts';

export class NoOpSmsService implements SmsService {
  send(recipient: number, text: string) {
    console.warn(`NoOpSmsService: Sending sms to ${recipient}: ${text}`);
  }
}
