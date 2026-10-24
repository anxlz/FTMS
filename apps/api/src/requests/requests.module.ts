import { Module } from '@nestjs/common';
import { StudentsModule } from '../students/students.module';
import { GroupSwapsController, MyGroupSwapsController } from './group-swaps.controller';
import { GroupSwapsService } from './group-swaps.service';
import { TicketsController } from './tickets.controller';
import { TicketsService } from './tickets.service';

/** Phase 5: support tickets (§13) and mutual group-swap requests (§14). */
@Module({
  imports: [StudentsModule],
  controllers: [TicketsController, GroupSwapsController, MyGroupSwapsController],
  providers: [TicketsService, GroupSwapsService],
})
export class RequestsModule {}
