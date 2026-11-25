import { parentPort, workerData } from 'node:worker_threads';
import { buildArtifactInProcess, type BuildOptions } from './build-pipeline';

async function run(): Promise<void> {
  if (!parentPort) throw new Error('Knowledge worker needs a parent port');
  const { epubPath, options } = workerData as { epubPath: string; options: BuildOptions };
  try {
    parentPort.postMessage({ type: 'result', result: await buildArtifactInProcess(epubPath, options) });
  } catch (error) {
    parentPort.postMessage({ type: 'error', error: error instanceof Error ? error.message : 'Knowledge build failed' });
  }
}
void run();
