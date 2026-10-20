/**
 * Supabase Storage buckets used by FTMS. Every bucket is PRIVATE: objects are only
 * reachable through short-lived signed URLs issued by the API after an
 * authorization check (§16.3). Limits are enforced by Supabase on upload and are
 * re-validated by the API before any upload is accepted.
 *
 * `pnpm storage:provision` creates missing buckets and re-applies these settings
 * to existing ones, so this file is the single source of truth.
 */

const MB = 1024 * 1024;

const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
const PDF = 'application/pdf';
const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const PPTX = 'application/vnd.openxmlformats-officedocument.presentationml.presentation';

export interface BucketDefinition {
  readonly id: string;
  readonly purpose: string;
  readonly fileSizeLimitBytes: number;
  readonly allowedMimeTypes: readonly string[];
}

export const STORAGE_BUCKETS = {
  visitMedia: {
    id: 'visit-media',
    purpose: 'Visit cover photos and images (§6.3).',
    fileSizeLimitBytes: 10 * MB,
    allowedMimeTypes: IMAGE_TYPES,
  },
  visitDocuments: {
    id: 'visit-documents',
    purpose: 'Optional documents attached to visits (§6.3).',
    fileSizeLimitBytes: 25 * MB,
    allowedMimeTypes: [PDF, DOCX, XLSX, PPTX, ...IMAGE_TYPES],
  },
  studentImports: {
    id: 'student-imports',
    purpose: 'Faculty-uploaded student spreadsheets kept for import audit (§4.1).',
    fileSizeLimitBytes: 10 * MB,
    allowedMimeTypes: [XLSX, 'text/csv'],
  },
  ticketAttachments: {
    id: 'ticket-attachments',
    purpose: 'Optional support-ticket attachments (§13.2).',
    fileSizeLimitBytes: 10 * MB,
    allowedMimeTypes: [PDF, ...IMAGE_TYPES],
  },
} as const satisfies Record<string, BucketDefinition>;

export type BucketKey = keyof typeof STORAGE_BUCKETS;
export type BucketId = (typeof STORAGE_BUCKETS)[BucketKey]['id'];

export const ALL_BUCKETS: readonly BucketDefinition[] = Object.values(STORAGE_BUCKETS);
