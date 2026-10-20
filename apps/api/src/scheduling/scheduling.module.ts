import { Module } from '@nestjs/common';
import { ProgramController } from './program.controller';
import { ProgramService } from './program.service';
import { ScheduleExceptionsController, SchedulesController } from './schedules.controller';
import { SchedulesService } from './schedules.service';
import { VisitFilesService } from './visit-files.service';
import { CalendarController, VisitsController } from './visits.controller';
import { VisitsService } from './visits.service';

/** Phase 3: program settings, recurring schedules, exceptions, visits, calendars. */
@Module({
  controllers: [
    ProgramController,
    SchedulesController,
    ScheduleExceptionsController,
    VisitsController,
    CalendarController,
  ],
  providers: [ProgramService, SchedulesService, VisitsService, VisitFilesService],
})
export class SchedulingModule {}
