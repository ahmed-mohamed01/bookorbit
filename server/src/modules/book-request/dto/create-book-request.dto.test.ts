import 'reflect-metadata';

import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { REQUEST_SOURCE_LIMIT } from '@bookorbit/types';

import { CreateBookRequestDto } from './create-book-request.dto';

function dto(coverUrl: string | null): CreateBookRequestDto {
  return Object.assign(new CreateBookRequestDto(), {
    title: 'A book',
    mediaKind: 'ebook',
    coverUrl,
  });
}

describe('CreateBookRequestDto', () => {
  it.each(['https://covers.example/book.jpg', 'http://localhost/cover'])('accepts an HTTP cover URL: %s', async (coverUrl) => {
    await expect(validate(dto(coverUrl))).resolves.toEqual([]);
  });

  it.each(['data:image/png;base64,AAAA', 'javascript:alert(1)', 'cover.jpg', 'https://'])('rejects a non-HTTP cover URL: %s', async (coverUrl) => {
    expect(await validate(dto(coverUrl))).not.toEqual([]);
  });

  it('allows an omitted cover', async () => {
    await expect(validate(dto(null))).resolves.toEqual([]);
  });

  it.each([
    ['a valid source list', [1, 2], true],
    ['null', null, true],
    ['an empty source list', [], false],
    ['duplicate source ids', [1, 1], false],
    ['a non-integer source id', [1.5], false],
    ['too many source ids', Array.from({ length: REQUEST_SOURCE_LIMIT + 1 }, (_, index) => index + 1), false],
  ])('validates sourceIds when it is %s', async (_label, sourceIds, valid) => {
    const instance = plainToInstance(CreateBookRequestDto, { title: 'A book', mediaKind: 'ebook', sourceIds });

    const errors = await validate(instance);
    expect(errors.length === 0).toBe(valid);
  });
});
