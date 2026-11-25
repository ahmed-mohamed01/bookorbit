import { ValidationPipe } from '@nestjs/common';
import {
  KnowledgeAskDto,
  KnowledgeBuildDto,
  KnowledgeScopeDto,
  KnowledgeSettingsDto,
  KnowledgeTermsDto,
  KnowledgeXrayRunDto,
} from './dto/book-knowledge.dto';
import { KnowledgeTermKeyPipe } from './book-knowledge-term-key.pipe';
describe('Book Knowledge DTOs', () => {
  const pipe = new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true });
  it.each([KnowledgeAskDto, KnowledgeScopeDto, KnowledgeTermsDto, KnowledgeSettingsDto, KnowledgeBuildDto])(
    'rejects unlisted fields in %s',
    async (metatype) => {
      await expect(pipe.transform({ question: 'What is light?', position: 1 }, { type: 'body', metatype })).rejects.toThrow();
    },
  );
  it('requires explicit full scope and bounds pagination', async () => {
    expect(await pipe.transform({}, { type: 'query', metatype: KnowledgeScopeDto })).toEqual({ scope: 'position' });
    expect(await pipe.transform({ scope: 'full' }, { type: 'query', metatype: KnowledgeScopeDto })).toEqual({ scope: 'full' });
    await expect(pipe.transform({ limit: '101' }, { type: 'query', metatype: KnowledgeTermsDto })).rejects.toThrow();
    expect((await pipe.transform({ limit: '20' }, { type: 'query', metatype: KnowledgeTermsDto })).limit).toBe(20);
  });
  it('takes a fresh X-Ray build and no pipeline choice', async () => {
    const body = (value: object) => pipe.transform(value, { type: 'body', metatype: KnowledgeXrayRunDto });
    expect(await body({ bookId: 3, fresh: true })).toMatchObject({ bookId: 3, fresh: true });
    await expect(body({ bookId: 3, pipeline: 'dense' })).rejects.toThrow();
    expect((await body({ bookId: 3 })).fresh).toBeUndefined();
    await expect(body({ bookId: 3, pipeline: 'one-pass' })).rejects.toThrow();
    await expect(body({ bookId: 3, passRuns: 2 })).rejects.toThrow();
  });
  it('rejects malformed term keys', () => {
    const keys = new KnowledgeTermKeyPipe();
    expect(keys.transform('lumen lattice')).toBe('lumen lattice');
    expect(() => keys.transform('../hidden')).toThrow();
    expect(() => keys.transform('x'.repeat(201))).toThrow();
  });
});
