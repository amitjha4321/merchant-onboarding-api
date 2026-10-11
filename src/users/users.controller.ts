import { Body, Controller, Get, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AuthenticatedUser } from '../auth/authenticated-user.interface';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { CreateUserDto } from './dto/create-user.dto';
import { ListUsersQueryDto } from './dto/list-users-query.dto';
import { UserResponseDto } from './dto/user-response.dto';
import { Role } from './role.enum';
import { UsersService } from './users.service';

@ApiTags('users')
@ApiBearerAuth()
@Roles(Role.ADMIN)
@Controller('users')
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  @Post()
  @ApiOperation({ summary: 'Create a user (ADMIN only)' })
  async create(
    @Body() dto: CreateUserDto,
    @CurrentUser() actor: AuthenticatedUser,
  ): Promise<UserResponseDto> {
    return UserResponseDto.from(await this.usersService.create(dto, actor));
  }

  @Get()
  @ApiOperation({ summary: 'List users, e.g. ?role=REVIEWER to pick an assignee (ADMIN only)' })
  async list(@Query() query: ListUsersQueryDto): Promise<UserResponseDto[]> {
    return (await this.usersService.list(query.role)).map((u) => UserResponseDto.from(u));
  }
}
