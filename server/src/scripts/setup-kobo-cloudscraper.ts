import { execFile as execFileCallback } from 'child_process';
import { existsSync } from 'fs';
import { mkdir } from 'fs/promises';
import { join } from 'path';
import { promisify } from 'util';

const execFile = promisify(execFileCallback);

const SERVER_ROOT = process.cwd();
const VENV_DIR = join(SERVER_ROOT, '.venv', 'kobo-cloudscraper');
const PYTHON_BIN = process.platform === 'win32' ? join(VENV_DIR, 'Scripts', 'python.exe') : join(VENV_DIR, 'bin', 'python');
const REQUIREMENTS_PATH = join(SERVER_ROOT, 'requirements', 'kobo-cloudscraper.txt');

async function runCommand(command: string, args: string[]): Promise<void> {
  await execFile(command, args, {
    cwd: SERVER_ROOT,
    maxBuffer: 1024 * 1024,
  });
}

async function hasCloudscraper(): Promise<boolean> {
  if (!existsSync(PYTHON_BIN)) return false;

  try {
    await runCommand(PYTHON_BIN, ['-c', 'import cloudscraper; assert getattr(cloudscraper, "__version__", "") == "3.0.0"']);
    return true;
  } catch {
    return false;
  }
}

async function createVenv(): Promise<void> {
  await mkdir(join(SERVER_ROOT, '.venv'), { recursive: true });

  try {
    await runCommand('python3', ['-m', 'venv', VENV_DIR]);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Could not create Kobo cloudscraper venv with python3: ${message}`, { cause: error });
  }
}

async function run(): Promise<void> {
  if (await hasCloudscraper()) {
    return;
  }

  await createVenv();
  await runCommand(PYTHON_BIN, ['-m', 'pip', 'install', '--disable-pip-version-check', '--quiet', '-r', REQUIREMENTS_PATH]);

  if (!(await hasCloudscraper())) {
    throw new Error('Kobo cloudscraper setup completed, but cloudscraper 3.0.0 could not be imported');
  }
}

void run().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
