import { AI_ERROR_CODES, AI_FEATURE_DEFINITIONS } from '@bookorbit/types';
import type { ArgumentsHost } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { EventEmitter } from 'node:events';
import { GlobalExceptionFilter } from '../../common/filters/http-exception.filter';
import type { RequestUser } from '../../common/types/request-user';
import { AiError } from '../ai/ai-client.types';
import type { AiClient } from '../ai/ai-client.service';
import type { AiLedgerRepository } from '../ai/ai-ledger.repository';
import type { AiSettingsService } from '../ai/ai-settings.service';
import { BookKnowledgeAskService } from './book-knowledge-ask.service';
import { BookKnowledgeCardService } from './book-knowledge-card.service';
import { BookKnowledgeController } from './book-knowledge.controller';
import type { BookKnowledgeRepository } from './book-knowledge.repository';
import type { BookKnowledgeService } from './book-knowledge.service';
import type { BookKnowledgeTermsService } from './book-knowledge-terms.service';
import { BOOK_KNOWLEDGE_AI_FEATURE, BookKnowledgeModelService } from './book-knowledge-model.service';
import type { BookKnowledgeSettingsService } from './book-knowledge-settings.service';
import type { Artifact } from './core/model';
import { ARTIFACT_VERSION, TERMS_VERSION, TEXT_VERSION } from './core/versions';

const choice = { slot: 'fast' as const, connectionId: 4, model: 'fixture', prices: null, jsonMode: 'auto' as const };

const reader = { id: 7 } as RequestUser;
const call = { userId: reader.id, signal: new AbortController().signal };

function setup(options: { enabled?: boolean; featureOn?: boolean; careful?: boolean } = {}) {
  const { enabled = true, featureOn = true, careful = false } = options;
  const ai = {
    complete: vi.fn<AiClient['complete']>(() =>
      Promise.resolve({ text: '{"ok":true}', json: { ok: true }, usage: { input: 1, output: 1 }, finish: 'stop', model: 'fixture' }),
    ),
    resolveSlot: vi.fn((slot: 'fast' | 'careful') => Promise.resolve({ ...choice, slot })),
  };
  const slot = (on: boolean) => ({ connectionId: on ? 4 : null, model: on ? 'fixture' : null });
  const aiSettings = {
    snapshot: vi.fn(() =>
      Promise.resolve({
        features: { [BOOK_KNOWLEDGE_AI_FEATURE]: { enabled: featureOn, readerRequestsPerMonth: 3, readerMonthlyBudget: 1 } },
        slots: { fast: slot(true), careful: slot(careful) },
      }),
    ),
  };
  const ledger = { readerSpend: vi.fn().mockResolvedValue({ requests: 3, costMicros: 1_000_000 }) };
  const settings = { enabled: vi.fn(() => Promise.resolve(enabled)) };
  const service = new BookKnowledgeModelService(
    ai as unknown as AiClient,
    aiSettings as unknown as AiSettingsService,
    settings as unknown as BookKnowledgeSettingsService,
    ledger as unknown as AiLedgerRepository,
  );
  return { service, ai, aiSettings, ledger };
}

