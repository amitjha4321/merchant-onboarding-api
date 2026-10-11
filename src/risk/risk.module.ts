import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { MerchantApplication } from '../applications/application.entity';
import { RISK_PROVIDER } from './providers/risk-provider.interface';
import { SimulatedKybProvider } from './providers/simulated-kyb.provider';
import { RISK_QUEUE } from './risk.constants';
import { RiskJob } from './risk-job.entity';
import { RiskProcessor } from './risk.processor';
import { RiskService } from './risk.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([RiskJob, MerchantApplication]),
    BullModule.registerQueue({ name: RISK_QUEUE }),
  ],
  providers: [
    RiskService,
    { provide: RISK_PROVIDER, useClass: SimulatedKybProvider },
    RiskProcessor,
  ],
  exports: [RiskService],
})
export class RiskModule {}
