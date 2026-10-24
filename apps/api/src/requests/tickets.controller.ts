import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UploadedFiles,
  UseInterceptors,
} from '@nestjs/common';
import { FilesInterceptor } from '@nestjs/platform-express';
import {
  type CreateTicketRequest,
  CreateTicketRequestSchema,
  type ListTicketsQuery,
  ListTicketsQuerySchema,
  type ListTicketsResponse,
  TICKET_FILE_MAX_BYTES,
  TICKET_FILES_PER_POST,
  type TicketDetail,
  type TicketMessageRequest,
  TicketMessageRequestSchema,
  type UpdateTicketStatusRequest,
  UpdateTicketStatusRequestSchema,
} from '@ftms/core';
import { CurrentPrincipal, RequirePermissions, Roles } from '../auth/decorators';
import { type AuthPrincipal } from '../auth/principal';
import { Ctx, type RequestContext } from '../common/request-context';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { TicketsService, type UploadedTicketFile } from './tickets.service';

const uuid = new ParseUUIDPipe({ version: '7' });

/** In memory only (no temp files on serverless), bounded count and size, UTF-8 names. */
const files = (fields: number) =>
  FilesInterceptor('files', TICKET_FILES_PER_POST, {
    limits: {
      fileSize: TICKET_FILE_MAX_BYTES,
      files: TICKET_FILES_PER_POST,
      fields,
      parts: fields + TICKET_FILES_PER_POST,
    },
    defParamCharset: 'utf8',
  });

/** Support tickets (§13). Visibility is decided per ticket by the service. */
@Controller()
export class TicketsController {
  constructor(private readonly tickets: TicketsService) {}

  @Post('tickets')
  @Roles('STUDENT')
  @UseInterceptors(files(3))
  create(
    @CurrentPrincipal() principal: AuthPrincipal,
    @Body(new ZodValidationPipe(CreateTicketRequestSchema)) body: CreateTicketRequest,
    @UploadedFiles() uploads: UploadedTicketFile[] | undefined,
    @Ctx() context: RequestContext,
  ): Promise<TicketDetail> {
    return this.tickets.create(principal, body, uploads, context);
  }

  @Get('me/tickets')
  @Roles('STUDENT')
  listOwn(
    @CurrentPrincipal() principal: AuthPrincipal,
    @Query(new ZodValidationPipe(ListTicketsQuerySchema)) query: ListTicketsQuery,
  ): Promise<ListTicketsResponse> {
    return this.tickets.listOwn(principal, query);
  }

  @Get('tickets')
  @RequirePermissions('tickets.process')
  list(
    @Query(new ZodValidationPipe(ListTicketsQuerySchema)) query: ListTicketsQuery,
  ): Promise<ListTicketsResponse> {
    return this.tickets.list(query);
  }

  /** The owner, or staff with `tickets.process`. */
  @Get('tickets/:id')
  detail(
    @CurrentPrincipal() principal: AuthPrincipal,
    @Param('id', uuid) id: string,
  ): Promise<TicketDetail> {
    return this.tickets.detail(principal, id);
  }

  @Post('tickets/:id/messages')
  @UseInterceptors(files(2))
  addMessage(
    @CurrentPrincipal() principal: AuthPrincipal,
    @Param('id', uuid) id: string,
    @Body(new ZodValidationPipe(TicketMessageRequestSchema)) body: TicketMessageRequest,
    @UploadedFiles() uploads: UploadedTicketFile[] | undefined,
    @Ctx() context: RequestContext,
  ): Promise<TicketDetail> {
    return this.tickets.addMessage(principal, id, body, uploads, context);
  }

  @Post('tickets/:id/status')
  @HttpCode(200)
  @RequirePermissions('tickets.process')
  setStatus(
    @CurrentPrincipal() principal: AuthPrincipal,
    @Param('id', uuid) id: string,
    @Body(new ZodValidationPipe(UpdateTicketStatusRequestSchema)) body: UpdateTicketStatusRequest,
    @Ctx() context: RequestContext,
  ): Promise<TicketDetail> {
    return this.tickets.setStatus(principal, id, body, context);
  }
}
