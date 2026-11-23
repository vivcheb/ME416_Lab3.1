import { isDetectionExcluded } from './roi.ts';
import {
  DEFAULT_TRACKER_SETTINGS,
  type PersonState,
  type PolygonZone,
  type RawDetection,
  type RoomStatus,
  type TelemetryPacket,
  type TrackerSettings,
  type TrackState,
} from './types.ts';

/**
 * Pure, deterministic multi-person tracker and room activity classifier.
 *
 * Implements Sections 2 & 4 of the 5MP PoE AI Turret Camera specification:
 *  - Confidence & minimum bounding-box height filtering
 *  - Normalized ROI polygon exclusion (bottom-center feet or bbox center)
 *  - Greedy nearest-centroid matching bounded by maxMatchDistanceMultiple * smoothedHeight
 *  - 3-frame track confirmation with monotonically increasing, never-reused public IDs
 *  - Grace period (frames + 1.0s time fallback) with occluded flag
 *  - EMA smoothing on centroid (x, y) and height (with partial-occlusion slow-shrink & window max)
 *  - Time-based displacement over rolling performance.now() window (net Euclidean or path length)
 *  - Warm-up guard (norm_disp = 0, calm until full window) & >1s stream stall guard
 *  - Individual hysteresis state hold / cooldown (default 1.0s)
 *  - Room-level status (empty, calm, chaotic, tie) with debounce (default 500ms)
 */

export const CONFIRMATION_FRAMES = 3;
export const STREAM_STALL_GAP_MS = 1000;
export const MAX_HEIGHT_SHRINK_FACTOR = 0.95; // At most 5% shrink per frame to resist occlusion clipping

/**
 * Computes the exponential moving average: next = alpha * current + (1 - alpha) * previous.
 */
export function applyEma(previous: number, current: number, alpha: number): number {
  const clampedAlpha = Math.min(1, Math.max(0.01, alpha));
  return clampedAlpha * current + (1 - clampedAlpha) * previous;
}

/**
 * Computes raw (undebounced) room status from confirmed calm and chaotic occupant counts.
 */
export function computeRawRoomStatus(calmCount: number, chaoticCount: number): Exclude<RoomStatus, 'offline'> {
  const total = calmCount + chaoticCount;
  if (total === 0) return 'empty';
  if (calmCount > chaoticCount) return 'calm';
  if (chaoticCount > calmCount) return 'chaotic';
  return 'tie';
}

export interface TrackerFrameResult {
  tracks: TrackState[];            // All confirmed tracks (including currently occluded within grace period)
  pendingTracks: TrackState[];     // Unconfirmed tracks (< 3 hits), useful for debug overlay
  filteredDetections: RawDetection[]; // Detections that passed confidence, height, and ROI filters
  excludedCount: number;           // Number of detections ignored due to ROI zones
  totalPeople: number;
  calmCount: number;
  chaoticCount: number;
  rawRoomStatus: Exclude<RoomStatus, 'offline'>;
  roomStatus: Exclude<RoomStatus, 'offline'>;
  roomStatusChanged: boolean;
  stallDetected: boolean;
  packet: TelemetryPacket;
}

export class RoomTracker {
  private settings: TrackerSettings;
  private tracks: TrackState[] = [];
  private nextInternalId = 1;
  private nextPublicId = 1;
  private lastFrameTimestamp: number | null = null;

  // Room-level debounced state
  private currentRoomStatus: Exclude<RoomStatus, 'offline'> = 'empty';
  private pendingRoomStatus: Exclude<RoomStatus, 'offline'> | null = null;
  private pendingRoomStatusSince = 0;

  constructor(initialSettings?: Partial<TrackerSettings>) {
    this.settings = { ...DEFAULT_TRACKER_SETTINGS, ...initialSettings };
  }

  public updateSettings(partial: Partial<TrackerSettings>): void {
    this.settings = { ...this.settings, ...partial };
  }

  public getSettings(): TrackerSettings {
    return { ...this.settings };
  }

