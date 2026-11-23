import 'dotenv/config';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import express, { type NextFunction, type Request, type Response } from 'express';
import { WebSocketServer, WebSocket } from 'ws';
import {
  buildRtspUrl,
  maskRtspUrl,
  parseRtspUrl,
  RtspStreamSupervisor,
  testCameraConnection,
} from './server/rtsp-stream.ts';
import { MqttBridge } from './server/mqtt-bridge.ts';
import type {
  BridgeStatusPayload,
  StreamProfile,
  TelemetryLogEntry,
  VideoSourceType,
} from './src/core/types.ts';

const PORT = Number.parseInt(process.env.PORT || '3000', 10) || 3000;
// Default 0.0.0.0 in hosted/dev containers, or HOST from .env (e.g. 127.0.0.1 for local-only deployment)
const HOST = process.env.HOST || '0.0.0.0';
const ACCESS_TOKEN = (process.env.ACCESS_TOKEN || '').trim();
const CAMERA_LOST_TIMEOUT_MS = 10_000;

// Parse initial RTSP configuration from .env (credentials remain server-side only)
const envRtspUrl = (process.env.CAMERA_RTSP_URL || '').trim();
const envMainRtspUrl = (process.env.CAMERA_MAIN_RTSP_URL || '').trim();
const isPlaceholderRtsp =
  !envRtspUrl ||
  envRtspUrl.includes('VIEW_USER:VIEW_PASS@') ||
  envRtspUrl.includes('USER:PASS@CAMERA_IP');

const parsedInitial = !isPlaceholderRtsp ? parseRtspUrl(envRtspUrl) : null;

const rtspSupervisor = new RtspStreamSupervisor({
  rtspUrl: parsedInitial ? envRtspUrl : '',
  mainRtspUrl: envMainRtspUrl && !envMainRtspUrl.includes('VIEW_USER:VIEW_PASS@') ? envMainRtspUrl : '',
  host: parsedInitial?.host || '',
  port: parsedInitial?.port || 554,
  path: parsedInitial?.path || '/h264Preview_01_sub',
  user: parsedInitial?.user || '',
  password: parsedInitial?.password || '',
  streamProfile: 'sub',
  targetFps: Number.parseInt(process.env.STREAM_FPS || '15', 10) || 15,
  scaleWidth: Number.parseInt(process.env.STREAM_WIDTH || '640', 10) || 640,
});

const mqttBridge = new MqttBridge({
  host: process.env.BROKER_HOST || 'rasticvm.internal',
  port: Number.parseInt(process.env.BROKER_PORT || '1883', 10) || 1883,
  topic: process.env.TOPIC || 'room/activity/status',
  useLocalhostFallback: process.env.BROKER_FALLBACK === 'true',
  clearOldTopicOnChange: true,
  offlineOnTabClose: process.env.OFFLINE_ON_TAB_CLOSE !== 'false',
  offlineGraceMs: Number.parseInt(process.env.OFFLINE_GRACE_MS || '5000', 10) || 5000,
});

// Active source reported by connected browser dashboard
let activeBrowserSource: VideoSourceType = parsedInitial ? 'ip_camera' : 'simulation';
let tabCloseTimer: NodeJS.Timeout | null = null;
let cameraLostTimer: NodeJS.Timeout | null = null;
let cameraLostPublished = false;

function buildStatusPayload(): BridgeStatusPayload {
  const pubMeta = mqttBridge.getLastPublishedMeta();
  return {
    cameraState: rtspSupervisor.getState(),
    cameraError: rtspSupervisor.getLastError(),
    cameraFps: rtspSupervisor.getMeasuredFps(),
    cameraResolution: rtspSupervisor.getResolution(),
    brokerState: mqttBridge.getState(),
    brokerError: mqttBridge.getLastError(),
    cameraConfig: rtspSupervisor.getPublicConfig(),
    mqttConfig: mqttBridge.getPublicConfig(),
    lastPublishedAt: pubMeta.lastPublishedAt,
    lastPublishedTopic: pubMeta.lastPublishedTopic,
    lastPublishedStatus: pubMeta.lastPublishedStatus,
  };
}

/**
 * Constant-time token verification when ACCESS_TOKEN is configured for LAN exposure.
 */
