import { ConsoleLogger, INestApplication } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import { accessLogMiddleware } from './common/access-log.js';
import { AppExceptionFilter } from './common/app-exception.filter.js';
import { REQUEST_ID_HEADER, requestIdMiddleware } from './common/request-context.js';
import { APP_CONFIG, type AppConfig } from './config/env.js';

export function configureApp(app: INestApplication): void {
  const config = app.get<AppConfig>(APP_CONFIG);
  (app as NestExpressApplication).set('trust proxy', config.TRUST_PROXY);
  app.use(requestIdMiddleware);
  if (config.NODE_ENV !== 'test') {
    const json = config.NODE_ENV === 'production';
    app.use(accessLogMiddleware(new ConsoleLogger('Access', { json }), json ? 'json' : 'text'));
  }
  app.use(helmet({ crossOriginResourcePolicy: { policy: 'same-site' } }));
  app.setGlobalPrefix('api/v1');
  app.use(cookieParser());
  app.useGlobalFilters(new AppExceptionFilter());
  app.enableCors({
    origin: config.FRONTEND_URL,
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
    exposedHeaders: [REQUEST_ID_HEADER],
  });
}
