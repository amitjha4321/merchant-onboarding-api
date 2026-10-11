import { PartialType } from '@nestjs/swagger';
import { CreateApplicationDto } from './create-application.dto';

/**
 * Partial update. Nested `owner` / `processing` objects are replaced as a whole when present
 * (each must be complete) — keeps validation simple and avoids ambiguous deep merges.
 */
export class UpdateApplicationDto extends PartialType(CreateApplicationDto) {}
