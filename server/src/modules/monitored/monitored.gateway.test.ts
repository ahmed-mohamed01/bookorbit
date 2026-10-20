import { Test } from '@nestjs/testing';
import { JwtService } from '@nestjs/jwt';
import { Permission } from '@bookorbit/types';
import { expect, it, vi } from 'vitest';
import { AuthService } from '../auth/auth.service';
import { MonitoredGateway } from './monitored.gateway';

it('authenticates two users and emits only to the owner room', async () => {
  const module = await Test.createTestingModule({
    providers: [
      MonitoredGateway,
      { provide: JwtService, useValue: { verify: vi.fn((token) => ({ sub: Number(token), ver: 1 })) } },
      {
        provide: AuthService,
        useValue: { validateSessionUser: vi.fn((id) => Promise.resolve({ id, isSuperuser: false, permissions: [Permission.BookRequestAccess] })) },
      },
    ],
  }).compile();
  const gateway = module.get(MonitoredGateway);
  const sockets = [1, 2].map((id) => ({ id: String(id), data: {}, handshake: { auth: { token: String(id) } }, join: vi.fn() }));
  for (const socket of sockets) await gateway.handleConnection(socket as never);
  expect(sockets[0].join).toHaveBeenCalledWith('user:1');
  expect(sockets[1].join).toHaveBeenCalledWith('user:2');
  const emit = vi.fn();
  const to = vi.fn().mockReturnValue({ emit });
  gateway.server = { to } as never;
  const item = { id: 'a' };
  gateway.emitFetch(1, item as never);
  expect(to).toHaveBeenCalledExactlyOnceWith('user:1');
  expect(emit).toHaveBeenCalledWith('monitored:fetch', { item });
});
