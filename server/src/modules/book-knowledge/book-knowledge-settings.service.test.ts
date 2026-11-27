import { BookKnowledgeSettingsService } from './book-knowledge-settings.service';
import type { AiSettingsService } from '../ai/ai-settings.service';

describe('BookKnowledgeSettingsService', () => {
  it('follows the Book Knowledge toggle in the AI settings', async () => {
    const features = vi.fn<() => Promise<Record<string, { enabled: boolean }>>>();
    const settings = new BookKnowledgeSettingsService({ features } as unknown as AiSettingsService);
    features.mockResolvedValue({ 'book-knowledge': { enabled: true } });
    expect(await settings.enabled()).toBe(true);
    features.mockResolvedValue({ 'book-knowledge': { enabled: false } });
    expect(await settings.enabled()).toBe(false);
    features.mockResolvedValue({});
    expect(await settings.enabled()).toBe(false);
  });
});
