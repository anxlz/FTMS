/**
 * Raised when code tries to use an external service whose credentials are not
 * configured. Only reachable outside production — production refuses to boot
 * without the credentials (see `config/env.ts`).
 */
export class ServiceNotConfiguredError extends Error {
  constructor(readonly service: string) {
    super(`${service} is not configured. Set its environment variables (see .env.example).`);
    this.name = 'ServiceNotConfiguredError';
  }
}

/** Rejects with a descriptive error if `promise` does not settle within `ms`. */
export async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms} ms`)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}
