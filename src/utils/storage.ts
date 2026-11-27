import {
  DEFAULT_TRACKER_SETTINGS,
  type PolygonZone,
  type TrackerSettings,
  type VideoSourceType,
} from '../core/types';

const STORAGE_KEY = 'lumina_room_tracker_config_v1';

export interface PersistedMqttPrefs {
  host: string;
  port: number;
  topic: string;
  useLocalhostFallback: boolean;
  clearOldTopicOnChange: boolean;
  offlineOnTabClose: boolean;
  offlineGraceMs: number;
}

export interface PersistedAppConfig {
  version: 1;
  source: VideoSourceType;
  settings: TrackerSettings;
  ignoreZones: PolygonZone[];
  mqttPrefs?: PersistedMqttPrefs;
}

export const DEFAULT_PERSISTED_CONFIG: PersistedAppConfig = {
  version: 1,
  source: 'simulation',
  settings: { ...DEFAULT_TRACKER_SETTINGS },
  ignoreZones: [],
};

function sanitizeNumber(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

function sanitizeZones(raw: unknown): PolygonZone[] {
  if (!Array.isArray(raw)) return [];
  const zones: PolygonZone[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const obj = item as Record<string, unknown>;
    if (!Array.isArray(obj.points) || obj.points.length < 3) continue;
    const points = obj.points
      .filter(
        (p): p is { x: number; y: number } =>
          Boolean(p) &&
          typeof (p as { x: unknown }).x === 'number' &&
          typeof (p as { y: unknown }).y === 'number' &&
          Number.isFinite((p as { x: number }).x) &&
          Number.isFinite((p as { y: number }).y),
      )
      .map((p) => ({
        x: Math.min(1, Math.max(0, p.x)),
        y: Math.min(1, Math.max(0, p.y)),
      }));
    if (points.length >= 3) {
      zones.push({
        id: typeof obj.id === 'string' && obj.id ? obj.id : `zone-${zones.length + 1}`,
        name: typeof obj.name === 'string' && obj.name ? obj.name : `Ignore Zone ${zones.length + 1}`,
        points,
      });
    }
  }
  return zones;
}

export function sanitizeImportedConfig(raw: unknown): PersistedAppConfig {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ...DEFAULT_PERSISTED_CONFIG, settings: { ...DEFAULT_TRACKER_SETTINGS }, ignoreZones: [] };
  }

  const obj = raw as Record<string, unknown>;
  const s = (obj.settings && typeof obj.settings === 'object' ? obj.settings : {}) as Record<string, unknown>;
  const d = DEFAULT_TRACKER_SETTINGS;

  const source: VideoSourceType =
    obj.source === 'ip_camera' || obj.source === 'webcam' || obj.source === 'simulation'
      ? obj.source
      : 'simulation';

  const settings: TrackerSettings = {
    evaluationIntervalSec: sanitizeNumber(s.evaluationIntervalSec, d.evaluationIntervalSec, 0.5, 5.0),
    normalizedMovementThreshold: sanitizeNumber(
      s.normalizedMovementThreshold,
      d.normalizedMovementThreshold,
      0.05,
      0.5,
    ),
    detectionConfidence: sanitizeNumber(s.detectionConfidence, d.detectionConfidence, 0.2, 0.95),
    emaAlpha: sanitizeNumber(s.emaAlpha, d.emaAlpha, 0.05, 1.0),
    mqttHeartbeatIntervalSec: sanitizeNumber(s.mqttHeartbeatIntervalSec, d.mqttHeartbeatIntervalSec, 1, 60),
    graceFrames: Math.round(sanitizeNumber(s.graceFrames, d.graceFrames, 15, 30)),
    graceTimeMs: Math.round(sanitizeNumber(s.graceTimeMs, d.graceTimeMs, 500, 3000)),
    stateHoldSec: sanitizeNumber(s.stateHoldSec, d.stateHoldSec, 0.5, 5.0),
    roomDebounceMs: Math.round(sanitizeNumber(s.roomDebounceMs, d.roomDebounceMs, 0, 3000)),
    minBoxHeightFraction: sanitizeNumber(s.minBoxHeightFraction, d.minBoxHeightFraction, 0.02, 0.3),
    maxMatchDistanceMultiple: sanitizeNumber(s.maxMatchDistanceMultiple, d.maxMatchDistanceMultiple, 0.5, 2.5),
    displacementMode: s.displacementMode === 'path_length' ? 'path_length' : 'net',
    roiTestPoint: s.roiTestPoint === 'bbox_center' ? 'bbox_center' : 'bottom_center',
    modelBase: s.modelBase === 'mobilenet_v2' ? 'mobilenet_v2' : 'lite_mobilenet_v2',
    inferenceWidth: [320, 480, 640, 960].includes(Number(s.inferenceWidth))
      ? Number(s.inferenceWidth)
      : d.inferenceWidth,
    mirrorVideo: Boolean(s.mirrorVideo),
    flipVertical: Boolean(s.flipVertical),
    debugOverlay: Boolean(s.debugOverlay),
  };

  let mqttPrefs: PersistedMqttPrefs | undefined;
  if (obj.mqttPrefs && typeof obj.mqttPrefs === 'object') {
    const m = obj.mqttPrefs as Record<string, unknown>;
    if (typeof m.host === 'string' && typeof m.topic === 'string') {
      mqttPrefs = {
        host: m.host,
        port: Math.round(sanitizeNumber(m.port, 1883, 1, 65535)),
        topic: m.topic,
        useLocalhostFallback: Boolean(m.useLocalhostFallback),
        clearOldTopicOnChange: m.clearOldTopicOnChange !== false,
        offlineOnTabClose: m.offlineOnTabClose !== false,
        offlineGraceMs: Math.round(sanitizeNumber(m.offlineGraceMs, 5000, 0, 60000)),
      };
    }
  }

  return {
    version: 1,
    source,
    settings,
    ignoreZones: sanitizeZones(obj.ignoreZones),
    mqttPrefs,
  };
}

export function loadPersistedConfig(): { config: PersistedAppConfig; hasStoredValue: boolean } {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      return {
        config: {
          ...DEFAULT_PERSISTED_CONFIG,
          settings: { ...DEFAULT_TRACKER_SETTINGS },
          ignoreZones: [],
        },
        hasStoredValue: false,
      };
    }
    const parsed = JSON.parse(raw) as unknown;
    return { config: sanitizeImportedConfig(parsed), hasStoredValue: true };
  } catch {
    return {
      config: {
        ...DEFAULT_PERSISTED_CONFIG,
        settings: { ...DEFAULT_TRACKER_SETTINGS },
        ignoreZones: [],
      },
      hasStoredValue: false,
    };
  }
}

export function savePersistedConfig(config: PersistedAppConfig): void {
  try {
    // Strictly exclude any camera credentials — only UI tuning, ROI polygons, source & MQTT host/topic
    const clean: PersistedAppConfig = {
      version: 1,
      source: config.source,
      settings: config.settings,
      ignoreZones: config.ignoreZones,
      mqttPrefs: config.mqttPrefs,
    };
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(clean));
  } catch {
    // Ignore storage quota errors
  }
}

export function clearPersistedConfig(): void {
  try {
    window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    // ignore
  }
}
