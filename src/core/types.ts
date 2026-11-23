/**
 * Shared types for the Room Activity Tracker (frontend, bridge, and tests).
 * All tuneable defaults match the 5MP PoE AI Turret Camera build specification.
 */

export type VideoSourceType = 'ip_camera' | 'webcam' | 'simulation';

export type RoomStatus = 'calm' | 'chaotic' | 'tie' | 'empty' | 'offline';
export type PersonState = 'calm' | 'chaotic';

export type CameraConnectionState = 'streaming' | 'reconnecting' | 'offline';
export type BrokerConnectionState = 'connected' | 'disconnected' | 'reconnecting';
export type BridgeConnectionState = 'connected' | 'disconnected' | 'reconnecting';

export type CocoModelBase = 'lite_mobilenet_v2' | 'mobilenet_v2';
export type RoiTestPointMode = 'bottom_center' | 'bbox_center';
export type DisplacementMetricMode = 'net' | 'path_length';
export type StreamProfile = 'sub' | 'main';

export interface Point {
  x: number;
  y: number;
}

/**
 * ROI Exclusion Zone stored in normalized frame coordinates (0..1)
 * so zones survive stream resolution changes and window resizing.
 */
export interface PolygonZone {
  id: string;
  name: string;
  points: Point[]; // Normalized 0..1 coordinates
}

/** Raw detection bounding box in processed stream frame pixel coordinates (un-mirrored). */
export interface RawDetection {
  x: number;      // Top-left X in frame pixels
  y: number;      // Top-left Y in frame pixels
  width: number;  // Bounding box width in frame pixels
  height: number; // Bounding box height in frame pixels
  score: number;  // Confidence 0..1
  class?: string;
}

export interface HistorySample {
  timestamp: number; // performance.now() in ms
  x: number;         // Smoothed centroid X
  y: number;         // Smoothed centroid Y
  height: number;    // Smoothed bbox height
}

/** Internal + rendered track representation. */
export interface TrackState {
  internalId: number;
  publicId: number | null; // Assigned after 3 consecutive confirmed frames; never reused
  consecutiveHits: number;
  confirmed: boolean;
  missedFrames: number;
  lastSeenAt: number;      // ms
  occluded: boolean;

  // Raw latest detection (for debug overlay)
  rawBox: { x: number; y: number; width: number; height: number };
  rawCentroid: Point;
  confidence: number;

  // EMA-smoothed state
  smoothedX: number;
  smoothedY: number;
  smoothedHeight: number;
  windowMaxHeight: number;

  // Displacement & classification
  history: HistorySample[];
  normDisp: number;
  warmingUp: boolean;
  state: PersonState;
  lastStateChangeAt: number; // ms, enforces state hold / cooldown
}

export interface TrackerSettings {
  // Section 5 primary live controls
  evaluationIntervalSec: number;       // 0.5 - 5.0, default 1.5
  normalizedMovementThreshold: number; // 0.05 - 0.50, default 0.15
  detectionConfidence: number;         // 0.20 - 0.95, default 0.55
  emaAlpha: number;                    // 0.05 - 1.0, default 0.3
  mqttHeartbeatIntervalSec: number;    // 1 - 60, default 5

  // Additional exposed controls
  graceFrames: number;                 // 15 - 30, default 20 (with 1.0s time fallback)
  graceTimeMs: number;                 // default 1000 ms
  stateHoldSec: number;                // 0.5 - 5.0, default 1.0
  roomDebounceMs: number;              // 0 - 3000, default 500
  minBoxHeightFraction: number;        // 0.02 - 0.30, default 0.08
  maxMatchDistanceMultiple: number;    // 0.5 - 2.5, default 1.0
  displacementMode: DisplacementMetricMode; // 'net' | 'path_length'
  roiTestPoint: RoiTestPointMode;      // 'bottom_center' | 'bbox_center'
  modelBase: CocoModelBase;            // 'lite_mobilenet_v2' | 'mobilenet_v2'
  inferenceWidth: number;              // 320 | 480 | 640 | 960, default 640
  mirrorVideo: boolean;
  debugOverlay: boolean;
}

export const DEFAULT_TRACKER_SETTINGS: TrackerSettings = {
  evaluationIntervalSec: 1.5,
  normalizedMovementThreshold: 0.15,
  detectionConfidence: 0.55,
  emaAlpha: 0.3,
  mqttHeartbeatIntervalSec: 5,
  graceFrames: 20,
  graceTimeMs: 1000,
  stateHoldSec: 1.0,
  roomDebounceMs: 500,
  minBoxHeightFraction: 0.08,
  maxMatchDistanceMultiple: 1.0,
  displacementMode: 'net',
  roiTestPoint: 'bottom_center',
  modelBase: 'lite_mobilenet_v2',
  inferenceWidth: 640,
  mirrorVideo: false,
  debugOverlay: false,
};

export interface OccupantTelemetry {
  id: number;
  x: number;         // Integer pixels in processed stream frame (un-mirrored)
  y: number;         // Integer pixels in processed stream frame (un-mirrored)
  norm_disp: number; // Rounded normalized displacement
  state: PersonState;
}

export interface TelemetryPacket {
  timestamp: string;
  room_status: RoomStatus;
  total_people: number;
  calm_count: number;
  chaotic_count: number;
  frame: { width: number; height: number };
  occupants: OccupantTelemetry[];
  reason?: 'camera_lost' | 'shutdown' | 'tab_closed';
}

export interface OfflinePacket {
  room_status: 'offline';
  reason?: 'camera_lost' | 'shutdown' | 'tab_closed';
}

export interface CameraPublicConfig {
  configured: boolean;
  host: string;
  port: number;
  path: string;
  user: string;       // Masked or username-only if entered; password is NEVER returned
  hasPassword: boolean;
  streamProfile: StreamProfile;
  targetFps: number;
  scaleWidth: number;
  maskedUrl: string;
  hasMainStream: boolean;
}

export interface MqttPublicConfig {
  host: string;
  port: number;
  topic: string;
  useLocalhostFallback: boolean;
  clearOldTopicOnChange: boolean;
  offlineOnTabClose: boolean;
  offlineGraceMs: number;
  activeHost: string;
  clientId: string;
}

export interface BridgeStatusPayload {
  cameraState: CameraConnectionState;
  cameraError: string | null;
  cameraFps: number;
  cameraResolution: { width: number; height: number } | null;
  brokerState: BrokerConnectionState;
  brokerError: string | null;
  cameraConfig: CameraPublicConfig;
  mqttConfig: MqttPublicConfig;
  lastPublishedAt: number | null;
  lastPublishedTopic: string | null;
  lastPublishedStatus: RoomStatus | null;
}

export interface TelemetryLogEntry {
  id: string;
  timestamp: string;
  category: 'transition' | 'mqtt' | 'camera' | 'bridge' | 'broker';
  level: 'info' | 'warn' | 'error' | 'success';
  summary: string;
  payload?: unknown;
}

export interface CameraTestResult {
  ok: boolean;
  code: 'ok' | 'auth_failure' | 'timeout' | 'bad_path' | 'network_error' | 'not_configured' | 'ffmpeg_missing';
  message: string;
  codec?: string;
  width?: number;
  height?: number;
  fps?: number;
  maskedUrl?: string;
}

export interface PerformanceMetrics {
  streamFps: number;
  detectionFps: number;
  inferenceMs: number;
  publishLatencyMs: number | null;
  tfBackend: string;
  modelLoaded: boolean;
  modelSource: 'local' | 'remote' | 'simulation' | 'none';
}
