import { Permission } from '@bookorbit/types';
import { UnauthorizedException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import type { RequestUser } from '../../common/types/request-user';
import { WS_UNAUTHORIZED_EVENT } from '../../common/utils/ws-auth.utils';
import { AuthenticatorService } from '../auth/authenticator.service';
import { MonitoredGateway } from './monitored.gateway';

function makeGateway(authenticateSocket: AuthenticatorService['authenticateSocket']) {
  return new MonitoredGateway({ authenticateSocket } as unknown as AuthenticatorService);
}

function makeClient(token = 'jwt') {
  return {
    id: 'socket-1',
    data: {} as Record<string, unknown>,
    handshake: { auth: { token } },
    join: vi.fn().mockResolvedValue(undefined),
    emit: vi.fn(),
    disconnect: vi.fn(),
  };
}

function sessionUser(id: number): RequestUser {
  return {
    id,
    isSuperuser: false,
    permissions: [Permission.BookRequestAccess],
    credential: { kind: 'session', sessionId: 10 + id },
  } as RequestUser;
}

describe('MonitoredGateway', () => {
  it('accepts a session socket and emits only to the owner room', async () => {
    const gateway = makeGateway(vi.fn((client) => Promise.resolve(sessionUser(Number(client.handshake.auth.token)))));
    const sockets = [makeClient('1'), makeClient('2')];
    for (const socket of sockets) await gateway.handleConnection(socket as never);

    expect(sockets[0].join).toHaveBeenCalledWith('user:1');
    expect(sockets[1].join).toHaveBeenCalledWith('user:2');
    expect(sockets[0].disconnect).not.toHaveBeenCalled();

    const emit = vi.fn();
    const to = vi.fn().mockReturnValue({ emit });
    gateway.server = { to } as never;
    const item = { id: 'a' };
    gateway.emitFetch(1, item as never);
    expect(to).toHaveBeenCalledExactlyOnceWith('user:1');
    expect(emit).toHaveBeenCalledWith('monitored:fetch', { item });
  });

  it('refuses an invalid token and tells the client to re-authenticate', async () => {
    const gateway = makeGateway(vi.fn().mockRejectedValue(new UnauthorizedException('Invalid token')));
    const client = makeClient('bad');
    await gateway.handleConnection(client as never);

    expect(client.join).not.toHaveBeenCalled();
    expect(client.emit).toHaveBeenCalledWith(WS_UNAUTHORIZED_EVENT, { reason: 'invalid_token' });
    expect(client.disconnect).toHaveBeenCalledTimes(1);
  });

  it('refuses an API key socket because fetch events carry the owner scope', async () => {
    const user = {
      ...sessionUser(3),
      credential: { kind: 'api_key', keyId: 7, keyName: 'k', audience: 'api', access: 'read', libraryIds: [1], ownerIsSuperuser: false },
    } as RequestUser;
    const gateway = makeGateway(vi.fn().mockResolvedValue(user));
    const client = makeClient('bo_key');
    await gateway.handleConnection(client as never);

    expect(client.join).not.toHaveBeenCalled();
    expect(client.data.user).toBeUndefined();
    expect(client.emit).not.toHaveBeenCalled();
    expect(client.disconnect).toHaveBeenCalledTimes(1);
  });
});
