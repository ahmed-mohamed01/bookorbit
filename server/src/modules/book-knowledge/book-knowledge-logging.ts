import { HttpException, type Logger } from '@nestjs/common';
export async function knowledgeOperation<T>(logger: Logger, event: string, ids: string, operation: () => Promise<T>): Promise<T> {
  const started = Date.now();
  logger.log(`[${event}] [start] ${ids} - operation started`);
  try {
    const result = await operation();
    logger.log(`[${event}] [end] ${ids} durationMs=${Date.now() - started} completed=true - operation completed`);
    return result;
  } catch (error) {
    const level = error instanceof HttpException && error.getStatus() < 500 ? 'debug' : 'error';
    logger[level](
      `[${event}] [fail] ${ids} durationMs=${Date.now() - started} errorClass=${error instanceof Error ? error.name : 'UnknownError'} error="operation failed" - operation failed`,
    );
    throw error;
  }
}
