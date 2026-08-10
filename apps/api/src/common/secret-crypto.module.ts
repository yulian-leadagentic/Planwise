/**
 * Global module exposing SecretCryptoService — the single crypto
 * gateway for every OAuth/OIDC client secret in the system. Marked
 * @Global so the SSO admin module + OIDC auth flow can inject it
 * without each module having to import the module explicitly.
 */
import { Global, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { SecretCryptoService } from './services/secret-crypto.service';

@Global()
@Module({
  imports: [ConfigModule],
  providers: [SecretCryptoService],
  exports: [SecretCryptoService],
})
export class SecretCryptoModule {}
