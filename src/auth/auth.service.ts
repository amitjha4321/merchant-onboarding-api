import { randomBytes } from 'crypto';
import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { AuditAction } from '../audit/audit-action.enum';
import { AuditService } from '../audit/audit.service';
import { UserResponseDto } from '../users/dto/user-response.dto';
import { hashPasswordSync, verifyPassword } from '../users/password';
import { UsersService } from '../users/users.service';
import { JwtPayload } from './authenticated-user.interface';
import { LoginDto } from './dto/login.dto';
import { TokenResponseDto } from './dto/token-response.dto';

/**
 * Hash of a random throwaway value, generated once per process. Comparing against it when the
 * user doesn't exist keeps response timing similar, so the endpoint can't be used to
 * enumerate accounts.
 */
const DUMMY_HASH = hashPasswordSync(randomBytes(32).toString('hex'));

@Injectable()
export class AuthService {
  constructor(
    private readonly users: UsersService,
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
    private readonly audit: AuditService,
  ) {}

  async login(dto: LoginDto): Promise<TokenResponseDto> {
    const user = await this.users.findByEmailWithPassword(dto.email);
    const passwordOk = await verifyPassword(dto.password, user?.passwordHash ?? DUMMY_HASH);

    if (!user || !passwordOk || !user.isActive) {
      await this.audit.recordSafely({
        action: AuditAction.LOGIN_FAILED,
        actor: null,
        entityType: 'user',
        entityId: user?.id ?? null,
        // Only the (masked) email is recorded — never the attempted password.
        metadata: { email: dto.email },
      });
      // Same message for every failure reason.
      throw new UnauthorizedException('Invalid credentials');
    }

    const payload: JwtPayload = { sub: user.id, email: user.email, role: user.role };
    const accessToken = await this.jwt.signAsync(payload);
    await this.audit.recordSafely({
      action: AuditAction.LOGIN_SUCCEEDED,
      actor: { id: user.id, role: user.role },
      entityType: 'user',
      entityId: user.id,
    });

    return {
      accessToken,
      tokenType: 'Bearer',
      expiresIn: this.config.getOrThrow<string>('jwt.expiresIn'),
      user: UserResponseDto.from(user),
    };
  }
}
