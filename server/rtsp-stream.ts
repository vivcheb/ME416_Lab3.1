import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import type { Request, Response } from 'express';
import type {
  CameraConnectionState,
  CameraPublicConfig,
  CameraTestResult,
  StreamProfile,
} from '../src/core/types.ts';

export interface CameraInternalConfig {
  rtspUrl: string;
  mainRtspUrl: string;
  host: string;
  port: number;
  path: string;
  user: string;
  password: string;
  streamProfile: StreamProfile;
  targetFps: number;
  scaleWidth: number;
}

const HOST_REGEX = /^[a-zA-Z0-9._:\-\[\]]{1,253}$/;
const JPEG_SOI = Buffer.from([0xff, 0xd8]);
const JPEG_EOI = Buffer.from([0xff, 0xd9]);
const MAX_FRAME_BUFFER_BYTES = 4 * 1024 * 1024;
const WATCHDOG_TIMEOUT_MS = 5000;
const MIN_BACKOFF_MS = 1000;
const MAX_BACKOFF_MS = 15000;

/**
 * Masks any credentials in RTSP URLs or log strings so username/password NEVER leak
 * into logs, API responses, or browser telemetry.
 */
export function maskRtspUrl(rawUrl: string): string {
  if (!rawUrl) return '';
  return rawUrl.replace(/(rtsp:\/\/)([^:@/\s]+)(:([^@/\s]*))?@/gi, '$1***:***@');
}

export function sanitizeLogLine(line: string, secretValues: string[] = []): string {
  let cleaned = maskRtspUrl(line);
  for (const secret of secretValues) {
    if (secret && secret.length >= 2) {
      cleaned = cleaned.split(secret).join('***');
      const encoded = encodeURIComponent(secret);
      if (encoded !== secret) {
        cleaned = cleaned.split(encoded).join('***');
      }
    }
  }
  return cleaned;
}

/**
 * Parses an RTSP URL into discrete fields for server-side configuration.
 */
export function parseRtspUrl(rawUrl: string): {
  host: string;
  port: number;
  path: string;
  user: string;
  password: string;
} | null {
  if (!rawUrl || !rawUrl.trim().toLowerCase().startsWith('rtsp://')) {
    return null;
  }
  try {
    const parsed = new URL(rawUrl.trim());
    if (parsed.protocol !== 'rtsp:') return null;
    const port = parsed.port ? Number.parseInt(parsed.port, 10) : 554;
    if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
    const host = parsed.hostname;
    if (!host || !HOST_REGEX.test(host)) return null;
    const pathAndQuery = `${parsed.pathname || '/'}${parsed.search || ''}`;
    return {
      host,
      port,
      path: pathAndQuery,
      user: decodeURIComponent(parsed.username || ''),
      password: decodeURIComponent(parsed.password || ''),
    };
  } catch {
    return null;
  }
}

/**
 * Validates and constructs a safe RTSP URL from discrete fields.
 */
