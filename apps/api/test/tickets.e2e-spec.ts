import { ListTicketsResponseSchema, TicketDetailSchema } from '@ftms/core';
import request from 'supertest';
import { BackgroundTasks } from '../src/common/background-tasks.service';
import { PrismaService } from '../src/prisma/prisma.service';
import {
  addToGroup,
  bearer,
  bootTestApp,
  createGroup,
  createUser,
  login,
  recordOf,
  resetDatabase,
  type SeededUser,
  type TestApp,
} from './helpers/test-app';

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);
const PDF = Buffer.from('%PDF-1.4\n1 0 obj << >> endobj\ntrailer << >>\n%%EOF\n');

interface Student {
  user: SeededUser;
  token: string;
  recordId: string;
}

describe('Support tickets (§13)', () => {
  let app: TestApp;
  let prisma: PrismaService;
  const http = () => request(app.getHttpServer());

  let faculty: SeededUser;
  let facultyToken: string;
  let student: Student;
  let other: Student;

  beforeAll(async () => {
    ({ app } = await bootTestApp());
    prisma = app.get(PrismaService);
  });
  afterAll(async () => {
    await app.close();
  });

  async function newStudent(): Promise<Student> {
    const user = await createUser(app, 'STUDENT');
    const recordId = await recordOf(app, user.id);
    return { user, recordId, token: (await login(app, user.email, user.password!)).accessToken };
  }

  beforeEach(async () => {
    await resetDatabase(app);
    faculty = await createUser(app, 'FACULTY');
    facultyToken = (await login(app, faculty.email, faculty.password!)).accessToken;
    student = await newStudent();
    other = await newStudent();
    const group = await createGroup(app, 'المجموعة أ');
    await addToGroup(app, student.recordId, group.id);
  });

  const create = (s: Student, fields: Record<string, string>, files: [Buffer, string][] = []) => {
    let req = http().post('/tickets').set(bearer(s.token));
    for (const [key, value] of Object.entries(fields)) req = req.field(key, value);
    for (const [body, name] of files) req = req.attach('files', body, name);
    return req;
  };

  const message = (
    token: string,
    id: string,
    body: string,
    extra: Record<string, string> = {},
    files: [Buffer, string][] = [],
  ) => {
    let req = http().post(`/tickets/${id}/messages`).set(bearer(token)).field('body', body);
    for (const [key, value] of Object.entries(extra)) req = req.field(key, value);
    for (const [buf, name] of files) req = req.attach('files', buf, name);
    return req;
  };

  const detail = async (token: string, id: string) =>
    TicketDetailSchema.parse(
      (await http().get(`/tickets/${id}`).set(bearer(token)).expect(200)).body,
    );

  const expectError = (res: request.Response, status: number, code: string) =>
    expect({ status: res.status, code: res.body?.code }).toEqual({ status, code });

  async function complaint(s: Student = student) {
    const res = await create(
      s,
      {
        category: 'COMPLAINT',
        subject: 'الحافلة تأخرت',
        description: 'Bus 3 left 40 minutes late on Monday.',
      },
      [
        [PDF, 'schedule.pdf'],
        [PNG, 'صورة.png'],
      ],
    );
    expect(res.status).toBe(201);
    return TicketDetailSchema.parse(res.body);
  }

  it('creates a ticket with attachments kept in private storage', async () => {
    const ticket = await complaint();
    expect(ticket).toMatchObject({
      category: 'COMPLAINT',
      subject: 'الحافلة تأخرت',
      status: 'OPEN',
      student: null,
      swap: null,
      resolution: null,
    });
    expect(ticket.number).toBeGreaterThan(0);
    expect(ticket.history).toEqual([
      expect.objectContaining({
        from: null,
        to: 'OPEN',
        by: { kind: 'STUDENT', name: expect.any(String) },
      }),
    ]);
    expect(ticket.attachments.map((a) => [a.fileName, a.contentType])).toEqual([
      ['schedule.pdf', 'application/pdf'],
      ['صورة.png', 'image/png'],
    ]);
    // Short-lived signed links, served without any other check (local driver in tests).
    const link = ticket.attachments[0]!.url.replace(/^\/files\//, '/local-files/');
    const file = await http()
      .get(link)
      .buffer(true)
      .parse((r, done) => {
        const chunks: Buffer[] = [];
        r.on('data', (c: Buffer) => chunks.push(c));
        r.on('end', () => done(null, Buffer.concat(chunks)));
      })
      .expect(200);
    expect(Buffer.compare(file.body as Buffer, PDF)).toBe(0);
    const stored = await prisma.ticketAttachment.findMany({ where: { ticketId: ticket.id } });
    expect(stored.every((a) => a.bucket === 'ticket-attachments')).toBe(true);
    expect(stored.every((a) => a.storagePath.startsWith('tickets/'))).toBe(true);

    const audit = await prisma.auditLog.findFirstOrThrow({
      where: { action: 'ticket.created', resourceId: ticket.id },
    });
    expect(audit).toMatchObject({ actorId: student.user.id, after: { attachments: 2 } });
  });

  it('validates the form and the files', async () => {
    const base = {
      category: 'SUGGESTION',
      subject: 'More shade',
      description: 'Please add tents.',
    };
    expectError(await create(student, { ...base, subject: ' ' }), 400, 'VALIDATION_FAILED');
    expectError(
      await create(student, { ...base, category: 'GROUP_SWAP' }),
      400,
      'VALIDATION_FAILED',
    );
    const fake = Buffer.from('MZ not really a pdf');
    expectError(await create(student, base, [[fake, 'tool.pdf']]), 400, 'FILE_TYPE_NOT_ALLOWED');
    const big = Buffer.concat([PDF, Buffer.alloc(4 * 1024 * 1024)]);
    expect((await create(student, base, [[big, 'big.pdf']])).status).toBe(413);
    expect(await prisma.supportTicket.count()).toBe(0);
    // Staff do not open tickets; students do.
    const res = await http()
      .post('/tickets')
      .set(bearer(facultyToken))
      .field('category', 'COMPLAINT')
      .field('subject', 'x x x')
      .field('description', 'y y y');
    expectError(res, 403, 'FORBIDDEN');
  });

  it('shows students only their own tickets, filterable by category and status', async () => {
    const mine = await complaint();
    await create(student, {
      category: 'SUGGESTION',
      subject: 'Water at the farm',
      description: 'Bring more water.',
    }).expect(201);
    const theirs = await complaint(other);

    const list = async (s: Student, query = '') =>
      ListTicketsResponseSchema.parse(
        (await http().get(`/me/tickets${query}`).set(bearer(s.token)).expect(200)).body,
      );
    expect((await list(student)).total).toBe(2);
    expect((await list(student, '?category=COMPLAINT')).items.map((t) => t.id)).toEqual([mine.id]);
    expect((await list(student, '?status=CLOSED')).total).toBe(0);
    expect((await list(student, '?status=ACTIVE')).total).toBe(2);
    expect((await list(other)).items.map((t) => t.id)).toEqual([theirs.id]);

    // Another student's ticket does not exist for them.
    expectError(
      await http().get(`/tickets/${theirs.id}`).set(bearer(student.token)),
      404,
      'NOT_FOUND',
    );
    expectError(await message(student.token, theirs.id, 'hello'), 404, 'NOT_FOUND');
    // Students cannot use the staff list.
    expectError(await http().get('/tickets').set(bearer(student.token)), 403, 'FORBIDDEN');
  });

  it('gives staff a searchable queue with the students’ details', async () => {
    const ticket = await complaint();
    await complaint(other);
    const queue = async (query: string) =>
      ListTicketsResponseSchema.parse(
        (await http().get(`/tickets${query}`).set(bearer(facultyToken)).expect(200)).body,
      );
    const all = await queue('?status=ACTIVE');
    expect(all.total).toBe(2);
    const row = all.items.find((t) => t.id === ticket.id)!;
    expect(row.student).toMatchObject({
      id: student.recordId,
      seatNumber: student.user.seatNumber,
      group: { name: 'المجموعة أ' },
    });
    expect((await queue(`?q=%23${ticket.number}`)).items.map((t) => t.id)).toEqual([ticket.id]);
    expect((await queue(`?q=${student.user.seatNumber}`)).items.map((t) => t.id)).toEqual([
      ticket.id,
    ]);
  });

  it('runs the conversation: replies, internal notes, status changes, and student privacy', async () => {
    const ticket = await complaint();
    const facultyName = (await prisma.user.findUniqueOrThrow({ where: { id: faculty.id } }))
      .displayName;

    // A staff reply marks it in progress and tells the student.
    await message(facultyToken, ticket.id, 'We are checking with the driver.').expect(201);
    // An internal note (with a file) never reaches the student.
    await message(
      facultyToken,
      ticket.id,
      'Driver was sick; replacement arranged.',
      {
        internal: 'true',
      },
      [[PDF, 'note.pdf']],
    ).expect(201);
    // Students cannot write internal notes.
    expectError(
      await message(student.token, ticket.id, 'secret', { internal: 'true' }),
      403,
      'FORBIDDEN',
    );

    const staffView = await detail(facultyToken, ticket.id);
    expect(staffView.status).toBe('IN_PROGRESS');
    expect(staffView.messages.map((m) => [m.internal, m.author])).toEqual([
      [false, { kind: 'STAFF', name: facultyName }],
      [true, { kind: 'STAFF', name: facultyName }],
    ]);
    expect(staffView.messages[1]!.attachments).toHaveLength(1);

    const studentView = await detail(student.token, ticket.id);
    expect(studentView.messages.map((m) => [m.body, m.author])).toEqual([
      ['We are checking with the driver.', { kind: 'STAFF', name: null }],
    ]);
    expect(studentView.history.map((h) => [h.to, h.by])).toEqual([
      ['OPEN', { kind: 'STUDENT', name: expect.any(String) }],
      ['IN_PROGRESS', { kind: 'STAFF', name: null }],
    ]);
    expect(JSON.stringify(studentView)).not.toContain(facultyName);
    expect(JSON.stringify(studentView)).not.toContain('replacement arranged');
    expect(JSON.stringify(studentView)).not.toContain('note.pdf');

    // Resolving records the outcome the student sees.
    await http()
      .post(`/tickets/${ticket.id}/status`)
      .set(bearer(facultyToken))
      .send({ status: 'RESOLVED', note: 'A replacement bus now runs on Mondays.' })
      .expect(200);
    expect(await detail(student.token, ticket.id)).toMatchObject({
      status: 'RESOLVED',
      resolution: 'A replacement bus now runs on Mondays.',
    });
    // A student reply reopens a resolved ticket.
    await message(student.token, ticket.id, 'It was late again today.').expect(201);
    const reopened = await detail(student.token, ticket.id);
    expect(reopened).toMatchObject({ status: 'OPEN', resolution: null });
    expect(reopened.history.at(-1)).toMatchObject({
      from: 'RESOLVED',
      to: 'OPEN',
      by: { kind: 'STUDENT' },
    });

    // A closed ticket takes no messages until staff reopen it.
    await http()
      .post(`/tickets/${ticket.id}/status`)
      .set(bearer(facultyToken))
      .send({ status: 'CLOSED', note: 'Handled with the transport office.' })
      .expect(200);
    expectError(await message(student.token, ticket.id, 'one more thing'), 409, 'TICKET_CLOSED');
    expectError(
      await http()
        .post(`/tickets/${ticket.id}/status`)
        .set(bearer(facultyToken))
        .send({ status: 'CLOSED' }),
      409,
      'NO_CHANGES',
    );
    await http()
      .post(`/tickets/${ticket.id}/status`)
      .set(bearer(facultyToken))
      .send({ status: 'IN_PROGRESS' })
      .expect(200);
    await message(student.token, ticket.id, 'one more thing').expect(201);

    // The student was told about each staff reply and status change.
    await app.get(BackgroundTasks).drain();
    const notes = await prisma.notification.findMany({
      where: { recipientId: student.user.id },
      orderBy: { createdAt: 'asc' },
    });
    expect(notes.map((n) => n.type).sort()).toEqual([
      'ticket.replied',
      'ticket.status_changed',
      'ticket.status_changed',
      'ticket.status_changed',
    ]);
    expect(notes.every((n) => n.link === `/tickets/${ticket.id}`)).toBe(true);
    expect(JSON.stringify(notes.map((n) => n.data))).not.toContain(facultyName);

    // Every staff action is audited with its actor.
    const actions = await prisma.auditLog.findMany({
      where: { resourceType: 'ticket', resourceId: ticket.id },
      orderBy: { id: 'asc' },
    });
    expect(actions.map((a) => a.action)).toEqual([
      'ticket.created',
      'ticket.replied',
      'ticket.note_added',
      'ticket.status_changed',
      'ticket.replied',
      'ticket.status_changed',
      'ticket.status_changed',
      'ticket.replied',
    ]);
    expect(actions.filter((a) => a.actorId === faculty.id)).toHaveLength(5);
  });

  it('keeps ticket processing to holders of tickets.process', async () => {
    const ticket = await complaint();
    const director = await createUser(app, 'TRAINING_DIRECTOR');
    const restricted = await createUser(app, 'FACULTY');
    await prisma.userPermissionGrant.create({
      data: {
        userId: restricted.id,
        permissionKey: 'tickets.process',
        effect: 'DENY',
        grantedById: director.id,
        reason: 'Not on the help desk',
      },
    });
    const token = (await login(app, restricted.email, restricted.password!)).accessToken;
    expectError(await http().get('/tickets').set(bearer(token)), 403, 'FORBIDDEN');
    expectError(await http().get(`/tickets/${ticket.id}`).set(bearer(token)), 403, 'FORBIDDEN');
    expectError(await message(token, ticket.id, 'hi'), 403, 'FORBIDDEN');
    expectError(
      await http()
        .post(`/tickets/${ticket.id}/status`)
        .set(bearer(token))
        .send({ status: 'CLOSED' }),
      403,
      'FORBIDDEN',
    );
  });
});
