import { type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { type AuthResponse, type Role } from '@ftms/core';
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
  const seatNumber = role === 'STUDENT' ? (options.seatNumber ?? `S${1000 + counter}`) : undefined;
  const user = await prisma.user.create({
    data: {
      email,
      role,
      status: options.status ?? 'ACTIVE',
      displayName: `Test ${role} ${counter}`,
      passwordHash: password ? await hashPassword(password) : null,
      mustChangePassword: options.mustChangePassword ?? false,
      ...(role === 'STUDENT'
        ? {
            studentProfile: { create: { seatNumber: seatNumber!, fullName: `Student ${counter}` } },
          }
        : { facultyProfile: { create: { fullName: `Staff ${counter}` } } }),
    },
  });
  return { id: user.id, email, password, role, seatNumber };
}

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
