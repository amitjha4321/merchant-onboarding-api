import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';
import { Role } from '../users/role.enum';
import { AuditAction } from './audit-action.enum';

/**
 * Append-only record of significant actions. UPDATE/DELETE are blocked by a DB trigger
 * (see migration). `metadata` is always passed through `redact()` before persisting.
 */
@Entity('audit_logs')
@Index('ix_audit_logs_entity', ['entityType', 'entityId', 'createdAt'])
export class AuditLog {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar', length: 64 })
  action: AuditAction;

  /** NULL for system actors (e.g. the risk worker). */
  @Index('ix_audit_logs_actor_id')
  @Column({ type: 'uuid', nullable: true })
  actorId: string | null;

  @Column({ type: 'varchar', length: 16 })
  actorType: 'USER' | 'SYSTEM';

  @Column({ type: 'varchar', length: 16, nullable: true })
  actorRole: Role | null;

  @Column({ type: 'varchar', length: 64 })
  entityType: string;

  @Column({ type: 'varchar', length: 64, nullable: true })
  entityId: string | null;

  @Column({ type: 'jsonb', default: () => "'{}'" })
  metadata: Record<string, unknown>;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;
}
