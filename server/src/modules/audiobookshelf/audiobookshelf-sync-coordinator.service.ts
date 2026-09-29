import { Injectable } from '@nestjs/common';

@Injectable()
export class AudiobookshelfSyncCoordinatorService {
  private readonly syncUsers = new Set<number>();
  private readonly pushUsers = new Set<number>();

  tryStartSync(userId: number): boolean {
    if (this.syncUsers.has(userId) || this.pushUsers.has(userId)) return false;
    this.syncUsers.add(userId);
    return true;
  }

  endSync(userId: number): void {
    this.syncUsers.delete(userId);
  }

  isSyncRunning(userId: number): boolean {
    return this.syncUsers.has(userId);
  }

  tryStartPush(userId: number): boolean {
    if (this.syncUsers.has(userId) || this.pushUsers.has(userId)) return false;
    this.pushUsers.add(userId);
    return true;
  }

  endPush(userId: number): void {
    this.pushUsers.delete(userId);
  }
}
