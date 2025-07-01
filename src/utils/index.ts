// Utility functions used across the application

export function formatTimestamp(date: Date): string {
  return date.toISOString();
}

export function createLogger(context: string) {
  return {
    info: (message: string, ...args: any[]) => console.log(`[${context}] INFO:`, message, ...args),
    warn: (message: string, ...args: any[]) => console.warn(`[${context}] WARN:`, message, ...args),
    error: (message: string, ...args: any[]) => console.error(`[${context}] ERROR:`, message, ...args),
    debug: (message: string, ...args: any[]) => console.debug(`[${context}] DEBUG:`, message, ...args),
  };
}

export function sanitizeText(text: string): string {
  return text.replace(/[<>&]/g, (char) => {
    switch (char) {
      case '<': return '&lt;';
      case '>': return '&gt;';
      case '&': return '&amp;';
      default: return char;
    }
  });
}

export function truncateText(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return text.substring(0, maxLength - 3) + '...';
}

export function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export function isValidUrl(string: string): boolean {
  try {
    new URL(string);
    return true;
  } catch (_) {
    return false;
  }
}