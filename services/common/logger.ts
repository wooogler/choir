interface LogMetadata {
  [key: string]: any;
  userId?: string;
  workspaceId?: string;
  channelId?: string;
  sessionId?: string;
  fileName?: string;
  operation?: string;
}

export class Logger {
  private static formatMessage(level: string, message: string, metadata?: LogMetadata): string {
    const timestamp = new Date().toISOString();
    const metaStr = metadata ? ` | ${JSON.stringify(metadata)}` : '';
    return `[${timestamp}] [${level.toUpperCase()}] ${message}${metaStr}`;
  }

  static info(message: string, metadata?: LogMetadata): void {
    const formatted = this.formatMessage('info', message, metadata);
    console.info(formatted);
  }

  static error(message: string, error?: Error, metadata?: LogMetadata): void {
    const errorMeta = error
      ? {
          ...metadata,
          error: error.message,
          stack: error.stack,
          errorName: error.name,
        }
      : metadata;

    const formatted = this.formatMessage('error', message, errorMeta);
    console.error(formatted);
  }

  static warn(message: string, metadata?: LogMetadata): void {
    const formatted = this.formatMessage('warn', message, metadata);
    console.warn(formatted);
  }

  static debug(message: string, metadata?: LogMetadata): void {
    if (process.env.NODE_ENV === 'development' || process.env.DEBUG === 'true') {
      const formatted = this.formatMessage('debug', message, metadata);
      console.debug(formatted);
    }
  }

  static performance(operation: string, duration: number, metadata?: LogMetadata): void {
    this.info(`Performance: ${operation} completed in ${duration}ms`, {
      ...metadata,
      operation,
      duration,
      type: 'performance',
    });
  }
}
