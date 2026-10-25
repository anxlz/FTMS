import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { AbsencesService } from './absences.service';
import { AttendanceTokens } from './attendance-tokens';
import {
  AttendanceController,
  CheckInController,
  GuestCheckInController,
  InternalAttendanceController,
} from './attendance.controller';
import { AttendanceService } from './attendance.service';
import { CheckInService } from './check-in.service';
import { ExportService } from './export.service';
import { GuestCheckInService } from './guest-check-in.service';

/**
 * Phase 4: QR check-in, absences, corrections, dashboards and exports.
 * Phase 8: guest attendance; check-in without biometrics, under a location policy.
 */
@Module({
  imports: [AuthModule],
  controllers: [
    CheckInController,
    GuestCheckInController,
    AttendanceController,
    InternalAttendanceController,
  ],
  providers: [
    AbsencesService,
    AttendanceTokens,
    AttendanceService,
    CheckInService,
    ExportService,
    GuestCheckInService,
  ],
  exports: [AbsencesService],
})
export class AttendanceModule {}
