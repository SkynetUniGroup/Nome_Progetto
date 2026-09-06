import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { MongooseModule } from '@nestjs/mongoose';
import { BullModule } from '@nestjs/bullmq';
import { AuthModule } from './auth/auth.module';
import { CredentialsModule } from './credentials/credentials.module';
import { GithubModule } from './github/github.module';
import { InternalGithubModule } from './github/internal-github.module';
import { ContextsModule } from './contexts/contexts.module';
import { TasksModule } from './tasks/tasks.module';
import { ReportsModule } from './reports/reports.module';
import { OperationsModule } from './operations/operations.module';
import { TemplatesModule } from './templates/templates.module';
import { EventsModule } from './events/events.module';
import { envValidationSchema } from './config/env.validation';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      validationSchema: envValidationSchema,
    }),
    MongooseModule.forRootAsync({
      imports: [ConfigModule],
      useFactory: (config: ConfigService) => ({
        uri: config.get<string>('MONGODB_URI'),
      }),
      inject: [ConfigService],
    }),
    BullModule.forRootAsync({
      imports: [ConfigModule],
      useFactory: (config: ConfigService) => {
        const redisUrl = new URL(config.get<string>('REDIS_URL')!);
        return {
          connection: {
            host: redisUrl.hostname,
            port: Number(redisUrl.port) || 6379,
            password: redisUrl.password || undefined,
          },
        };
      },
      inject: [ConfigService],
    }),
    AuthModule,
    CredentialsModule,
    GithubModule,
    InternalGithubModule,
    ContextsModule,
    TasksModule,
    ReportsModule,
    OperationsModule,
    EventsModule,
    TemplatesModule,
  ],
})
export class AppModule {}
