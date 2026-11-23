import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { RoomSimulation, type SimBehavior, type SimPreset } from './core/simulation';
import { RoomTracker } from './core/tracker';
import {
  DEFAULT_TRACKER_SETTINGS,
  type PerformanceMetrics,
  type PolygonZone,
  type RoomStatus,
  type TelemetryPacket,
  type TrackerSettings,
  type TrackState,
  type VideoSourceType,
} from './core/types';
import { useBridgeSocket } from './hooks/useBridgeSocket';
import { useDetector } from './hooks/useDetector';
import { LabGuideView } from './components/LabGuideView';
import { SettingsView } from './components/SettingsView';
import { StatusStrip } from './components/StatusStrip';
import { TelemetryConsole } from './components/TelemetryConsole';
import { TopBar, type WorkspaceTab } from './components/TopBar';
import { TuningPanel } from './components/TuningPanel';
import { VideoStage } from './components/VideoStage';
import {
  clearPersistedConfig,
  loadPersistedConfig,
  sanitizeImportedConfig,
  savePersistedConfig,
  type PersistedMqttPrefs,
} from './utils/storage';

export default function App() {
  const initialStored = useMemo(() => loadPersistedConfig(), []);

  const [activeTab, setActiveTab] = useState<WorkspaceTab>('monitor');
  const [source, setSource] = useState<VideoSourceType>(initialStored.config.source);
  const [settings, setSettings] = useState<TrackerSettings>(initialStored.config.settings);
  const [ignoreZones, setIgnoreZones] = useState<PolygonZone[]>(initialStored.config.ignoreZones);
  const [mqttPrefs, setMqttPrefs] = useState<PersistedMqttPrefs | undefined>(
    initialStored.config.mqttPrefs,
  );

  // Video & simulation states
  const [simPreset, setSimPreset] = useState<SimPreset>('calm_studio');
  const [uploadedFileUrl, setUploadedFileUrl] = useState<string | null>(null);
  const [uploadedFileName, setUploadedFileName] = useState<string | null>(null);
  const [webcamDevices, setWebcamDevices] = useState<MediaDeviceInfo[]>([]);
  const [selectedWebcamId, setSelectedWebcamId] = useState<string>('');
  const [webcamError, setWebcamError] = useState<string | null>(null);
  const [mjpegError, setMjpegError] = useState(false);
  const [mjpegNonce, setMjpegNonce] = useState(0);

  // Live room summary UI state
  const [roomStatus, setRoomStatus] = useState<RoomStatus>('empty');
  const [rawRoomStatus, setRawRoomStatus] = useState<RoomStatus>('empty');
  const [counts, setCounts] = useState({ total: 0, calm: 0, chaotic: 0 });
  const [latestPacket, setLatestPacket] = useState<TelemetryPacket | null>(null);
  const [metrics, setMetrics] = useState<PerformanceMetrics>({
    streamFps: 0,
    detectionFps: 0,
    inferenceMs: 0,
    publishLatencyMs: null,
    tfBackend: 'standby',
    modelLoaded: false,
    modelSource: 'none',
  });

  // Bridge WebSocket & server status
  const {
    bridgeState,
    bridgeStatus,
    logs,
    logsPaused,
    setLogsPaused,
    clearLogs,
    appendLog,
    sendTelemetry,
    notifySourceChange,
    publishLatencyMs,
    authRequired,
    accessToken,
    setAccessToken,
    refreshStatus,
    apiFetch,
  } = useBridgeSocket();

  // Enable TensorFlow.js coco-ssd only for real camera/video sources (zero overhead in synthetic sim)
  const needsTfDetector =
    source === 'ip_camera' ||
    source === 'webcam' ||
    (source === 'simulation' && Boolean(uploadedFileUrl));

  const { status: detectorStatus, detectCanvas } = useDetector(settings.modelBase, needsTfDetector);

  // Refs for zero-jitter high-frequency loop
  const trackerRef = useRef<RoomTracker>(new RoomTracker(settings));
  const simRef = useRef<RoomSimulation>(new RoomSimulation('calm_studio'));
  const settingsRef = useRef<TrackerSettings>(settings);
  const ignoreZonesRef = useRef<PolygonZone[]>(ignoreZones);
  const sourceRef = useRef<VideoSourceType>(source);
  const uploadedFileUrlRef = useRef<string | null>(uploadedFileUrl);
  const sendTelemetryRef = useRef(sendTelemetry);
  const appendLogRef = useRef(appendLog);
  const detectCanvasRef = useRef(detectCanvas);
  const detectorReadyRef = useRef(detectorStatus.ready);
  const cameraStateRef = useRef(bridgeStatus?.cameraState ?? 'offline');

  const mjpegImgRef = useRef<HTMLImageElement | null>(null);
  const webcamVideoRef = useRef<HTMLVideoElement | null>(null);
  const fileVideoRef = useRef<HTMLVideoElement | null>(null);
  const simCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const overlayCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const offscreenCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const webcamStreamRef = useRef<MediaStream | null>(null);

  const tracksRef = useRef<TrackState[]>([]);
  const pendingTracksRef = useRef<TrackState[]>([]);
  const frameSizeRef = useRef<{ width: number; height: number }>({ width: 640, height: 360 });
  const lastHeartbeatAtRef = useRef<number>(0);
  const lastPublishedStatusRef = useRef<RoomStatus | null>(null);
  const autoSelectedCameraRef = useRef(false);

  // Sync refs
  useEffect(() => {
    settingsRef.current = settings;
    trackerRef.current.updateSettings(settings);
  }, [settings]);

  useEffect(() => {
    ignoreZonesRef.current = ignoreZones;
  }, [ignoreZones]);

  useEffect(() => {
    sourceRef.current = source;
  }, [source]);

  useEffect(() => {
    uploadedFileUrlRef.current = uploadedFileUrl;
  }, [uploadedFileUrl]);

  useEffect(() => {
    sendTelemetryRef.current = sendTelemetry;
  }, [sendTelemetry]);

  useEffect(() => {
    appendLogRef.current = appendLog;
  }, [appendLog]);

  useEffect(() => {
    detectCanvasRef.current = detectCanvas;
  }, [detectCanvas]);

  useEffect(() => {
    detectorReadyRef.current = detectorStatus.ready;
  }, [detectorStatus.ready]);

  useEffect(() => {
    cameraStateRef.current = bridgeStatus?.cameraState ?? 'offline';
  }, [bridgeStatus?.cameraState]);

  // If the user hasn't stored a custom source yet and server has CAMERA_RTSP_URL configured in .env,
  // default automatically to IP Camera (RTSP via bridge) per Acceptance Criterion #1.
  useEffect(() => {
    if (
      !autoSelectedCameraRef.current &&
      !initialStored.hasStoredValue &&
      bridgeStatus?.cameraConfig.configured
    ) {
      autoSelectedCameraRef.current = true;
      setSource('ip_camera');
    }
  }, [bridgeStatus?.cameraConfig.configured, initialStored.hasStoredValue]);

  // Persist ROI polygons, sliders, source choice, and MQTT prefs in localStorage
  useEffect(() => {
    savePersistedConfig({
      version: 1,
      source,
      settings,
      ignoreZones,
      mqttPrefs,
    });
  }, [source, settings, ignoreZones, mqttPrefs]);

  // Notify bridge when video source changes (controls camera_lost > 10s rule)
  useEffect(() => {
    if (bridgeState === 'connected') {
      notifySourceChange(source);
    }
  }, [source, bridgeState, notifySourceChange]);

  // Update publish latency metric
  useEffect(() => {
    setMetrics((prev) => ({
      ...prev,
      publishLatencyMs,
      tfBackend: detectorStatus.backend,
      modelLoaded: detectorStatus.ready,
      modelSource:
        source === 'simulation' && !uploadedFileUrl ? 'simulation' : detectorStatus.modelSource,
    }));
  }, [publishLatencyMs, detectorStatus, source, uploadedFileUrl]);

  // ============================================================================
  // Local Webcam Management (Section 1: request stream first, then enumerateDevices + devicechange)
  // ============================================================================
  const stopWebcam = useCallback(() => {
    if (webcamStreamRef.current) {
      for (const track of webcamStreamRef.current.getTracks()) {
        track.stop();
      }
      webcamStreamRef.current = null;
    }
    if (webcamVideoRef.current) {
      webcamVideoRef.current.srcObject = null;
    }
  }, []);

  const startWebcam = useCallback(
    async (deviceId?: string) => {
      stopWebcam();
      setWebcamError(null);

      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        setWebcamError(
          'Webcam access requires a secure context (http://localhost:3000 or HTTPS).',
        );
        return;
      }

      try {
        const videoConstraints: MediaTrackConstraints = {
          width: { ideal: 640 },
          height: { ideal: 360 },
          frameRate: { ideal: 15 },
          ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
        };
        const stream = await navigator.mediaDevices.getUserMedia({
          video: videoConstraints,
          audio: false,
        });

        webcamStreamRef.current = stream;
        if (webcamVideoRef.current) {
          webcamVideoRef.current.srcObject = stream;
          await webcamVideoRef.current.play().catch(() => {});
        }

        // Re-enumerate devices AFTER permission is granted so camera labels are populated
        const devices = await navigator.mediaDevices.enumerateDevices();
        const videoInputs = devices.filter((d) => d.kind === 'videoinput');
        setWebcamDevices(videoInputs);

        const activeTrackDeviceId = stream.getVideoTracks()[0]?.getSettings().deviceId;
        if (activeTrackDeviceId) {
          setSelectedWebcamId(activeTrackDeviceId);
        }
      } catch (err) {
        const msg =
          err instanceof Error
            ? err.message
            : 'Camera permission denied or no webcam device detected.';
        setWebcamError(msg);
      }
    },
    [stopWebcam],
  );

  useEffect(() => {
    if (source !== 'webcam') {
      stopWebcam();
      return;
    }

    void startWebcam(selectedWebcamId || undefined);

    const handleDeviceChange = async () => {
      try {
        const devices = await navigator.mediaDevices.enumerateDevices();
        setWebcamDevices(devices.filter((d) => d.kind === 'videoinput'));
      } catch {
        // ignore
      }
    };

    navigator.mediaDevices?.addEventListener?.('devicechange', handleDeviceChange);
    return () => {
      navigator.mediaDevices?.removeEventListener?.('devicechange', handleDeviceChange);
      stopWebcam();
    };
  }, [source, startWebcam, stopWebcam, selectedWebcamId]);

  // Revoke uploaded video object URL on unmount / change
  useEffect(() => {
    return () => {
      if (uploadedFileUrl) {
        URL.revokeObjectURL(uploadedFileUrl);
      }
    };
  }, [uploadedFileUrl]);

  // ============================================================================
  // Main Real-Time Detection, Tracking & MQTT Telemetry Publishing Loop
  // ============================================================================
  useEffect(() => {
    let active = true;
    let rafId = 0;
    let lastSimFrameAt = 0;
    let lastUiSyncAt = 0;

    const streamTimestamps: number[] = [];
    const detectTimestamps: number[] = [];
    let emaInferenceMs = 0;

    const ensureOffscreen = (w: number, h: number) => {
      if (!offscreenCanvasRef.current) {
        offscreenCanvasRef.current = document.createElement('canvas');
      }
      const c = offscreenCanvasRef.current;
      if (c.width !== w || c.height !== h) {
        c.width = w;
        c.height = h;
      }
      return c;
    };

    const recordFps = (arr: number[], now: number): number => {
      arr.push(now);
      while (arr.length > 0 && now - arr[0] > 2000) {
        arr.shift();
      }
      if (arr.length < 2) return 0;
      const span = (arr[arr.length - 1] - arr[0]) / 1000;
      return span > 0 ? (arr.length - 1) / span : 0;
    };

    const handleTrackerOutput = (
      result: ReturnType<RoomTracker['processFrame']>,
      nowMs: number,
      infMs: number,
    ) => {
      tracksRef.current = result.tracks;
      pendingTracksRef.current = result.pendingTracks;

      const detFps = recordFps(detectTimestamps, nowMs);
      emaInferenceMs = emaInferenceMs === 0 ? infMs : emaInferenceMs * 0.8 + infMs * 0.2;

      // Publish immediately on debounced room_status change (< 200 ms) OR on heartbeat interval
      const heartbeatMs = Math.max(1000, settingsRef.current.mqttHeartbeatIntervalSec * 1000);
      const isInitialPublish = lastPublishedStatusRef.current === null;
      const statusChanged =
        result.roomStatusChanged ||
        (!isInitialPublish && lastPublishedStatusRef.current !== result.roomStatus);

      if (statusChanged || isInitialPublish) {
        const prev = lastPublishedStatusRef.current;
        lastPublishedStatusRef.current = result.roomStatus;
        lastHeartbeatAtRef.current = nowMs;
        sendTelemetryRef.current(result.packet, true);
        if (prev && prev !== result.roomStatus) {
          appendLogRef.current(
            'transition',
            result.roomStatus === 'chaotic' ? 'warn' : 'success',
            `Room status changed: ${prev} → ${result.roomStatus} (total=${result.totalPeople}, calm=${result.calmCount}, chaotic=${result.chaoticCount})`,
            result.packet,
          );
        }
      } else if (nowMs - lastHeartbeatAtRef.current >= heartbeatMs) {
        lastHeartbeatAtRef.current = nowMs;
        sendTelemetryRef.current(result.packet, false);
      }

      // Throttle React state updates to ~10 Hz while canvas overlay renders at full 60 FPS
      if (nowMs - lastUiSyncAt >= 100 || statusChanged) {
        lastUiSyncAt = nowMs;
        const stFps =
          sourceRef.current === 'ip_camera'
            ? bridgeStatus?.cameraFps ?? recordFps(streamTimestamps, nowMs)
            : recordFps(streamTimestamps, nowMs);
        setRoomStatus(result.roomStatus);
        setRawRoomStatus(result.rawRoomStatus);
        setCounts({
          total: result.totalPeople,
          calm: result.calmCount,
          chaotic: result.chaoticCount,
        });
        setLatestPacket(result.packet);
        setMetrics((prev) => ({
          ...prev,
          streamFps: Number(stFps.toFixed(1)),
          detectionFps: Number(detFps.toFixed(1)),
          inferenceMs: Number(emaInferenceMs.toFixed(1)),
        }));
      }
    };

    const tick = (nowMs: number) => {
      if (!active) return;

      const curSource = sourceRef.current;
      const curSettings = settingsRef.current;

      // Case A: Synthetic Simulation Mode (built-in 15 FPS architectural scene + detections)
      if (curSource === 'simulation' && !uploadedFileUrlRef.current) {
        if (nowMs - lastSimFrameAt >= 66) {
          lastSimFrameAt = nowMs;
          const simCanvas = simCanvasRef.current;
          if (simCanvas) {
            const simW = curSettings.inferenceWidth;
            const simH = Math.round((simW * 9) / 16);
            if (simCanvas.width !== simW || simCanvas.height !== simH) {
              simCanvas.width = simW;
              simCanvas.height = simH;
            }
            frameSizeRef.current = { width: simW, height: simH };
            const ctx = simCanvas.getContext('2d');
            if (ctx) {
              const t0 = performance.now();
              const detections = simRef.current.stepAndRender(ctx, simW, simH, nowMs);
              const result = trackerRef.current.processFrame(
                detections,
                simW,
                simH,
                ignoreZonesRef.current,
                nowMs,
              );
              const elapsed = performance.now() - t0;
              recordFps(streamTimestamps, nowMs);
              handleTrackerOutput(result, nowMs, elapsed);
            }
          }
        }
        rafId = window.requestAnimationFrame(tick);
        return;
      }

      // Case B: Real video frame -> offscreen canvas -> non-overlapping coco-ssd inference
      let mediaEl: HTMLImageElement | HTMLVideoElement | null = null;
      let natW = 0;
      let natH = 0;

      if (curSource === 'ip_camera') {
        const img = mjpegImgRef.current;
        if (img && img.complete && img.naturalWidth > 0 && cameraStateRef.current === 'streaming') {
          mediaEl = img;
          natW = img.naturalWidth;
          natH = img.naturalHeight;
        }
      } else if (curSource === 'webcam') {
        const vid = webcamVideoRef.current;
        if (vid && vid.readyState >= 2 && vid.videoWidth > 0) {
          mediaEl = vid;
          natW = vid.videoWidth;
          natH = vid.videoHeight;
        }
      } else if (curSource === 'simulation' && uploadedFileUrlRef.current) {
        const vid = fileVideoRef.current;
        if (vid && vid.readyState >= 2 && vid.videoWidth > 0) {
          mediaEl = vid;
          natW = vid.videoWidth;
          natH = vid.videoHeight;
        }
      }

      if (mediaEl && natW > 0 && natH > 0) {
        const targetW = Math.min(curSettings.inferenceWidth, natW);
        const targetH = Math.max(1, Math.round((natH / natW) * targetW));
        frameSizeRef.current = { width: targetW, height: targetH };
        recordFps(streamTimestamps, nowMs);

        if (detectorReadyRef.current) {
          const offscreen = ensureOffscreen(targetW, targetH);
          const ctx = offscreen.getContext('2d', { willReadFrequently: true });
          if (ctx) {
            ctx.drawImage(mediaEl, 0, 0, targetW, targetH);
            void detectCanvasRef
              .current(offscreen, curSettings.detectionConfidence)
              .then((res) => {
                if (!active || !res) return;
                const tNow = performance.now();
                const tracked = trackerRef.current.processFrame(
                  res.detections,
                  targetW,
                  targetH,
                  ignoreZonesRef.current,
                  tNow,
                );
                handleTrackerOutput(tracked, tNow, res.inferenceMs);
              });
          }
        }
      }

      rafId = window.requestAnimationFrame(tick);
    };

    rafId = window.requestAnimationFrame(tick);
    return () => {
      active = false;
      window.cancelAnimationFrame(rafId);
    };
  }, [bridgeStatus?.cameraFps]);

  // Reflect server-published offline status when IP camera is lost > 10s
  const effectiveRoomStatus: RoomStatus =
    source === 'ip_camera' &&
    bridgeStatus?.lastPublishedStatus === 'offline' &&
    bridgeStatus.cameraState !== 'streaming'
      ? 'offline'
      : roomStatus;

  const handleSettingsChange = useCallback((partial: Partial<TrackerSettings>) => {
    setSettings((prev) => ({ ...prev, ...partial }));
  }, []);

  const handleResetDefaults = useCallback(() => {
    clearPersistedConfig();
    setSettings({ ...DEFAULT_TRACKER_SETTINGS });
    setIgnoreZones([]);
    trackerRef.current.reset(false);
    appendLog('bridge', 'info', 'Reset all tuning sliders and ROI zones to defaults.');
  }, [appendLog]);

  const handleExportSettings = useCallback(() => {
    const exportPayload = {
      version: 1,
      exportedAt: new Date().toISOString(),
      note: 'Camera credentials are intentionally excluded.',
      source,
      settings,
      ignoreZones,
      mqttPrefs: mqttPrefs ?? bridgeStatus?.mqttConfig,
    };
    const blob = new Blob([JSON.stringify(exportPayload, null, 2)], {
      type: 'application/json',
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `room-tracker-config-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
    appendLog('bridge', 'info', 'Exported settings and ROI zones as JSON (credentials excluded).');
  }, [source, settings, ignoreZones, mqttPrefs, bridgeStatus?.mqttConfig, appendLog]);

  const handleImportSettings = useCallback(
    (rawJson: string): { ok: boolean; message: string } => {
      try {
        const parsed = JSON.parse(rawJson) as unknown;
        const clean = sanitizeImportedConfig(parsed);
        setSource(clean.source);
        setSettings(clean.settings);
        setIgnoreZones(clean.ignoreZones);
        if (clean.mqttPrefs) {
          setMqttPrefs(clean.mqttPrefs);
        }
        appendLog('bridge', 'success', 'Imported settings and ROI zones from JSON.');
        return { ok: true, message: 'Settings imported successfully (credentials excluded).' };
      } catch {
        return { ok: false, message: 'Invalid JSON configuration file.' };
      }
    },
    [appendLog],
  );

  const handleSourceChange = useCallback((next: VideoSourceType) => {
    setSource(next);
    setMjpegError(false);
    trackerRef.current.reset(false);
    tracksRef.current = [];
    pendingTracksRef.current = [];
  }, []);

  const handleRetryCamera = useCallback(async () => {
    setMjpegError(false);
    setMjpegNonce((n) => n + 1);
    try {
      await apiFetch('/api/camera/retry', { method: 'POST' });
      await refreshStatus();
    } catch {
      // ignore
    }
  }, [apiFetch, refreshStatus]);

  const handleUploadVideoFile = useCallback((file: File) => {
    setUploadedFileUrl((prev) => {
      if (prev) URL.revokeObjectURL(prev);
      return URL.createObjectURL(file);
    });
    setUploadedFileName(file.name);
    trackerRef.current.reset(false);
  }, []);

  const handleClearVideoFile = useCallback(() => {
    setUploadedFileUrl((prev) => {
      if (prev) URL.revokeObjectURL(prev);
      return null;
    });
    setUploadedFileName(null);
    trackerRef.current.reset(false);
  }, []);

  const handleSelectSimPreset = useCallback((preset: SimPreset) => {
    setSimPreset(preset);
    simRef.current.loadPreset(preset);
    trackerRef.current.reset(false);
  }, []);

  const handleAddSimPerson = useCallback((behavior: SimBehavior) => {
    simRef.current.addPerson(behavior);
  }, []);

  const handleClearSimPeople = useCallback(() => {
    simRef.current.clearPeople();
    setSimPreset('empty_room');
  }, []);

  const handleQuickOptimizeFps = useCallback(() => {
    setSettings((prev) => ({
      ...prev,
      modelBase: 'lite_mobilenet_v2',
      inferenceWidth: 480,
    }));
  }, []);

  const streamUrl = useMemo(() => {
    const params = new URLSearchParams();
    params.set('t', String(mjpegNonce));
    if (accessToken) params.set('token', accessToken);
    return `/stream.mjpg?${params.toString()}`;
  }, [mjpegNonce, accessToken]);

  const brokerHostLabel = bridgeStatus?.mqttConfig
    ? `${bridgeStatus.mqttConfig.activeHost}:${bridgeStatus.mqttConfig.port}`
    : 'rasticvm.internal:1883';

  return (
    <div className="pastel-ambient-canvas min-h-screen flex flex-col">
      <TopBar
        activeTab={activeTab}
        onSelectTab={setActiveTab}
        onExportSettings={handleExportSettings}
      />

      <main className="mx-auto w-full max-w-[1440px] flex-1 px-4 py-6 sm:px-6 space-y-6">
        <StatusStrip
          roomStatus={effectiveRoomStatus}
          rawRoomStatus={rawRoomStatus}
          offlineReason={effectiveRoomStatus === 'offline' ? 'camera_lost' : null}
          totalPeople={effectiveRoomStatus === 'offline' ? 0 : counts.total}
          calmCount={effectiveRoomStatus === 'offline' ? 0 : counts.calm}
          chaoticCount={effectiveRoomStatus === 'offline' ? 0 : counts.chaotic}
          cameraState={bridgeStatus?.cameraState ?? 'offline'}
          bridgeState={bridgeState}
          brokerState={bridgeStatus?.brokerState ?? 'disconnected'}
          source={source}
          brokerHostLabel={brokerHostLabel}
        />

        {activeTab === 'monitor' && (
          <>
            <div className="grid grid-cols-1 gap-6 xl:grid-cols-12 items-start">
              <div className="xl:col-span-8">
                <VideoStage
                  source={source}
                  onSourceChange={handleSourceChange}
                  settings={settings}
                  ignoreZones={ignoreZones}
                  onZonesChange={setIgnoreZones}
                  cameraState={bridgeStatus?.cameraState ?? 'offline'}
                  cameraError={bridgeStatus?.cameraError ?? null}
                  cameraConfigured={Boolean(bridgeStatus?.cameraConfig.configured)}
                  streamUrl={streamUrl}
                  onRetryCamera={() => void handleRetryCamera()}
                  onOpenCameraSettings={() => setActiveTab('settings')}
                  mjpegImgRef={mjpegImgRef}
                  webcamVideoRef={webcamVideoRef}
                  fileVideoRef={fileVideoRef}
                  simCanvasRef={simCanvasRef}
                  overlayCanvasRef={overlayCanvasRef}
                  tracksRef={tracksRef}
                  pendingTracksRef={pendingTracksRef}
                  frameSizeRef={frameSizeRef}
                  webcamDevices={webcamDevices}
                  selectedWebcamId={selectedWebcamId}
                  onSelectWebcam={setSelectedWebcamId}
                  webcamError={webcamError}
                  onRetryWebcam={() => void startWebcam(selectedWebcamId || undefined)}
                  uploadedFileUrl={uploadedFileUrl}
                  uploadedFileName={uploadedFileName}
                  onUploadVideoFile={handleUploadVideoFile}
                  onClearVideoFile={handleClearVideoFile}
                  simPreset={simPreset}
                  onSelectSimPreset={handleSelectSimPreset}
                  onAddSimPerson={handleAddSimPerson}
                  onClearSimPeople={handleClearSimPeople}
                  metrics={metrics}
                  detectorStatus={detectorStatus}
                  onQuickOptimizeFps={handleQuickOptimizeFps}
                  mjpegError={mjpegError}
                  onMjpegLoad={() => setMjpegError(false)}
                  onMjpegError={() => setMjpegError(true)}
                />
              </div>

              <div className="xl:col-span-4">
                <TuningPanel
                  settings={settings}
                  onChange={handleSettingsChange}
                  onResetDefaults={handleResetDefaults}
                  onExportJson={handleExportSettings}
                  onImportJson={handleImportSettings}
                />
              </div>
            </div>

            <TelemetryConsole
              logs={logs}
              paused={logsPaused}
              onTogglePause={() => setLogsPaused(!logsPaused)}
              onClear={clearLogs}
              latestPacket={latestPacket}
              topic={bridgeStatus?.mqttConfig.topic || 'room/activity/status'}
              compact
            />
          </>
        )}

        {activeTab === 'settings' && (
          <SettingsView
            bridgeStatus={bridgeStatus}
            apiFetch={apiFetch}
            onStatusUpdated={refreshStatus}
            onMqttPrefsSaved={setMqttPrefs}
            authRequired={authRequired}
            accessToken={accessToken}
            onSetAccessToken={setAccessToken}
          />
        )}

        {activeTab === 'telemetry' && (
          <TelemetryConsole
            logs={logs}
            paused={logsPaused}
            onTogglePause={() => setLogsPaused(!logsPaused)}
            onClear={clearLogs}
            latestPacket={latestPacket}
            topic={bridgeStatus?.mqttConfig.topic || 'room/activity/status'}
          />
        )}

        {activeTab === 'guide' && <LabGuideView />}
      </main>

      <footer className="mx-auto w-full max-w-[1440px] px-4 py-4 sm:px-6 text-xs text-slate-500 flex flex-wrap items-center justify-between gap-2">
        <span>Lumina Room Tracker · 5MP PoE AI Turret Activity &amp; MQTT Bridge</span>
        <span>Offline-capable browser inference · Credentials stay server-side</span>
      </footer>
    </div>
  );
}
