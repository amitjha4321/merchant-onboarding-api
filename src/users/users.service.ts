import { ConflictException, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AuditAction } from '../audit/audit-action.enum';
import { AuditService } from '../audit/audit.service';
import { AuthenticatedUser } from '../auth/authenticated-user.interface';
import { CreateUserDto } from './dto/create-user.dto';
import { hashPassword } from './password';
import { Role } from './role.enum';
import { User } from './user.entity';

@Injectable()
export class UsersService {
  constructor(
    @InjectRepository(User) private readonly users: Repository<User>,
    private readonly audit: AuditService,
  ) {}

  findById(id: string): Promise<User | null> {
    return this.users.findOne({ where: { id } });
  }

  findActiveById(id: string): Promise<User | null> {
    return this.users.findOne({ where: { id, isActive: true } });
  }

  /** The only query that selects the password hash. */
  findByEmailWithPassword(email: string): Promise<User | null> {
    return this.users
      .createQueryBuilder('u')
      .addSelect('u.passwordHash')
      .where('u.email = :email', { email: email.trim().toLowerCase() })
      .getOne();
  }

  list(role?: Role): Promise<User[]> {
    return this.users.find({ where: role ? { role } : {}, order: { createdAt: 'ASC' } });
  }

  async create(dto: CreateUserDto, actor: AuthenticatedUser): Promise<User> {
    if (await this.users.exists({ where: { email: dto.email } })) {
      throw new ConflictException('A user with this email already exists');
    }
    const passwordHash = await hashPassword(dto.password);

    return this.users.manager.transaction(async (em) => {
      const user = await em.save(
        em.create(User, { email: dto.email, fullName: dto.fullName, role: dto.role, passwordHash }),
      );
      await this.audit.record(
        {
          action: AuditAction.USER_CREATED,
          actor,
          entityType: 'user',
          entityId: user.id,
          metadata: { email: user.email, role: user.role },
        },
        em,
      );
      return user;
    });
  }
}
