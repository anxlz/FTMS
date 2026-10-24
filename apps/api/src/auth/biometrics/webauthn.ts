import { Injectable } from '@nestjs/common';
import { type WebAuthnPurpose } from '../../generated/prisma/client';
import { AppConfigService } from '../../config/app-config.service';
import { Clock } from '../../common/clock';
import { type Prisma } from '../../generated/prisma/client';
import { PrismaService } from '../../prisma/prisma.service';

type Db = Prisma.TransactionClient | PrismaService;

/** A challenge is valid this long, and only once. */
export const CHALLENGE_SECONDS = 5 * 60;

/**
 * The relying party (§4.5). Ceremonies run on the web app's pages, so its
 * origin is the expected origin and its host the relying-party id.
 */
@Injectable()
export class WebAuthnSettings {
  readonly origin: string;
  readonly rpId: string;
  readonly rpName = 'FTMS — Field Training, Faculty of Agriculture, Ain Shams University';

  constructor(config: AppConfigService) {
    const url = new URL(config.get('WEB_APP_URL') ?? 'http://localhost:3000');
    this.origin = url.origin;
    this.rpId = config.get('WEBAUTHN_RP_ID') ?? url.hostname;
  }
}

/** 16 bytes of a UUID: the WebAuthn user handle (no personal data). */
export const uuidBytes = (id: string): Uint8Array<ArrayBuffer> =>
  new Uint8Array(Buffer.from(id.replace(/-/g, ''), 'hex'));

export const uuidFromHandle = (handle: string): string | null => {
  const hex = Buffer.from(handle, 'base64url').toString('hex');
  return /^[0-9a-f]{32}$/.test(hex)
    ? `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
    : null;
};

/**
 * Single-use WebAuthn challenges, stored server-side. A registration and a
 * check-in challenge are bound to the account (and a check-in one to the
 * visit), so an assertion made for one purpose cannot be replayed for another.
 */
@Injectable()
export class WebAuthnChallenges {
  constructor(
    private readonly prisma: PrismaService,
    private readonly clock: Clock,
  ) {}

  async create(
    purpose: WebAuthnPurpose,
    challenge: string,
    binding: { userId?: string; visitId?: string } = {},
    db: Db = this.prisma,
  ): Promise<string> {
    const now = this.clock.now();
    // Housekeeping: challenges are worthless once expired.
    await db.webAuthnChallenge.deleteMany({
      where: { expiresAt: { lt: new Date(now.getTime() - 24 * 3600_000) } },
    });
    const row = await db.webAuthnChallenge.create({
      data: {
        purpose,
        challenge,
        userId: binding.userId ?? null,
        visitId: binding.visitId ?? null,
        createdAt: now,
        expiresAt: new Date(now.getTime() + CHALLENGE_SECONDS * 1000),
      },
    });
    return row.id;
  }

  /** Marks the challenge used and returns it; null when unknown, used, expired or bound elsewhere. */
  async consume(
    id: string,
    purpose: WebAuthnPurpose,
    binding: { userId?: string | null; visitId?: string | null } = {},
    db: Db = this.prisma,
  ): Promise<string | null> {
    const now = this.clock.now();
    const rows = await db.webAuthnChallenge.updateManyAndReturn({
      where: {
        id,
        purpose,
        consumedAt: null,
        expiresAt: { gt: now },
        ...(binding.userId !== undefined ? { userId: binding.userId } : {}),
        ...(binding.visitId !== undefined ? { visitId: binding.visitId } : {}),
      },
      data: { consumedAt: now },
    });
    return rows[0]?.challenge ?? null;
  }
}
