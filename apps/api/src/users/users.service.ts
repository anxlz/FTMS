import { Injectable } from '@nestjs/common';
import {
  type AccountStatus,
  canReceiveGrants,
  type CreateUserRequest,
  isStaffRole,
  isUniversityEmail,
  type ListUsersQuery,
  type ListUsersResponse,
  type MeResponse,
  PERMISSIONS,
  type Role,
  type SetPermissionGrantsRequest,
  type UpdatePreferencesRequest,
  type UpdateUserRoleRequest,
  type UpdateUserStatusRequest,
  type UserDetail,
} from '@ftms/core';
import { AuditService } from '../audit/audit.service';
import { invitationEmail } from '../auth/auth-emails';
import { actorOf, type AuthPrincipal } from '../auth/principal';
import { SessionService } from '../auth/session.service';
import { ApiException, Errors } from '../common/api-exception';
import { BackgroundTasks } from '../common/background-tasks.service';
import { type RequestContext } from '../common/request-context';
import { AppConfigService } from '../config/app-config.service';
import { type AuthMethod, Prisma } from '../generated/prisma/client';
import { MailService } from '../mail/mail.service';
import { PrismaService } from '../prisma/prisma.service';
import {
  auditSnapshot,
  toDetail,
  toMe,
  toSummary,
  USER_INCLUDE,
  type UserWithRelations,
} from './user-mapping';
import { literal } from '../common/search';

const conflict = (code: 'EMAIL_ALREADY_EXISTS' | 'SEAT_NUMBER_ALREADY_EXISTS') =>
  new ApiException(
    409,
    code,
    code === 'EMAIL_ALREADY_EXISTS' ? 'Email already in use' : 'Seat number already in use',
  );

