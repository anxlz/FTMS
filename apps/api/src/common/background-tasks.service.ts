import { Injectable, Logger, type OnApplicationShutdown } from '@nestjs/common';
import { waitUntil } from '@vercel/functions';

/**
 * Work that must not delay or shape the HTTP response — e.g. sending an email
 * after "if the account exists, we sent a code", where waiting for SMTP would
 * reveal through timing whether the account exists. On Vercel, `waitUntil`
 * keeps the function alive until the task settles; elsewhere it simply runs.
 * Failures are logged, never thrown into the request.
 */
@Injectable()
export class BackgroundTasks implements OnApplicationShutdown {
  private readonly logger = new Logger(BackgroundTasks.name);
  private readonly pending = new Set<Promise<void>>();

  run(label: string, task: () => Promise<unknown>): void {
    const promise: Promise<void> = Promise.resolve()
      .then(task)
      .then(
        () => undefined,
        (error: unknown) => {
          const message = error instanceof Error ? error.message : String(error);
          this.logger.error(`Background task "${label}" failed: ${message}`);
        },
      )
      .finally(() => this.pending.delete(promise));
    this.pending.add(promise);
    waitUntil(promise);
  }

  /** Resolves once every task started so far has settled (tests, shutdown). */
  async drain(): Promise<void> {
    while (this.pending.size > 0) await Promise.allSettled([...this.pending]);
  }

  async onApplicationShutdown(): Promise<void> {
    await this.drain();
  }
}
