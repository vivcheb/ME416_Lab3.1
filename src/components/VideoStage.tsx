import { useCallback, useEffect, useRef, useState } from 'react';
import {
  AlertTriangle,
  Camera,
  Check,
  Film,
  FlipHorizontal2,
  FlipVertical2,
  PenTool,
  Plus,
  RefreshCw,
  Trash2,
  Undo2,
  X,
} from 'lucide-react';
import { distanceBetween } from '../core/roi';
import type { SimBehavior, SimPreset } from '../core/simulation';
import type {
  CameraConnectionState,
  PerformanceMetrics,
  Point,
  PolygonZone,
  TrackerSettings,
  TrackState,
  VideoSourceType,
} from '../core/types';
import type { DetectorStatus } from '../hooks/useDetector';

interface VideoStageProps {
  source: VideoSourceType;
  onSourceChange: (src: VideoSourceType) => void;
  settings: TrackerSettings;
  onToggleMirror: () => void;
  onToggleFlipVertical: () => void;
  ignoreZones: PolygonZone[];
  onZonesChange: (zones: PolygonZone[]) => void;
  cameraState: CameraConnectionState;
  cameraError: string | null;
  cameraConfigured: boolean;
  streamUrl: string;
  onRetryCamera: () => void;
  onOpenCameraSettings: () => void;

  // Refs shared with the parent detection/tracking loop
  mjpegImgRef: React.RefObject<HTMLImageElement | null>;
  webcamVideoRef: React.RefObject<HTMLVideoElement | null>;
  fileVideoRef: React.RefObject<HTMLVideoElement | null>;
  simCanvasRef: React.RefObject<HTMLCanvasElement | null>;
  overlayCanvasRef: React.RefObject<HTMLCanvasElement | null>;

  // Live renderable state
  tracksRef: React.RefObject<TrackState[]>;
  pendingTracksRef: React.RefObject<TrackState[]>;
  frameSizeRef: React.RefObject<{ width: number; height: number }>;

  // Webcam & video file state
  webcamDevices: MediaDeviceInfo[];
  selectedWebcamId: string;
  onSelectWebcam: (deviceId: string) => void;
  webcamError: string | null;
  onRetryWebcam: () => void;

  uploadedFileUrl: string | null;
  uploadedFileName: string | null;
  onUploadVideoFile: (file: File) => void;
  onClearVideoFile: () => void;

  // Simulation controls
  simPreset: SimPreset;
  onSelectSimPreset: (preset: SimPreset) => void;
  onAddSimPerson: (behavior: SimBehavior) => void;
  onClearSimPeople: () => void;

  // Metrics & detector state
  metrics: PerformanceMetrics;
  detectorStatus: DetectorStatus;
  onQuickOptimizeFps: () => void;
  mjpegError: boolean;
  onMjpegLoad: () => void;
  onMjpegError: () => void;
}

const SIM_PRESETS: Array<{ id: SimPreset; label: string }> = [
  { id: 'calm_studio', label: 'Calm Studio' },
  { id: 'active_lab', label: 'Active Lab' },
  { id: 'tie_balance', label: 'Tie Balance' },
  { id: 'occlusion_test', label: 'Desk Occlusion' },
  { id: 'empty_room', label: 'Empty Room' },
];

