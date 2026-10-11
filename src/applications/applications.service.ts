import {
  ForbiddenException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, Repository } from 'typeorm';
import { AuditAction } from '../audit/audit-action.enum';
import { AuditService } from '../audit/audit.service';
import { AuthenticatedUser } from '../auth/authenticated-user.interface';
import { paginate, Paginated } from '../common/dto/pagination.dto';
import { RiskService } from '../risk/risk.service';
import { Role } from '../users/role.enum';
import { UsersService } from '../users/users.service';
import { ApplicationStatus, RiskStatus } from './application-status.enum';
import { MerchantApplication } from './application.entity';
import {
  assertAssignable,
  assertEditable,
  assertTransition,
  resolveDecision,
} from './domain/application-state-machine';
import { ApplicationPolicy } from './domain/application.policy';
import { AssignReviewerDto } from './dto/assign-reviewer.dto';
import { CreateApplicationDto, ProcessingInfoDto } from './dto/create-application.dto';
import { ListApplicationsQueryDto } from './dto/list-applications-query.dto';
import { ReviewDecisionDto } from './dto/review-decision.dto';
import { UpdateApplicationDto } from './dto/update-application.dto';

const ENTITY_TYPE = 'merchant_application';

@Injectable()
export class ApplicationsService {
  constructor(
    @InjectRepository(MerchantApplication)
    private readonly applications: Repository<MerchantApplication>,
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly users: UsersService,
    private readonly risk: RiskService,
    private readonly audit: AuditService,
  ) {}

  // ---------------------------------------------------------------------------
  // Queries
  // ---------------------------------------------------------------------------

  /** Scoped lookup: anything outside the caller's scope is reported as 404. */
  async findOneForUser(id: string, user: AuthenticatedUser): Promise<MerchantApplication> {
    const app = await this.applications.findOne({
      where: { id, ...ApplicationPolicy.scopeFor(user) },
    });
    if (!app) throw new NotFoundException('Application not found');
    return app;
  }

  async list(
    query: ListApplicationsQueryDto,
    user: AuthenticatedUser,
  ): Promise<Paginated<MerchantApplication>> {
    // Scope is applied last so a caller-supplied filter can never widen it.
    const where = {
      ...(query.status && { status: query.status }),
      ...(query.riskStatus && { riskStatus: query.riskStatus }),
      ...(query.assignedReviewerId && { assignedReviewerId: query.assignedReviewerId }),
      ...ApplicationPolicy.scopeFor(user),
    };
    const [rows, total] = await this.applications.findAndCount({
      where,
      order: { [query.sortBy]: query.sortOrder, id: 'ASC' },
      skip: (query.page - 1) * query.limit,
      take: query.limit,
    });
    return paginate(rows, total, query.page, query.limit);
  }

  // ---------------------------------------------------------------------------
  // Commands
  // ---------------------------------------------------------------------------

  async create(dto: CreateApplicationDto, user: AuthenticatedUser): Promise<MerchantApplication> {
    assertProcessingConsistent(dto.processing);

    return this.dataSource.transaction(async (em) => {
      const app = await em.save(
        em.create(MerchantApplication, {
          ...dto,
          websiteUrl: dto.websiteUrl ?? null,
          settlementAccountNumber: dto.settlementAccountNumber ?? null,
          status: ApplicationStatus.DRAFT,
          riskStatus: RiskStatus.NOT_STARTED,
          createdById: user.id,
        }),
      );
      await this.audit.record(
        {
          action: AuditAction.APPLICATION_CREATED,
          actor: user,
          entityType: ENTITY_TYPE,
          entityId: app.id,
          metadata: { businessName: app.businessName, status: app.status },
        },
        em,
      );
      return app;
    });
  }

  async update(
    id: string,
    dto: UpdateApplicationDto,
    user: AuthenticatedUser,
  ): Promise<MerchantApplication> {
    return this.dataSource.transaction(async (em) => {
      const app = await this.lockForUser(em, id, user);
      if (!ApplicationPolicy.canEdit(user, app)) {
        throw new ForbiddenException('You cannot edit this application');
      }
      assertEditable(app.status);

      const changedFields = Object.keys(dto).filter(
        (k) => dto[k as keyof UpdateApplicationDto] !== undefined,
      );
      if (changedFields.length === 0) return app;

      const next = em.merge(MerchantApplication, app, dto);
      assertProcessingConsistent(next.processing);
      const saved = await em.save(next);

      await this.audit.record(
        {
          action: AuditAction.APPLICATION_UPDATED,
          actor: user,
          entityType: ENTITY_TYPE,
          entityId: app.id,
          // Field names only — values may be sensitive.
          metadata: { changedFields },
        },
        em,
      );
      return saved;
    });
  }

