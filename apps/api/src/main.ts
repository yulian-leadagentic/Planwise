import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import { Logger } from 'nestjs-pino';
import helmet from 'helmet';
import compression from 'compression';
import cookieParser from 'cookie-parser';

import { AppModule } from './app.module';
import { HttpExceptionFilter } from './common/filters/http-exception.filter';
import { ResponseInterceptor } from './common/interceptors/response.interceptor';
import { TimeoutInterceptor } from './common/interceptors/timeout.interceptor';
import { startWatchdog } from './common/watchdog';
import { startWedgeKillswitch } from './common/wedge-killswitch';
import { startVitalsLogger } from './common/vitals';

async function bootstrap() {
  // bufferLogs: true so early-boot logs go through pino once it's wired
  const app = await NestFactory.create(AppModule, { bufferLogs: true });
  app.useLogger(app.get(Logger));

  // Security
  app.use(helmet());
  app.use(compression());
  app.use(cookieParser());

  // CORS — accept a comma-separated list of allowed origins so a single env
  // var can cover prod + staging + localhost. Falls back to local dev origin.
  const corsOrigins = (process.env.FRONTEND_URL || 'http://localhost:5173')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);
  app.enableCors({
    origin: (origin, cb) => {
      // Allow same-origin / curl / server-to-server (no Origin header)
      if (!origin) return cb(null, true);
      cb(null, corsOrigins.includes(origin));
    },
    credentials: true,
  });

  // Global prefix
  app.setGlobalPrefix('api/v1');

  // Global pipes
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: true },
    }),
  );

  // Global filters & interceptors
  app.useGlobalFilters(new HttpExceptionFilter());
  app.useGlobalInterceptors(new ResponseInterceptor(), new TimeoutInterceptor());

  // Swagger — disabled in production to avoid leaking internal surface
  if (process.env.NODE_ENV !== 'production') {
    const config = new DocumentBuilder()
      .setTitle('Planwise API')
      .setDescription('Planwise Project Management API')
      .setVersion('1.0')
      .addBearerAuth()
      .build();
    const document = SwaggerModule.createDocument(app, config);
    SwaggerModule.setup('api/docs', app, document);
  }

  // Graceful shutdown — drains connections on SIGTERM/SIGINT so orchestrators
  // can roll pods without dropping in-flight requests.
  app.enableShutdownHooks();

  // HTTP-server-level hard timeouts. Nest's TimeoutInterceptor wraps the
  // rxjs pipeline, but if a TCP socket gets stuck at a lower layer (a
  // hanging DB driver write, a stalled response stream, anything below
  // the controller) Nest can't see it. Set socket-level timeouts so any
  // request stuck for >45s is killed at the OS level. Headers timeout
  // protects against slowloris-style clients that send headers slowly.
  const httpServer: any = app.getHttpAdapter().getInstance();
  if (httpServer?.server) {
    httpServer.server.requestTimeout = 45_000;
    httpServer.server.headersTimeout = 30_000;
    httpServer.server.keepAliveTimeout = 65_000;
  }

  const port = process.env.PORT || 3000;
  await app.listen(port);

  // The underlying http.Server is only created after listen() — re-apply
  // here so the values stick. (Express's getHttpAdapter().getInstance()
  // returns the express app; the server is on .httpServer or as a
  // sibling on the adapter.)
  const adapter: any = app.getHttpAdapter();
  const realServer = adapter.httpServer || adapter.server;
  if (realServer) {
    realServer.requestTimeout = 45_000;
    realServer.headersTimeout = 30_000;
    realServer.keepAliveTimeout = 65_000;
  }

  const logger = app.get(Logger);
  logger.log(`Application running on port ${port}`, 'Bootstrap');

  // Process-level safety nets. Without these an unhandled rejection or
  // uncaught exception can leave the event loop running in a corrupt state —
  // the container looks "alive" to Railway but new requests hang. We'd rather
  // crash loudly and let Railway's restartPolicy=ON_FAILURE restart us.
  process.on('unhandledRejection', (reason) => {
    logger.error(
      `unhandledRejection: ${reason instanceof Error ? reason.stack : String(reason)}`,
      'FatalError',
    );
    setTimeout(() => process.exit(1), 100);
  });
  process.on('uncaughtException', (err) => {
    logger.error(`uncaughtException: ${err.stack || err.message}`, 'FatalError');
    setTimeout(() => process.exit(1), 100);
  });

  // Self-probing watchdog: if our own HTTP listener stops responding to a
  // localhost probe of /api/v1/health/live for ~40s, exit(1) so Railway
  // restarts us. Catches the 2026-06-10 freeze pattern (HTTP wedged, container
  // alive). Tightened on 2026-06-14 after repeat incidents.
  startWatchdog(port, logger);

  // Out-of-loop killswitch — runs in worker_threads so it survives a hard
  // main-thread block (sync CPU work, native deadlock). The in-process
  // watchdog above can't catch that case because its own timers freeze
  // alongside everything else. SIGKILLs the process after ~30s of
  // main-loop unresponsiveness; complements the watchdog, doesn't replace it.
  startWedgeKillswitch(logger);

  // Vitals logger — emits event-loop / heap / handle stats every 30s so the
  // log line just before a wedge tells us what subsystem hit the wall.
  startVitalsLogger(logger);
}
bootstrap();
