import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, Repository } from 'typeorm';
import { AuthenticatedUser } from '../auth/authenticated-user.interface';
import { paginate, Paginated } from '../common/dto/pagination.dto';
import { redact } from '../common/utils/redact';
import { AuditAction } from './audit-action.enum';
import { AuditLog } from './audit-log.entity';
import { ListAuditLogsQueryDto } from './dto/list-audit-logs-query.dto';

export interface AuditEntry {
  action: AuditAction;
  /** `null` = system actor (background worker). */
  actor: Pick<AuthenticatedUser, 'id' | 'role'> | null;
  entityType: string;
  entityId: string | null;
  metadata?: Record<string, unknown>;
}

@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name);

  constructor(@InjectRepository(AuditLog) private readonly logs: Repository<AuditLog>) {}

  /**
   * Persist an audit entry. Pass the caller's transactional EntityManager so the audit row
   * commits (or rolls back) atomically with the business change it describes.
   */
  async record(entry: AuditEntry, em?: EntityManager): Promise<void> {
    const repo = em ? em.getRepository(AuditLog) : this.logs;
    await repo.save(
      repo.create({
        action: entry.action,
        actorId: entry.actor?.id ?? null,
        actorType: entry.actor ? 'USER' : 'SYSTEM',
        actorRole: entry.actor?.role ?? null,
        entityType: entry.entityType,
        entityId: entry.entityId,
        metadata: redact(entry.metadata ?? {}),
      }),
    );
  }

  /** Best-effort variant for events that have no surrounding transaction (e.g. failed login). */
  async recordSafely(entry: AuditEntry): Promise<void> {
    try {
      await this.record(entry);
    } catch (err) {
      this.logger.error(`Failed to write audit entry ${entry.action}`, (err as Error).stack);
    }
  }

  async list(query: ListAuditLogsQueryDto): Promise<Paginated<AuditLog>> {
    const qb = this.logs.createQueryBuilder('a').orderBy('a.createdAt', 'DESC');
    if (query.entityId) qb.andWhere('a.entityId = :entityId', { entityId: query.entityId });
    if (query.entityType)
      qb.andWhere('a.entityType = :entityType', { entityType: query.entityType });
    if (query.action) qb.andWhere('a.action = :action', { action: query.action });
    if (query.actorId) qb.andWhere('a.actorId = :actorId', { actorId: query.actorId });
    const [rows, total] = await qb
      .skip((query.page - 1) * query.limit)
      .take(query.limit)
      .getManyAndCount();
    return paginate(rows, total, query.page, query.limit);
  }
}
