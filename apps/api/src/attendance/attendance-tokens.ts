import { createHmac, timingSafeEqual } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import { type VisitQrCodes } from '@ftms/core';
import QRCode from 'qrcode';
import { deriveKey } from '../common/crypto';
import { AppConfigService } from '../config/app-config.service';

const MAC_BYTES = 16;
const CONTEXT = 'ftms:attendance-qr:v1:';

const idBytes = (uuid: string): Buffer => Buffer.from(uuid.replace(/-/g, ''), 'hex');
const uuidOf = (bytes: Buffer): string => {
  const h = bytes.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
};

/**
 * Stable, HMAC-signed attendance QR tokens (§7.2): the visit id plus a MAC, so
 * the same printed code works for the whole visit, cannot be forged for another
 * visit, and carries no personal data. The token only identifies the visit —
 * every eligibility rule is checked by the API at check-in.
 */
@Injectable()
export class AttendanceTokens {
  private readonly logger = new Logger(AttendanceTokens.name);
  private readonly key: Buffer;
  private readonly webBase: string;

  constructor(config: AppConfigService) {
    const secret = config.get('QR_HMAC_SECRET');
    if (!secret) {
      // Production refuses to boot without QR_HMAC_SECRET (config/env.ts).
      this.logger.warn('QR_HMAC_SECRET is not set; using a key derived from JWT_ACCESS_SECRET');
    }
    this.key = deriveKey(secret ?? config.get('JWT_ACCESS_SECRET'), 'attendance-qr');
    this.webBase = (config.get('WEB_APP_URL') ?? 'http://localhost:3000').replace(/\/+$/, '');
  }

  private mac(id: Buffer): Buffer {
    return createHmac('sha256', this.key)
      .update(CONTEXT)
      .update(id)
      .digest()
      .subarray(0, MAC_BYTES);
  }

  sign(visitId: string): string {
    const id = idBytes(visitId);
    return Buffer.concat([id, this.mac(id)]).toString('base64url');
  }

  /** The visit id, or null when the token is malformed or was not signed by us. */
  verify(token: string): string | null {
    const bytes = Buffer.from(token, 'base64url');
    if (bytes.length !== 16 + MAC_BYTES || bytes.toString('base64url') !== token) return null;
    const id = bytes.subarray(0, 16);
    return timingSafeEqual(bytes.subarray(16), this.mac(id)) ? uuidOf(id) : null;
  }

  checkInUrl(visitId: string): string {
    return `${this.webBase}/check-in/${this.sign(visitId)}`;
  }

  detailsUrl(visitId: string): string {
    return `${this.webBase}/visits/${visitId}`;
  }

  /** Both codes of a visit, as SVG data URIs ready to print (§7). */
  async qrCodes(visitId: string): Promise<VisitQrCodes> {
    const svg = async (url: string) => {
      const markup = await QRCode.toString(url, {
        type: 'svg',
        errorCorrectionLevel: 'M',
        margin: 2,
        width: 320,
      });
      return `data:image/svg+xml;base64,${Buffer.from(markup, 'utf8').toString('base64')}`;
    };
    const details = this.detailsUrl(visitId);
    const attendance = this.checkInUrl(visitId);
    return {
      details: { url: details, svg: await svg(details) },
      attendance: { url: attendance, svg: await svg(attendance) },
    };
  }
}