export function VideoStage({
  source,
  onSourceChange,
  settings,
  onToggleMirror,
  onToggleFlipVertical,
  ignoreZones,
  onZonesChange,
  cameraState,
  cameraError,
  cameraConfigured,
  streamUrl,
  onRetryCamera,
  onOpenCameraSettings,
  mjpegImgRef,
  webcamVideoRef,
  fileVideoRef,
  simCanvasRef,
  overlayCanvasRef,
  tracksRef,
  pendingTracksRef,
  frameSizeRef,
  webcamDevices,
  selectedWebcamId,
  onSelectWebcam,
  webcamError,
  onRetryWebcam,
  uploadedFileUrl,
  uploadedFileName,
  onUploadVideoFile,
  onClearVideoFile,
  simPreset,
  onSelectSimPreset,
  onAddSimPerson,
  onClearSimPeople,
  metrics,
  detectorStatus,
  onQuickOptimizeFps,
  mjpegError,
  onMjpegLoad,
  onMjpegError,
}: VideoStageProps) {
  const stageContainerRef = useRef<HTMLDivElement | null>(null);
  const videoUploadInputRef = useRef<HTMLInputElement | null>(null);

  const [isDrawingRoi, setIsDrawingRoi] = useState(false);
  const [draftPoints, setDraftPoints] = useState<Point[]>([]);
  const [hoverPoint, setHoverPoint] = useState<Point | null>(null);

  const draftPointsRef = useRef<Point[]>([]);
  const hoverPointRef = useRef<Point | null>(null);
  const isDrawingRef = useRef(false);
  const ignoreZonesRef = useRef<PolygonZone[]>(ignoreZones);
  const settingsRef = useRef<TrackerSettings>(settings);

  useEffect(() => {
    draftPointsRef.current = draftPoints;
  }, [draftPoints]);

  useEffect(() => {
    hoverPointRef.current = hoverPoint;
  }, [hoverPoint]);

  useEffect(() => {
    isDrawingRef.current = isDrawingRoi;
  }, [isDrawingRoi]);

  useEffect(() => {
    ignoreZonesRef.current = ignoreZones;
  }, [ignoreZones]);

  useEffect(() => {
    settingsRef.current = settings;
  }, [settings]);

  // Keep HTML5 overlay <canvas> matched to exact display viewport using ResizeObserver (Section 3)
  useEffect(() => {
    const container = stageContainerRef.current;
    const canvas = overlayCanvasRef.current;
    if (!container || !canvas) return;

    const syncSize = () => {
      const rect = container.getBoundingClientRect();
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const nextW = Math.max(1, Math.round(rect.width * dpr));
      const nextH = Math.max(1, Math.round(rect.height * dpr));
      if (canvas.width !== nextW || canvas.height !== nextH) {
        canvas.width = nextW;
        canvas.height = nextH;
      }
    };

    syncSize();
    const observer = new ResizeObserver(syncSize);
    observer.observe(container);
    return () => observer.disconnect();
  }, [overlayCanvasRef]);

  // Smooth 60 FPS visual overlay renderer (ROI polygons, centroid dots, labels, debug overlay)
  useEffect(() => {
    let rafId = 0;

    const drawOverlay = () => {
      const canvas = overlayCanvasRef.current;
      if (canvas) {
        const ctx = canvas.getContext('2d');
        if (ctx) {
          const w = canvas.width;
          const h = canvas.height;
          const dpr = Math.min(window.devicePixelRatio || 1, 2);
          ctx.clearRect(0, 0, w, h);

          const curSettings = settingsRef.current;
          const mirrored = curSettings.mirrorVideo;
          const flippedV = curSettings.flipVertical;
          const frameDims = frameSizeRef.current || { width: 640, height: 360 };
          const fw = Math.max(1, frameDims.width);
          const fh = Math.max(1, frameDims.height);

          const toCanvasX = (normX: number) => (mirrored ? 1 - normX : normX) * w;
          const toCanvasY = (normY: number) => (flippedV ? 1 - normY : normY) * h;
          const pxToCanvasX = (px: number) => toCanvasX(px / fw);
          const pxToCanvasY = (py: number) => toCanvasY(py / fh);

          // 1. Draw saved ROI exclusion polygons (semi-transparent rose at 25% alpha)
          const zones = ignoreZonesRef.current;
          for (const zone of zones) {
            if (zone.points.length < 3) continue;
            ctx.save();
            ctx.beginPath();
            ctx.moveTo(toCanvasX(zone.points[0].x), toCanvasY(zone.points[0].y));
            for (let i = 1; i < zone.points.length; i++) {
              ctx.lineTo(toCanvasX(zone.points[i].x), toCanvasY(zone.points[i].y));
            }
            ctx.closePath();
            ctx.fillStyle = 'rgba(244, 63, 94, 0.24)';
            ctx.fill();
            ctx.strokeStyle = 'rgba(225, 29, 72, 0.85)';
            ctx.lineWidth = 2 * dpr;
            ctx.stroke();

            // Zone caption at centroid
            let avgX = 0;
            let avgY = 0;
            for (const pt of zone.points) {
              avgX += toCanvasX(pt.x);
              avgY += toCanvasY(pt.y);
            }
            avgX /= zone.points.length;
            avgY /= zone.points.length;

            ctx.font = `600 ${11 * dpr}px "DM Sans", system-ui, sans-serif`;
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            const labelW = ctx.measureText(zone.name).width + 12 * dpr;
            ctx.fillStyle = 'rgba(136, 19, 55, 0.78)';
            ctx.beginPath();
            ctx.roundRect(avgX - labelW / 2, avgY - 10 * dpr, labelW, 20 * dpr, 6 * dpr);
            ctx.fill();
            ctx.fillStyle = '#ffffff';
            ctx.fillText(zone.name, avgX, avgY);
            ctx.restore();
          }

          // 2. Draw active draft polygon with visible vertices
          const draft = draftPointsRef.current;
          if (isDrawingRef.current && draft.length > 0) {
            ctx.save();
            ctx.beginPath();
            ctx.moveTo(toCanvasX(draft[0].x), toCanvasY(draft[0].y));
            for (let i = 1; i < draft.length; i++) {
              ctx.lineTo(toCanvasX(draft[i].x), toCanvasY(draft[i].y));
            }
            if (hoverPointRef.current) {
              ctx.lineTo(
                toCanvasX(hoverPointRef.current.x),
                toCanvasY(hoverPointRef.current.y),
              );
            }
            if (draft.length >= 3) {
              ctx.fillStyle = 'rgba(244, 63, 94, 0.16)';
              ctx.fill();
            }
            ctx.strokeStyle = '#E11D48';
            ctx.setLineDash([6 * dpr, 4 * dpr]);
            ctx.lineWidth = 2 * dpr;
            ctx.stroke();
            ctx.setLineDash([]);

            // Visible vertex nodes (highlight first vertex to show click-to-close)
            for (let i = 0; i < draft.length; i++) {
              const vx = toCanvasX(draft[i].x);
              const vy = toCanvasY(draft[i].y);
              ctx.beginPath();
              ctx.arc(vx, vy, (i === 0 ? 6.5 : 4.5) * dpr, 0, Math.PI * 2);
              ctx.fillStyle = i === 0 ? '#FFE4E6' : '#FFFFFF';
              ctx.fill();
              ctx.strokeStyle = '#E11D48';
              ctx.lineWidth = 2 * dpr;
              ctx.stroke();
            }
            ctx.restore();
          }

          // 3. Draw pending tracks (brief 1-2 frame confirmation ramp) so detected webcam/camera people show immediate visual feedback
          if (pendingTracksRef.current && pendingTracksRef.current.length > 0) {
            for (const pTrack of pendingTracksRef.current) {
              const bx = mirrored
                ? toCanvasX((pTrack.rawBox.x + pTrack.rawBox.width) / fw)
                : pxToCanvasX(pTrack.rawBox.x);
              const by = flippedV
                ? toCanvasY((pTrack.rawBox.y + pTrack.rawBox.height) / fh)
                : pxToCanvasY(pTrack.rawBox.y);
              const bw = (pTrack.rawBox.width / fw) * w;
              const bh = (pTrack.rawBox.height / fh) * h;

              ctx.save();
              if (curSettings.debugOverlay) {
                ctx.strokeStyle = 'rgba(100, 116, 139, 0.75)';
                ctx.setLineDash([4 * dpr, 4 * dpr]);
                ctx.lineWidth = 1.5 * dpr;
                ctx.strokeRect(bx, by, bw, bh);
              }

              const psx = pxToCanvasX(pTrack.smoothedX);
              const psy = pxToCanvasY(pTrack.smoothedY);
              ctx.beginPath();
              ctx.arc(psx, psy, 4.5 * dpr, 0, Math.PI * 2);
              ctx.fillStyle = 'rgba(99, 102, 241, 0.85)';
              ctx.fill();

              const pendingLabel = curSettings.debugOverlay
                ? `confirm ${pTrack.consecutiveHits}/3`
                : 'Person · stationary';
              ctx.font = `600 ${11 * dpr}px "JetBrains Mono", monospace`;
              const padX = 7 * dpr;
              const boxH = 20 * dpr;
              const boxW = ctx.measureText(pendingLabel).width + padX * 2;
              const margin = 8 * dpr;
              let lx = psx + 10 * dpr;
              if (lx + boxW > w - margin) lx = psx - 10 * dpr - boxW;
              lx = Math.max(margin, Math.min(w - boxW - margin, lx));
              const ly = Math.max(margin, Math.min(h - boxH - margin, psy - boxH / 2));

              ctx.fillStyle = 'rgba(51, 65, 85, 0.78)';
              ctx.beginPath();
              ctx.roundRect(lx, ly, boxW, boxH, 6 * dpr);
              ctx.fill();
              ctx.fillStyle = '#FFFFFF';
              ctx.textAlign = 'left';
              ctx.textBaseline = 'middle';
              ctx.fillText(pendingLabel, lx + padX, ly + boxH / 2);
              ctx.restore();
            }
          }

          // 4. Draw confirmed tracks: smoothed centroid dot, floating stationary/active tag, and optional debug trails/boxes
          const tracks = tracksRef.current || [];
          for (const track of tracks) {
            const sx = pxToCanvasX(track.smoothedX);
            const sy = pxToCanvasY(track.smoothedY);

            const isOccluded = track.occluded;
            const isActive = track.state === 'chaotic';

            const dotCore = isOccluded
              ? '#64748B'
              : isActive
              ? '#F43F5E'
              : '#0D9488';
            const dotHalo = isOccluded
              ? 'rgba(100, 116, 139, 0.28)'
              : isActive
              ? 'rgba(244, 63, 94, 0.32)'
              : 'rgba(20, 184, 166, 0.30)';
            const labelBg = isOccluded
              ? 'rgba(51, 65, 85, 0.86)'
              : isActive
              ? 'rgba(190, 18, 60, 0.90)'
              : 'rgba(15, 118, 110, 0.90)';

            ctx.save();
            if (isOccluded) {
              ctx.globalAlpha = 0.62;
            }

            // Debug overlay: raw bbox, raw centroid, connector, and rolling trail
            if (curSettings.debugOverlay) {
              const bx = mirrored
                ? toCanvasX((track.rawBox.x + track.rawBox.width) / fw)
                : pxToCanvasX(track.rawBox.x);
              const by = flippedV
                ? toCanvasY((track.rawBox.y + track.rawBox.height) / fh)
                : pxToCanvasY(track.rawBox.y);
              const bw = (track.rawBox.width / fw) * w;
              const bh = (track.rawBox.height / fh) * h;

              ctx.strokeStyle = isActive
                ? 'rgba(244, 63, 94, 0.72)'
                : 'rgba(20, 184, 166, 0.72)';
              ctx.lineWidth = 1.5 * dpr;
              ctx.strokeRect(bx, by, bw, bh);

              // Motion trail from rolling history buffer
              if (track.history.length > 1) {
                ctx.beginPath();
                ctx.moveTo(
                  pxToCanvasX(track.history[0].x),
                  pxToCanvasY(track.history[0].y),
                );
                for (let i = 1; i < track.history.length; i++) {
                  ctx.lineTo(
                    pxToCanvasX(track.history[i].x),
                    pxToCanvasY(track.history[i].y),
                  );
                }
                ctx.strokeStyle = dotCore;
                ctx.lineWidth = 2.2 * dpr;
                ctx.stroke();
              }

              // Raw centroid vs smoothed centroid connector
              if (!isOccluded) {
                const rx = pxToCanvasX(track.rawCentroid.x);
                const ry = pxToCanvasY(track.rawCentroid.y);
                ctx.beginPath();
                ctx.moveTo(rx, ry);
                ctx.lineTo(sx, sy);
                ctx.strokeStyle = 'rgba(99, 102, 241, 0.85)';
                ctx.lineWidth = 1.2 * dpr;
                ctx.stroke();

                ctx.beginPath();
                ctx.arc(rx, ry, 3.2 * dpr, 0, Math.PI * 2);
                ctx.fillStyle = '#6366F1';
                ctx.fill();
              }
            }

            // Smoothed centroid halo + crisp dot
            ctx.beginPath();
            ctx.arc(sx, sy, 12 * dpr, 0, Math.PI * 2);
            ctx.fillStyle = dotHalo;
            ctx.fill();

            ctx.beginPath();
            ctx.arc(sx, sy, 5.5 * dpr, 0, Math.PI * 2);
            ctx.fillStyle = dotCore;
            ctx.fill();
            ctx.strokeStyle = '#FFFFFF';
            ctx.lineWidth = 2 * dpr;
            ctx.stroke();

            // Floating label: ID <n> · stationary|active|occluded (clamped inside canvas edges)
            const statusText = isOccluded
              ? 'occluded'
              : isActive
              ? 'active'
              : 'stationary';
            const debugSuffix = curSettings.debugOverlay
              ? ` (${track.normDisp.toFixed(2)})`
              : '';
            const labelText = `ID ${track.publicId} · ${statusText}${debugSuffix}`;

            ctx.font = `600 ${11.5 * dpr}px "JetBrains Mono", monospace`;
            const textMetrics = ctx.measureText(labelText);
            const padX = 8 * dpr;
            const boxH = 22 * dpr;
            const boxW = textMetrics.width + padX * 2;

            const margin = 8 * dpr;
            let lx = sx + 12 * dpr;
            if (lx + boxW > w - margin) {
              lx = sx - 12 * dpr - boxW;
            }
            lx = Math.max(margin, Math.min(w - boxW - margin, lx));

            let ly = sy - boxH / 2;
            ly = Math.max(margin, Math.min(h - boxH - margin, ly));

            ctx.fillStyle = labelBg;
            ctx.beginPath();
            ctx.roundRect(lx, ly, boxW, boxH, 7 * dpr);
            ctx.fill();
            ctx.strokeStyle = 'rgba(255, 255, 255, 0.55)';
            ctx.lineWidth = 1 * dpr;
            ctx.stroke();

            ctx.fillStyle = '#FFFFFF';
            ctx.textAlign = 'left';
            ctx.textBaseline = 'middle';
            ctx.fillText(labelText, lx + padX, ly + boxH / 2);

            ctx.restore();
          }
        }
      }

      rafId = window.requestAnimationFrame(drawOverlay);
    };

    rafId = window.requestAnimationFrame(drawOverlay);
    return () => window.cancelAnimationFrame(rafId);
  }, [overlayCanvasRef, tracksRef, pendingTracksRef, frameSizeRef]);

  // Convert pointer event to un-flipped normalized frame coordinate (0..1)
  const getNormalizedPoint = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>): Point | null => {
      const canvas = overlayCanvasRef.current;
      if (!canvas) return null;
      const rect = canvas.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return null;
      const rawX = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
      const rawY = Math.min(1, Math.max(0, (e.clientY - rect.top) / rect.height));
      return {
        x: settings.mirrorVideo ? 1 - rawX : rawX,
        y: settings.flipVertical ? 1 - rawY : rawY,
      };
    },
    [overlayCanvasRef, settings.mirrorVideo, settings.flipVertical],
  );

  const finishDraftZone = useCallback(() => {
    if (draftPoints.length < 3) return;
    const newZone: PolygonZone = {
      id: `zone-${Date.now()}`,
      name: `Ignore Zone ${ignoreZones.length + 1}`,
      points: draftPoints,
    };
    onZonesChange([...ignoreZones, newZone]);
    setDraftPoints([]);
    setHoverPoint(null);
    setIsDrawingRoi(false);
  }, [draftPoints, ignoreZones, onZonesChange]);

  const handleCanvasClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!isDrawingRoi) return;
    const pt = getNormalizedPoint(e);
    if (!pt) return;

    // Close polygon if user clicks near the first vertex and has >= 3 points
    if (draftPoints.length >= 3 && distanceBetween(pt, draftPoints[0]) < 0.03) {
      finishDraftZone();
      return;
    }

    setDraftPoints((prev) => [...prev, pt]);
  };

  const handleCanvasDoubleClick = () => {
    if (!isDrawingRoi) return;
    if (draftPoints.length >= 3) {
      finishDraftZone();
    }
  };

  const handleCanvasMouseMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!isDrawingRoi) return;
    setHoverPoint(getNormalizedPoint(e));
  };

  const handleUndoPoint = () => {
    setDraftPoints((prev) => prev.slice(0, -1));
  };

  const handleDeleteZone = (id: string) => {
    onZonesChange(ignoreZones.filter((z) => z.id !== id));
  };

  const handleClearZones = () => {
    onZonesChange([]);
    setDraftPoints([]);
    setIsDrawingRoi(false);
  };

  const showIpCameraUnavailable =
    source === 'ip_camera' && (!cameraConfigured || cameraState === 'offline' || mjpegError);

  const activeResolution = frameSizeRef.current || { width: 640, height: 360 };
  const effectiveStreamBadgeState =
    source === 'ip_camera'
      ? cameraState
      : source === 'webcam'
      ? webcamError
        ? 'offline'
        : 'streaming'
      : 'streaming';

  const lowFpsWarning =
    source !== 'simulation' &&
    detectorStatus.ready &&
    metrics.detectionFps > 0 &&
    metrics.detectionFps < 10;

  return (
    <div className="liquid-glass rounded-2xl p-5 flex flex-col gap-4">
      {/* Top Toolbar: Video Source Selector + Source-Specific Controls */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex items-center gap-2">
            <label htmlFor="video-source-select" className="text-xs font-semibold text-slate-700 whitespace-nowrap">
              Video Source
            </label>
            <select
              id="video-source-select"
              value={source}
              onChange={(e) => onSourceChange(e.target.value as VideoSourceType)}
              className="glass-input rounded-xl px-3 py-2 text-xs font-medium text-slate-900 cursor-pointer"
            >
              <option value="ip_camera">IP Camera (RTSP via Bridge)</option>
              <option value="webcam">Local Webcam (Development)</option>
              <option value="simulation">Simulation / Video File</option>
            </select>
          </div>

          {source === 'webcam' && (
            <div className="flex items-center gap-2">
              <select
                aria-label="Select webcam device"
                value={selectedWebcamId}
                onChange={(e) => onSelectWebcam(e.target.value)}
                className="glass-input max-w-[240px] truncate rounded-xl px-3 py-2 text-xs text-slate-800"
              >
                {webcamDevices.length === 0 ? (
                  <option value="">Default camera</option>
                ) : (
                  webcamDevices.map((dev, idx) => (
                    <option key={dev.deviceId || idx} value={dev.deviceId}>
                      {dev.label || `Camera ${idx + 1}`}
                    </option>
                  ))
                )}
              </select>
            </div>
          )}

          {source === 'simulation' && (
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={() => videoUploadInputRef.current?.click()}
                className="glass-btn inline-flex items-center gap-1.5 rounded-xl px-3 py-2 text-xs font-medium cursor-pointer whitespace-nowrap"
              >
                <Film className="h-3.5 w-3.5 text-indigo-600" aria-hidden="true" />
                {uploadedFileName ? 'Replace Video' : 'Load Video File'}
              </button>
              <input
                ref={videoUploadInputRef}
                type="file"
                accept="video/*"
                className="hidden"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) onUploadVideoFile(file);
                  e.target.value = '';
                }}
              />
              {uploadedFileUrl && (
                <button
                  type="button"
                  onClick={onClearVideoFile}
                  className="glass-btn inline-flex items-center gap-1 rounded-xl px-2.5 py-2 text-xs text-slate-600 cursor-pointer whitespace-nowrap"
                >
                  <X className="h-3.5 w-3.5" aria-hidden="true" />
                  Use Synthetic Room
                </button>
              )}
            </div>
          )}
        </div>

        {/* Camera Flip & ROI Drawing Controls */}
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={onToggleMirror}
            title="Flip camera horizontally (mirror)"
            className={`inline-flex items-center gap-1.5 rounded-xl px-2.5 py-2 text-xs font-medium cursor-pointer whitespace-nowrap transition-colors ${
              settings.mirrorVideo
                ? 'bg-indigo-600 text-white shadow-sm'
                : 'glass-btn text-slate-700'
            }`}
          >
            <FlipHorizontal2 className="h-3.5 w-3.5" aria-hidden="true" />
            Flip H
          </button>

          <button
            type="button"
            onClick={onToggleFlipVertical}
            title="Invert camera vertically (upside-down flip)"
            className={`inline-flex items-center gap-1.5 rounded-xl px-2.5 py-2 text-xs font-medium cursor-pointer whitespace-nowrap transition-colors ${
              settings.flipVertical
                ? 'bg-indigo-600 text-white shadow-sm'
                : 'glass-btn text-slate-700'
            }`}
          >
            <FlipVertical2 className="h-3.5 w-3.5" aria-hidden="true" />
            Invert V
          </button>

          {!isDrawingRoi ? (
            <button
              type="button"
              onClick={() => {
                setDraftPoints([]);
                setIsDrawingRoi(true);
              }}
              className="glass-btn inline-flex items-center gap-1.5 rounded-xl px-3 py-2 text-xs font-medium text-slate-800 cursor-pointer whitespace-nowrap"
            >
              <PenTool className="h-3.5 w-3.5 text-rose-600" aria-hidden="true" />
              Draw Ignore Zone
            </button>
          ) : (
            <>
              <button
                type="button"
                disabled={draftPoints.length < 3}
                onClick={finishDraftZone}
                className="pastel-3d-btn inline-flex items-center gap-1.5 rounded-xl px-3 py-2 text-xs font-semibold cursor-pointer whitespace-nowrap"
              >
                <Check className="h-3.5 w-3.5" aria-hidden="true" />
                Finish Zone ({draftPoints.length})
              </button>
              <button
                type="button"
                disabled={draftPoints.length === 0}
                onClick={handleUndoPoint}
                className="glass-btn inline-flex items-center gap-1.5 rounded-xl px-2.5 py-2 text-xs font-medium cursor-pointer whitespace-nowrap"
              >
                <Undo2 className="h-3.5 w-3.5" aria-hidden="true" />
                Undo Point
              </button>
              <button
                type="button"
                onClick={() => {
                  setDraftPoints([]);
                  setHoverPoint(null);
                  setIsDrawingRoi(false);
                }}
                className="glass-btn inline-flex items-center gap-1 rounded-xl px-2.5 py-2 text-xs text-slate-600 cursor-pointer whitespace-nowrap"
              >
                Cancel
              </button>
            </>
          )}

          {ignoreZones.length > 0 && !isDrawingRoi && (
            <button
              type="button"
              onClick={handleClearZones}
              className="glass-btn inline-flex items-center gap-1.5 rounded-xl px-2.5 py-2 text-xs font-medium text-rose-700 cursor-pointer whitespace-nowrap"
            >
              <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
              Clear Zones
            </button>
          )}
        </div>
      </div>

      {/* Simulation Scene Presets Bar (when synthetic room is active) */}
      {source === 'simulation' && !uploadedFileUrl && (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl bg-white/55 border border-white/80 px-3.5 py-2.5">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-[11px] font-semibold text-slate-500 mr-1">Scene Preset</span>
            {SIM_PRESETS.map((preset) => (
              <button
                key={preset.id}
                type="button"
                onClick={() => onSelectSimPreset(preset.id)}
                className={`rounded-lg px-2.5 py-1 text-xs font-medium transition-colors cursor-pointer whitespace-nowrap ${
                  simPreset === preset.id
                    ? 'bg-indigo-600 text-white shadow-sm'
                    : 'text-slate-600 hover:bg-white/80 hover:text-slate-900'
                }`}
              >
                {preset.label}
              </button>
            ))}
          </div>

          <div className="flex flex-wrap items-center gap-1.5">
            <button
              type="button"
              onClick={() => onAddSimPerson('stationary')}
              className="glass-btn inline-flex items-center gap-1 rounded-lg px-2.5 py-1 text-xs font-medium text-teal-800 cursor-pointer whitespace-nowrap"
            >
              <Plus className="h-3 w-3" aria-hidden="true" />
              Calm
            </button>
            <button
              type="button"
              onClick={() => onAddSimPerson('walking')}
              className="glass-btn inline-flex items-center gap-1 rounded-lg px-2.5 py-1 text-xs font-medium text-rose-800 cursor-pointer whitespace-nowrap"
            >
              <Plus className="h-3 w-3" aria-hidden="true" />
              Walker
            </button>
            <button
              type="button"
              onClick={() => onAddSimPerson('pacing')}
              className="glass-btn inline-flex items-center gap-1 rounded-lg px-2.5 py-1 text-xs font-medium text-amber-800 cursor-pointer whitespace-nowrap"
            >
              <Plus className="h-3 w-3" aria-hidden="true" />
              Pacing
            </button>
            <button
              type="button"
              onClick={onClearSimPeople}
              className="glass-btn rounded-lg px-2.5 py-1 text-xs text-slate-600 cursor-pointer whitespace-nowrap"
            >
              Empty
            </button>
          </div>
        </div>
      )}

      {/* ROI drawing helper instruction */}
      {isDrawingRoi && (
        <div className="flex items-center justify-between gap-3 rounded-xl bg-rose-50/90 border border-rose-200/80 px-3.5 py-2 text-xs text-rose-900">
          <span>
            Click on the video frame to place polygon vertices around doorways, mirrors, or windows.
            Click the first vertex or double-click to close the ignore zone.
          </span>
          <span className="font-mono-tabular font-semibold whitespace-nowrap">
            {draftPoints.length} pts
          </span>
        </div>
      )}

      {/* Main 16:9 Video + Exact HTML5 Canvas Overlay Stage */}
      <div
        ref={stageContainerRef}
        className="relative aspect-video w-full overflow-hidden rounded-2xl bg-slate-900/95 border border-white/85 shadow-[0_14px_30px_-14px_rgba(52,68,110,0.28)] select-none"
      >
        {/* Video Layer 1: IP Camera MJPEG <img> */}
        {source === 'ip_camera' && cameraConfigured && (
          <img
            ref={mjpegImgRef}
            src={streamUrl}
            alt="5MP PoE IP camera live MJPEG sub-stream"
            referrerPolicy="no-referrer"
            onLoad={onMjpegLoad}
            onError={onMjpegError}
            className={`h-full w-full object-fill ${settings.mirrorVideo ? '-scale-x-100' : ''} ${
              settings.flipVertical ? '-scale-y-100' : ''
            } ${showIpCameraUnavailable ? 'opacity-20' : 'opacity-100'}`}
          />
        )}

        {/* Video Layer 2: Local Webcam <video> */}
        <video
          ref={webcamVideoRef}
          autoPlay
          playsInline
          muted
          className={`h-full w-full object-fill ${settings.mirrorVideo ? '-scale-x-100' : ''} ${
            settings.flipVertical ? '-scale-y-100' : ''
          } ${source === 'webcam' && !webcamError ? 'block' : 'hidden'}`}
        />

        {/* Video Layer 3: Uploaded Local Video File <video> */}
        <video
          ref={fileVideoRef}
          src={uploadedFileUrl ?? undefined}
          autoPlay
          loop
          playsInline
          muted
          controls={false}
          className={`h-full w-full object-fill ${settings.mirrorVideo ? '-scale-x-100' : ''} ${
            settings.flipVertical ? '-scale-y-100' : ''
          } ${source === 'simulation' && uploadedFileUrl ? 'block' : 'hidden'}`}
        />

        {/* Video Layer 4: Built-in Synthetic Room <canvas> */}
        <canvas
          ref={simCanvasRef}
          width={640}
          height={360}
          className={`h-full w-full object-fill ${settings.mirrorVideo ? '-scale-x-100' : ''} ${
            settings.flipVertical ? '-scale-y-100' : ''
          } ${source === 'simulation' && !uploadedFileUrl ? 'block' : 'hidden'}`}
        />

        {/* Exact Overlaid HTML5 Canvas for ROI polygons, Centroids, Labels & Debug trails */}
        <canvas
          ref={overlayCanvasRef}
          onClick={handleCanvasClick}
          onDoubleClick={handleCanvasDoubleClick}
          onMouseMove={handleCanvasMouseMove}
          className={`absolute inset-0 h-full w-full ${
            isDrawingRoi ? 'cursor-crosshair' : 'cursor-default'
          }`}
        />

        {/* Top-Left Measured Contrast Scrim Stream HUD (Section 3) */}
        <div className="pointer-events-none absolute top-3 left-3 flex items-center gap-2.5 rounded-xl bg-slate-950/72 px-3 py-1.5 text-xs text-white backdrop-blur-md border border-white/15">
          <span
            className={`h-2 w-2 rounded-full ${
              effectiveStreamBadgeState === 'streaming'
                ? 'bg-teal-400'
                : effectiveStreamBadgeState === 'reconnecting'
                ? 'bg-amber-400'
                : 'bg-rose-400'
            }`}
            aria-hidden="true"
          />
          <span className="font-medium capitalize">{effectiveStreamBadgeState}</span>
          <span className="text-white/40" aria-hidden="true">
            ·
          </span>
          <span className="font-mono-tabular text-white/90">
            {activeResolution.width}×{activeResolution.height}
          </span>
          <span className="text-white/40" aria-hidden="true">
            ·
          </span>
          <span className="font-mono-tabular text-white/90">
            {metrics.streamFps.toFixed(1)} FPS
          </span>
        </div>

        {/* Model Loading Overlay for real video modes */}
        {(source === 'webcam' || source === 'ip_camera' || (source === 'simulation' && uploadedFileUrl)) &&
          detectorStatus.loading && (
            <div className="pointer-events-none absolute right-3 top-3 rounded-xl bg-slate-950/75 px-3 py-1.5 text-xs text-indigo-100 backdrop-blur-md border border-white/15">
              Loading TensorFlow.js {settings.modelBase}…
            </div>
          )}

        {/* Clear Error State with Retry Button: IP Camera Unavailable */}
        {showIpCameraUnavailable && (
          <div className="absolute inset-0 flex items-center justify-center bg-slate-950/68 p-6 backdrop-blur-sm">
            <div className="max-w-md rounded-2xl bg-white/92 p-6 text-center shadow-xl border border-white">
              <Camera className="mx-auto h-8 w-8 text-indigo-600" aria-hidden="true" />
              <h3 className="mt-3 text-base font-semibold text-slate-900">
                {cameraConfigured ? 'IP Camera Stream Unavailable' : 'No PoE Camera Configured'}
              </h3>
              <p className="mt-1.5 text-xs text-slate-600 leading-relaxed">
                {cameraError ||
                  'Configure CAMERA_RTSP_URL in .env or enter your camera host and sub-stream path in Camera & MQTT settings. You can also test the full pipeline in Simulation mode.'}
              </p>
              <div className="mt-4 flex flex-wrap items-center justify-center gap-2.5">
                {cameraConfigured && (
                  <button
                    type="button"
                    onClick={onRetryCamera}
                    className="pastel-3d-btn inline-flex items-center gap-1.5 rounded-xl px-4 py-2 text-xs font-semibold cursor-pointer"
                  >
                    <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
                    Retry Stream
                  </button>
                )}
                <button
                  type="button"
                  onClick={onOpenCameraSettings}
                  className="glass-btn rounded-xl px-4 py-2 text-xs font-semibold text-slate-800 cursor-pointer"
                >
                  Camera Settings
                </button>
                <button
                  type="button"
                  onClick={() => onSourceChange('simulation')}
                  className="glass-btn rounded-xl px-4 py-2 text-xs font-medium text-indigo-700 cursor-pointer"
                >
                  Open Simulation
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Clear Error State with Retry Button: Webcam Error */}
        {source === 'webcam' && webcamError && (
          <div className="absolute inset-0 flex items-center justify-center bg-slate-950/68 p-6 backdrop-blur-sm">
            <div className="max-w-md rounded-2xl bg-white/92 p-6 text-center shadow-xl border border-white">
              <AlertTriangle className="mx-auto h-8 w-8 text-amber-600" aria-hidden="true" />
              <h3 className="mt-3 text-base font-semibold text-slate-900">Webcam Unavailable</h3>
              <p className="mt-1.5 text-xs text-slate-600 leading-relaxed">{webcamError}</p>
              <div className="mt-4 flex items-center justify-center gap-2.5">
                <button
                  type="button"
                  onClick={onRetryWebcam}
                  className="pastel-3d-btn inline-flex items-center gap-1.5 rounded-xl px-4 py-2 text-xs font-semibold cursor-pointer"
                >
                  <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
                  Retry Webcam
                </button>
                <button
                  type="button"
                  onClick={() => onSourceChange('simulation')}
                  className="glass-btn rounded-xl px-4 py-2 text-xs font-medium text-slate-700 cursor-pointer"
                >
                  Switch to Simulation
                </button>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Active ROI Zones List (single-zone deletion) */}
      {ignoreZones.length > 0 && (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-slate-600">
          <span className="font-medium text-slate-700">Active Ignore Zones:</span>
          {ignoreZones.map((zone) => (
            <span key={zone.id} className="inline-flex items-center gap-1.5">
              <span>
                {zone.name} ({zone.points.length} pts)
              </span>
              <button
                type="button"
                onClick={() => handleDeleteZone(zone.id)}
                aria-label={`Delete ${zone.name}`}
                className="rounded p-0.5 text-slate-400 hover:bg-rose-100 hover:text-rose-700 cursor-pointer"
              >
                <X className="h-3.5 w-3.5" aria-hidden="true" />
              </button>
            </span>
          ))}
        </div>
      )}

      {/* Warnings: CPU Backend Fallback / Low FPS (< 10 FPS) / Detector Error */}
      {(detectorStatus.isCpuFallback || lowFpsWarning || detectorStatus.error) && (
        <div className="space-y-2">
          {detectorStatus.isCpuFallback && source !== 'simulation' && (
            <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl bg-amber-50/90 border border-amber-200/80 px-3.5 py-2 text-xs text-amber-950">
              <span>
                TensorFlow.js fell back to the <strong>CPU</strong> backend because WebGL was
                unavailable. Enable GPU acceleration for 15+ FPS detection.
              </span>
            </div>
          )}

          {lowFpsWarning && (
            <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl bg-amber-50/90 border border-amber-200/80 px-3.5 py-2 text-xs text-amber-950">
              <span>
                Detection rate is below 10 FPS ({metrics.detectionFps.toFixed(1)} FPS). Switch to{' '}
                <code className="font-mono-tabular">lite_mobilenet_v2</code> or lower inference
                width to 480 px.
              </span>
              <button
                type="button"
                onClick={onQuickOptimizeFps}
                className="glass-btn rounded-lg px-2.5 py-1 text-xs font-semibold text-amber-900 cursor-pointer whitespace-nowrap"
              >
                Apply Fast Profile
              </button>
            </div>
          )}

          {detectorStatus.error && (source !== 'simulation' || uploadedFileUrl) && (
            <div className="rounded-xl bg-rose-50/90 border border-rose-200/80 px-3.5 py-2 text-xs text-rose-900">
              Detector notice: {detectorStatus.error}
            </div>
          )}
        </div>
      )}

      {/* Performance Readout Strip (Section 5) */}
      <div className="grid grid-cols-2 gap-3 border-t border-slate-200/70 pt-3.5 sm:grid-cols-5">
        <div>
          <p className="text-[11px] text-slate-500">Stream FPS</p>
          <p className="font-mono-tabular text-sm font-semibold text-slate-900">
            {metrics.streamFps.toFixed(1)} <span className="text-[11px] font-normal text-slate-500">fps</span>
          </p>
        </div>
        <div>
          <p className="text-[11px] text-slate-500">Detection FPS</p>
          <p className="font-mono-tabular text-sm font-semibold text-slate-900">
            {metrics.detectionFps.toFixed(1)} <span className="text-[11px] font-normal text-slate-500">fps</span>
          </p>
        </div>
        <div>
          <p className="text-[11px] text-slate-500">Inference Time</p>
          <p className="font-mono-tabular text-sm font-semibold text-slate-900">
            {metrics.inferenceMs.toFixed(1)} <span className="text-[11px] font-normal text-slate-500">ms</span>
          </p>
        </div>
        <div>
          <p className="text-[11px] text-slate-500">Publish Latency</p>
          <p className="font-mono-tabular text-sm font-semibold text-slate-900">
            {metrics.publishLatencyMs !== null ? `${metrics.publishLatencyMs}` : '—'}{' '}
            <span className="text-[11px] font-normal text-slate-500">ms</span>
          </p>
        </div>
        <div>
          <p className="text-[11px] text-slate-500">TFJS Backend</p>
          <p className="font-mono-tabular text-sm font-semibold text-slate-900 uppercase">
            {source === 'simulation' && !uploadedFileUrl ? 'SIM ENGINE' : metrics.tfBackend}
          </p>
        </div>
      </div>
    </div>
  );
}
