import { join } from 'path';
import { DataSourceOptions } from 'typeorm';
import { SnakeNamingStrategy } from 'typeorm-naming-strategies';
import { MerchantApplication } from '../applications/application.entity';
import { AuditLog } from '../audit/audit-log.entity';
import { AppConfig } from '../config/configuration';
import { RiskJob } from '../risk/risk-job.entity';
import { User } from '../users/user.entity';

export const ENTITIES = [User, MerchantApplication, RiskJob, AuditLog];

/** Shared by the Nest app and the TypeORM CLI so both see identical settings. */
export function buildTypeOrmOptions(db: AppConfig['db']): DataSourceOptions {
  return {
    type: 'postgres',
    host: db.host,
    port: db.port,
    username: db.username,
    password: db.password,
    database: db.name,
    entities: ENTITIES,
    migrations: [join(__dirname, 'migrations', '*.{ts,js}')],
    migrationsTableName: 'typeorm_migrations',
    migrationsRun: db.migrationsRun,
    // Schema is owned by reviewed migrations only.
    synchronize: false,
    uuidExtension: 'pgcrypto', // gen_random_uuid()
    namingStrategy: new SnakeNamingStrategy(),
    logging: db.logging ? ['query', 'error'] : ['error'],
  };
}
