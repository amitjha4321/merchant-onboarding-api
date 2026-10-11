import 'dotenv/config';
import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { configuration } from '../config/configuration';
import { buildTypeOrmOptions } from './typeorm.options';

/** Entry point for the TypeORM CLI (migration:run / revert / generate). */
export default new DataSource({ ...buildTypeOrmOptions(configuration().db), migrationsRun: false });
