import { IsNotEmpty, IsString } from 'class-validator';

export class AddNoteDto {
  @IsString()
  @IsNotEmpty()
  note: string;
}