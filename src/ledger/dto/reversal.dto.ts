import { IsString, IsUUID, MaxLength, MinLength } from 'class-validator';

export class ReversalDto {
  @IsUUID()
  idempotencyKey: string;

  @IsString()
  @MinLength(3)
  @MaxLength(120)
  reason: string;
}
