const fs = require('node:fs');
const path = require('node:path');
const source = process.argv[2];
if (!source) throw new Error('Usage: node scripts/book-knowledge-common-words.cjs SCOWL_PATH');
const seen = new Set();
const levels = [10, 20, 35, 40].map((level) => {
  const words = new Set();
  for (const dialect of ['english', 'american']) {
    const file = path.join(source, 'final', `${dialect}-words.${level}`);
    for (const word of fs.readFileSync(file, 'latin1').split(/\r?\n/)) {
      if (/^[a-z]+$/.test(word) && !seen.has(word)) words.add(word);
    }
  }
  for (const word of words) seen.add(word);
  return `  [${level}, ${JSON.stringify([...words].sort().join(' '))}],`;
});
const target = path.join(__dirname, '../src/modules/book-knowledge/core');
fs.writeFileSync(
  path.join(target, 'common-words.ts'),
  `// Generated from SCOWL 2020.12.07. See common-words.LICENSE.\nconst levels: [number, string][] = [\n${levels.join('\n')}\n];\nconst rarityByLevel: Record<number, number> = { 10: 0, 20: 0.1, 35: 0.35, 40: 0.6 };\nconst rarities = new Map(levels.flatMap(([level, text]) => text.split(' ').map((word): [string, number] => [word, rarityByLevel[level]])));\nexport function wordRarity(word: string): number { return rarities.get(word) ?? 1; }\n`,
);
fs.writeFileSync(
  path.join(target, 'common-words.LICENSE'),
  'SCOWL 2020.12.07, modified selection: ASCII lowercase english-words and american-words levels 10, 20, 35, 40.\n\n' +
    fs.readFileSync(path.join(source, 'Copyright'), 'utf8'),
);
