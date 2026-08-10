import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { ConfigModule, ConfigService } from '@nestjs/config';

import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { JwtStrategy } from './strategies/jwt.strategy';
import { LocalStrategy } from './strategies/local.strategy';
import { RefreshStrategy } from './strategies/refresh.strategy';
import { UsersModule } from '../users/users.module';
import { OidcController } from './oidc/oidc.controller';
import { OidcUserResolverService } from './oidc/oidc-user-resolver.service';
import { SsoAdminModule } from '../sso-admin/sso-admin.module';

@Module({
  imports: [
    PassportModule.register({ defaultStrategy: 'jwt' }),
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const secret = config.get<string>('JWT_ACCESS_SECRET');
        if (!secret || secret.length < 32) {
          throw new Error('JWT_ACCESS_SECRET must be set and at least 32 characters long');
        }
        return {
          secret,
          signOptions: { expiresIn: config.get<string>('JWT_ACCESS_EXPIRY', '1h') },
        };
      },
    }),
    UsersModule,
    // SsoAdminModule owns issuerUrlFor() — imported so the OIDC
    // controller uses the SAME issuer-mapping the admin test-connection
    // endpoint uses. One place to fix if a provider changes.
    SsoAdminModule,
  ],
  controllers: [AuthController, OidcController],
  providers: [AuthService, JwtStrategy, LocalStrategy, RefreshStrategy, OidcUserResolverService],
  exports: [AuthService, JwtModule],
})
export class AuthModule {}
