import { Injectable } from '@nestjs/common';

import { buildAudioTimeline, filePositionToAbsoluteSeconds } from '../../common/utils/audio-timeline.utils';
import { AudioPlayOrderService } from '../audiobook-chapters/audio-play-order.service';

@Injectable()
export class AudiobookshelfAudioPositionService {
  constructor(private readonly chapters: AudioPlayOrderService) {}

  async resolveAudioBookPosition(
    audioBookId: number,
    currentFileId: number,
    positionSeconds: number,
  ): Promise<{ audioSeconds: number; audioTotalSeconds: number } | null> {
    const timeline = buildAudioTimeline(await this.chapters.resolveAudioPlayOrder(audioBookId));
    if (timeline.incomplete || !timeline.entries.some((file) => file.fileId === currentFileId)) return null;
    return {
      audioSeconds: filePositionToAbsoluteSeconds(timeline, currentFileId, positionSeconds),
      audioTotalSeconds: timeline.totalSeconds,
    };
  }
}
