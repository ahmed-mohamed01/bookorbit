import { compareAudioPlayOrder } from './audio-play-order.utils';

function audioRow(sortOrder: number | null, absolutePath: string) {
  return { sortOrder, absolutePath };
}

describe('compareAudioPlayOrder', () => {
  it('orders by sortOrder and pushes a null sortOrder last', () => {
    const files = [audioRow(null, '/books/zz.mp3'), audioRow(2, '/books/b.mp3'), audioRow(1, '/books/a.mp3')];

    expect(files.sort(compareAudioPlayOrder).map((file) => file.absolutePath)).toEqual(['/books/a.mp3', '/books/b.mp3', '/books/zz.mp3']);
  });

  it('falls back to natural filename order when every sortOrder is null', () => {
    const files = [audioRow(null, '/books/track-10.mp3'), audioRow(null, '/books/track-2.mp3'), audioRow(null, '/books/track-1.mp3')];

    expect(files.sort(compareAudioPlayOrder).map((file) => file.absolutePath)).toEqual([
      '/books/track-1.mp3',
      '/books/track-2.mp3',
      '/books/track-10.mp3',
    ]);
  });

  it('compares basenames rather than whole paths', () => {
    expect(compareAudioPlayOrder(audioRow(null, '/zzz/track-2.mp3'), audioRow(null, '/aaa/track-10.mp3'))).toBeLessThan(0);
  });

  it('is stable for files that tie on both keys', () => {
    const first = audioRow(1, '/books/disc-1/track-1.mp3');
    const second = audioRow(1, '/books/disc-2/track-1.mp3');

    expect(compareAudioPlayOrder(first, second)).toBe(0);
    expect([first, second].sort(compareAudioPlayOrder)).toEqual([first, second]);
  });
});
