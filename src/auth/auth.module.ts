import { Global, Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';
import { MongooseModule } from '@nestjs/mongoose';
import { ThrottlerModule } from '@nestjs/throttler';
import { APP_CONFIG, type AppConfig } from '../config/env.js';
import { AuthController } from './auth.controller.js';
import { AuthGuard } from './auth.guard.js';
import { AuthService } from './auth.service.js';
import { RefreshToken, RefreshTokenSchema } from './refresh-token.schema.js';
import { RefreshTokensRepository } from './refresh-tokens.repository.js';
import { SessionsController } from './sessions.controller.js';
import { SessionsService } from './sessions.service.js';
import { TokensService } from './tokens.service.js';

@Global()
@Module({
  imports: [
    ThrottlerModule.forRootAsync({
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig) => ({
        throttlers: [{ name: 'auth', ttl: 60_000, limit: config.AUTH_RATE_LIMIT }],
        errorMessage: 'Too many attempts; please wait a minute and try again',
      }),
    }),
    JwtModule.registerAsync({
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig) => ({ secret: config.JWT_SECRET }),
    }),
    MongooseModule.forFeature([{ name: RefreshToken.name, schema: RefreshTokenSchema }]),
  ],
  controllers: [AuthController, SessionsController],
  providers: [
    AuthService,
    TokensService,
    RefreshTokensRepository,
    SessionsService,
    { provide: APP_GUARD, useClass: AuthGuard },
  ],
  exports: [AuthService, TokensService, SessionsService],
})
export class AuthModule {}
