import { PROGRAM_TIME_ZONE, zonedToUtc } from '@ftms/core';
import { PrismaService } from '../src/prisma/prisma.service';
import {
  bootTestApp,
  createGroup,
  createProgram,
  createUser,
  createVisit,
  resetDatabase,
  type TestApp,
} from './helpers/test-app';

/** Phase 3 rules enforced by the database itself (§16.1, §16.2), violated directly. */
describe('Scheduling database rules (real Postgres)', () => {
  let app: TestApp;
  let prisma: PrismaService;
  let programId: string;
  let groupId: string;

  beforeAll(async () => {
    ({ app } = await bootTestApp());
    prisma = app.get(PrismaService);
  });
  afterAll(async () => {
    await app.close();
  });
  beforeEach(async () => {
    await resetDatabase(app);
    programId = (await createProgram(app)).id;
    groupId = (await createGroup(app)).id;
  });

  const visitData = (date: string, startTime: string) => ({
    programId,
    title: 'Visit',
    date: new Date(`${date}T00:00:00Z`),
    startTime: new Date(`1970-01-01T${startTime}:00Z`),
    // Deliberately wrong: the database derives the instant itself.
    startsAt: new Date(0),
    checkInOpensMinutes: 15,
    graceMinutes: 15,
    checkInClosesMinutes: 60,
  });

  it('runs every session in UTC, as the driver adapter requires (§16.2)', async () => {
    const [row] = await prisma.$queryRaw<
      { tz: string }[]
    >`SELECT current_setting('TimeZone') AS tz`;
    expect(row?.tz).toBe('UTC');
  });

  it('derives UTC instants from Cairo wall-clock values, across daylight saving', async () => {
    const cases: [string, string, string][] = [
      ['2026-07-01', '10:00', '2026-07-01T07:00:00.000Z'], // summer, UTC+3
      ['2027-01-15', '10:00', '2027-01-15T08:00:00.000Z'], // winter, UTC+2
      ['2026-04-24', '00:30', '2026-04-23T22:30:00.000Z'], // skipped hour: moves forward
      ['2026-10-29', '23:30', '2026-10-29T21:30:00.000Z'], // repeated hour: standard time
    ];
    for (const [date, time, expected] of cases) {
      const visit = await prisma.trainingVisit.create({
        data: { ...visitData(date, time), groups: { create: [{ groupId }] } },
      });
      expect(visit.startsAt.toISOString()).toBe(expected);
      // The API's own conversion agrees with the database on every case.
      expect(zonedToUtc(date, time, PROGRAM_TIME_ZONE).toISOString()).toBe(expected);
    }
  });

  it('keeps at least one group on every visit (checked at commit)', async () => {
    await expect(
      prisma.trainingVisit.create({ data: visitData('2027-01-10', '10:00') }),
    ).rejects.toThrow(/at least one group/);
    const visit = await createVisit(app, programId, [groupId]);
    await expect(prisma.visitGroup.deleteMany({ where: { visitId: visit.id } })).rejects.toThrow(
      /at least one group/,
    );
    // Swapping the group inside one transaction is fine.
    const other = await createGroup(app);
    await prisma.$transaction(async (tx) => {
      await tx.visitGroup.create({ data: { visitId: visit.id, groupId: other.id } });
      await tx.visitGroup.delete({ where: { visitId_groupId: { visitId: visit.id, groupId } } });
    });
    expect(await prisma.visitGroup.count({ where: { visitId: visit.id } })).toBe(1);
  });

  it('never targets an archived group', async () => {
    const archived = await createGroup(app);
    await prisma.trainingGroup.update({
      where: { id: archived.id },
      data: { archivedAt: new Date() },
    });
    const visit = await createVisit(app, programId, [groupId]);
    await expect(
      prisma.visitGroup.create({ data: { visitId: visit.id, groupId: archived.id } }),
    ).rejects.toThrow(/archived/);
  });

  it('keeps a cancelled visit complete, coordinates paired and map links https', async () => {
    const visit = await createVisit(app, programId, [groupId]);
    const update = (data: Record<string, unknown>) =>
      prisma.trainingVisit.update({ where: { id: visit.id }, data });
    await expect(update({ status: 'CANCELLED' })).rejects.toThrow();
    await expect(update({ latitude: 30 })).rejects.toThrow();
    await expect(update({ mapUrl: 'javascript:alert(1)' })).rejects.toThrow();
    await expect(update({ graceMinutes: 90 })).rejects.toThrow();
    await expect(
      update({ status: 'CANCELLED', cancelReason: 'Rain', cancelledAt: new Date() }),
    ).resolves.toMatchObject({ status: 'CANCELLED' });
  });

  it('allows one current program, one cover per visit and one day off per date', async () => {
    await expect(createProgram(app)).rejects.toThrow();
    const visit = await createVisit(app, programId, [groupId]);
    const cover = (path: string) =>
      prisma.visitFile.create({
        data: {
          visitId: visit.id,
          kind: 'COVER',
          bucket: 'visit-media',
          storagePath: path,
          fileName: 'c.png',
          contentType: 'image/png',
          sizeBytes: 10,
        },
      });
    await cover('visits/a.png');
    await expect(cover('visits/b.png')).rejects.toThrow();

    const dayOff = () =>
      prisma.scheduleException.create({
        data: { programId, date: new Date('2027-01-07T00:00:00Z'), reason: 'Holiday' },
      });
    await dayOff();
    await expect(dayOff()).rejects.toThrow();
  });

  it('freezes an ended schedule', async () => {
    const schedule = await prisma.trainingSchedule.create({
      data: {
        programId,
        title: 'Weekly',
        weekdays: [0, 3],
        startTime: new Date('1970-01-01T10:00:00Z'),
        startsOn: new Date('2027-01-01T00:00:00Z'),
        endsOn: new Date('2027-02-01T00:00:00Z'),
        groups: { create: [{ groupId }] },
      },
    });
    await expect(
      prisma.trainingSchedule.update({ where: { id: schedule.id }, data: { weekdays: [0, 0] } }),
    ).rejects.toThrow();
    await prisma.trainingSchedule.update({
      where: { id: schedule.id },
      data: { endedAt: new Date(), endReason: 'Done' },
    });
    await expect(
      prisma.trainingSchedule.update({ where: { id: schedule.id }, data: { title: 'Changed' } }),
    ).rejects.toThrow(/has ended/);
  });

  it('creates each notification once per recipient and event', async () => {
    const user = await createUser(app, 'STUDENT');
    const data = {
      recipientId: user.id,
      type: 'visit.created',
      data: {},
      dedupeKey: 'visit.created:x',
    };
    expect((await prisma.notification.createMany({ data, skipDuplicates: true })).count).toBe(1);
    expect((await prisma.notification.createMany({ data, skipDuplicates: true })).count).toBe(0);
    expect(await prisma.notification.count()).toBe(1);
  });
});
