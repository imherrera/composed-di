import { Logger, LogEvent, LogEventPayload } from './logger';

export class EmailAlertLogger implements Logger {
  private readonly buffer: LogEvent[] = [];
  private readonly bufferSize: number;
  private readonly recipients: string[];
  private readonly emailQueue: string[] = [];

  constructor(bufferSize: number = 50, recipients: string[] = []) {
    this.bufferSize = bufferSize;
    this.recipients = recipients;
  }

  private addToBuffer(event: Omit<LogEvent, 'date'>): void {
    // Keep the buffer to the specified size
    if (this.buffer.length >= this.bufferSize) {
      this.buffer.shift();
    }
    this.buffer.push({ ...event, date: new Date() });
  }

  public info(message: string, payload?: LogEventPayload): void {
    this.addToBuffer({ level: 'INFO', message, payload });
  }

  public error(
    message: string,
    error?: unknown,
    payload?: LogEventPayload,
  ): void {
    this.addToBuffer({ level: 'ERROR', message, payload });
    this.emailQueue.push(createTableString(this.buffer, error));
    this.buffer.length = 0;
  }

  public debug(message: string, payload?: LogEventPayload): void {
    this.addToBuffer({ level: 'DEBUG', message, payload });
  }

  public async flush(): Promise<void> {
    for (const email of this.emailQueue) {
      console.error(email);
    }
    // Clear all buffers
    this.buffer.length = 0;
    this.emailQueue.length = 0;
  }
}

function createTableString(events: LogEvent[], error?: unknown): string {
  if (events.length === 0) {
    return 'No events to display';
  }

  // Calculate column widths
  const dateWidth = Math.max(
    4,
    ...events.map((e) => e.date.toISOString().length),
  );
  const levelWidth = Math.max(
    5, // "Level" header length
    ...events.map((e) => e.level.length),
  );
  const messageWidth = Math.max(7, ...events.map((e) => e.message.length));
  const payloadWidth = Math.max(
    7,
    ...events.map((e) => (e.payload ? JSON.stringify(e.payload).length : 0)),
  );

  // Create header
  const header = [
    'DATE'.padEnd(dateWidth),
    'LEVEL'.padEnd(levelWidth),
    'MESSAGE'.padEnd(messageWidth),
    'PAYLOAD'.padEnd(payloadWidth),
  ].join(' | ');

  // Create separator
  const separator = [
    '-'.repeat(dateWidth),
    '-'.repeat(levelWidth),
    '-'.repeat(messageWidth),
    '-'.repeat(payloadWidth),
  ].join('-|-');

  // Create rows
  const rows = events.map((event) => {
    const date = event.date.toISOString().padEnd(dateWidth);
    const level = event.level.padEnd(levelWidth);
    const message = event.message.padEnd(messageWidth);
    const payload = (event.payload ? JSON.stringify(event.payload) : '').padEnd(
      payloadWidth,
    );
    return [date, level, message, payload].join(' | ');
  });

  // Create error section if error exists
  const errorSection = error
    ? '\n\nError Details:\n' +
      '-'.repeat(20) +
      '\n' +
      (error instanceof Error
        ? `${error.name}: ${error.message}\n${error.stack || ''}`
        : String(error))
    : '';

  // Combine all parts
  return [header, separator, ...rows].join('\n') + errorSection;
}
