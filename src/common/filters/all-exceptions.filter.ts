import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { QueryFailedError } from 'typeorm';

interface ErrorBody {
  statusCode: number;
  error: string;
  message: string | string[];
  path: string;
  requestId?: string;
  timestamp: string;
}

const PG_UNIQUE_VIOLATION = '23505';
const PG_SERIALIZATION_FAILURE = '40001';

/**
 * Single place that shapes every error response. Unknown errors become a generic 500 —
 * internal messages, SQL and stack traces are logged server-side but never returned.
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const req = ctx.getRequest<Request & { id?: string }>();
    const res = ctx.getResponse<Response>();

    const { status, message } = this.resolve(exception);
    if (status >= 500) {
      this.logger.error(
        `${req.method} ${req.originalUrl.split('?')[0]} -> ${status} rid=${req.id}`,
        exception instanceof Error ? exception.stack : String(exception),
      );
    }

    const body: ErrorBody = {
      statusCode: status,
      error: HttpStatus[status] ?? 'Error',
      message,
      path: req.originalUrl.split('?')[0],
      requestId: req.id,
      timestamp: new Date().toISOString(),
    };
    res.status(status).json(body);
  }

  private resolve(exception: unknown): { status: number; message: string | string[] } {
    if (exception instanceof HttpException) {
      const response = exception.getResponse();
      const message =
        typeof response === 'string'
          ? response
          : ((response as { message?: string | string[] }).message ?? exception.message);
      return { status: exception.getStatus(), message };
    }
    if (exception instanceof QueryFailedError) {
      const code = (exception as QueryFailedError & { code?: string }).code;
      if (code === PG_UNIQUE_VIOLATION) {
        return { status: HttpStatus.CONFLICT, message: 'Resource already exists' };
      }
      if (code === PG_SERIALIZATION_FAILURE) {
        return { status: HttpStatus.CONFLICT, message: 'Concurrent update, please retry' };
      }
    }
    return { status: HttpStatus.INTERNAL_SERVER_ERROR, message: 'Internal server error' };
  }
}
