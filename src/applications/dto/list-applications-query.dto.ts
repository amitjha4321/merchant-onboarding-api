import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsEnum, IsIn, IsOptional, IsUUID } from 'class-validator';
import { PaginationQueryDto } from '../../common/dto/pagination.dto';
import { ApplicationStatus, RiskStatus } from '../application-status.enum';

export class ListApplicationsQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ enum: ApplicationStatus })
  @IsOptional()
  @IsEnum(ApplicationStatus)
  status?: ApplicationStatus;

  @ApiPropertyOptional({ enum: RiskStatus })
  @IsOptional()
  @IsEnum(RiskStatus)
  riskStatus?: RiskStatus;

  @ApiPropertyOptional({ description: 'Filter by assigned reviewer (applied within your scope)' })
  @IsOptional()
  @IsUUID()
  assignedReviewerId?: string;

  @ApiPropertyOptional({ enum: ['createdAt', 'updatedAt', 'submittedAt'], default: 'createdAt' })
  @IsOptional()
  @IsIn(['createdAt', 'updatedAt', 'submittedAt'])
  sortBy: 'createdAt' | 'updatedAt' | 'submittedAt' = 'createdAt';

  @ApiPropertyOptional({ enum: ['ASC', 'DESC'], default: 'DESC' })
  @IsOptional()
  @IsIn(['ASC', 'DESC'])
  sortOrder: 'ASC' | 'DESC' = 'DESC';
}
