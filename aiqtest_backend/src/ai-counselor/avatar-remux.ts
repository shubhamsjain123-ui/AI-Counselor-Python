import { Logger } from '@nestjs/common';
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { randomBytes } from 'crypto';

const logger = new Logger('AvatarRemux');

function run(cmd: string, args: string[]): Promise<{ code: number; stderr: string; stdout: string }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    let stdout = '';
    child.stderr.on('data', (d) => {
      stderr += d.toString();
    });
    child.stdout.on('data', (d) => {
      stdout += d.toString();
    });
    child.on('close', (code) => resolve({ code: code ?? 1, stderr, stdout }));
    child.on('error', (err) => resolve({ code: 1, stderr: err.message, stdout: '' }));
  });
}

async function ffprobeDuration(filePath: string): Promise<number | null> {
  const { code, stdout, stderr } = await run('ffprobe', [
    '-v',
    'error',
    '-show_entries',
    'format=duration',
    '-of',
    'default=nw=1:nk=1',
    filePath,
  ]);
  if (code !== 0) {
    logger.warn(`ffprobe failed: ${stderr.slice(0, 200)}`);
    return null;
  }
  const n = parseFloat(stdout.trim());
  return Number.isFinite(n) ? n : null;
}

/**
 * Lock the exact Gemini PCM into the MuseTalk MP4.
 * Rejects videos that are shorter than the speech (stale/wrong clip).
 */
export async function remuxGeminiPcmIntoMp4(
  videoBuffer: Buffer,
  pcmBuffer: Buffer,
  sampleRate = 24000,
): Promise<Buffer | null> {
  const id = randomBytes(6).toString('hex');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `sabcq-remux-${id}-`));
  const inMp4 = path.join(dir, 'in.mp4');
  const inWav = path.join(dir, 'speech.wav');
  const outMp4 = path.join(dir, 'out.mp4');
  const pcmPath = path.join(dir, 'raw.pcm');

  const cleanup = () => {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch (_) {}
  };

  try {
    fs.writeFileSync(inMp4, videoBuffer);
    fs.writeFileSync(pcmPath, pcmBuffer);
    const pcmDur = pcmBuffer.length / 2 / sampleRate;

    // If MuseTalk returned a shorter clip than our speech, it is almost certainly stale.
    const inDur = await ffprobeDuration(inMp4);
    if (inDur != null && inDur + 0.35 < pcmDur) {
      logger.warn(
        `Rejecting short MuseTalk clip: video=${inDur.toFixed(2)}s pcm=${pcmDur.toFixed(2)}s`,
      );
      cleanup();
      return null;
    }

    let r = await run('ffmpeg', [
      '-y',
      '-f',
      's16le',
      '-ar',
      String(sampleRate),
      '-ac',
      '1',
      '-i',
      pcmPath,
      inWav,
    ]);
    if (r.code !== 0) {
      logger.warn(`PCM→WAV failed: ${r.stderr.slice(-300)}`);
      cleanup();
      return null;
    }

    r = await run('ffmpeg', [
      '-y',
      '-i',
      inMp4,
      '-i',
      inWav,
      '-map',
      '0:v:0',
      '-map',
      '1:a:0',
      '-c:v',
      'copy',
      '-c:a',
      'aac',
      '-b:a',
      '192k',
      '-shortest',
      '-movflags',
      '+faststart',
      outMp4,
    ]);
    if (r.code !== 0 || !fs.existsSync(outMp4)) {
      r = await run('ffmpeg', [
        '-y',
        '-i',
        inMp4,
        '-i',
        inWav,
        '-map',
        '0:v:0',
        '-map',
        '1:a:0',
        '-c:v',
        'libx264',
        '-preset',
        'veryfast',
        '-pix_fmt',
        'yuv420p',
        '-c:a',
        'aac',
        '-b:a',
        '192k',
        '-shortest',
        '-movflags',
        '+faststart',
        outMp4,
      ]);
    }

    if (r.code !== 0 || !fs.existsSync(outMp4) || fs.statSync(outMp4).size < 1000) {
      logger.warn(`Remux failed: ${r.stderr.slice(-400)}`);
      cleanup();
      return null;
    }

    const outDur = await ffprobeDuration(outMp4);
    if (outDur == null || Math.abs(outDur - pcmDur) > 0.85) {
      logger.warn(
        `Rejecting remux: pcmDur=${pcmDur.toFixed(2)}s outDur=${outDur} (stale/wrong MuseTalk clip)`,
      );
      cleanup();
      return null;
    }

    const result = fs.readFileSync(outMp4);
    logger.log(
      `Remux OK: ${result.length} bytes, pcm=${pcmDur.toFixed(2)}s video=${outDur.toFixed(2)}s`,
    );
    cleanup();
    return result;
  } catch (err: any) {
    logger.warn(`Remux exception: ${err.message}`);
    cleanup();
    return null;
  }
}

/** True if MP4 duration roughly matches PCM length (detects poisoned identical caches). */
export async function mp4MatchesPcmDuration(
  videoBuffer: Buffer,
  pcmBuffer: Buffer,
  sampleRate = 24000,
  toleranceSec = 0.85,
): Promise<boolean> {
  const id = randomBytes(4).toString('hex');
  const tmp = path.join(os.tmpdir(), `sabcq-chk-${id}.mp4`);
  try {
    fs.writeFileSync(tmp, videoBuffer);
    const outDur = await ffprobeDuration(tmp);
    const pcmDur = pcmBuffer.length / 2 / sampleRate;
    return outDur != null && Math.abs(outDur - pcmDur) <= toleranceSec;
  } catch {
    return false;
  } finally {
    try {
      fs.unlinkSync(tmp);
    } catch (_) {}
  }
}

/**
 * Concatenate multiple MuseTalk chunk MP4s into one continuous lip-sync video.
 * Re-encodes for reliability across chunk boundaries.
 */
export async function concatMp4Buffers(parts: Buffer[]): Promise<Buffer | null> {
  if (!parts.length) return null;
  if (parts.length === 1) return parts[0];

  const id = randomBytes(6).toString('hex');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `sabcq-cat-${id}-`));
  const listFile = path.join(dir, 'list.txt');
  const outMp4 = path.join(dir, 'joined.mp4');

  const cleanup = () => {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch (_) {}
  };

  try {
    const lines: string[] = [];
    parts.forEach((buf, i) => {
      const p = path.join(dir, `part_${i}.mp4`);
      fs.writeFileSync(p, buf);
      lines.push(`file '${p}'`);
    });
    fs.writeFileSync(listFile, lines.join('\n'));

    // Re-encode concat (copy often fails when chunk codecs/timestamps differ)
    const r = await run('ffmpeg', [
      '-y',
      '-f',
      'concat',
      '-safe',
      '0',
      '-i',
      listFile,
      '-c:v',
      'libx264',
      '-preset',
      'veryfast',
      '-pix_fmt',
      'yuv420p',
      '-c:a',
      'aac',
      '-b:a',
      '192k',
      '-movflags',
      '+faststart',
      outMp4,
    ]);

    if (r.code !== 0 || !fs.existsSync(outMp4) || fs.statSync(outMp4).size < 1000) {
      logger.warn(`concat MP4 failed: ${r.stderr.slice(-400)}`);
      cleanup();
      return null;
    }

    const result = fs.readFileSync(outMp4);
    logger.log(`Concat OK: ${parts.length} chunks → ${result.length} bytes`);
    cleanup();
    return result;
  } catch (err: any) {
    logger.warn(`concat exception: ${err.message}`);
    cleanup();
    return null;
  }
}
