import { ForbiddenException, Logger, UnauthorizedException } from '@nestjs/common';
import { OnGatewayConnection, WebSocketGateway, WebSocketServer } from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { Permission, type MonitoredAuthorItem } from '@bookorbit/types';
import { apiKeyCredentialOf } from '../../common/types/request-user';
import { sanitizeLogValue } from '../../common/utils/log-sanitize.utils';
import { rejectSocketConnection } from '../../common/utils/ws-auth.utils';
import { wsCorsOrigin } from '../../common/utils/ws-cors.utils';
import { AuthenticatorService } from '../auth/authenticator.service';

@WebSocketGateway({ namespace: '/monitored', cors: { origin: wsCorsOrigin() } })
export class MonitoredGateway implements OnGatewayConnection {
  @WebSocketServer() server: Server;
  private readonly logger = new Logger(MonitoredGateway.name);
  constructor(private readonly authenticator: AuthenticatorService) {}

  async handleConnection(client: Socket): Promise<void> {
    try {
      const user = await this.authenticator.authenticateSocket(client);
      // Fetch events are built with the owner's full scope, so a narrower key must not receive them.
      const apiKey = apiKeyCredentialOf(user);
      if (apiKey) throw new ForbiddenException(`API key ${apiKey.keyId} cannot subscribe to watchlist events`);
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