function verifyAccessToken(provided: string | undefined): boolean {
  if (!ACCESS_TOKEN) return true;
  if (!provided) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(ACCESS_TOKEN);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function extractRequestToken(req: Request): string | undefined {
  const auth = req.headers.authorization;
  if (auth && auth.startsWith('Bearer ')) {
    return auth.slice(7).trim();
  }
  const queryToken = req.query.token;
  if (typeof queryToken === 'string') {
    return queryToken.trim();
  }
  return undefined;
}

function requireAccessToken(req: Request, res: Response, next: NextFunction): void {
  if (!verifyAccessToken(extractRequestToken(req))) {
    res.status(401).json({ error: 'Unauthorized: valid access token required.' });
    return;
  }
  next();
}

async function startServer() {
  const app = express();
  app.use(express.json({ limit: '256kb' }));

  const server = http.createServer(app);
  const wss = new WebSocketServer({ noServer: true });

  const broadcast = (message: Record<string, unknown>) => {
    const data = JSON.stringify(message);
    for (const client of wss.clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(data);
      }
    }
  };

  const broadcastLog = (
    category: TelemetryLogEntry['category'],
    level: TelemetryLogEntry['level'],
    summary: string,
    payload?: unknown,
  ) => {
    const entry: TelemetryLogEntry = {
      id: crypto.randomBytes(6).toString('hex'),
      timestamp: new Date().toISOString(),
      category,
      level,
      summary,
      payload,
    };
    broadcast({ type: 'bridge:log', entry });
  };

  const broadcastStatus = () => {
    broadcast({ type: 'bridge:status', status: buildStatusPayload() });
  };

  // No-video rule (Section 4 & 6): if IP camera stream is down >10s, publish offline camera_lost
  const evaluateCameraLostTimer = () => {
    const state = rtspSupervisor.getState();
    if (activeBrowserSource !== 'ip_camera') {
      if (cameraLostTimer) {
        clearTimeout(cameraLostTimer);
        cameraLostTimer = null;
      }
      cameraLostPublished = false;
      return;
    }

    if (state === 'streaming') {
      if (cameraLostTimer) {
        clearTimeout(cameraLostTimer);
        cameraLostTimer = null;
      }
      if (cameraLostPublished) {
        cameraLostPublished = false;
        broadcastLog('camera', 'success', 'Camera stream recovered — resuming normal room status telemetry.');
      }
    } else if (!cameraLostTimer && !cameraLostPublished) {
      cameraLostTimer = setTimeout(() => {
        cameraLostTimer = null;
        if (activeBrowserSource === 'ip_camera' && rtspSupervisor.getState() !== 'streaming') {
          cameraLostPublished = true;
          void mqttBridge.publishOffline('camera_lost');
          broadcastLog(
            'camera',
            'error',
            'Camera stream unavailable for >10s — published offline (reason: camera_lost).',
            { room_status: 'offline', reason: 'camera_lost' },
          );
          broadcastStatus();
        }
      }, CAMERA_LOST_TIMEOUT_MS);
    }
  };

  // Wire RTSP supervisor events
  rtspSupervisor.on('state', ({ state, error }) => {
    evaluateCameraLostTimer();
    broadcastStatus();
    if (error) {
      broadcastLog('camera', state === 'offline' ? 'error' : 'warn', `Camera ${state}: ${error}`);
    } else {
      broadcastLog('camera', state === 'streaming' ? 'success' : 'info', `Camera state -> ${state}`);
    }
  });

  rtspSupervisor.on('log', ({ level, message }) => {
    broadcastLog('camera', level, message);
  });

  // Wire MQTT bridge events
  mqttBridge.on('state', ({ state, error }) => {
    broadcastStatus();
    if (error) {
      broadcastLog('broker', 'error', `Broker ${state}: ${error}`);
    } else {
      broadcastLog('broker', state === 'connected' ? 'success' : 'info', `Broker state -> ${state}`);
    }
  });

  mqttBridge.on('log', ({ level, message, payload }) => {
    broadcastLog('broker', level, message, payload);
  });

  mqttBridge.on('published', ({ topic, payload, isStateChange }) => {
    broadcastStatus();
    broadcastLog(
      'mqtt',
      isStateChange ? 'success' : 'info',
      `${isStateChange ? 'State publish' : 'Heartbeat'} -> ${topic} [${payload.room_status}]`,
      payload,
    );
  });

  // Periodic status refresh for live camera FPS readouts
  const statusInterval = setInterval(() => {
    if (wss.clients.size > 0 && rtspSupervisor.getState() === 'streaming') {
      broadcastStatus();
    }
  }, 2000);

  // HTTP -> WebSocket upgrade handler on /ws (same port 3000)
  server.on('upgrade', (request, socket, head) => {
    const reqUrl = new URL(request.url || '/', `http://${request.headers.host || 'localhost'}`);
    if (reqUrl.pathname !== '/ws') {
      socket.destroy();
      return;
    }

    const token =
      reqUrl.searchParams.get('token') ||
      (request.headers.authorization?.startsWith('Bearer ')
        ? request.headers.authorization.slice(7).trim()
        : undefined);

    if (!verifyAccessToken(token)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }

    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit('connection', ws, request);
    });
  });

  wss.on('connection', (ws) => {
    // Cancel pending tab-close offline timer so page refreshes never flap status
    if (tabCloseTimer) {
      clearTimeout(tabCloseTimer);
      tabCloseTimer = null;
    }

    ws.send(JSON.stringify({ type: 'bridge:status', status: buildStatusPayload() }));
    broadcastLog('bridge', 'success', `Browser dashboard connected (${wss.clients.size} active).`);

    ws.on('message', (raw) => {
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(raw.toString('utf8')) as Record<string, unknown>;
      } catch {
        return;
      }

      if (msg.type === 'telemetry') {
        const isStateChange = Boolean(msg.isStateChange);
        const sentAt = typeof msg.sentAt === 'number' ? msg.sentAt : null;
        const result = mqttBridge.publishTelemetry(msg.payload, isStateChange);
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(
            JSON.stringify({
              type: 'telemetry:ack',
              ok: result.ok,
              error: result.error,
              sentAt,
              brokerConnected: mqttBridge.getState() === 'connected',
            }),
          );
        }
      } else if (msg.type === 'source:change') {
        const src = msg.source;
        if (src === 'ip_camera' || src === 'webcam' || src === 'simulation') {
          activeBrowserSource = src;
          if (src === 'ip_camera' && rtspSupervisor.isConfigured() && rtspSupervisor.getState() === 'offline') {
            rtspSupervisor.start();
          }
          evaluateCameraLostTimer();
          broadcastLog('bridge', 'info', `Active video source switched to ${src.replace('_', ' ')}.`);
        }
      }
    });

    ws.on('close', () => {
      if (wss.clients.size === 0) {
        const cfg = mqttBridge.getPublicConfig();
        if (cfg.offlineOnTabClose) {
          tabCloseTimer = setTimeout(() => {
            tabCloseTimer = null;
            if (wss.clients.size === 0) {
              void mqttBridge.publishOffline('tab_closed');
            }
          }, cfg.offlineGraceMs);
        }
      }
    });
  });

  // ============================================================================
  // Protected Bridge API & MJPEG Stream Routes
  // ============================================================================

  app.get('/api/status', requireAccessToken, (_req, res) => {
    res.json(buildStatusPayload());
  });

  app.get('/stream.mjpg', requireAccessToken, (req, res) => {
    rtspSupervisor.attachMjpegClient(req, res);
  });

  app.post('/api/camera/retry', requireAccessToken, (_req, res) => {
    rtspSupervisor.restart();
    broadcastStatus();
    res.json({ ok: true, status: buildStatusPayload() });
  });

  app.post('/api/settings/camera', requireAccessToken, (req, res) => {
    const body = req.body as Record<string, unknown>;
    const host = typeof body.host === 'string' ? body.host.trim() : '';
    const port = Number(body.port ?? 554);
    const camPath = typeof body.path === 'string' ? body.path.trim() : '/h264Preview_01_sub';
    const userInput = typeof body.user === 'string' ? body.user.trim() : '';
    const passwordInput = typeof body.password === 'string' ? body.password : '';
    const streamProfile: StreamProfile = body.streamProfile === 'main' ? 'main' : 'sub';
    const targetFps = Number(body.targetFps ?? 15);
    const scaleWidth = Number(body.scaleWidth ?? 640);

    // Keep existing server-side credentials if user left masked/blank fields untouched
    const effectiveUser =
      userInput === '***' || userInput === '' ? rtspSupervisor.getStoredUser() : userInput;
    const effectivePassword =
      passwordInput === '' ? rtspSupervisor.getStoredPassword() : passwordInput;

    if (!host) {
      rtspSupervisor.updateConfig({
        rtspUrl: '',
        host: '',
        port: 554,
        path: camPath || '/h264Preview_01_sub',
        streamProfile,
        targetFps,
        scaleWidth,
      });
      broadcastStatus();
      res.json({ ok: true, status: buildStatusPayload() });
      return;
    }

    const builtUrl = buildRtspUrl({
      host,
      port,
      path: camPath,
      user: effectiveUser,
      password: effectivePassword,
    });

    if (!builtUrl) {
      res.status(400).json({
        ok: false,
        error: 'Invalid camera settings. Verify host, port (1-65535), and path starting with "/".',
      });
      return;
    }

    rtspSupervisor.updateConfig({
      rtspUrl: builtUrl,
      host,
      port,
      path: camPath,
      user: effectiveUser,
      password: effectivePassword,
      streamProfile,
      targetFps,
      scaleWidth,
    });

    broadcastLog(
      'camera',
      'info',
      `Updated camera settings (${maskRtspUrl(builtUrl)}, ${targetFps} fps, ${scaleWidth}px, profile=${streamProfile}).`,
    );
    broadcastStatus();
    res.json({ ok: true, status: buildStatusPayload() });
  });

  app.post('/api/camera/test', requireAccessToken, async (req, res) => {
    const body = (req.body || {}) as Record<string, unknown>;
    let testUrl = rtspSupervisor.getActiveRtspUrl();

    if (typeof body.host === 'string' && body.host.trim()) {
      const userInput = typeof body.user === 'string' ? body.user.trim() : '';
      const passInput = typeof body.password === 'string' ? body.password : '';
      const effectiveUser =
        userInput === '***' || userInput === '' ? rtspSupervisor.getStoredUser() : userInput;
      const effectivePass =
        passInput === '' ? rtspSupervisor.getStoredPassword() : passInput;

      const built = buildRtspUrl({
        host: body.host.trim(),
        port: Number(body.port ?? 554),
        path: typeof body.path === 'string' ? body.path.trim() : '/h264Preview_01_sub',
        user: effectiveUser,
        password: effectivePass,
      });

      if (!built) {
        res.status(400).json({
          ok: false,
          code: 'bad_path',
          message: 'Invalid host, port, or RTSP path format.',
        });
        return;
      }
      testUrl = built;
    }

    const result = await testCameraConnection(testUrl, 6000);
    broadcastLog('camera', result.ok ? 'success' : 'warn', `Camera test: ${result.message}`);
    res.json(result);
  });

  app.post('/api/settings/mqtt', requireAccessToken, async (req, res) => {
    const body = (req.body || {}) as Record<string, unknown>;
    const result = await mqttBridge.updateConfig({
      host: typeof body.host === 'string' ? body.host : undefined,
      port: body.port !== undefined ? Number(body.port) : undefined,
      topic: typeof body.topic === 'string' ? body.topic : undefined,
      useLocalhostFallback:
        typeof body.useLocalhostFallback === 'boolean' ? body.useLocalhostFallback : undefined,
      clearOldTopicOnChange:
        typeof body.clearOldTopicOnChange === 'boolean' ? body.clearOldTopicOnChange : undefined,
      offlineOnTabClose:
        typeof body.offlineOnTabClose === 'boolean' ? body.offlineOnTabClose : undefined,
      offlineGraceMs: body.offlineGraceMs !== undefined ? Number(body.offlineGraceMs) : undefined,
    });

    if (!result.ok) {
      res.status(400).json(result);
      return;
    }

    broadcastStatus();
    res.json({ ok: true, status: buildStatusPayload() });
  });

  // Serve locally bundled offline TensorFlow.js model weights if present in public/models/
  const modelsDir = path.resolve(process.cwd(), 'public', 'models');
  if (fs.existsSync(modelsDir)) {
    app.use('/models', express.static(modelsDir));
  }

  // Mount Vite dev middleware in development, or static dist/ in production
  if (process.env.NODE_ENV !== 'production') {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distDir = path.resolve(process.cwd(), 'dist');
    app.use(express.static(distDir));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distDir, 'index.html'));
    });
  }

  // Start MQTT client and RTSP supervisor (if camera configured in .env)
  mqttBridge.connect();
  if (rtspSupervisor.isConfigured()) {
    rtspSupervisor.start();
  }

  server.listen(PORT, HOST, () => {
    const displayHost = HOST === '0.0.0.0' ? 'localhost' : HOST;
    console.log(`[Room Tracker Bridge] Listening on http://${displayHost}:${PORT}`);
    console.log(
      `[Room Tracker Bridge] RTSP: ${rtspSupervisor.isConfigured() ? maskRtspUrl(rtspSupervisor.getActiveRtspUrl()) : 'not configured (Simulation/Webcam ready)'}`,
    );
    console.log(
      `[Room Tracker Bridge] MQTT: mqtt://${mqttBridge.getActiveHost()}:${mqttBridge.getPublicConfig().port} -> ${mqttBridge.getPublicConfig().topic}`,
    );
  });

  // Graceful SIGINT / SIGTERM shutdown publishes retained offline packet
  let shuttingDown = false;
  const gracefulShutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`\n[Room Tracker Bridge] Received ${signal}, publishing offline and closing...`);
    clearInterval(statusInterval);
    if (tabCloseTimer) clearTimeout(tabCloseTimer);
    if (cameraLostTimer) clearTimeout(cameraLostTimer);
    rtspSupervisor.stop();
    await mqttBridge.shutdown();
    wss.close();
    server.close(() => {
      process.exit(0);
    });
    setTimeout(() => process.exit(0), 2000);
  };

  process.on('SIGINT', () => void gracefulShutdown('SIGINT'));
  process.on('SIGTERM', () => void gracefulShutdown('SIGTERM'));
}

void startServer();
