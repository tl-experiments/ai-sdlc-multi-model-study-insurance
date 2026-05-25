import { ApiProperty } from '@nestjs/swagger';
import {
  IsEmail,
  IsIn,
  IsOptional,
  IsString,
  MinLength,
} from 'class-validator';

export class CreateEmployeeDto {
  @ApiProperty({ description: 'Username for login', example: 'jdoe', minLength: 3 })
  @IsString()
  @MinLength(3)
  username!: string;

  @ApiProperty({ description: 'User password', example: 'password123', minLength: 6 })
  @IsString()
  @MinLength(6)
  password!: string;

  @ApiProperty({
    enum: ['admin', 'manager', 'employee', 'auditor'],
    description: 'User role',
    example: 'employee',
  })
  @IsIn(['admin', 'manager', 'employee', 'auditor'])
  role!: 'admin' | 'manager' | 'employee' | 'auditor';

  @ApiProperty({ description: "Employee's full name", example: 'John Doe' })
  @IsString()
  full_name!: string;

  @ApiProperty({ description: "Employee's email address", example: 'john.doe@example.com' })
  @IsEmail()
  email!: string;

  @ApiProperty({ required: false, description: "Employee's phone number", example: '555-123-4567' })
  @IsOptional()
  @IsString()
  phone?: string;

  @ApiProperty({ required: false, description: "Employee's home address", example: '123 Main St, Anytown, USA' })
  @IsOptional()
  @IsString()
  address?: string;

  @ApiProperty({
    required: false,
    description: "ID of the employee's manager",
    example: 'clqkx3j4i00003b6qg8d2h4f9',
  })
  @IsOptional()
  @IsString()
  reports_to_id?: string;

  @ApiProperty({
    required: false,
    description: 'Government ID (PII, will be encrypted)',
    example: '999-99-9999',
  })
  @IsOptional()
  @IsString()
  government_id?: string;

  @ApiProperty({
    required: false,
    description: 'Bank account number (PII, will be encrypted)',
    example: '1234567890',
  })
  @IsOptional()
  @IsString()
  bank_account?: string;

  @ApiProperty({
    required: false,
    description: 'Base salary (PII, will be encrypted)',
    example: '95000',
  })
  @IsOptional()
  @IsString()
  salary_base?: string;
}