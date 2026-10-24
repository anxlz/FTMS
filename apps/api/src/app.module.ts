import { Module } from '@nestjs/common';
import { AttendanceModule } from './attendance/attendance.module';
import { AuditModule } from './audit/audit.module';
import { AuthModule } from './auth/auth.module';
import { CommonModule } from './common/common.module';
import { AppConfigModule } from './config/app-config.module';
import { HealthModule } from './health/health.module';
import { MailModule } from './mail/mail.module';
import { NotificationsModule } from './notifications/notifications.module';
import { PrismaModule } from './prisma/prisma.module';
import { RateLimitModule } from './rate-limit/rate-limit.module';
import { RedisModule } from './redis/redis.module';
import { SchedulingModule } from './scheduling/scheduling.module';
import { StorageModule } from './storage/storage.module';
import { StudentsModule } from './students/students.module';
import { UsersModule } from './users/users.module';

@Module({
  imports: [
    AppConfigModule,
    CommonModule,
    PrismaModule,
    RedisModule,
    RateLimitModule,
    StorageModule,
    MailModule,
    AuditModule,
    NotificationsModule,
    AuthModule,
    UsersModule,
    StudentsModule,
    SchedulingModule,
    AttendanceModule,
    HealthModule,
  ],
})
export class AppModule {}
