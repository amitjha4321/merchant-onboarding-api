import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { RISK_QUEUE } from '../risk/risk.constants';
import { HealthController } from './health.controller';

@Module({
  imports: [BullModule.registerQueue({ name: RISK_QUEUE })],
  controllers: [HealthController],
})
export class HealthModule {}
