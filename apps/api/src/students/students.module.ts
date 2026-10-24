import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { GroupsController } from './groups.controller';
import { GroupsService } from './groups.service';
import { ImportsController } from './imports/imports.controller';
import { ImportsService } from './imports/imports.service';
import { MeController } from './me.controller';
import { ProfileChangesService } from './profile-changes.service';
import { ProfileChangesController, VerificationsController } from './reviews.controller';
import { StudentsController } from './students.controller';
import { StudentsService } from './students.service';
import { VerificationsService } from './verifications.service';

/** Phase 2: student records, groups, imports, account verification, profile changes. */
@Module({
  imports: [AuthModule],
  controllers: [
    MeController,
    StudentsController,
    GroupsController,
    ImportsController,
    ProfileChangesController,
    VerificationsController,
  ],
  providers: [
    StudentsService,
    GroupsService,
    ImportsService,
    ProfileChangesService,
    VerificationsService,
  ],
  exports: [GroupsService],
})
export class StudentsModule {}
