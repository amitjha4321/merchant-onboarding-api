import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Initial schema. Hand-reviewed; verified against the entities with
 * `npm run migration:generate -- src/database/migrations/Check` (must produce no changes).
 */
export class InitialSchema1760000000000 implements MigrationInterface {
  name = 'InitialSchema1760000000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`CREATE EXTENSION IF NOT EXISTS pgcrypto`);

    // ---- enums ----
    await q.query(`CREATE TYPE "user_role" AS ENUM ('ADMIN', 'REVIEWER', 'SALES')`);
    await q.query(
      `CREATE TYPE "business_type" AS ENUM ('SOLE_PROPRIETORSHIP', 'PARTNERSHIP', 'LLC', 'CORPORATION', 'NON_PROFIT')`,
    );
    await q.query(
      `CREATE TYPE "application_status" AS ENUM ('DRAFT', 'SUBMITTED', 'UNDER_REVIEW', 'INFO_REQUESTED', 'APPROVED', 'REJECTED')`,
    );
    await q.query(
      `CREATE TYPE "risk_status" AS ENUM ('NOT_STARTED', 'PENDING', 'COMPLETED', 'FAILED')`,
    );
    await q.query(`CREATE TYPE "risk_level" AS ENUM ('LOW', 'MEDIUM', 'HIGH')`);
    await q.query(
      `CREATE TYPE "risk_job_status" AS ENUM ('QUEUED', 'PROCESSING', 'COMPLETED', 'FAILED', 'SUPERSEDED')`,
    );

    // ---- users ----
    await q.query(`
      CREATE TABLE "users" (
        "id"            uuid NOT NULL DEFAULT gen_random_uuid(),
        "email"         character varying(320) NOT NULL,
        "password_hash" character varying(100) NOT NULL,
        "full_name"     character varying(200) NOT NULL,
        "role"          "user_role" NOT NULL,
        "is_active"     boolean NOT NULL DEFAULT true,
        "created_at"    TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at"    TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "pk_users" PRIMARY KEY ("id")
      )`);
    await q.query(`CREATE UNIQUE INDEX "uq_users_email" ON "users" ("email")`);

    // ---- merchant_applications ----
    // tax_id / settlement_account_number hold AES-256-GCM ciphertext (see FieldCipher).
    await q.query(`
      CREATE TABLE "merchant_applications" (
        "id"                                     uuid NOT NULL DEFAULT gen_random_uuid(),
        "business_name"                          character varying(200) NOT NULL,
        "legal_business_name"                    character varying(200) NOT NULL,
        "business_type"                          "business_type" NOT NULL,
        "country_code"                           character(2) NOT NULL,
        "website_url"                            character varying(2048),
        "tax_id"                                 text NOT NULL,
        "settlement_account_number"              text,
        "owner_full_name"                        character varying(200) NOT NULL,
        "owner_email"                            character varying(320) NOT NULL,
        "owner_phone"                            character varying(32) NOT NULL,
        "processing_mcc"                         character(4) NOT NULL,
        "processing_currency"                    character(3) NOT NULL,
        "processing_expected_monthly_volume_minor" bigint NOT NULL,
        "processing_average_ticket_minor"        bigint NOT NULL,
        "status"                                 "application_status" NOT NULL DEFAULT 'DRAFT',
        "risk_status"                            "risk_status" NOT NULL DEFAULT 'NOT_STARTED',
        "risk_level"                             "risk_level",
        "risk_score"                             smallint,
        "risk_checked_at"                        TIMESTAMP WITH TIME ZONE,
        "submission_count"                       integer NOT NULL DEFAULT 0,
        "submitted_at"                           TIMESTAMP WITH TIME ZONE,
        "created_by_id"                          uuid NOT NULL,
        "assigned_reviewer_id"                   uuid,
        "assigned_at"                            TIMESTAMP WITH TIME ZONE,
        "decided_by_id"                          uuid,
        "decided_at"                             TIMESTAMP WITH TIME ZONE,
        "decision_reason"                        text,
        "version"                                integer NOT NULL,
        "created_at"                             TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at"                             TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "pk_merchant_applications" PRIMARY KEY ("id"),
        CONSTRAINT "ck_applications_amounts_positive" CHECK (
          "processing_expected_monthly_volume_minor" > 0 AND "processing_average_ticket_minor" > 0
        ),
        CONSTRAINT "ck_applications_risk_score_range" CHECK (
          "risk_score" IS NULL OR "risk_score" BETWEEN 0 AND 100
        )
      )`);
    await q.query(
      `CREATE INDEX "ix_applications_created_by" ON "merchant_applications" ("created_by_id", "created_at")`,
    );
    await q.query(
      `CREATE INDEX "ix_applications_reviewer_status" ON "merchant_applications" ("assigned_reviewer_id", "status")`,
    );
    await q.query(
      `CREATE INDEX "ix_applications_status_created" ON "merchant_applications" ("status", "created_at")`,
    );
    await q.query(`
      ALTER TABLE "merchant_applications"
        ADD CONSTRAINT "fk_applications_created_by" FOREIGN KEY ("created_by_id")
          REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE NO ACTION,
        ADD CONSTRAINT "fk_applications_assigned_reviewer" FOREIGN KEY ("assigned_reviewer_id")
          REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE NO ACTION,
        ADD CONSTRAINT "fk_applications_decided_by" FOREIGN KEY ("decided_by_id")
          REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`);

