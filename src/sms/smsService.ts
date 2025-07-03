export interface SmsService {
  send(recipient: number, text: string): void;
}
