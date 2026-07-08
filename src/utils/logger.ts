/**
 * Logger utility for the MCP server
 */

export enum LogLevel {
  VERBOSE = 'verbose',
  DEBUG = 'debug',
  INFO = 'info',
  WARN = 'warn',
  ERROR = 'error',
  FATAL = 'fatal'
}

export class Logger {
  private readonly name: string;
  private static level: LogLevel = LogLevel.FATAL;

  constructor(name: string) {
    this.name = name;
  }

  static setLogLevel(level: LogLevel): void {
    Logger.level = level;
  }

  private shouldLog(level: LogLevel): boolean {
    const levels = Object.values(LogLevel);
    return levels.indexOf(level) >= levels.indexOf(Logger.level);
  }

  private formatMessage(level: LogLevel, message: string): string {
    const timestamp = new Date().toISOString();
    return `[${timestamp}] [${level.toUpperCase()}] [${this.name}] ${message}`;
  }

  private write(level: LogLevel, message: string, data?: unknown): void {
    const suffix = this.formatDataSuffix(data);
    console.error(this.formatMessage(level, message) + suffix);
  }

  private formatDataSuffix(data: unknown): string {
    if (data === undefined) {
      return '';
    }

    if (typeof data === 'string') {
      return ` ${data}`;
    }

    if (data instanceof Error) {
      return ` ${data.stack ?? data.message}`;
    }

    try {
      return ` ${JSON.stringify(data)}`;
    } catch {
      return ` ${this.formatUnserializableData(data)}`;
    }
  }

  private formatUnserializableData(data: unknown): string {
    try {
      return String(data);
    } catch {
      return '[Unserializable data]';
    }
  }

  verbose(message: string, data?: unknown): void {
    if (this.shouldLog(LogLevel.VERBOSE)) {
      this.write(LogLevel.VERBOSE, message, data);
    }
  }

  debug(message: string, data?: unknown): void {
    if (this.shouldLog(LogLevel.DEBUG)) {
      this.write(LogLevel.DEBUG, message, data);
    }
  }

  info(message: string, data?: unknown): void {
    if (this.shouldLog(LogLevel.INFO)) {
      this.write(LogLevel.INFO, message, data);
    }
  }

  warn(message: string, data?: unknown): void {
    if (this.shouldLog(LogLevel.WARN)) {
      this.write(LogLevel.WARN, message, data);
    }
  }

  error(message: string, error?: unknown): void {
    if (this.shouldLog(LogLevel.ERROR)) {
      this.write(LogLevel.ERROR, message, error);
    }
  }

  fatal(message: string, error?: unknown): void {
    if (this.shouldLog(LogLevel.FATAL)) {
      this.write(LogLevel.FATAL, message, error);
    }
  }
}

export const createLogger = (name: string): Logger => new Logger(name);
