import sharp from 'sharp';
import { describe, expect, it } from 'vitest';

import { generateThumbnail } from './cover';

async function sampleCover(): Promise<Buffer> {
  return sharp({ create: { width: 1600, height: 2400, channels: 3, noise: { type: 'gaussian', mean: 128, sigma: 40 } } })
    .jpeg({ quality: 95 })
    .toBuffer();
}

describe('generateThumbnail encoding', () => {
  it('writes a baseline JPEG inside 400 x 600 so OPDS and Kobo clients can still decode it', async () => {
    const metadata = await sharp(await generateThumbnail(await sampleCover())).metadata();

    expect(metadata.format).toBe('jpeg');
    expect(metadata.isProgressive).toBe(false);
    expect(metadata.width).toBe(400);
    expect(metadata.height).toBe(600);
  });

  it('is smaller than the previous quality 90 encoding', async () => {
    const cover = await sampleCover();
    const previous = await sharp(cover).resize(400, 600, { fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 90 }).toBuffer();

    expect((await generateThumbnail(cover)).length).toBeLessThan(previous.length * 0.8);
  });
});
