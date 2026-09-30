import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { timingSafeEqual } from 'crypto';
import { Request } from 'express';

@Injectable()
export class InternalKeyGuard implements CanActivate {
  constructor(private readonly config: ConfigService) {}

  canActivate(context: ExecutionContext): boolean {
    const expected = this.config.get<string>('INTERNAL_API_KEY');
    const received = context.switchToHttp().getRequest<Request>().headers['x-internal-key'];
    if (!expected || typeof received !== 'string') throw new UnauthorizedException('Clave interna requerida');
    const expectedBuffer = Buffer.from(expected);
    const receivedBuffer = Buffer.from(received);
    if (expectedBuffer.length !== receivedBuffer.length || !timingSafeEqual(expectedBuffer, receivedBuffer)) {
      throw new UnauthorizedException('Clave interna inválida');
    }
    return true;
  }
}