export function buildRtspUrl(fields: {
  host: string;
  port: number;
  path: string;
  user?: string;
  password?: string;
}): string | null {
  const host = fields.host.trim();
  if (!host || !HOST_REGEX.test(host)) return null;

  const port = Number(fields.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;

  const rawPath = (fields.path || '/').trim();
  if (!rawPath.startsWith('/') || /[\r\n\0\s]/.test(rawPath)) return null;

  const user = fields.user ? encodeURIComponent(fields.user) : '';
  const pass = fields.password ? encodeURIComponent(fields.password) : '';
  const auth = user ? (pass ? `${user}:${pass}@` : `${user}@`) : '';

  return `rtsp://${auth}${host}:${port}${rawPath}`;
}

/**
 * Inspects a JPEG buffer's SOF0/SOF2 marker to extract frame width and height.
 */
function parseJpegDimensions(buf: Buffer): { width: number; height: number } | null {
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return null;
  let offset = 2;
  while (offset + 9 < buf.length) {
    if (buf[offset] !== 0xff) {
      offset++;
      continue;
    }
    const marker = buf[offset + 1];
    // SOF0 (0xC0) or SOF2 (0xC2)
    if (marker === 0xc0 || marker === 0xc2) {
      const height = buf.readUInt16BE(offset + 5);
      const width = buf.readUInt16BE(offset + 7);
      if (width > 0 && height > 0) return { width, height };
      return null;
    }
    if (marker === 0xd9 || marker === 0xda) break;
    const segmentLen = buf.readUInt16BE(offset + 2);
    if (segmentLen < 2) break;
    offset += 2 + segmentLen;
  }
  return null;
}

/**
 * Classifies an ffmpeg/ffprobe stderr output into an actionable camera error.
 */
function classifyRtspError(stderrText: string): {
  code: CameraTestResult['code'];
  message: string;
} {
  const lower = stderrText.toLowerCase();
  if (lower.includes('401') || lower.includes('unauthorized') || lower.includes('authorization failed')) {
    return {
      code: 'auth_failure',
      message: 'Authentication failed (401 Unauthorized). Check the view-only camera username and password.',
    };
  }
  if (lower.includes('404') || lower.includes('not found') || lower.includes('stream not found')) {
    return {
      code: 'bad_path',
      message: 'RTSP stream path not found (404). Verify the manufacturer sub-stream path in your camera manual.',
    };
  }
  if (lower.includes('timed out') || lower.includes('timeout')) {
    return {
      code: 'timeout',
      message: 'Connection timed out. Verify camera PoE power, static IP, and LAN/VLAN reachability.',
    };
  }
  if (
    lower.includes('connection refused') ||
    lower.includes('no route to host') ||
    lower.includes('network is unreachable') ||
    lower.includes('name or service not known')
  ) {
    return {
      code: 'network_error',
      message: 'Camera host unreachable or RTSP port 554 refused. Confirm static IP and RTSP enabled on camera.',
    };
  }
  return {
    code: 'network_error',
    message: 'Unable to open RTSP stream. Verify host, port, credentials, and sub-stream path.',
  };
}

export function resolveFfmpegBin(): string {
  return process.env.FFMPEG_PATH?.trim() || 'ffmpeg';
}

export function resolveFfprobeBin(): string {
  const ffmpegPath = process.env.FFMPEG_PATH?.trim();
  if (ffmpegPath && ffmpegPath.endsWith('ffmpeg')) {
    return ffmpegPath.slice(0, -6) + 'ffprobe';
  }
  return 'ffprobe';
}

/**
 * Runs a one-shot connection test against an RTSP URL using ffprobe (TCP transport, no shell).
 * Reports auth failure, timeout, bad path, or the stream's actual resolution, codec, and FPS.
 */
export function testCameraConnection(rtspUrl: string, timeoutMs = 6000): Promise<CameraTestResult> {
  return new Promise((resolve) => {
    if (!rtspUrl) {
      resolve({
        ok: false,
        code: 'not_configured',
        message: 'No RTSP camera URL is configured. Enter camera host/path or set CAMERA_RTSP_URL in .env.',
      });
      return;
    }

    const maskedUrl = maskRtspUrl(rtspUrl);
    const parsed = parseRtspUrl(rtspUrl);
    const secrets = parsed ? [parsed.user, parsed.password] : [];

    const args = [
      '-v', 'error',
      '-rtsp_transport', 'tcp',
      '-select_streams', 'v:0',
      '-show_entries', 'stream=codec_name,width,height,avg_frame_rate,r_frame_rate',
      '-of', 'json',
      rtspUrl,
    ];

    let proc: ChildProcessWithoutNullStreams;
    try {
      proc = spawn(resolveFfprobeBin(), args, { shell: false });
    } catch {
      resolve({
        ok: false,
        code: 'ffmpeg_missing',
        message: 'ffprobe binary not found. Install ffmpeg on the host machine.',
        maskedUrl,
      });
      return;
    }

    let stdout = '';
    let stderr = '';
    let settled = false;

    const finish = (result: CameraTestResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    const timer = setTimeout(() => {
      try {
        proc.kill('SIGKILL');
      } catch {
        // ignore
      }
      finish({
        ok: false,
        code: 'timeout',
        message: `Connection timed out after ${Math.round(timeoutMs / 1000)}s probing ${maskedUrl}.`,
        maskedUrl,
      });
    }, timeoutMs);

    proc.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });

    proc.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });

    proc.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'ENOENT') {
        finish({
          ok: false,
          code: 'ffmpeg_missing',
          message: 'ffprobe is not installed or not in PATH. Install ffmpeg to bridge RTSP streams.',
          maskedUrl,
        });
      } else {
        finish({
          ok: false,
          code: 'network_error',
          message: sanitizeLogLine(err.message, secrets),
          maskedUrl,
        });
      }
    });

    proc.on('close', (code) => {
      if (settled) return;
      if (code === 0 && stdout.trim()) {
        try {
          const data = JSON.parse(stdout) as {
            streams?: Array<{
              codec_name?: string;
              width?: number;
              height?: number;
              avg_frame_rate?: string;
              r_frame_rate?: string;
            }>;
          };
          const stream = data.streams?.[0];
          if (stream) {
            const fpsRaw = stream.avg_frame_rate && stream.avg_frame_rate !== '0/0'
              ? stream.avg_frame_rate
              : stream.r_frame_rate || '0/1';
            const [num, den] = fpsRaw.split('/').map(Number);
            const fps = den && Number.isFinite(num / den) ? Number((num / den).toFixed(1)) : undefined;

            finish({
              ok: true,
              code: 'ok',
              message: `Connected to ${maskedUrl} (${stream.codec_name?.toUpperCase() ?? 'VIDEO'} ${stream.width ?? '?'}x${stream.height ?? '?'}${fps ? ` @ ${fps} fps` : ''}).`,
              codec: stream.codec_name,
              width: stream.width,
              height: stream.height,
              fps,
              maskedUrl,
            });
            return;
          }
        } catch {
          // Fall through to error handling
        }
      }

      const classified = classifyRtspError(sanitizeLogLine(stderr, secrets));
      finish({
        ok: false,
        code: classified.code,
        message: classified.message,
        maskedUrl,
      });
    });
  });
}

