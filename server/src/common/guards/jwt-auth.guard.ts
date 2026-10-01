import { ExecutionContext, ForbiddenException, Injectable, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AuthGuard } from '@nestjs/passport';

import { ALLOW_DEFAULT_PASSWORD_KEY } from '../decorators/allow-default-password.decorator';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';
import { RequestUser } from '../types/request-user';
import { AuthenticationMethod } from '@bookorbit/types';

@Injectable()
export class JwtAuthGuard extends AuthGuard('jwt') {
  constructor(private readonly reflector: Reflector) {
    super();
  }

  canActivate(context: ExecutionContext) {
    // NestJS 12 runs global guards on WebSocket messages too. Gateways verify the token at the handshake,
    // and a socket message carries no HTTP headers for passport to read.
    if (context.getType() !== 'http') return true;
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [context.getHandler(), context.getClass()]);
    if (isPublic) return true;
    return super.canActivate(context);
  }

  handleRequest<T extends RequestUser>(err: unknown, user: T, _info: unknown, context: ExecutionContext): T {
    if (err || !user) {
      throw new UnauthorizedException();
    }

    if (user.isDefaultPassword && user.authenticationMethod !== AuthenticationMethod.Oidc) {
      const allowDefaultPassword = this.reflector.getAllAndOverride<boolean>(ALLOW_DEFAULT_PASSWORD_KEY, [context.getHandler(), context.getClass()]);
      if (!allowDefaultPassword) {
        throw new ForbiddenException('Password change required');
      }
    }

    return user;
  }
}
