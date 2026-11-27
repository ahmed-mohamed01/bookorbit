import { Injectable } from '@nestjs/common';
import { AiSettingsService } from '../ai/ai-settings.service';

export const BOOK_KNOWLEDGE_AI_FEATURE = 'book-knowledge';

/** Book Knowledge is on exactly when its feature is on in the server's AI settings. */
@Injectable()
export class BookKnowledgeSettingsService {
  constructor(private readonly aiSettings: AiSettingsService) {}
  async enabled(): Promise<boolean> {
    return (await this.aiSettings.features())[BOOK_KNOWLEDGE_AI_FEATURE]?.enabled === true;
  }
}
