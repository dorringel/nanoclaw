import { logger } from './logger.js';

/**
 * Transcribes an audio buffer using the OpenAI Whisper API.
 * Returns the transcribed text, or null if transcription fails.
 */
export async function transcribeAudio(
  audioBuffer: Buffer,
  filename: string,
): Promise<string | null> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    logger.warn('OPENAI_API_KEY not set — voice transcription unavailable');
    return null;
  }

  try {
    const { OpenAI } = await import('openai');
    const client = new OpenAI({ apiKey });

    const file = new File([audioBuffer], filename, { type: 'audio/ogg' });
    const result = await client.audio.transcriptions.create({
      file,
      model: 'whisper-1',
    });

    logger.info(
      { chars: result.text.length },
      'Transcribed voice message',
    );
    return result.text;
  } catch (err) {
    logger.error({ err }, 'OpenAI transcription failed');
    return null;
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