  public getCurrentRoomStatus(): Exclude<RoomStatus, 'offline'> {
    return this.currentRoomStatus;
  }

  /**
   * Resets active tracks and debounce state while preserving monotonically increasing public IDs
   * within the session unless fullSessionReset is true.
   */
  public reset(fullSessionReset = false): void {
    this.tracks = [];
    this.lastFrameTimestamp = null;
    this.currentRoomStatus = 'empty';
    this.pendingRoomStatus = null;
    this.pendingRoomStatusSince = 0;
    if (fullSessionReset) {
      this.nextInternalId = 1;
      this.nextPublicId = 1;
    }
  }

  /**
   * Processes a single frame of raw person detections.
   *
   * @param rawDetections Detections from coco-ssd or simulation (class 'person')
   * @param frameWidth    Processed stream width in pixels (un-mirrored)
   * @param frameHeight   Processed stream height in pixels (un-mirrored)
   * @param ignoreZones   Normalized (0..1) ROI exclusion polygons
   * @param nowMs         Monotonic timestamp in ms (e.g. performance.now())
   * @param wallClockIso  Optional ISO timestamp string for the telemetry packet
   */
  public processFrame(
    rawDetections: RawDetection[],
    frameWidth: number,
    frameHeight: number,
    ignoreZones: PolygonZone[],
    nowMs: number,
    wallClockIso?: string,
  ): TrackerFrameResult {
    const safeW = Math.max(1, Math.round(frameWidth));
    const safeH = Math.max(1, Math.round(frameHeight));

    // 1. Stream stall guard: if gap between consecutive frames > 1 s, clear displacement buffers
    let stallDetected = false;
    if (this.lastFrameTimestamp !== null && nowMs - this.lastFrameTimestamp > STREAM_STALL_GAP_MS) {
      stallDetected = true;
      for (const track of this.tracks) {
        track.history = [
          {
            timestamp: nowMs,
            x: track.smoothedX,
            y: track.smoothedY,
            height: track.smoothedHeight,
          },
        ];
        track.normDisp = 0;
        track.warmingUp = true;
      }
    }
    this.lastFrameTimestamp = nowMs;

    // 2. Filter detections by class, confidence, min height, and ROI exclusion zones
    const minHeightPx = this.settings.minBoxHeightFraction * safeH;
    const filteredDetections: RawDetection[] = [];
    let excludedCount = 0;

    for (const det of rawDetections) {
      if (det.class && det.class !== 'person') continue;
      if (det.score < this.settings.detectionConfidence) continue;
      if (det.height < minHeightPx) continue;

      if (isDetectionExcluded(det, safeW, safeH, ignoreZones, this.settings.roiTestPoint)) {
        excludedCount++;
        continue;
      }
      filteredDetections.push(det);
    }

    // 3. Greedy nearest-centroid matching (sorted by Euclidean distance)
    // Max match distance = maxMatchDistanceMultiple * smoothedHeight
    interface CandidatePair {
      trackIndex: number;
      detIndex: number;
      distance: number;
    }

    const candidates: CandidatePair[] = [];
    for (let t = 0; t < this.tracks.length; t++) {
      const track = this.tracks[t];
      const maxDist = Math.max(
        1,
        this.settings.maxMatchDistanceMultiple * Math.max(track.smoothedHeight, minHeightPx),
      );
      for (let d = 0; d < filteredDetections.length; d++) {
        const det = filteredDetections[d];
        const cx = det.x + det.width * 0.5;
        const cy = det.y + det.height * 0.5;
        const dist = Math.hypot(cx - track.smoothedX, cy - track.smoothedY);
        if (dist <= maxDist) {
          candidates.push({ trackIndex: t, detIndex: d, distance: dist });
        }
      }
    }

    candidates.sort((a, b) => a.distance - b.distance);

    const matchedTracks = new Set<number>();
    const matchedDets = new Set<number>();

    const evalWindowMs = Math.max(100, this.settings.evaluationIntervalSec * 1000);
    const holdMs = Math.max(0, this.settings.stateHoldSec * 1000);

    for (const pair of candidates) {
      if (matchedTracks.has(pair.trackIndex) || matchedDets.has(pair.detIndex)) continue;
      matchedTracks.add(pair.trackIndex);
      matchedDets.add(pair.detIndex);

      const track = this.tracks[pair.trackIndex];
      const det = filteredDetections[pair.detIndex];
      const rawCx = det.x + det.width * 0.5;
      const rawCy = det.y + det.height * 0.5;

      // Apply EMA smoothing to centroid and height
      track.smoothedX = applyEma(track.smoothedX, rawCx, this.settings.emaAlpha);
      track.smoothedY = applyEma(track.smoothedY, rawCy, this.settings.emaAlpha);

      const emaHeight = applyEma(track.smoothedHeight, det.height, this.settings.emaAlpha);
      // Resist partial-occlusion clipping: limit downward height shrinkage to at most 5% per frame
      track.smoothedHeight = Math.max(emaHeight, track.smoothedHeight * MAX_HEIGHT_SHRINK_FACTOR);

      track.rawBox = { x: det.x, y: det.y, width: det.width, height: det.height };
      track.rawCentroid = { x: rawCx, y: rawCy };
      track.confidence = det.score;
      track.missedFrames = 0;
      track.lastSeenAt = nowMs;
      track.occluded = false;
      track.consecutiveHits += 1;

      // Track confirmation: 3 consecutive frames before public ID assignment & counting
      if (!track.confirmed && track.consecutiveHits >= CONFIRMATION_FRAMES) {
        track.confirmed = true;
        track.publicId = this.nextPublicId++;
      }

      // Append to rolling time-based history buffer and prune samples older than evalWindowMs
      // Keep the oldest sample just at/before the window boundary so we measure the full span cleanly
      track.history.push({
        timestamp: nowMs,
        x: track.smoothedX,
        y: track.smoothedY,
        height: track.smoothedHeight,
      });

      const cutoff = nowMs - evalWindowMs;
      while (track.history.length > 2 && track.history[1].timestamp <= cutoff) {
        track.history.shift();
      }

      // Compute max smoothed height over evaluation window for partial-occlusion resilience
      let maxH = track.smoothedHeight;
      for (const sample of track.history) {
        if (sample.height > maxH) maxH = sample.height;
      }
      track.windowMaxHeight = Math.max(1, maxH);

      // Warm-up check: require full evaluation interval of history before allowing chaotic
      const oldest = track.history[0];
      const spanMs = nowMs - oldest.timestamp;

      if (spanMs < evalWindowMs * 0.92) {
        track.warmingUp = true;
        track.normDisp = 0;
        track.state = 'calm';
      } else {
        track.warmingUp = false;
        let displacementPx = 0;

        if (this.settings.displacementMode === 'path_length') {
          for (let i = 1; i < track.history.length; i++) {
            const prev = track.history[i - 1];
            const curr = track.history[i];
            displacementPx += Math.hypot(curr.x - prev.x, curr.y - prev.y);
          }
        } else {
          // Net Euclidean displacement from start of window to current smoothed centroid
          displacementPx = Math.hypot(
            track.smoothedX - oldest.x,
            track.smoothedY - oldest.y,
          );
        }

        const normDisp = displacementPx / track.windowMaxHeight;
        track.normDisp = Number.isFinite(normDisp) ? normDisp : 0;

        // Individual state classification with hysteresis / state hold cooldown
        const desiredState: PersonState =
          track.normDisp > this.settings.normalizedMovementThreshold ? 'chaotic' : 'calm';

        if (desiredState !== track.state) {
          if (nowMs - track.lastStateChangeAt >= holdMs) {
            track.state = desiredState;
            track.lastStateChangeAt = nowMs;
          }
        }
      }
    }

    // 4. Handle unmatched existing tracks (grace period + time fallback)
    const survivingTracks: TrackState[] = [];
    for (let t = 0; t < this.tracks.length; t++) {
      const track = this.tracks[t];
      if (matchedTracks.has(t)) {
        survivingTracks.push(track);
        continue;
      }

      // Unconfirmed tracks must match for 3 CONSECUTIVE frames — drop immediately if missed
      if (!track.confirmed) {
        continue;
      }

      track.missedFrames += 1;
      track.occluded = true;

      const timeSinceLastSeen = nowMs - track.lastSeenAt;
      const withinFrameGrace = track.missedFrames <= this.settings.graceFrames;
      const withinTimeGrace = timeSinceLastSeen <= this.settings.graceTimeMs;

      // Expire only when grace period expires (frames OR time fallback if FPS drops)
      if (withinFrameGrace && withinTimeGrace) {
        survivingTracks.push(track);
      }
    }

    // 5. Create new pending tracks for unmatched detections
    for (let d = 0; d < filteredDetections.length; d++) {
      if (matchedDets.has(d)) continue;
      const det = filteredDetections[d];
      const rawCx = det.x + det.width * 0.5;
      const rawCy = det.y + det.height * 0.5;

      survivingTracks.push({
        internalId: this.nextInternalId++,
        publicId: null,
        consecutiveHits: 1,
        confirmed: false,
        missedFrames: 0,
        lastSeenAt: nowMs,
        occluded: false,
        rawBox: { x: det.x, y: det.y, width: det.width, height: det.height },
        rawCentroid: { x: rawCx, y: rawCy },
        confidence: det.score,
        smoothedX: rawCx,
        smoothedY: rawCy,
        smoothedHeight: Math.max(1, det.height),
        windowMaxHeight: Math.max(1, det.height),
        history: [{ timestamp: nowMs, x: rawCx, y: rawCy, height: Math.max(1, det.height) }],
        normDisp: 0,
        warmingUp: true,
        state: 'calm',
        lastStateChangeAt: nowMs - holdMs, // Ready to classify as soon as warm-up completes
      });
    }

    this.tracks = survivingTracks;

    // 6. Compute room-level counts & debounced room_status (only confirmed, non-expired tracks)
    const confirmedTracks = this.tracks.filter((t) => t.confirmed && t.publicId !== null);
    const pendingTracks = this.tracks.filter((t) => !t.confirmed);

    let calmCount = 0;
    let chaoticCount = 0;
    for (const track of confirmedTracks) {
      if (track.state === 'chaotic') chaoticCount++;
      else calmCount++;
    }
    const totalPeople = calmCount + chaoticCount;
    const rawRoomStatus = computeRawRoomStatus(calmCount, chaoticCount);

    let roomStatusChanged = false;
    if (rawRoomStatus === this.currentRoomStatus) {
      this.pendingRoomStatus = null;
    } else {
      if (this.pendingRoomStatus !== rawRoomStatus) {
        this.pendingRoomStatus = rawRoomStatus;
        this.pendingRoomStatusSince = nowMs;
      }
      if (nowMs - this.pendingRoomStatusSince >= this.settings.roomDebounceMs) {
        this.currentRoomStatus = rawRoomStatus;
        this.pendingRoomStatus = null;
        roomStatusChanged = true;
      }
    }

    // 7. Build MQTT telemetry packet (Section 6 schema: integer un-mirrored coords)
    const packet: TelemetryPacket = {
      timestamp: wallClockIso ?? new Date().toISOString(),
      room_status: this.currentRoomStatus,
      total_people: totalPeople,
      calm_count: calmCount,
      chaotic_count: chaoticCount,
      frame: { width: safeW, height: safeH },
      occupants: confirmedTracks.map((t) => ({
        id: t.publicId!,
        x: Math.round(t.smoothedX),
        y: Math.round(t.smoothedY),
        norm_disp: Number(t.normDisp.toFixed(3)),
        state: t.state,
      })),
    };

    return {
      tracks: confirmedTracks,
      pendingTracks,
      filteredDetections,
      excludedCount,
      totalPeople,
      calmCount,
      chaoticCount,
      rawRoomStatus,
      roomStatus: this.currentRoomStatus,
      roomStatusChanged,
      stallDetected,
      packet,
    };
  }
}