/**
 * Supervises an ffmpeg RTSP -> MJPEG child process with JPEG framing,
 * 5-second frame watchdog, exponential backoff (1s -> 15s), and multipart HTTP fan-out.
 */
export class RtspStreamSupervisor extends EventEmitter {
  private config: CameraInternalConfig;
  private ffmpegProc: ChildProcessWithoutNullStreams | null = null;
  private state: CameraConnectionState = 'offline';
  private lastError: string | null = null;
  private lastFrameAt = 0;
  private latestFrame: Buffer | null = null;
  private frameBuffer: Buffer = Buffer.alloc(0);
  private clients = new Set<Response>();
  private frameTimestamps: number[] = [];
  private resolution: { width: number; height: number } | null = null;

  private watchdogTimer: NodeJS.Timeout | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private backoffMs = MIN_BACKOFF_MS;
  private shouldRun = false;

  constructor(initialConfig: CameraInternalConfig) {
    super();
    this.config = { ...initialConfig };
  }

  public isConfigured(): boolean {
    return Boolean(this.config.rtspUrl && this.config.host);
  }

  public getState(): CameraConnectionState {
    return this.state;
  }

  public getLastError(): string | null {
    return this.lastError;
  }

  public getResolution(): { width: number; height: number } | null {
    return this.resolution;
  }

  public getMeasuredFps(): number {
    const now = Date.now();
    this.frameTimestamps = this.frameTimestamps.filter((ts) => now - ts <= 2000);
    if (this.frameTimestamps.length < 2) return 0;
    const spanSec = (this.frameTimestamps[this.frameTimestamps.length - 1] - this.frameTimestamps[0]) / 1000;
    if (spanSec <= 0) return 0;
    return Number(((this.frameTimestamps.length - 1) / spanSec).toFixed(1));
  }

  /**
   * Returns sanitized camera configuration safe to send to the browser.
   * Credentials are NEVER exposed.
   */
  public getPublicConfig(): CameraPublicConfig {
    return {
      configured: this.isConfigured(),
      host: this.config.host,
      port: this.config.port,
      path: this.config.path,
      user: this.config.user ? '***' : '',
      hasPassword: Boolean(this.config.password),
      streamProfile: this.config.streamProfile,
      targetFps: this.config.targetFps,
      scaleWidth: this.config.scaleWidth,
      maskedUrl: maskRtspUrl(this.getActiveRtspUrl()),
      hasMainStream: Boolean(this.config.mainRtspUrl),
    };
  }

  public getActiveRtspUrl(): string {
    if (this.config.streamProfile === 'main' && this.config.mainRtspUrl) {
      return this.config.mainRtspUrl;
    }
    return this.config.rtspUrl;
  }

  public getStoredPassword(): string {
    return this.config.password;
  }

  public getStoredUser(): string {
    return this.config.user;
  }

  public updateConfig(next: Partial<CameraInternalConfig>): void {
    this.config = { ...this.config, ...next };
    // Never decode full 5MP in browser: main stream downscales to <=1280px, sub stream <=960px
    const maxW = this.config.streamProfile === 'main' ? 1280 : 960;
    this.config.scaleWidth = Math.min(maxW, Math.max(160, Math.round(this.config.scaleWidth)));
    this.config.targetFps = Math.min(30, Math.max(1, Math.round(this.config.targetFps)));

    if (this.isConfigured() && (this.shouldRun || this.clients.size > 0)) {
      this.restart();
    } else if (!this.isConfigured()) {
      this.stop();
    }
  }

