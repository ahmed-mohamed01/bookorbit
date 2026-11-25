import { Test } from '@nestjs/testing';
import { BookKnowledgeSettingsService } from './book-knowledge-settings.service';
import { BookKnowledgeRepository } from './book-knowledge.repository';
import { BookKnowledgeSettingsController } from './book-knowledge.controller';
import { PERMISSION_KEY } from '../../common/decorators/require-permission.decorator';
import { Permission } from '@bookorbit/types';
describe('Book Knowledge instance settings', () => {
  it('stores only the enabled switch', async () => {
    let row = { id: 1, enabled: false };
    const repo = {
      settings: vi.fn(() => Promise.resolve(row)),
      saveSettings: vi.fn((values: { enabled: boolean }) => {
        row = { ...row, ...values };
        return Promise.resolve();
      }),
    };
    const module = await Test.createTestingModule({
      providers: [BookKnowledgeSettingsService, { provide: BookKnowledgeRepository, useValue: repo }],
    }).compile();
    const settings = module.get(BookKnowledgeSettingsService);
    expect(await settings.update({ enabled: true }, 1)).toEqual({ enabled: true });
    expect(await settings.enabled()).toBe(true);
    await settings.update({}, 1);
    expect(repo.saveSettings).toHaveBeenCalledTimes(1);
  });
  it('gates the settings controller with the same permission as TTS', () => {
    expect(Reflect.getMetadata(PERMISSION_KEY, BookKnowledgeSettingsController)).toBe(Permission.ManageAppSettings);
  });
});
