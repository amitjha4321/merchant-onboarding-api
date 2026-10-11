import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsEmail,
  IsEnum,
  IsInt,
  IsISO31661Alpha2,
  IsISO4217CurrencyCode,
  IsOptional,
  IsString,
  IsUrl,
  Length,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { Trim, UpperTrim } from '../../common/utils/trim.transform';
import { BusinessType } from '../application-status.enum';

const MAX_MINOR_AMOUNT = 10_000_000_000_000; // 100bn major units — sanity bound

export class OwnerContactDto {
  @ApiProperty({ example: 'Jane Example' })
  @Trim()
  @IsString()
  @Length(1, 200)
  fullName: string;

  @ApiProperty({ example: 'jane.owner@example.com' })
  @Trim()
  @IsEmail()
  @MaxLength(320)
  email: string;

  @ApiProperty({ example: '+15555550123', description: 'E.164 format' })
  @Matches(/^\+[1-9]\d{6,14}$/, { message: 'phone must be in E.164 format, e.g. +15555550123' })
  phone: string;
}

export class ProcessingInfoDto {
  @ApiProperty({ example: '5812', description: 'ISO 18245 merchant category code' })
  @Matches(/^\d{4}$/, { message: 'mcc must be a 4-digit code' })
  mcc: string;

  @ApiProperty({ example: 'USD' })
  @UpperTrim()
  @IsISO4217CurrencyCode()
  currency: string;

  @ApiProperty({ example: 5_000_000, description: 'Expected monthly volume in minor units' })
  @IsInt()
  @Min(1)
  @Max(MAX_MINOR_AMOUNT)
  expectedMonthlyVolumeMinor: number;

  @ApiProperty({ example: 2_500, description: 'Average ticket size in minor units' })
  @IsInt()
  @Min(1)
  @Max(MAX_MINOR_AMOUNT)
  averageTicketMinor: number;
}

export class CreateApplicationDto {
  @ApiProperty({ example: 'Example Coffee' })
  @Trim()
  @IsString()
  @Length(1, 200)
  businessName: string;

  @ApiProperty({ example: 'Example Coffee LLC' })
  @Trim()
  @IsString()
  @Length(1, 200)
  legalBusinessName: string;

  @ApiProperty({ enum: BusinessType })
  @IsEnum(BusinessType)
  businessType: BusinessType;

  @ApiProperty({ example: 'US' })
  @UpperTrim()
  @IsISO31661Alpha2()
  countryCode: string;

  @ApiPropertyOptional({ example: 'https://coffee.example.com' })
  @IsOptional()
  @IsUrl({ protocols: ['http', 'https'], require_protocol: true })
  @MaxLength(2048)
  websiteUrl?: string;

  @ApiProperty({
    example: '00-0000000',
    writeOnly: true,
    description: 'Tax/registration id. Encrypted at rest, masked in responses.',
  })
  @Matches(/^[A-Za-z0-9-]{4,32}$/, { message: 'taxId must be 4-32 alphanumeric characters' })
  taxId: string;

  @ApiPropertyOptional({
    example: '000123456789',
    writeOnly: true,
    description: 'Settlement account number / IBAN. Encrypted at rest, masked in responses.',
  })
  @IsOptional()
  @Matches(/^[A-Za-z0-9]{4,34}$/, { message: 'settlementAccountNumber must be 4-34 alphanumerics' })
  settlementAccountNumber?: string;

  @ApiProperty({ type: OwnerContactDto })
  @ValidateNested()
  @Type(() => OwnerContactDto)
  owner: OwnerContactDto;

  @ApiProperty({ type: ProcessingInfoDto })
  @ValidateNested()
  @Type(() => ProcessingInfoDto)
  processing: ProcessingInfoDto;
}
