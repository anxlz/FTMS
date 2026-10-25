import { Module } from '@nestjs/common';
import { AttendanceModule } from '../attendance/attendance.module';
import { AuditLogModule } from '../audit/audit-log.module';
import { ReportsController } from './reports.controller';
import { ReportsService } from './reports.service';

/** Phase 6: training-wide reports. */
@Module({
  imports: [AttendanceModule, AuditLogModule],
  controllers: [ReportsController],
  providers: [ReportsService],
})
export class ReportsModule {}