@Injectable()
export class UsersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly sessions: SessionService,
    private readonly mail: MailService,
    private readonly background: BackgroundTasks,
    private readonly config: AppConfigService,
  ) {}

  private async load(id: string): Promise<UserWithRelations> {
    const user = await this.prisma.user.findUnique({ where: { id }, include: USER_INCLUDE });
    if (!user) throw Errors.notFound('User');
    return user;
  }

  /* ────────────────────────────── self service ────────────────────────────── */

  async me(userId: string, sessionMethod: AuthMethod): Promise<MeResponse> {
    return toMe(await this.load(userId), sessionMethod);
  }

  async updatePreferences(
    userId: string,
    sessionMethod: AuthMethod,
    input: UpdatePreferencesRequest,
  ): Promise<MeResponse> {
    // A write with `include` runs in an implicit transaction whose relation queries
    // Prisma 7 issues concurrently; write first, then read.
    await this.prisma.user.update({
      where: { id: userId },
      data: { preferredLocale: input.preferredLocale },
    });
    return this.me(userId, sessionMethod);
  }

  /* ──────────────────────────── administration ──────────────────────────── */

  /**
   * `users.manage` (Super Admin) manages every account; `faculty.manage`
   * (Training Director by default) manages faculty accounts only.
   */
  private assertCanManage(principal: AuthPrincipal, role: Role): void {
    if (principal.permissions.has('users.manage')) return;
    if (role === 'FACULTY' && principal.permissions.has('faculty.manage')) return;
    throw Errors.forbidden();
  }

  /** Defense in depth: the route guard already checked this. */
  private assertHas(
    principal: AuthPrincipal,
    permission: 'users.manage' | 'permissions.manage',
  ): void {
    if (!principal.permissions.has(permission)) throw Errors.forbidden();
  }

  private assertNotSelf(principal: AuthPrincipal, target: UserWithRelations): void {
    if (principal.userId === target.id) {
      throw new ApiException(
        409,
        'SELF_ACTION_FORBIDDEN',
        'You cannot change your own account here',
      );
    }
  }

  /** Never leave the system without an active Super Admin. */
  private async assertAnotherActiveSuperAdmin(
    target: UserWithRelations,
    tx: Prisma.TransactionClient,
  ): Promise<void> {
    if (target.role !== 'SUPER_ADMIN' || target.status !== 'ACTIVE') return;
    const others = await tx.user.count({
      where: { role: 'SUPER_ADMIN', status: 'ACTIVE', id: { not: target.id } },
    });
    if (others === 0) {
      throw new ApiException(
        409,
        'LAST_SUPER_ADMIN',
        'The last active Super Admin cannot be removed',
      );
    }
  }

  async list(query: ListUsersQuery): Promise<ListUsersResponse> {
    const q = query.q?.trim();
    const where: Prisma.UserWhereInput = {
      ...(query.role ? { role: query.role } : {}),
      ...(query.status ? { status: query.status } : {}),
      ...(q
        ? {
            OR: [
              { email: { contains: literal(q.toLowerCase()) } },
              { displayName: { contains: literal(q), mode: 'insensitive' } },
              { studentProfile: { seatNumber: { contains: literal(q.toUpperCase()) } } },
            ],
          }
        : {}),
    };
    // Two sequential reads (not one transaction: Prisma 7 runs `include` queries
    // concurrently inside interactive transactions, which pg deprecates).
    const total = await this.prisma.user.count({ where });
    const users = await this.prisma.user.findMany({
      where,
      include: USER_INCLUDE,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      skip: (query.page - 1) * query.pageSize,
      take: query.pageSize,
    });
    return { items: users.map(toSummary), total, page: query.page, pageSize: query.pageSize };
  }

  async detail(id: string): Promise<UserDetail> {
    return toDetail(await this.load(id));
  }

  /**
   * Creates an account without a password. The person signs in the first time
   * with an emailed code and then sets a password (§4.3).
   */
  async create(
    principal: AuthPrincipal,
    input: CreateUserRequest,
    context: RequestContext,
  ): Promise<UserDetail> {
    this.assertCanManage(principal, input.role);
    if (
      input.role === 'STUDENT' &&
      !isUniversityEmail(input.email, this.config.get('UNIVERSITY_EMAIL_DOMAINS'))
    ) {
      throw new ApiException(400, 'EMAIL_NOT_UNIVERSITY', 'Use a university email address', {
        details: { email: ['EMAIL_NOT_UNIVERSITY'] },
      });
    }

    if (await this.prisma.user.findUnique({ where: { email: input.email } })) {
      throw conflict('EMAIL_ALREADY_EXISTS');
    }
    if (input.role === 'STUDENT') {
      const clash = await this.prisma.studentProfile.findFirst({
        where: { OR: [{ seatNumber: input.seatNumber }, { universityEmail: input.email }] },
      });
      if (clash) {
        throw conflict(
          clash.seatNumber === input.seatNumber
            ? 'SEAT_NUMBER_ALREADY_EXISTS'
            : 'EMAIL_ALREADY_EXISTS',
        );
      }
    }

    let userId: string;
    try {
      userId = await this.prisma.$transaction(async (tx) => {
        const created = await tx.user.create({
          data: {
            email: input.email,
            role: input.role,
            status: 'ACTIVE',
            displayName: input.fullName,
            createdById: principal.userId,
            ...(input.role === 'STUDENT'
              ? {
                  studentProfile: {
                    create: {
                      seatNumber: input.seatNumber,
                      fullName: input.fullName,
                      universityEmail: input.email,
                    },
                  },
                }
              : {
                  facultyProfile: {
                    create: {
                      fullName: input.fullName,
                      academicTitle: input.academicTitle ?? null,
                      department: input.department ?? null,
                    },
                  },
                }),
          },
        });
        await this.audit.record(
          {
            actor: actorOf(principal),
            action: 'user.created',
            resourceType: 'user',
            resourceId: created.id,
            outcome: 'SUCCESS',
            after: {
              email: created.email,
              role: created.role,
              status: created.status,
              displayName: created.displayName,
              seatNumber: input.role === 'STUDENT' ? input.seatNumber : null,
              hasPassword: false,
              grants: [],
            },
            context,
          },
          tx,
        );
        return created.id;
      });
    } catch (error) {
      // A concurrent request may have taken the email or seat number after our check.
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        const emailTaken = await this.prisma.user.findUnique({ where: { email: input.email } });
        throw conflict(emailTaken ? 'EMAIL_ALREADY_EXISTS' : 'SEAT_NUMBER_ALREADY_EXISTS');
      }
      throw error;
    }
    const user = await this.load(userId);

    const email = invitationEmail({
      displayName: user.displayName,
      role: user.role,
      email: user.email,
      webAppUrl: this.config.get('WEB_APP_URL'),
    });
    this.background.run('invitation email', () =>
      this.mail.send({ to: user.email, subject: email.subject, text: email.text }),
    );
    return toDetail(user);
  }

  async setStatus(
    principal: AuthPrincipal,
    id: string,
    input: UpdateUserStatusRequest,
    context: RequestContext,
  ): Promise<UserDetail> {
    const target = await this.load(id);
    this.assertCanManage(principal, target.role);
    this.assertNotSelf(principal, target);
    if (target.status === input.status) return toDetail(target);

    // A student account without a linked record is not verified (§4.2 Case B):
    // it can be suspended, and reactivating it returns it to the review state —
    // only the verification review (or a link) makes it ACTIVE.
    let status: AccountStatus = input.status;
    if (target.role === 'STUDENT' && !target.studentProfile && input.status === 'ACTIVE') {
      if (target.status === 'PENDING_VERIFICATION') {
        throw new ApiException(
          409,
          'AUTH_ACCOUNT_PENDING',
          'Verify this account through the review queue',
        );
      }
      status = 'PENDING_VERIFICATION';
    }
    if (target.status === status) return toDetail(target);

    await this.prisma.$transaction(async (tx) => {
      if (status === 'SUSPENDED') await this.assertAnotherActiveSuperAdmin(target, tx);
      await tx.user.update({ where: { id }, data: { status } });
      const revoked =
        status === 'SUSPENDED'
          ? await this.sessions.revokeAllForUser(id, 'account_suspended', { tx })
          : 0;
      await this.audit.record(
        {
          actor: actorOf(principal),
          action: 'user.status_changed',
          resourceType: 'user',
          resourceId: id,
          outcome: 'SUCCESS',
          reason: input.reason,
          before: { status: target.status },
          after: { status },
          metadata: { sessionsRevoked: revoked },
          context,
        },
        tx,
      );
    });
    return toDetail(await this.load(id));
  }

  /**
   * Moves a staff account between staff roles (Super Admin only). Students and
   * staff are different identities; the database rejects crossing that line too.
   */
  async setRole(
    principal: AuthPrincipal,
    id: string,
    input: UpdateUserRoleRequest,
    context: RequestContext,
  ): Promise<UserDetail> {
    this.assertHas(principal, 'users.manage');
    const target = await this.load(id);
    this.assertNotSelf(principal, target);
    if (!isStaffRole(target.role)) {
      throw new ApiException(409, 'ROLE_CHANGE_NOT_ALLOWED', 'Student accounts cannot change role');
    }
    if (target.role === input.role) return toDetail(target);

    const beforeGrants = auditSnapshot(target).grants;
    await this.prisma.$transaction(async (tx) => {
      if (input.role !== 'SUPER_ADMIN') await this.assertAnotherActiveSuperAdmin(target, tx);
      const dropGrants = !canReceiveGrants(input.role) && target.grants.length > 0;
      if (dropGrants) await tx.userPermissionGrant.deleteMany({ where: { userId: id } });
      if (!target.facultyProfile) {
        await tx.facultyProfile.create({ data: { userId: id, fullName: target.displayName } });
      }
      await tx.user.update({ where: { id }, data: { role: input.role } });
      await this.audit.record(
        {
          actor: actorOf(principal),
          action: 'user.role_changed',
          resourceType: 'user',
          resourceId: id,
          outcome: 'SUCCESS',
          reason: input.reason,
          before: { role: target.role, grants: beforeGrants },
          after: { role: input.role, grants: dropGrants ? [] : beforeGrants },
          context,
        },
        tx,
      );
    });
    return toDetail(await this.load(id));
  }

  /** Replaces a Training Director's or Faculty member's per-user grants. */
  async setGrants(
    principal: AuthPrincipal,
    id: string,
    input: SetPermissionGrantsRequest,
    context: RequestContext,
  ): Promise<UserDetail> {
    this.assertHas(principal, 'permissions.manage');
    const target = await this.load(id);
    if (!canReceiveGrants(target.role)) {
      throw new ApiException(
        400,
        'PERMISSION_NOT_GRANTABLE',
        `${target.role} accounts cannot receive grants`,
        {
          details: { role: [target.role] },
        },
      );
    }
    const forbidden = input.grants
      .map((g) => g.permission)
      .filter((key) => !PERMISSIONS[key as keyof typeof PERMISSIONS].grantable);
    if (forbidden.length > 0) {
      throw new ApiException(
        400,
        'PERMISSION_NOT_GRANTABLE',
        'These permissions cannot be granted',
        {
          details: { grants: forbidden },
        },
      );
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.userPermissionGrant.deleteMany({ where: { userId: id } });
      if (input.grants.length > 0) {
        await tx.userPermissionGrant.createMany({
          data: input.grants.map((g) => ({
            userId: id,
            permissionKey: g.permission,
            effect: g.effect,
            grantedById: principal.userId,
            reason: input.reason,
          })),
        });
      }
      await this.audit.record(
        {
          actor: actorOf(principal),
          action: 'user.permissions_changed',
          resourceType: 'user',
          resourceId: id,
          outcome: 'SUCCESS',
          reason: input.reason,
          before: { grants: auditSnapshot(target).grants },
          after: { grants: input.grants },
          context,
        },
        tx,
      );
    });
    return toDetail(await this.load(id));
  }
}
