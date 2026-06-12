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

  const port = process.env.PORT || 3000;
  await app.listen(port);

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
  // localhost probe of /api/v1/health/live for ~1.5min, exit(1) so Railway
  // restarts us. Catches the 2026-06-10 freeze pattern (HTTP wedged, container
  // alive).
  startWatchdog(port, logger);
}
bootstrap();
