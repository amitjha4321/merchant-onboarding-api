import { CallHandler, ExecutionContext, Injectable, Logger, NestInterceptor } from '@nestjs/common';
import { Request, Response } from 'express';
import { Observable, tap } from 'rxjs';
import { AuthenticatedUser } from '../../auth/authenticated-user.interface';

/**
 * Access log. Deliberately logs only method, path, status, latency and principal id —
 * never request bodies or headers (which may contain passwords / bearer tokens).
 */
@Injectable()
export class LoggingInterceptor implements NestInterceptor {
  private readonly logger = new Logger('HTTP');

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const http = context.switchToHttp();
    const req = http.getRequest<Request & { id?: string; user?: AuthenticatedUser }>();
    const started = Date.now();
    const path = req.originalUrl.split('?')[0];

    return next.handle().pipe(
      tap({
        next: () => {
          const res = http.getResponse<Response>();
          this.logger.log(
            `${req.method} ${path} ${res.statusCode} ${Date.now() - started}ms user=${req.user?.id ?? '-'} rid=${req.id}`,
          );
        },
      }),
    );
  }
}
