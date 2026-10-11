import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import {
  ApiAcceptedResponse,
  ApiBearerAuth,
  ApiConflictResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnprocessableEntityResponse,
} from '@nestjs/swagger';
import { AuthenticatedUser } from '../auth/authenticated-user.interface';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { RiskService } from '../risk/risk.service';
import { RiskJobResponseDto } from '../risk/dto/risk-job-response.dto';
import { Role } from '../users/role.enum';
import { ApplicationsService } from './applications.service';
import { ApplicationResponseDto, PaginatedApplicationsDto } from './dto/application-response.dto';
import { AssignReviewerDto } from './dto/assign-reviewer.dto';
import { CreateApplicationDto } from './dto/create-application.dto';
import { ListApplicationsQueryDto } from './dto/list-applications-query.dto';
import { ReviewDecisionDto } from './dto/review-decision.dto';
import { UpdateApplicationDto } from './dto/update-application.dto';

const IdParam = () => Param('id', new ParseUUIDPipe({ version: '4' }));

@ApiTags('applications')
@ApiBearerAuth()
@ApiNotFoundResponse({ description: 'Not found, or not visible to the caller' })
@Controller('applications')
export class ApplicationsController {
  constructor(
    private readonly applications: ApplicationsService,
    private readonly risk: RiskService,
  ) {}

  @Post()
  @Roles(Role.SALES, Role.ADMIN)
  @ApiOperation({ summary: 'Create a merchant application (DRAFT)' })
  async create(
    @Body() dto: CreateApplicationDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<ApplicationResponseDto> {
    return ApplicationResponseDto.from(await this.applications.create(dto, user));
  }

  @Get()
  @ApiOperation({
    summary: 'List applications visible to the caller',
    description: 'SALES: own applications. REVIEWER: assigned to them. ADMIN: all.',
  })
  @ApiOkResponse({ type: PaginatedApplicationsDto })
  async list(
    @Query() query: ListApplicationsQueryDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<PaginatedApplicationsDto> {
    const page = await this.applications.list(query, user);
    return { ...page, data: page.data.map((a) => ApplicationResponseDto.from(a)) };
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get an application by id' })
  async findOne(
    @IdParam() id: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<ApplicationResponseDto> {
    return ApplicationResponseDto.from(await this.applications.findOneForUser(id, user));
  }

  @Patch(':id')
  @Roles(Role.SALES, Role.ADMIN)
  @ApiOperation({ summary: 'Update an application (only while DRAFT or INFO_REQUESTED)' })
  @ApiConflictResponse({ description: 'Application is not editable in its current status' })
  async update(
    @IdParam() id: string,
    @Body() dto: UpdateApplicationDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<ApplicationResponseDto> {
    return ApplicationResponseDto.from(await this.applications.update(id, dto, user));
  }

  @Post(':id/submit')
  @Roles(Role.SALES, Role.ADMIN)
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({ summary: 'Submit for review; enqueues the asynchronous risk check' })
  @ApiAcceptedResponse({ type: ApplicationResponseDto })
  @ApiConflictResponse({ description: 'Invalid state transition' })
  async submit(
    @IdParam() id: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<ApplicationResponseDto> {
    return ApplicationResponseDto.from(await this.applications.submit(id, user));
  }

  @Post(':id/assign')
  @Roles(Role.ADMIN)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Assign (or re-assign) a reviewer (ADMIN only)' })
  @ApiUnprocessableEntityResponse({ description: 'reviewerId is not an active REVIEWER' })
  async assign(
    @IdParam() id: string,
    @Body() dto: AssignReviewerDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<ApplicationResponseDto> {
    return ApplicationResponseDto.from(await this.applications.assignReviewer(id, dto, user));
  }

  @Post(':id/decision')
  @Roles(Role.REVIEWER)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Approve / reject / request info (assigned REVIEWER only)' })
  @ApiForbiddenResponse({ description: 'Caller is not the assigned reviewer' })
  @ApiConflictResponse({ description: 'Invalid state transition' })
  @ApiUnprocessableEntityResponse({ description: 'Business rule violated (e.g. risk incomplete)' })
  async decide(
    @IdParam() id: string,
    @Body() dto: ReviewDecisionDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<ApplicationResponseDto> {
    return ApplicationResponseDto.from(await this.applications.recordDecision(id, dto, user));
  }

  @Get(':id/risk-jobs')
  @Roles(Role.ADMIN, Role.REVIEWER)
  @ApiOperation({ summary: 'Risk check history for an application' })
  async riskJobs(
    @IdParam() id: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<RiskJobResponseDto[]> {
    await this.applications.findOneForUser(id, user); // object-level visibility check
    return (await this.risk.listForApplication(id)).map((j) => RiskJobResponseDto.from(j));
  }

  @Post(':id/risk-jobs/requeue')
  @Roles(Role.ADMIN)
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({ summary: 'Re-run a FAILED (or lost) risk check for the current submission' })
  async requeueRisk(
    @IdParam() id: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<RiskJobResponseDto> {
    return RiskJobResponseDto.from(await this.risk.requeue(id, user));
  }
}
