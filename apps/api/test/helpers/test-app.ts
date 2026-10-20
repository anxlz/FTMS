import { type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { type AuthResponse, type Role } from '@ftms/core';
import { type CellValue, Workbook } from 'exceljs';
import request from 'supertest';
import { type App } from 'supertest/types';
import { configureApp } from '../../src/app.factory';
import { AppModule } from '../../src/app.module';
import { hashPassword } from '../../src/auth/password-hashing';
import { BackgroundTasks } from '../../src/common/background-tasks.service';
import { CLIENT_IP_HEADER, PROXY_KEY_HEADER } from '../../src/common/request-context';
import { type OutgoingMail, MailService } from '../../src/mail/mail.service';
import { PrismaService } from '../../src/prisma/prisma.service';
import { MemoryRateLimiter, RateLimiter } from '../../src/rate-limit/rate-limiter';

export type TestApp = INestApplication<App>;

/** Every message the app "sent" (MailService runs in log mode in tests). */
export interface Mailbox {
  messages: OutgoingMail[];
  /** Latest 6-digit code mailed to `email`, after background sends settle. */
  latestCode(email: string): Promise<string | null>;
  clear(): void;
}

export async function bootTestApp(): Promise<{ app: TestApp; mailbox: Mailbox }> {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  const app = moduleRef.createNestApplication<TestApp>({ logger: false });
  configureApp(app);
  await app.init();

  const mail = app.get(MailService);
  const background = app.get(BackgroundTasks);
  const messages: OutgoingMail[] = [];
  const original = mail.send.bind(mail);
  jest.spyOn(mail, 'send').mockImplementation((message) => {
    messages.push(message);
    return original(message);
  });

  const mailbox: Mailbox = {
    messages,
    async latestCode(email) {
      await background.drain();
      const last = [...messages].reverse().find((m) => m.to === email);
      return last?.text.match(/\b(\d{6})\b/)?.[1] ?? null;
    },
    clear() {
      messages.length = 0;
    },
  };
  return { app, mailbox };
}

const TRUNCATE = [
  'auth_challenges',
  'auth_sessions',
  'user_permission_grants',
  'profile_change_requests',
  'student_verification_requests',
  'student_imports',
  'group_memberships',
  'training_groups',
  'student_profiles',
  'faculty_profiles',
  'users',
  'audit_logs',
].join(', ');

/**
 * Empties every data table between tests. The audit log is append-only by
 * trigger; `session_replication_role = replica` (superuser-only, test databases
 * only) suspends triggers for this transaction so the fixture can be reset.
 */
export async function resetDatabase(app: TestApp): Promise<void> {
  const prisma = app.get(PrismaService);
  await prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe('SET LOCAL session_replication_role = replica');
    await tx.$executeRawUnsafe(`TRUNCATE ${TRUNCATE} RESTART IDENTITY CASCADE`);
  });
  const limiter = app.get(RateLimiter);
  if (limiter instanceof MemoryRateLimiter) limiter.clear();
  await app.get(BackgroundTasks).drain();
}

export interface SeededUser {
  id: string;
  email: string;
  password: string | null;
  role: Role;
  seatNumber?: string;
}

let counter = 0;

/** Inserts an account directly (bypassing the API) for test setup. */
export async function createUser(
  app: TestApp,
  role: Role,
  options: {
    password?: string | null;
    status?: 'ACTIVE' | 'SUSPENDED' | 'PENDING_VERIFICATION';
    mustChangePassword?: boolean;
    seatNumber?: string;
    email?: string;
  } = {},
): Promise<SeededUser> {
  counter += 1;
  const prisma = app.get(PrismaService);
  const email = options.email ?? `${role.toLowerCase().replace('_', '-')}${counter}@agr.asu.edu.eg`;
  const password =
    options.password === undefined ? `correct horse ${counter} battery` : options.password;
  // A student waiting for verification has no record yet (§4.2 Case B).
  const withRecord = role === 'STUDENT' && options.status !== 'PENDING_VERIFICATION';
  const seatNumber = withRecord ? (options.seatNumber ?? `S${1000 + counter}`) : undefined;
  const user = await prisma.user.create({
    data: {
      email,
      role,
      status: options.status ?? 'ACTIVE',
      displayName: `Test ${role} ${counter}`,
      passwordHash: password ? await hashPassword(password) : null,
      mustChangePassword: options.mustChangePassword ?? false,
      emailVerifiedAt: new Date(),
      ...(role === 'STUDENT'
        ? withRecord
          ? {
              studentProfile: {
                create: {
                  seatNumber: seatNumber!,
                  fullName: `Student ${counter}`,
                  universityEmail: email,
                  linkedAt: new Date(),
                },
              },
            }
          : {}
        : { facultyProfile: { create: { fullName: `Staff ${counter}` } } }),
    },
  });
  return { id: user.id, email, password, role, seatNumber };
}

