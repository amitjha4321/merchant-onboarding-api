import { UserResponseDto } from '../../users/dto/user-response.dto';

export class TokenResponseDto {
  accessToken: string;
  tokenType: 'Bearer';
  expiresIn: string;
  user: UserResponseDto;
}
