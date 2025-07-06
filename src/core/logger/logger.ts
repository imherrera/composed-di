export type LogEventPayload = Record<string, any>;

export type LogLevel = 'INFO' | 'ERROR' | 'DEBUG';

export interface LogEvent {
  level: LogLevel;
  date: Date;
  error?: unknown;
  message: string;
  payload?: LogEventPayload;
}

export interface Logger {
  info(message: string, payload?: LogEventPayload): void;

  error(message: string, error: unknown, payload?: LogEventPayload): void;

  debug(message: string, payload?: LogEventPayload): void;
}
