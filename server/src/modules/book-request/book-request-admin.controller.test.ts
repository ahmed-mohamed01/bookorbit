import { BadRequestException, NotFoundException, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import type { ReleaseSearchProgress, ReleaseSearchResult } from '@bookorbit/types';
import { BookRequestAdminController } from './book-request-admin.controller';
import { BookRequestService } from './book-request.service';
import { BookRequestBatchService } from './batch/book-request-batch.service';
import { DownloadClientConfigService } from './download-clients/download-client-config.service';
import { RequestFulfillmentService } from './fulfillment/request-fulfillment.service';
import { RequestImportService } from './fulfillment/request-import.service';
import { RequestSeedService } from './fulfillment/request-seed.service';
import { RequestVerificationService } from './fulfillment/request-verification.service';

const result = { releases: [], indexers: [], cached: false } as unknown as ReleaseSearchResult;
const progress = { ...result, pending: [] } as ReleaseSearchProgress;

describe('BookRequestAdminController release stream', () => {
  let app: NestFastifyApplication;
  const search = vi.fn();
  const fulfillment = { prepareReleaseSearch: vi.fn() };

  beforeEach(async () => {
    search.mockReset().mockImplementation((onProgress) => {
      onProgress(progress);
      return Promise.resolve(result);
    });
    fulfillment.prepareReleaseSearch.mockReset().mockResolvedValue(search);
    const module = await Test.createTestingModule({
      controllers: [BookRequestAdminController],
      providers: [
        { provide: RequestFulfillmentService, useValue: fulfillment },
        ...[
          BookRequestService,
          BookRequestBatchService,
          DownloadClientConfigService,
          RequestImportService,
          RequestSeedService,
          RequestVerificationService,
        ].map((provide) => ({
          provide,
          useValue: {},
        })),
      ],
    }).compile();
    app = module.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  afterEach(async () => {
    await app.close();
  });

  it('emits progress then result with the default cache options', async () => {
    const response = await app.inject({ method: 'POST', url: '/admin/book-requests/7/releases/stream', payload: { refresh: false } });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toBe('text/event-stream');
    expect(response.body).toBe(`event: progress\ndata: ${JSON.stringify(progress)}\n\nevent: result\ndata: ${JSON.stringify(result)}\n\n`);
    expect(fulfillment.prepareReleaseSearch).toHaveBeenCalledWith(7, { refresh: false, overrides: undefined });
  });

  it('forces refresh for nested overrides', async () => {
    await app.inject({ method: 'POST', url: '/admin/book-requests/7/releases/stream', payload: { overrides: { title: 'Dune' } } });
    expect(fulfillment.prepareReleaseSearch).toHaveBeenCalledWith(7, { refresh: true, overrides: { title: 'Dune' } });
  });

  it.each([{ refresh: 'yes' }, { overrides: { title: 42 } }, { overrides: { extra: true } }, { extra: true }])(
    'rejects invalid DTOs before opening a stream',
    async (payload) => {
      const response = await app.inject({ method: 'POST', url: '/admin/book-requests/7/releases/stream', payload });
      expect(response.statusCode).toBe(400);
      expect(response.headers['content-type']).toContain('application/json');
      expect(fulfillment.prepareReleaseSearch).not.toHaveBeenCalled();
    },
  );

  it.each([new NotFoundException('missing'), new BadRequestException('not searchable')])(
    'returns pre-search failures as HTTP errors',
    async (error) => {
      fulfillment.prepareReleaseSearch.mockRejectedValue(error);
      const response = await app.inject({ method: 'POST', url: '/admin/book-requests/7/releases/stream', payload: {} });
      expect(response.statusCode).toBe(error.getStatus());
      expect(response.headers['content-type']).toContain('application/json');
      expect(search).not.toHaveBeenCalled();
    },
  );

  it('emits a terminal error after progress if searching throws', async () => {
    search.mockImplementation((onProgress) => {
      onProgress(progress);
      return Promise.reject(new BadRequestException('Search unavailable'));
    });
    const response = await app.inject({ method: 'POST', url: '/admin/book-requests/7/releases/stream', payload: {} });
    expect(response.statusCode).toBe(200);
    expect(response.body).toBe(`event: progress\ndata: ${JSON.stringify(progress)}\n\nevent: error\ndata: {"message":"Search unavailable"}\n\n`);
  });
});
