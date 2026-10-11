import { ApiProperty } from '@nestjs/swagger';
import { RiskLevel } from '../../applications/application-status.enum';
import { RiskJob } from '../risk-job.entity';
import { RiskJobStatus } from '../risk-job-status.enum';

export class RiskJobResponseDto {
  id: string;
  applicationId: string;
  submissionNumber: number;
  @ApiProperty({ enum: RiskJobStatus })
  status: RiskJobStatus;
  attempts: number;
  lastError: string | null;
  provider: string | null;
  providerReference: string | null;
  score: number | null;
  @ApiProperty({ enum: RiskLevel, nullable: true })
  level: RiskLevel | null;
  reasons: string[] | null;
  completedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;

  static from(job: RiskJob): RiskJobResponseDto {
    return {
      id: job.id,
      applicationId: job.applicationId,
      submissionNumber: job.submissionNumber,
      status: job.status,
      attempts: job.attempts,
      lastError: job.lastError,
      provider: job.provider,
      providerReference: job.providerReference,
      score: job.score,
      level: job.level,
      reasons: job.reasons,
      completedAt: job.completedAt,
      createdAt: job.createdAt,
      updatedAt: job.updatedAt,
    };
  }
}
