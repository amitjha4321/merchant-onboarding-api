import 'dotenv/config';
import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { configuration } from '../config/configuration';
import { hashPassword } from '../users/password';
import { Role } from '../users/role.enum';
import { User } from '../users/user.entity';
import { buildTypeOrmOptions } from './typeorm.options';

/**
 * Creates demo users for local development. Passwords are NOT stored in the repo:
 * SEED_DEFAULT_PASSWORD must be supplied via the environment. Idempotent (skips existing).
 */
const DEMO_USERS: Array<Pick<User, 'email' | 'fullName' | 'role'>> = [
  { email: 'admin@example.com', fullName: 'Demo Admin', role: Role.ADMIN },
  { email: 'reviewer@example.com', fullName: 'Demo Reviewer', role: Role.REVIEWER },
  { email: 'reviewer2@example.com', fullName: 'Demo Reviewer Two', role: Role.REVIEWER },
  { email: 'sales@example.com', fullName: 'Demo Sales', role: Role.SALES },
  { email: 'sales2@example.com', fullName: 'Demo Sales Two', role: Role.SALES },
];

async function seed(): Promise<void> {
  const password = process.env.SEED_DEFAULT_PASSWORD;
  if (!password || password.length < 12) {
    throw new Error('Set SEED_DEFAULT_PASSWORD (min 12 chars) in your environment to seed users');
  }

  const ds = await new DataSource({
    ...buildTypeOrmOptions(configuration().db),
    migrationsRun: true,
  }).initialize();
  try {
    const repo = ds.getRepository(User);
    const passwordHash = await hashPassword(password);
    for (const u of DEMO_USERS) {
      if (await repo.exists({ where: { email: u.email } })) {
        console.log(`skip   ${u.email} (exists)`);
        continue;
      }
      await repo.insert({ ...u, passwordHash });
      console.log(`create ${u.email} [${u.role}]`);
    }
  } finally {
    await ds.destroy();
  }
}

seed().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
