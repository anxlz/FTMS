import { Global, type MiddlewareConsumer, Module, type NestModule } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { ApiExceptionFilter } from './api-exception.filter';
import { BackgroundTasks } from './background-tasks.service';
import { RequestContextMiddleware } from './request-context.middleware';

@Global()
@Module({
  providers: [BackgroundTasks, { provide: APP_FILTER, useClass: ApiExceptionFilter }],
  exports: [BackgroundTasks],
})
export class CommonModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(RequestContextMiddleware).forRoutes('*path');
  }
}
