import { describe, expect, it } from 'vitest';

import { buildWebSerialOutcomeNotification } from './web-serials-notification.utils';

const base = { jobId: 12, title: 'Saga', noun: 'chapter', message: null, imported: 12, libraryName: 'Manga' };

describe('buildWebSerialOutcomeNotification', () => {
  it('words a completed job with a count and the library', () => {
    const { groupKey, patch } = buildWebSerialOutcomeNotification({ ...base, outcome: 'completed' });

    expect(groupKey).toBe('web-serial-job:12');
    expect(patch).toEqual({
      type: 'web_serial_completed',
      title: 'Saga is in your library',
      message: '12 chapters added to Manga.',
      actionUrl: '/web-serials/queue',
      meta: { jobId: 12 },
    });
  });

  it('counts the units the job made and singularises one', () => {
    const { patch } = buildWebSerialOutcomeNotification({ ...base, noun: 'volume', imported: 1, libraryName: null, outcome: 'completed' });
    expect(patch.message).toBe('1 volume added.');
    expect(buildWebSerialOutcomeNotification({ ...base, noun: 'volume', imported: 3, outcome: 'completed' }).patch.message).toBe(
      '3 volumes added to Manga.',
    );
  });

  it('prefers the job message for gaps and failures', () => {
    const gaps = buildWebSerialOutcomeNotification({ ...base, outcome: 'completed_with_gaps', message: '2 chapters could not be downloaded.' });
    expect(gaps.patch).toMatchObject({
      type: 'web_serial_completed_with_gaps',
      title: 'Saga was added with gaps',
      message: '2 chapters could not be downloaded.',
    });

    const failed = buildWebSerialOutcomeNotification({ ...base, outcome: 'failed', message: 'The source is down.' });
    expect(failed.patch).toMatchObject({ type: 'web_serial_failed', title: 'Saga could not be downloaded', message: 'The source is down.' });
  });

  it('keeps a very long series title within the notification title column', () => {
    const { patch } = buildWebSerialOutcomeNotification({ ...base, title: 'x'.repeat(1000), outcome: 'failed' });
    expect(patch.title.length).toBeLessThanOrEqual(255);
  });
});
