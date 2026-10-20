import { Injectable } from '@nestjs/common';
import { deriveKey, hmacSha256Hex, randomNumericCode, safeEqual } from '../common/crypto';
import { type RequestContext } from '../common/request-context';
import { AppConfigService } from '../config/app-config.service';
import { type ChallengePurpose, type Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AUTH } from './auth.constants';

/**
 * Emailed one-time codes, keyed by the recipient address (a code may be sent
 * before any account exists: first login of an imported student, signup). Only
 * an HMAC of (email, purpose, code) is stored, so a database leak does not
 * reveal live codes. A code is single-use, expires after `AUTH.codeSeconds`,
 * allows `AUTH.codeMaxAttempts` guesses, and is superseded by any newer code for
 * the same address and purpose.
 */
@Injectable()
export class ChallengeService {
  private readonly key: Buffer;

  constructor(
    private readonly prisma: PrismaService,
    config: AppConfigService,
  ) {
    this.key = deriveKey(config.get('JWT_ACCESS_SECRET'), 'auth-challenge-code');
  }

  private hash(email: string, purpose: ChallengePurpose, code: string): string {
    return hmacSha256Hex(this.key, `${email}:${purpose}:${code}`);
  }

  /** Creates a new code (invalidating older ones) and returns it for delivery. */
  async issue(
    email: string,
    purpose: ChallengePurpose,
    context: RequestContext,
    options: { userId?: string | null; tx?: Prisma.TransactionClient } = {},
  ): Promise<string> {
    const client = options.tx ?? this.prisma;
    const now = new Date();
    await client.authChallenge.updateMany({
      where: { email, purpose, consumedAt: null, expiresAt: { gt: now } },
      data: { expiresAt: now },
    });
    const code = randomNumericCode(AUTH.codeDigits);
    await client.authChallenge.create({
      data: {
        email,
        userId: options.userId ?? null,
        purpose,
        codeHash: this.hash(email, purpose, code),
        expiresAt: new Date(now.getTime() + AUTH.codeSeconds * 1000),
        maxAttempts: AUTH.codeMaxAttempts,
        requestIp: context.ip,
      },
    });
    return code;
  }

  /** Consumes the code if it is the live one for this address and purpose. */
  async consume(email: string, purpose: ChallengePurpose, code: string): Promise<boolean> {
    const now = new Date();
    const challenge = await this.prisma.authChallenge.findFirst({
      where: { email, purpose, consumedAt: null, expiresAt: { gt: now } },
      orderBy: { createdAt: 'desc' },
    });
    if (!challenge || challenge.attempts >= challenge.maxAttempts) return false;

    // Count the attempt atomically before comparing, so parallel guesses cannot exceed the limit.
    const counted = await this.prisma.authChallenge.updateMany({
      where: { id: challenge.id, consumedAt: null, attempts: { lt: challenge.maxAttempts } },
      data: { attempts: { increment: 1 } },
    });
    if (counted.count !== 1) return false;
    if (!safeEqual(this.hash(email, purpose, code), challenge.codeHash)) return false;

    const consumed = await this.prisma.authChallenge.updateMany({
      where: { id: challenge.id, consumedAt: null },
      data: { consumedAt: now },
    });
    return consumed.count === 1;
  }
}
