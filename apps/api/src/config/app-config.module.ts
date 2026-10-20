import { Global, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AppConfigService } from './app-config.service';
import { parseEnv } from './env';
import { loadEnvFiles } from './load-env-files';

@Global()
@Module({
  imports: [
    ConfigModule.forRoot({
      // `.env` files are loaded by `loadEnvFiles` so shell values always win; Nest only validates.
      ignoreEnvFile: true,
      cache: true,
      validate: () => {
        // Tests must be hermetic: never pick up a developer's local `.env`.
        if (process.env.NODE_ENV !== 'test') loadEnvFiles();
        return parseEnv(process.env);
      },
    }),
  ],
  providers: [AppConfigService],
  exports: [AppConfigService],
})
export class AppConfigModule {}
