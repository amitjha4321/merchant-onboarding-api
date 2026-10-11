import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { configuration } from '../src/config/configuration';
import { buildTypeOrmOptions } from '../src/database/typeorm.options';
import './setup-env';

/** Rebuild the test schema from the real migrations once per run. */
export default async function globalSetup(): Promise<void> {
  const db = configuration().db;
  if (!db.name.endsWith('_test')) {
    throw new Error(`Refusing to run e2e tests against non-test database "${db.name}"`);
  }
  const ds = await new DataSource({
    ...buildTypeOrmOptions(db),
    migrationsRun: false,
  }).initialize();
  try {
    await ds.query('DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;');
    await ds.runMigrations({ transaction: 'all' });
  } finally {
    await ds.destroy();
  }
}
