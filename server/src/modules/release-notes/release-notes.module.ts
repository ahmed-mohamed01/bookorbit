import { Module } from '@nestjs/common';

import { AppSettingsModule } from '../app-settings/app-settings.module';
import { ReleaseNotesController } from './release-notes.controller';
import { ReleaseNotesService } from './release-notes.service';

@Module({
  imports: [AppSettingsModule],
  controllers: [ReleaseNotesController],
  providers: [ReleaseNotesService],
})
export class ReleaseNotesModule {}
