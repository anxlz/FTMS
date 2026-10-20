import { Controller, Get, Header, Res } from '@nestjs/common';
import { type LivenessResponse, type ReadinessResponse } from '@ftms/core';
import type { Response } from 'express';
import { Public } from '../auth/decorators';
import { HealthService } from './health.service';

/** Health checks are public: uptime monitors and the web app call them without credentials. */
@Public()
@Controller('health')
export class HealthController {
  constructor(private readonly health: HealthService) {}

  /** Liveness: the process serves HTTP. Never touches a dependency. */
  @Get()
  @Header('Cache-Control', 'no-store')
  liveness(): LivenessResponse {
    return this.health.liveness();
  }

  /** Readiness: probes every dependency; 503 when the API should not receive traffic. */
  @Get('ready')
  @Header('Cache-Control', 'no-store')
  async readiness(@Res({ passthrough: true }) res: Response): Promise<ReadinessResponse> {
    const result = await this.health.readiness();
    if (result.status === 'not_ready') res.status(503);
    return result;
  }
}
