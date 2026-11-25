import { registerAs } from '@nestjs/config';

export const bookKnowledgeConfig = registerAs('bookKnowledge', () => {
  const threads = Number.parseInt(process.env.BOOK_KNOWLEDGE_GLINER_THREADS ?? '', 10);
  return { glinerThreads: Number.isInteger(threads) && threads > 0 ? threads : 2 };
});
