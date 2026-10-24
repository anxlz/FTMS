import { Injectable } from '@nestjs/common';

/**
 * The server's clock (§16.2: attendance is judged by the server, never by the
 * browser). Injected so tests can stand at any instant of a visit's window.
 */
@Injectable()
export class Clock {
  now(): Date {
    return new Date();
  }
}
