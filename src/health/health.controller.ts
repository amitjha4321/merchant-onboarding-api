import { InjectQueue } from '@nestjs/bullmq';
import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { InjectDataSource } from '@nestjs/typeorm';
import { Queue } from 'bullmq';
import { DataSource } from 'typeorm';
import { Public } from '../common/decorators/public.decorator';
import { RISK_QUEUE } from '../risk/risk.constants';

@ApiTags('health')
@Controller('health')
export class HealthController {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    @InjectQueue(RISK_QUEUE) private readonly riskQueue: Queue,
  ) {}

  @Public()
  @Get()
  @ApiOperation({ summary: 'Liveness/readiness: checks PostgreSQL and Redis' })
  async check(): Promise<{ status: 'ok'; db: 'up'; redis: 'up' }> {
    try {
      await this.dataSource.query('SELECT 1');
      await this.riskQueue.count(); // round-trips to Redis
      return { status: 'ok', db: 'up', redis: 'up' };
    } catch {
      throw new ServiceUnavailableException('Dependency check failed');
    }
  }
}
