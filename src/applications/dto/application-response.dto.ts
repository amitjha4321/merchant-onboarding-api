import { ApiProperty } from '@nestjs/swagger';
import { maskTail } from '../../common/utils/redact';
import { ApplicationStatus, BusinessType, RiskLevel, RiskStatus } from '../application-status.enum';
import { MerchantApplication } from '../application.entity';
import { OwnerContactDto, ProcessingInfoDto } from './create-application.dto';

/**
 * Public representation. Encrypted fields are never returned in full — only masked
 * (last 4 visible), which is enough for an operator to confirm a value.
 */
export class ApplicationResponseDto {
  id: string;
  businessName: string;
  legalBusinessName: string;
  @ApiProperty({ enum: BusinessType })
  businessType: BusinessType;
  countryCode: string;
  websiteUrl: string | null;
  @ApiProperty({ example: '******7890' })
  taxIdMasked: string;
  @ApiProperty({ example: '********6789', nullable: true })
  settlementAccountNumberMasked: string | null;
  owner: OwnerContactDto;
  processing: ProcessingInfoDto;
  @ApiProperty({ enum: ApplicationStatus })
  status: ApplicationStatus;
  @ApiProperty({ enum: RiskStatus })
  riskStatus: RiskStatus;
  @ApiProperty({ enum: RiskLevel, nullable: true })
  riskLevel: RiskLevel | null;
  riskScore: number | null;
  riskCheckedAt: Date | null;
  submissionCount: number;
  submittedAt: Date | null;
  createdById: string;
  assignedReviewerId: string | null;
  assignedAt: Date | null;
  decidedById: string | null;
  decidedAt: Date | null;
  decisionReason: string | null;
  version: number;
  createdAt: Date;
  updatedAt: Date;

  static from(app: MerchantApplication): ApplicationResponseDto {
    return {
      id: app.id,
      businessName: app.businessName,
      legalBusinessName: app.legalBusinessName,
      businessType: app.businessType,
      countryCode: app.countryCode,
      websiteUrl: app.websiteUrl,
      taxIdMasked: maskTail(app.taxId),
      settlementAccountNumberMasked: app.settlementAccountNumber
        ? maskTail(app.settlementAccountNumber)
        : null,
      owner: { ...app.owner },
      processing: { ...app.processing },
      status: app.status,
      riskStatus: app.riskStatus,
      riskLevel: app.riskLevel,
      riskScore: app.riskScore,
      riskCheckedAt: app.riskCheckedAt,
      submissionCount: app.submissionCount,
      submittedAt: app.submittedAt,
      createdById: app.createdById,
      assignedReviewerId: app.assignedReviewerId,
      assignedAt: app.assignedAt,
      decidedById: app.decidedById,
      decidedAt: app.decidedAt,
      decisionReason: app.decisionReason,
      version: app.version,
      createdAt: app.createdAt,
      updatedAt: app.updatedAt,
    };
  }
}

export class PaginatedApplicationsDto {
  @ApiProperty({ type: [ApplicationResponseDto] })
  data: ApplicationResponseDto[];
  meta: { page: number; limit: number; total: number; totalPages: number };
}