export interface SeededRecord {
  id: string;
  seatNumber: string;
  fullName: string;
  universityEmail: string | null;
}

/** Inserts an unlinked student record, as an import would. */
export async function createStudentRecord(
  app: TestApp,
  options: {
    seatNumber?: string;
    fullName?: string;
    parts?: [string, string, string, string];
    universityEmail?: string | null;
    phone?: string | null;
  } = {},
): Promise<SeededRecord> {
  counter += 1;
  const prisma = app.get(PrismaService);
  const parts = options.parts;
  const record = await prisma.studentProfile.create({
    data: {
      seatNumber: options.seatNumber ?? `R${2000 + counter}`,
      fullName: parts ? parts.join(' ') : (options.fullName ?? `Record Student ${counter}`),
      ...(parts
        ? {
            firstName: parts[0],
            fatherName: parts[1],
            grandfatherName: parts[2],
            familyName: parts[3],
          }
        : {}),
      universityEmail: options.universityEmail ?? null,
      phone: options.phone ?? null,
    },
  });
  return {
    id: record.id,
    seatNumber: record.seatNumber,
    fullName: record.fullName,
    universityEmail: record.universityEmail,
  };
}

export async function createGroup(
  app: TestApp,
  name?: string,
): Promise<{ id: string; name: string }> {
  counter += 1;
  const group = await app
    .get(PrismaService)
    .trainingGroup.create({ data: { name: name ?? `Group ${counter}` } });
  return { id: group.id, name: group.name };
}

export async function addToGroup(app: TestApp, studentId: string, groupId: string): Promise<void> {
  await app
    .get(PrismaService)
    .groupMembership.create({ data: { studentId, groupId, source: 'MANUAL' } });
}

/** The record id linked to an account. */
export async function recordOf(app: TestApp, userId: string): Promise<string> {
  return (await app.get(PrismaService).studentProfile.findUniqueOrThrow({ where: { userId } })).id;
}

/** An .xlsx file: one header row, then the given rows. Cells may be any exceljs value. */
export async function buildWorkbook(
  headers: string[],
  rows: CellValue[][],
  sheetName = 'Students',
): Promise<Buffer> {
  const workbook = new Workbook();
  const sheet = workbook.addWorksheet(sheetName);
  sheet.addRow(headers);
  for (const row of rows) sheet.addRow(row);
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

/** Template-style headers in the template's column order. */
export const TEMPLATE_HEADERS = [
  'رقم الجلوس / Seat number',
  'الاسم الأول / First name',
  "اسم الأب / Father's name",
  "اسم الجد / Grandfather's name",
  'اسم العائلة / Family name',
  'البريد الجامعي / University email',
  'المجموعة / Group',
  'رقم الهاتف / Phone',
];

export async function login(
  app: TestApp,
  identifier: string,
  password: string,
): Promise<AuthResponse> {
  const res = await request(app.getHttpServer())
    .post('/auth/login')
    .send({ identifier, password })
    .expect(200);
  return res.body as AuthResponse;
}

export const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

/** Headers the web BFF sends to pass the browser's IP. */
export const fromClientIp = (ip: string) => ({
  [CLIENT_IP_HEADER]: ip,
  [PROXY_KEY_HEADER]: process.env.BFF_SHARED_SECRET!,
});

export { hashPassword };
