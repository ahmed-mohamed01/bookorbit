import { Injectable, Logger } from '@nestjs/common';
import type { BookKnowledgeSettings } from '@bookorbit/types';
import { BookKnowledgeRepository } from './book-knowledge.repository';
import { knowledgeOperation } from './book-knowledge-logging';
import { KnowledgeSettingsDto } from './dto/book-knowledge.dto';
@Injectable()
export class BookKnowledgeSettingsService {
  private readonly logger = new Logger(BookKnowledgeSettingsService.name);
  constructor(private readonly repo: BookKnowledgeRepository) {}
  async get(): Promise<BookKnowledgeSettings> {
    return { enabled: await this.enabled() };
  }
  async enabled(): Promise<boolean> {
    return (await this.repo.settings()).enabled;
  }
  async update(dto: KnowledgeSettingsDto, userId: number): Promise<BookKnowledgeSettings> {
    return knowledgeOperation(this.logger, 'book_knowledge.settings', `userId=${userId}`, async () => {
      if (dto.enabled !== undefined) await this.repo.saveSettings({ enabled: dto.enabled });
      return this.get();
    });
  }
}
