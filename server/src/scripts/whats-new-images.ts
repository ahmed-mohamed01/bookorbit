/**
 * Normalize "What's New" highlight screenshots before dragging them into a GitHub release:
 * convert to webp, cap the largest dimension, strip metadata. Aspect ratio is preserved
 * (no cropping) - the app normalizes display size in CSS; this only trims file weight so the
 * popup loads fast and stays sharp in the lightbox.
 *
 *   pnpm whats-new:images <folder>                 # process every image into <folder>/processed
 *   pnpm whats-new:images <file.png>               # process a single file (handy for the webp test)
 *   pnpm whats-new:images <folder> --out <dir>     # custom output directory
 *   pnpm whats-new:images <folder> --max 1600      # custom max dimension (default 1280)
 *   pnpm whats-new:images <folder> --quality 82    # custom webp quality (default 80)
 *
 * Output filenames keep the original basename (extension swapped to .webp) so it stays obvious
 * which processed file maps to which highlight in the release markdown.
 */
import { existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { basename, extname, join, resolve } from 'node:path';

import sharp from 'sharp';

const INPUT_EXT_RE = /\.(png|jpe?g|webp|tiff?)$/i;
const DEFAULT_MAX = 1280;
const DEFAULT_QUALITY = 90;

interface Options {
  input: string;
  out: string;
  max: number;
  quality: number;
}

const VALUE_FLAGS = new Set(['--out', '--max', '--quality']);

function parseArgs(args: string[]): Options {
  const flag = (name: string): string | undefined => {
    const i = args.indexOf(name);
    return i !== -1 ? args[i + 1] : undefined;
  };

  const positionals = args.filter((a, i) => !a.startsWith('--') && !VALUE_FLAGS.has(args[i - 1]));
  const input = positionals[0];
  if (!input) throw new Error('Provide a folder or image file. See: pnpm whats-new:images --help');

  const resolvedInput = resolve(input);
  if (!existsSync(resolvedInput)) throw new Error(`Path not found: ${resolvedInput}`);

  const isDir = statSync(resolvedInput).isDirectory();
  const defaultOut = isDir ? join(resolvedInput, 'processed') : join(resolve(resolvedInput, '..'), 'processed');

  const max = Number(flag('--max') ?? DEFAULT_MAX);
  const quality = Number(flag('--quality') ?? DEFAULT_QUALITY);
  if (!Number.isFinite(max) || max < 64) throw new Error('--max must be a number >= 64');
  if (!Number.isFinite(quality) || quality < 1 || quality > 100) throw new Error('--quality must be 1-100');

  return { input: resolvedInput, out: resolve(flag('--out') ?? defaultOut), max, quality };
}

function collectImages(input: string): string[] {
  if (statSync(input).isFile()) return INPUT_EXT_RE.test(input) ? [input] : [];
  return readdirSync(input)
    .filter((f) => INPUT_EXT_RE.test(f))
    .map((f) => join(input, f))
    .filter((f) => statSync(f).isFile())
    .sort();
}

function formatKb(bytes: number): string {
  return `${(bytes / 1024).toFixed(0)} KB`;
}

function printHelp(): void {
  console.log(
    [
      'Usage: pnpm whats-new:images <folder|file> [--out <dir>] [--max <px>] [--quality <1-100>]',
      '',
      'Converts highlight screenshots to webp, caps the largest dimension, strips metadata.',
      'Aspect ratio is preserved (no cropping). Output basenames match the input (.webp).',
      '',
      `  --out <dir>       output directory (default: <input>/processed)`,
      `  --max <px>        cap the largest dimension (default: ${DEFAULT_MAX})`,
      `  --quality <n>     webp quality 1-100 (default: ${DEFAULT_QUALITY})`,
    ].join('\n'),
  );
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.length === 0) {
    printHelp();
    process.exit(args.length === 0 ? 1 : 0);
  }

  const opts = parseArgs(args);
  const images = collectImages(opts.input);
  if (images.length === 0) {
    console.log('No images found (png, jpg, jpeg, webp, tiff).');
    process.exit(1);
  }

  mkdirSync(opts.out, { recursive: true });
  console.log(`\nProcessing ${images.length} image(s) -> ${opts.out}`);
  console.log(`webp q${opts.quality} · max ${opts.max}px · aspect preserved\n${'─'.repeat(72)}`);

  let totalIn = 0;
  let totalOut = 0;

  for (const src of images) {
    const inSize = statSync(src).size;
    const outName = `${basename(src, extname(src))}.webp`;
    const dest = join(opts.out, outName);

    const pipeline = sharp(src)
      .rotate()
      .resize({ width: opts.max, height: opts.max, fit: 'inside', withoutEnlargement: true })
      .webp({ quality: opts.quality });
    const info = await pipeline.toFile(dest);

    totalIn += inSize;
    totalOut += info.size;
    const pct = ((1 - info.size / inSize) * 100).toFixed(0);
    console.log(`  ${basename(src)}\n    -> ${outName}  ${info.width}x${info.height}  ${formatKb(inSize)} -> ${formatKb(info.size)}  (-${pct}%)`);
  }

  console.log(`${'─'.repeat(72)}`);
  const savedPct = totalIn > 0 ? ((1 - totalOut / totalIn) * 100).toFixed(0) : '0';
  console.log(`Total: ${formatKb(totalIn)} -> ${formatKb(totalOut)}  (-${savedPct}%)`);
  console.log('✓ Done. Drag the .webp files from the output folder into the release editor.');
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
