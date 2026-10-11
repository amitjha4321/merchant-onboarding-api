import { ApiProperty } from '@nestjs/swagger';
import { Role } from '../role.enum';
import { User } from '../user.entity';

export class UserResponseDto {
  id: string;
  email: string;
  fullName: string;
  @ApiProperty({ enum: Role })
  role: Role;
  isActive: boolean;
  createdAt: Date;

  static from(user: User): UserResponseDto {
    return {
      id: user.id,
      email: user.email,
      fullName: user.fullName,
      role: user.role,
      isActive: user.isActive,
      createdAt: user.createdAt,
    };
  }
}
