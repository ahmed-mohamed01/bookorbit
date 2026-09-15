export const EXTRA_PROGRESS_SOURCE = Symbol('EXTRA_PROGRESS_SOURCE');

export interface ExtraProgress {
  percentage: number;
  updatedAt: Date;
}

export interface ExtraProgressSource {
  findProgressForBooks(userId: number, bookIds: number[]): Promise<Map<number, ExtraProgress>>;
}
