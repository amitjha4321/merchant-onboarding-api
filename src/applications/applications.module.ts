import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { RiskModule } from '../risk/risk.module';
import { UsersModule } from '../users/users.module';
import { ApplicationsController } from './applications.controller';
import { MerchantApplication } from './application.entity';
import { ApplicationsService } from './applications.service';

@Module({
  imports: [TypeOrmModule.forFeature([MerchantApplication]), UsersModule, RiskModule],
  controllers: [ApplicationsController],
  providers: [ApplicationsService],
})
export class ApplicationsModule {}
