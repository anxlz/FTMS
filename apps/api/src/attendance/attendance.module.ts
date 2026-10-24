import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { AbsencesService } from './absences.service';
import { AttendanceTokens } from './attendance-tokens';
import {
  AttendanceController,
  CheckInController,
  InternalAttendanceController,
} from './attendance.controller';
import { AttendanceService } from './attendance.service';
import { CheckInService } from './check-in.service';
import { ExportService } from './export.service';

/** Phase 4: QR check-in, absences, corrections, dashboards and exports. */
@Module({
  imports: [AuthModule],
  controllers: [CheckInController, AttendanceController, InternalAttendanceController],
  providers: [AbsencesService, AttendanceTokens, AttendanceService, CheckInService, ExportService],
})
export class AttendanceModule {}