  /**
   * DRAFT/INFO_REQUESTED -> SUBMITTED. Creates the risk job row in the same transaction,
   * then enqueues the background check after commit.
   */
  async submit(id: string, user: AuthenticatedUser): Promise<MerchantApplication> {
    const { app, riskJob } = await this.dataSource.transaction(async (em) => {
      const app = await this.lockForUser(em, id, user);
      if (!ApplicationPolicy.canEdit(user, app)) {
        throw new ForbiddenException('You cannot submit this application');
      }
      assertTransition(app.status, ApplicationStatus.SUBMITTED);

      const isResubmission = app.status === ApplicationStatus.INFO_REQUESTED;
      Object.assign(app, {
        status: ApplicationStatus.SUBMITTED,
        submissionCount: app.submissionCount + 1,
        submittedAt: new Date(),
        riskStatus: RiskStatus.PENDING,
        riskLevel: null,
        riskScore: null,
        riskCheckedAt: null,
        // A previous REQUEST_INFO decision no longer applies to the new submission.
        decidedById: null,
        decidedAt: null,
        decisionReason: null,
      });
      const saved = await em.save(app);
      const riskJob = await this.risk.createRiskJob(em, saved);

      await this.audit.record(
        {
          action: AuditAction.APPLICATION_SUBMITTED,
          actor: user,
          entityType: ENTITY_TYPE,
          entityId: app.id,
          metadata: {
            submissionNumber: saved.submissionCount,
            riskJobId: riskJob.id,
            resubmission: isResubmission,
          },
        },
        em,
      );
      return { app: saved, riskJob };
    });

    await this.risk.enqueueSafely(riskJob);
    return app;
  }

  async assignReviewer(
    id: string,
    dto: AssignReviewerDto,
    user: AuthenticatedUser,
  ): Promise<MerchantApplication> {
    if (!ApplicationPolicy.canAssign(user)) {
      throw new ForbiddenException('Only ADMIN can assign reviewers');
    }
    const reviewer = await this.users.findActiveById(dto.reviewerId);
    if (!reviewer || reviewer.role !== Role.REVIEWER) {
      throw new UnprocessableEntityException('reviewerId must reference an active REVIEWER');
    }

    return this.dataSource.transaction(async (em) => {
      const app = await this.lockForUser(em, id, user);
      assertAssignable(app.status);

      const previousReviewerId = app.assignedReviewerId;
      app.assignedReviewerId = reviewer.id;
      app.assignedAt = new Date();
      const saved = await em.save(app);

      await this.audit.record(
        {
          action: AuditAction.APPLICATION_ASSIGNED,
          actor: user,
          entityType: ENTITY_TYPE,
          entityId: app.id,
          metadata: { reviewerId: reviewer.id, previousReviewerId },
        },
        em,
      );
      return saved;
    });
  }

  async recordDecision(
    id: string,
    dto: ReviewDecisionDto,
    user: AuthenticatedUser,
  ): Promise<MerchantApplication> {
    return this.dataSource.transaction(async (em) => {
      const app = await this.lockForUser(em, id, user);
      if (!ApplicationPolicy.canDecide(user, app)) {
        throw new ForbiddenException('Only the assigned reviewer can record a decision');
      }
      const from = app.status;
      const target = resolveDecision(app.status, app.riskStatus, dto.decision, dto.reason);

      Object.assign(app, {
        status: target,
        decidedById: user.id,
        decidedAt: new Date(),
        decisionReason: dto.reason ?? null,
      });
      const saved = await em.save(app);

      await this.audit.record(
        {
          action: AuditAction.APPLICATION_DECISION_RECORDED,
          actor: user,
          entityType: ENTITY_TYPE,
          entityId: app.id,
          metadata: {
            decision: dto.decision,
            from,
            to: target,
            reason: dto.reason ?? null,
            riskStatus: app.riskStatus,
            riskLevel: app.riskLevel,
          },
        },
        em,
      );
      return saved;
    });
  }

  /**
   * SELECT ... FOR UPDATE within the caller's scope. Serialises concurrent commands on the
   * same application (e.g. two decisions racing, or an edit racing a submit).
   */
  private async lockForUser(
    em: EntityManager,
    id: string,
    user: AuthenticatedUser,
  ): Promise<MerchantApplication> {
    const app = await em.findOne(MerchantApplication, {
      where: { id, ...ApplicationPolicy.scopeFor(user) },
      lock: { mode: 'pessimistic_write' },
    });
    if (!app) throw new NotFoundException('Application not found');
    return app;
  }
}

/** Cross-field rule class-validator can't express cleanly. */
export function assertProcessingConsistent(
  p: Pick<ProcessingInfoDto, 'averageTicketMinor' | 'expectedMonthlyVolumeMinor'>,
) {
  if (p.averageTicketMinor > p.expectedMonthlyVolumeMinor) {
    throw new UnprocessableEntityException(
      'processing.averageTicketMinor cannot exceed processing.expectedMonthlyVolumeMinor',
    );
  }
}