describe('BookKnowledgeModelService', () => {
  it('needs the Book Knowledge switch, the AI feature and a slot model', async () => {
    expect(await setup().service.choice()).toMatchObject({ slot: 'fast', model: 'fixture' });
    expect(await setup({ enabled: false }).service.choice()).toBeNull();
    expect(await setup({ featureOn: false }).service.choice()).toBeNull();
    expect(await setup().service.choice('careful')).toBeNull();
  });

  it('sends every call as the book-knowledge feature on the chosen slot, so it lands in the ledger', async () => {
    const { service, ai } = setup();
    expect(await service.generate('prompt', { type: 'object' }, choice, call)).toEqual({ ok: true });
    expect(ai.complete).toHaveBeenCalledWith(
      expect.objectContaining({
        feature: 'book-knowledge',
        slot: 'fast',
        use: choice,
        schema: { type: 'object' },
        effort: 'low',
        temperature: 1,
        ...call,
      }),
    );
  });

  it('keeps a call’s own temperature over the default', async () => {
    const { service, ai } = setup();
    await service.complete({ system: 's', user: 'u', maxOutputTokens: 10, use: choice, temperature: 0 });
    expect(ai.complete).toHaveBeenCalledWith(expect.objectContaining({ temperature: 0 }));
  });

  it('turns reasoning off for a Qwen model, which ignores lower effort levels', async () => {
    const { service, ai } = setup();
    await service.complete({ system: 's', user: 'u', maxOutputTokens: 10, use: { ...choice, model: 'Qwen/Qwen3.6-35B-A3B' }, effort: 'low' });
    expect(ai.complete).toHaveBeenCalledWith(expect.objectContaining({ effort: 'none' }));
  });

  it('forwards reader options to chat', async () => {
    const { service, ai } = setup();
    await service.chat('s', 'u', 100, choice, { ...call, temperature: 0 });
    expect(ai.complete).toHaveBeenCalledWith(expect.objectContaining({ ...call, temperature: 0 }));
  });

  it('rejects a hung-up reader before calling the provider', async () => {
    const { service, ai } = setup();
    const options = { ...call, signal: AbortSignal.abort() };
    await expect(service.generate('p', {}, choice, options)).rejects.toMatchObject({ status: 502 });
    await expect(service.chat('s', 'u', 100, choice, options)).rejects.toMatchObject({ status: 502 });
    expect(ai.complete).not.toHaveBeenCalled();
  });

  it('blocks a reader at the monthly request or dollar cap before generation', async () => {
    const { service, ai, aiSettings, ledger } = setup();
    const snapshot = (await aiSettings.snapshot()) as Awaited<ReturnType<AiSettingsService['snapshot']>>;
    expect(AI_FEATURE_DEFINITIONS['book-knowledge']).toHaveProperty('perReader', true);
    for (const selected of [choice, { ...choice, prices: { input: 1, output: 1 } }]) {
      await expect(service.checkReaderCap(reader, snapshot, selected)).rejects.toMatchObject({
        status: 429,
        response: { errorCode: 'reader-cap' },
      });
    }
    expect(ledger.readerSpend).toHaveBeenCalledWith(expect.stringMatching(/^\d{4}-\d{2}$/), 'book-knowledge', reader.id);
    expect(ai.complete).not.toHaveBeenCalled();
  });

  it('keeps low effort for Starling-LM', async () => {
    const { service, ai } = setup();
    await service.complete({ system: 's', user: 'u', maxOutputTokens: 10, use: { ...choice, model: 'Starling-LM' }, effort: 'low' });
    expect(ai.complete).toHaveBeenCalledWith(expect.objectContaining({ effort: 'low' }));
  });

  it.each(AI_ERROR_CODES)('maps the %s AI error to its HTTP status', async (code) => {
    const { service, ai } = setup();
    ai.complete.mockRejectedValueOnce(new AiError(code, 'failed'));
    const status = code === 'budget' ? 429 : ['off', 'slot-empty', 'provider-down'].includes(code) ? 503 : 502;
    await expect(service.generate('p', {}, choice, call)).rejects.toMatchObject({
      status,
      ...(code === 'budget' ? { response: { errorCode: 'budget' } } : {}),
    });
  });

  it.each(['rate-limited', 'timeout'] as const)('maps provider %s to 503', async (failure) => {
    const { service, ai } = setup();
    ai.complete.mockRejectedValueOnce(new AiError('provider-down', 'failed', { failure }));
    await expect(service.chat('s', 'u', 100, choice, call)).rejects.toMatchObject({ status: 503 });
  });

  it('maps expiration of the reader timeout to 503', async () => {
    const { service, ai } = setup();
    const controller = new AbortController();
    ai.complete.mockImplementationOnce(() => {
      controller.abort(new DOMException('Timed out', 'TimeoutError'));
      return Promise.reject(new AiError('cancelled', 'The request was cancelled'));
    });
    await expect(service.generate('p', {}, choice, { ...call, signal: controller.signal })).rejects.toMatchObject({ status: 503 });
  });

  it('maps unexpected model errors to 502', async () => {
    const { service, ai } = setup();
    ai.complete.mockRejectedValueOnce(new Error('unexpected'));
    await expect(service.generate('p', {}, choice, call)).rejects.toMatchObject({ status: 502 });
  });
});