  public start(): void {
    if (!this.isConfigured()) {
      this.setState('offline', 'No RTSP camera configured in .env or Camera Settings.');
      return;
    }
    this.shouldRun = true;
    this.backoffMs = MIN_BACKOFF_MS;
    this.clearTimers();
    this.spawnFfmpeg();
    this.startWatchdog();
  }

  public restart(): void {
    this.killProcess();
    this.clearTimers();
    if (!this.isConfigured()) {
      this.setState('offline', 'Camera RTSP URL not configured.');
      return;
    }
    this.shouldRun = true;
    this.backoffMs = MIN_BACKOFF_MS;
    this.spawnFfmpeg();
    this.startWatchdog();
  }

  public stop(): void {
    this.shouldRun = false;
    this.clearTimers();
    this.killProcess();
    this.frameTimestamps = [];
    this.setState('offline', null);
  }

  /**
   * Attaches an Express response to the multipart/x-mixed-replace MJPEG stream.
   */
  public attachMjpegClient(req: Request, res: Response): void {
    res.writeHead(200, {
      'Content-Type': 'multipart/x-mixed-replace; boundary=frame',
      'Cache-Control': 'no-cache, no-store, must-revalidate',
      Pragma: 'no-cache',
      Connection: 'close',
    });

    this.clients.add(res);

    // Send latest frame immediately if available so the browser renders without delay
    if (this.latestFrame) {
      this.writeFrameToClient(res, this.latestFrame);
    }

    // Lazily start ffmpeg if configured and not already running
    if (this.isConfigured() && !this.shouldRun) {
      this.start();
    }

    req.on('close', () => {
      this.clients.delete(res);
    });
  }

  private writeFrameToClient(res: Response, jpeg: Buffer): void {
    if (res.writableEnded || res.destroyed) {
      this.clients.delete(res);
      return;
    }
    try {
      res.write(
        `--frame\r\nContent-Type: image/jpeg\r\nContent-Length: ${jpeg.length}\r\n\r\n`,
      );
      res.write(jpeg);
      res.write('\r\n');
    } catch {
      this.clients.delete(res);
    }
  }

  private setState(nextState: CameraConnectionState, errorMsg: string | null): void {
    const changed = this.state !== nextState || this.lastError !== errorMsg;
    this.state = nextState;
    this.lastError = errorMsg;
    if (changed) {
      this.emit('state', { state: this.state, error: this.lastError });
    }
  }

