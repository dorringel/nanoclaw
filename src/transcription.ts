import { execFile } from 'child_process';
import { writeFile, unlink, mkdtemp } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { promisify } from 'util';
import { logger } from './logger.js';

const execFileAsync = promisify(execFile);

const WHISPER_BIN = process.env.WHISPER_BIN || 'whisper-cli';
const WHISPER_MODEL =
  process.env.WHISPER_MODEL || 'data/models/ggml-small.bin';

/**
 * Transcribes an audio buffer using local whisper.cpp.
 * Converts to 16kHz WAV via ffmpeg, then runs whisper-cli.
 * Returns the transcribed text, or null if transcription fails.
 */
export async function transcribeAudio(
  audioBuffer: Buffer,
  filename: string,
): Promise<string | null> {
  let tmpDir: string | undefined;
  try {
    tmpDir = await mkdtemp(join(tmpdir(), 'whisper-'));
    const inputPath = join(tmpDir, filename);
    const wavPath = join(tmpDir, 'audio.wav');

    await writeFile(inputPath, audioBuffer);

    // Convert to 16kHz mono WAV (required by whisper.cpp)
    await execFileAsync('ffmpeg', [
      '-i', inputPath,
      '-ar', '16000',
      '-ac', '1',
      '-f', 'wav',
      wavPath,
      '-y',
    ], { timeout: 30_000 });

    // Run whisper-cli
    const { stdout } = await execFileAsync(WHISPER_BIN, [
      '-m', WHISPER_MODEL,
      '-f', wavPath,
      '--no-timestamps',
      '-nt',
    ], { timeout: 120_000 });

    const text = stdout.trim();
    if (!text) return null;

    logger.info({ chars: text.length }, 'Transcribed voice message');
    return text;
  } catch (err) {
    logger.error({ err }, 'whisper.cpp transcription failed');
    return null;
  } finally {
    // Clean up temp files
    if (tmpDir) {
      try {
        const { rm } = await import('fs/promises');
        await rm(tmpDir, { recursive: true });
      } catch { /* ignore cleanup errors */ }
    }
  }
}

/**
 * Downloads a file from a URL and returns its contents as a Buffer.
 */
export async function downloadBuffer(url: string): Promise<Buffer> {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Failed to download file: ${res.status} ${res.statusText}`);
  }
  const arrayBuffer = await res.arrayBuffer();
  return Buffer.from(arrayBuffer);
}