    // ---- risk_jobs ----
    await q.query(`
      CREATE TABLE "risk_jobs" (
        "id"                 uuid NOT NULL DEFAULT gen_random_uuid(),
        "application_id"     uuid NOT NULL,
        "submission_number"  integer NOT NULL,
        "status"             "risk_job_status" NOT NULL DEFAULT 'QUEUED',
        "attempts"           integer NOT NULL DEFAULT 0,
        "last_error"         character varying(500),
        "provider"           character varying(64),
        "provider_reference" character varying(128),
        "score"              smallint,
        "level"              "risk_level",
        "reasons"            jsonb,
        "completed_at"       TIMESTAMP WITH TIME ZONE,
        "created_at"         TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at"         TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "pk_risk_jobs" PRIMARY KEY ("id")
      )`);
    await q.query(
      `CREATE UNIQUE INDEX "uq_risk_jobs_application_submission" ON "risk_jobs" ("application_id", "submission_number")`,
    );
    await q.query(`
      ALTER TABLE "risk_jobs"
        ADD CONSTRAINT "fk_risk_jobs_application" FOREIGN KEY ("application_id")
          REFERENCES "merchant_applications"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);

    // ---- audit_logs (append-only) ----
    await q.query(`
      CREATE TABLE "audit_logs" (
        "id"          uuid NOT NULL DEFAULT gen_random_uuid(),
        "action"      character varying(64) NOT NULL,
        "actor_id"    uuid,
        "actor_type"  character varying(16) NOT NULL,
        "actor_role"  character varying(16),
        "entity_type" character varying(64) NOT NULL,
        "entity_id"   character varying(64),
        "metadata"    jsonb NOT NULL DEFAULT '{}'::jsonb,
        "created_at"  TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "pk_audit_logs" PRIMARY KEY ("id")
      )`);
    await q.query(
      `CREATE INDEX "ix_audit_logs_entity" ON "audit_logs" ("entity_type", "entity_id", "created_at")`,
    );
    await q.query(`CREATE INDEX "ix_audit_logs_actor_id" ON "audit_logs" ("actor_id")`);
    // Tamper resistance: the application role can insert audit rows but never rewrite them.
    await q.query(`
      CREATE OR REPLACE FUNCTION audit_logs_block_mutation() RETURNS trigger AS $$
      BEGIN
        RAISE EXCEPTION 'audit_logs is append-only';
      END;
      $$ LANGUAGE plpgsql`);
    await q.query(`
      CREATE TRIGGER "trg_audit_logs_append_only"
        BEFORE UPDATE OR DELETE ON "audit_logs"
        FOR EACH ROW EXECUTE FUNCTION audit_logs_block_mutation()`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TRIGGER IF EXISTS "trg_audit_logs_append_only" ON "audit_logs"`);
    await q.query(`DROP FUNCTION IF EXISTS audit_logs_block_mutation()`);
    await q.query(`DROP TABLE "audit_logs"`);
    await q.query(`DROP TABLE "risk_jobs"`);
    await q.query(`DROP TABLE "merchant_applications"`);
    await q.query(`DROP TABLE "users"`);
    await q.query(`DROP TYPE "risk_job_status"`);
    await q.query(`DROP TYPE "risk_level"`);
    await q.query(`DROP TYPE "risk_status"`);
    await q.query(`DROP TYPE "application_status"`);
    await q.query(`DROP TYPE "business_type"`);
    await q.query(`DROP TYPE "user_role"`);
  }
}
