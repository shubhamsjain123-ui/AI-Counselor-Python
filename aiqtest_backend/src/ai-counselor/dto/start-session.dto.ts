import { IsOptional, IsString } from 'class-validator';

export class StartSessionDto {
  @IsOptional()
  @IsString()
  studentId?: string;

  @IsOptional()
  @IsString()
  languagePreference?: string; // 'hinglish' | 'hindi' | 'english'
}
