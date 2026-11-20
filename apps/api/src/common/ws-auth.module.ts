import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { PrismaModule } from '../prisma/prisma.module';
import { WsAuthService } from './services/ws-auth.service';

/**
 * Handshake authentication for the Socket.IO gateways. JwtModule is
 * registered without options on purpose: WsAuthService passes the
 * access secret explicitly on every verify, read the same way the HTTP
 * JwtStrategy reads it.
 */
@Module({
  imports: [PrismaModule, JwtModule.register({})],
  providers: [WsAuthService],
  exports: [WsAuthService],
})
export class WsAuthModule {}
