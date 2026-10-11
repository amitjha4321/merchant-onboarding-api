import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsEmail, IsEnum, IsString, Length, MaxLength } from 'class-validator';
import { Role } from '../role.enum';

export class CreateUserDto {
  @ApiProperty({ example: 'reviewer2@example.com' })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim().toLowerCase() : value))
  @IsEmail()
  @MaxLength(320)
  email: string;

  @ApiProperty({ minLength: 12, maxLength: 72, writeOnly: true })
  @IsString()
  @Length(12, 72) // bcrypt only uses the first 72 bytes
  password: string;

  @ApiProperty({ example: 'Example Reviewer' })
  @IsString()
  @Length(1, 200)
  fullName: string;

  @ApiProperty({ enum: Role })
  @IsEnum(Role)
  role: Role;
}