const term = 'lumen lattice';
const artifact: Artifact = {
  formatVersion: ARTIFACT_VERSION,
  textVersion: TEXT_VERSION,
  termsVersion: TERMS_VERSION,
  fingerprint: 'fixture',
  seeds: [],
  aliasLinks: [],
  metadata: { titles: [], authors: [] },
  sentences: [
    {
      ordinal: 1,
      text: 'The lumen lattice bends light around sealed jars.',
      spineIndex: 0,
      paragraphIndex: 0,
      href: 'fixture.xhtml',
      structure: 'body',
      heading: false,
      emphasis: [],
    },
  ],
  terms: [
    {
      key: term,
      rarity: 1,
      wordCount: 2,
      deltas: [1],
      features: [{ alias: term, definition: true, capitalized: false, person: false, place: false, nested: false, structural: false, noun: true }],
    },
  ],
};

function setupRoutes(route: 'card' | 'ask') {
  const { service, ai, ledger } = setup();
  const knowledge = {
    context: vi.fn().mockResolvedValue({ artifact, info: { cutoffOrdinal: 1 }, fingerprint: artifact.fingerprint }),
  } as unknown as BookKnowledgeService;
  const repo = { cached: vi.fn().mockResolvedValue(null) };
  const controller = new BookKnowledgeController(
    knowledge,
    {} as BookKnowledgeTermsService,
    new BookKnowledgeCardService(knowledge, service, repo as unknown as BookKnowledgeRepository),
    new BookKnowledgeAskService(knowledge, service),
  );
  const raw = Object.assign(new EventEmitter(), { writableEnded: false, destroyed: false });
  const response = { raw, status: vi.fn().mockReturnThis(), send: vi.fn() };
  const reply = response as unknown as FastifyReply;
  const query = { scope: 'position' as const };
  const request = () =>
    route === 'card' ? controller.card(3, reader, term, query, {}, reply) : controller.ask(3, reader, query, { question: term }, reply);
  const host = {
    switchToHttp: () => ({ getResponse: () => reply, getRequest: () => ({ url: '/api/v1/books/3/knowledge', id: 'r1', raw: {} }) }),
  } as ArgumentsHost;
  const filter = new GlobalExceptionFilter();
  return { ai, ledger, raw, request, response, filter, host };
}

describe.each(['card', 'ask'] as const)('Book Knowledge %s route', (route) => {
  it('sends the reader-cap errorCode through the global filter before calling the provider', async () => {
    const { ai, request, response, filter, host } = setupRoutes(route);
    const error = await request().catch((failure: unknown) => failure);
    filter.catch(error, host);
    expect(response.status).toHaveBeenCalledWith(429);
    expect(response.send).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 429, errorCode: 'reader-cap' }));
    expect(ai.complete).not.toHaveBeenCalled();
  });

  it('aborts the provider signal when the reply closes', async () => {
    const { ai, ledger, raw, request } = setupRoutes(route);
    ledger.readerSpend.mockResolvedValue({ requests: 0, costMicros: 0 });
    ai.complete.mockImplementationOnce(
      ({ signal }) =>
        new Promise((_resolve, reject) => {
          signal?.addEventListener('abort', () => reject(new AiError('cancelled', 'The request was cancelled')), { once: true });
        }),
    );
    const result = expect(request()).rejects.toMatchObject({ status: 502 });
    await vi.waitFor(() => expect(ai.complete).toHaveBeenCalledWith(expect.objectContaining({ userId: reader.id, signal: expect.any(AbortSignal) })));
    raw.emit('close');
    await result;
    expect(raw.listenerCount('close')).toBe(0);
  });
});
