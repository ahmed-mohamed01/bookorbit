import { Logger, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { OnGatewayConnection, WebSocketGateway, WebSocketServer } from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { Permission, type AuthenticationMethod, type MonitoredAuthorItem } from '@bookorbit/types';
import { AuthService } from '../auth/auth.service';
import { sanitizeLogValue } from '../../common/utils/log-sanitize.utils';
import { rejectSocketConnection } from '../../common/utils/ws-auth.utils';
import { wsCorsOrigin } from '../../common/utils/ws-cors.utils';

@WebSocketGateway({ namespace: '/monitored', cors: { origin: wsCorsOrigin() } })
export class MonitoredGateway implements OnGatewayConnection {
  @WebSocketServer() server: Server;
  private readonly logger = new Logger(MonitoredGateway.name);
  constructor(
    private readonly jwtService: JwtService,
    private readonly authService: AuthService,
  ) {}

  async handleConnection(client: Socket): Promise<void> {
    try {
      const token = client.handshake.auth?.token as string | undefined;
      if (!token) throw new UnauthorizedException('No token provided');
      const payload = this.jwtService.verify<{ sub: number; ver: number; sid?: number; amr?: AuthenticationMethod }>(token, {
        algorithms: ['HS256'],
      });
      const user = await this.authService.validateSessionUser(payload.sub, payload.ver, payload.amr ?? 'legacy', payload.sid);
      if (!user) throw new UnauthorizedException('User not found or token revoked');
      if (!user.isSuperuser && !user.permissions.includes(Permission.BookRequestAccess)) {
        throw new UnauthorizedException('Missing book request access');
      }
      (client.data as Record<string, unknown>).user = user;
      await client.join(`user:${user.id}`);
      this.logger.debug(`WS connected: user=${user.id} socket=${client.id}`);
    } catch (err) {
      this.logger.warn(
        `[monitored.ws_connect] [fail] socket=${client.id} errorClass=${(err as Error)?.constructor?.name ?? 'Error'} error="${sanitizeLogValue((err as Error).message)}" - handshake refused`,
      );
      rejectSocketConnection(client, err);
    }
  }

  emitFetch(ownerUserId: number, item: MonitoredAuthorItem): void {
    this.server?.to(`user:${ownerUserId}`).emit('monitored:fetch', { item });
  }
}