  private clearTimers(): void {
    if (this.watchdogTimer) {
      clearInterval(this.watchdogTimer);
      this.watchdogTimer = null;
    }
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private killProcess(): void {
    if (this.ffmpegProc) {
      const proc = this.ffmpegProc;
      this.ffmpegProc = null;
      try {
        proc.stdout.removeAllListeners();
        proc.stderr.removeAllListeners();
        proc.removeAllListeners();
        proc.kill('SIGTERM');
        setTimeout(() => {
          try {
            if (!proc.killed) proc.kill('SIGKILL');
          } catch {
            // ignore
          }
        }, 1000);
      } catch {
        // ignore
      }
    }
    this.frameBuffer = Buffer.alloc(0);
  }

  private startWatchdog(): void {
    if (this.watchdogTimer) clearInterval(this.watchdogTimer);
    this.watchdogTimer = setInterval(() => {
      if (!this.shouldRun || !this.ffmpegProc) return;
      const now = Date.now();
      if (this.lastFrameAt > 0 && now - this.lastFrameAt > WATCHDOG_TIMEOUT_MS) {
        this.emit('log', {
          level: 'warn',
          message: `No RTSP frame received for ${WATCHDOG_TIMEOUT_MS / 1000}s — watchdog restarting ffmpeg.`,
        });
        this.scheduleReconnect('Stream stalled (watchdog triggered after 5s with no frames).');
      }
    }, 1000);
  }

  private scheduleReconnect(reason: string): void {
    this.killProcess();
    if (!this.shouldRun) return;

    const delay = this.backoffMs;
    this.backoffMs = Math.min(MAX_BACKOFF_MS, this.backoffMs * 2);

    this.setState(delay >= MAX_BACKOFF_MS ? 'offline' : 'reconnecting', reason);
    this.emit('log', {
      level: 'warn',
      message: `${reason} Retrying in ${(delay / 1000).toFixed(0)}s.`,
    });

    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.shouldRun) {
        this.spawnFfmpeg();
      }
    }, delay);
  }

  private spawnFfmpeg(): void {
    const rtspUrl = this.getActiveRtspUrl();
    if (!rtspUrl) {
      this.setState('offline', 'Camera RTSP URL is not configured.');
      return;
    }

    const scaleWidth =
      this.config.streamProfile === 'main'
        ? Math.min(1280, Math.max(640, this.config.scaleWidth))
        : Math.min(960, Math.max(160, this.config.scaleWidth));

    const args = [
      '-rtsp_transport', 'tcp',
      '-fflags', 'nobuffer',
      '-flags', 'low_delay',
      '-an',
      '-i', rtspUrl,
      '-vf', `fps=${this.config.targetFps},scale=${scaleWidth}:-2`,
      '-f', 'image2pipe',
      '-vcodec', 'mjpeg',
      '-q:v', '5',
      'pipe:1',
    ];

    this.setState('reconnecting', null);
    this.lastFrameAt = Date.now();
    this.frameBuffer = Buffer.alloc(0);

    const secrets = [this.config.user, this.config.password];
    let stderrAccum = '';

    try {
      const proc = spawn(resolveFfmpegBin(), args, { shell: false });
      this.ffmpegProc = proc;

      proc.stdout.on('data', (chunk: Buffer) => {
        this.handleJpegChunk(chunk);
      });

      proc.stderr.on('data', (chunk: Buffer) => {
        const text = sanitizeLogLine(chunk.toString('utf8'), secrets);
        stderrAccum = (stderrAccum + text).slice(-2000);
      });

      proc.on('error', (err: NodeJS.ErrnoException) => {
        const msg =
          err.code === 'ENOENT'
            ? 'ffmpeg binary not found in PATH. Install ffmpeg or set FFMPEG_PATH.'
            : sanitizeLogLine(err.message, secrets);
        this.scheduleReconnect(msg);
      });

      proc.on('close', (code) => {
        if (this.ffmpegProc !== proc) return;
        this.ffmpegProc = null;
        if (!this.shouldRun) return;
        const classified = classifyRtspError(stderrAccum);
        const msg =
          stderrAccum.trim().length > 0
            ? classified.message
            : `ffmpeg exited unexpectedly (code ${code ?? 'unknown'}).`;
        this.scheduleReconnect(msg);
      });
    } catch (err) {
      this.scheduleReconnect(
        err instanceof Error ? sanitizeLogLine(err.message, secrets) : 'Failed to spawn ffmpeg.',
      );
    }
  }

  private handleJpegChunk(chunk: Buffer): void {
    if (this.frameBuffer.length + chunk.length > MAX_FRAME_BUFFER_BYTES) {
      this.frameBuffer = Buffer.alloc(0);
    }
    this.frameBuffer = Buffer.concat([this.frameBuffer, chunk]);

    let startIdx = this.frameBuffer.indexOf(JPEG_SOI);
    while (startIdx !== -1) {
      const endIdx = this.frameBuffer.indexOf(JPEG_EOI, startIdx + 2);
      if (endIdx === -1) {
        // Keep partial frame starting at SOI
        if (startIdx > 0) {
          this.frameBuffer = this.frameBuffer.subarray(startIdx);
        }
        break;
      }

      const frame = Buffer.from(this.frameBuffer.subarray(startIdx, endIdx + 2));
      this.frameBuffer = this.frameBuffer.subarray(endIdx + 2);
      this.onFrameComplete(frame);
      startIdx = this.frameBuffer.indexOf(JPEG_SOI);
    }
  }

  private onFrameComplete(jpeg: Buffer): void {
    const now = Date.now();
    this.lastFrameAt = now;
    this.latestFrame = jpeg;
    this.backoffMs = MIN_BACKOFF_MS;

    this.frameTimestamps.push(now);
    if (this.frameTimestamps.length > 60) {
      this.frameTimestamps.shift();
    }

    if (!this.resolution) {
      const dims = parseJpegDimensions(jpeg);
      if (dims) this.resolution = dims;
    }

    if (this.state !== 'streaming') {
      this.setState('streaming', null);
      this.emit('log', {
        level: 'success',
        message: `RTSP stream active from ${maskRtspUrl(this.getActiveRtspUrl())}.`,
      });
    }

    for (const client of this.clients) {
      this.writeFrameToClient(client, jpeg);
    }
  }
}
