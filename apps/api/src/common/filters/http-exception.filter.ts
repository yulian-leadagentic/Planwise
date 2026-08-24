import {
  ExceptionFilter,
  Catch,
  ArgumentsHost,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import * as Sentry from '@sentry/node';
import { Response } from 'express';

@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(HttpExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<{ method?: string; url?: string }>();

    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let message = 'Internal server error';
    let details: any = null;
    let code = 'INTERNAL_ERROR';

    if (exception instanceof HttpException) {
      status = exception.getStatus();
      const exceptionResponse = exception.getResponse();

      if (typeof exceptionResponse === 'string') {
        message = exceptionResponse;
      } else if (typeof exceptionResponse === 'object') {
        const resp = exceptionResponse as any;
        message = resp.message || exception.message;
        details = resp.details || null;

        // Handle class-validator errors
        if (Array.isArray(resp.message)) {
          details = resp.message;
          message = 'Validation failed';
        }
      }

      code = this.getErrorCode(status);
    } else if (exception instanceof Error) {
      // Log the real error server-side, but never leak it to clients in prod.
      this.logger.error(`Unhandled error: ${exception.message}`, exception.stack);
      if (process.env.NODE_ENV !== 'production') {
        message = exception.message;
      }
      // In production, message stays as the generic "Internal server error"
    }

    // Ship 5xx to Sentry with the request-scoped user/route tags that
    // SentryContextInterceptor already pinned. 4xx stays out — those are
    // validation / permission / not-found noise; we already `logger.warn`
    // them below (see the "Symmetric 4xx logging" block). Sentry alert rules
    // catch 4xx *spikes* separately if we ever want them.
    //
    // getClient() gate is defensive — `captureException` is a safe no-op when
    // Sentry never inited, but the explicit check makes the intent obvious to
    // the next reader and skips constructing the event object.
    if (status >= 500 && Sentry.getClient()) {
      Sentry.captureException(exception, {
        tags: { source: 'HttpExceptionFilter', status: String(status) },
      });
    }

    // Symmetric 4xx logging (project-fixes-pack Fix 2). Client-side
    // validation and permission failures used to slip past the log
    // entirely, so diagnosing user-reported errors needed the client
    // to reproduce. One warn line per 4xx makes the API service log
    // self-serve — method + path + status + message, nothing else.
    // Deliberately never logs request bodies or headers: they carry
    // credentials and PII. `req.url` includes the query string but
    // not the host, matching what pino-http already writes.
    if (status >= 400 && status < 500) {
      const method = request?.method ?? '?';
      const url = request?.url ?? '?';
      this.logger.warn(`${status} ${method} ${url} — ${message}`);
    }

    response.status(status).json({
      success: false,
      error: {
        code,
        message,
        details,
      },
    });
  }

  private getErrorCode(status: number): string {
    switch (status) {
      case 400:
        return 'BAD_REQUEST';
      case 401:
        return 'UNAUTHORIZED';
      case 403:
        return 'FORBIDDEN';
      case 404:
        return 'NOT_FOUND';
      case 409:
        return 'CONFLICT';
      case 422:
        return 'UNPROCESSABLE_ENTITY';
      case 429:
        return 'TOO_MANY_REQUESTS';
      default:
        return 'INTERNAL_ERROR';
    }
  }
}
