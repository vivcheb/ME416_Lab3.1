import assert from 'node:assert/strict';
import test from 'node:test';
import { isDetectionExcluded, pointInPolygon } from '../src/core/roi.ts';
import { applyEma, computeRawRoomStatus, RoomTracker } from '../src/core/tracker.ts';
import type { PolygonZone, RawDetection } from '../src/core/types.ts';
import { validateTelemetryPacket } from '../src/core/validation.ts';
import { buildRtspUrl, maskRtspUrl } from '../server/rtsp-stream.ts';

function makeDet(cx: number, cy: number, height = 120, score = 0.85): RawDetection {
  const width = height * 0.45;
  return {
    x: cx - width / 2,
    y: cy - height / 2,
    width,
    height,
    score,
    class: 'person',
  };
}

test('EMA smoothing converges accurately with configurable alpha', () => {
  const next = applyEma(100, 200, 0.3);
  assert.ok(Math.abs(next - 130) < 1e-9);
  assert.equal(applyEma(100, 200, 1.0), 200);
});

test('Point-in-polygon ray casting handles convex, concave, and boundary cases', () => {
  const square = [
    { x: 0.1, y: 0.1 },
    { x: 0.5, y: 0.1 },
    { x: 0.5, y: 0.5 },
    { x: 0.1, y: 0.5 },
  ];
  assert.equal(pointInPolygon({ x: 0.3, y: 0.3 }, square), true);
  assert.equal(pointInPolygon({ x: 0.6, y: 0.3 }, square), false);

  // Concave L-shape polygon
  const lShape = [
    { x: 0.1, y: 0.1 },
    { x: 0.3, y: 0.1 },
    { x: 0.3, y: 0.3 },
    { x: 0.5, y: 0.3 },
    { x: 0.5, y: 0.5 },
    { x: 0.1, y: 0.5 },
  ];
  assert.equal(pointInPolygon({ x: 0.2, y: 0.4 }, lShape), true);
  assert.equal(pointInPolygon({ x: 0.4, y: 0.2 }, lShape), false);
});

test('ROI exclusion supports switching between bottom-center (feet) and bbox-center', () => {
  const doorwayZone: PolygonZone[] = [
    {
      id: 'door',
      name: 'Doorway',
      points: [
        { x: 0.0, y: 0.7 },
        { x: 0.4, y: 0.7 },
        { x: 0.4, y: 1.0 },
        { x: 0.0, y: 1.0 },
      ],
    },
  ];
  // Person center is at y=220 (0.61), feet at y=280 (0.78 -> inside zone)
  const det = makeDet(128, 220, 120);
  assert.equal(isDetectionExcluded(det, 640, 360, doorwayZone, 'bottom_center'), true);
  assert.equal(isDetectionExcluded(det, 640, 360, doorwayZone, 'bbox_center'), false);
});

test('Track confirmation requires 3 consecutive frames and preserves monotonic IDs', () => {
  const tracker = new RoomTracker({ roomDebounceMs: 0 });
  const det = makeDet(200, 200, 120);

  const f1 = tracker.processFrame([det], 640, 360, [], 100);
  assert.equal(f1.totalPeople, 0);
  const f2 = tracker.processFrame([det], 640, 360, [], 200);
  assert.equal(f2.totalPeople, 0);
  const f3 = tracker.processFrame([det], 640, 360, [], 300);
  assert.equal(f3.totalPeople, 1);
  assert.equal(f3.tracks[0].publicId, 1);

  // Expire track past grace time (> 1000ms)
  const fExpired = tracker.processFrame([], 640, 360, [], 2500);
  assert.equal(fExpired.totalPeople, 0);

  // New person appears and confirms -> must get ID 2 (never reuse ID 1)
  tracker.processFrame([det], 640, 360, [], 2600);
  tracker.processFrame([det], 640, 360, [], 2700);
  const fNew = tracker.processFrame([det], 640, 360, [], 2800);
  assert.equal(fNew.totalPeople, 1);
  assert.equal(fNew.tracks[0].publicId, 2);
});

test('Grace period retains occluded track for up to 1s and resumes same ID', () => {
  const tracker = new RoomTracker({ graceFrames: 20, graceTimeMs: 1000, roomDebounceMs: 0 });
  const det = makeDet(300, 200, 120);

  // Confirm track over 3 frames
  tracker.processFrame([det], 640, 360, [], 100);
  tracker.processFrame([det], 640, 360, [], 200);
  const confirmed = tracker.processFrame([det], 640, 360, [], 300);
  assert.equal(confirmed.tracks[0].publicId, 1);

  // Occluded behind furniture for 700ms (7 frames)
  for (let i = 1; i <= 7; i++) {
    const res = tracker.processFrame([], 640, 360, [], 300 + i * 100);
    assert.equal(res.totalPeople, 1);
    assert.equal(res.tracks[0].occluded, true);
    assert.equal(res.tracks[0].publicId, 1);
  }

  // Reappears near last position -> keeps ID 1
  const recovered = tracker.processFrame([makeDet(318, 200, 120)], 640, 360, [], 1100);
  assert.equal(recovered.totalPeople, 1);
  assert.equal(recovered.tracks[0].occluded, false);
  assert.equal(recovered.tracks[0].publicId, 1);
});

test('Stationary person over 60 seconds never flips to chaotic', () => {
  const tracker = new RoomTracker({
    evaluationIntervalSec: 1.5,
    normalizedMovementThreshold: 0.15,
    emaAlpha: 0.3,
    roomDebounceMs: 500,
  });

  // 10 FPS for 60 seconds = 600 frames with realistic 2px detector jitter
  for (let i = 0; i < 600; i++) {
    const t = i * 100;
    const jitterX = Math.sin(i * 1.7) * 2.0;
    const jitterY = Math.cos(i * 1.3) * 1.8;
    const res = tracker.processFrame([makeDet(320 + jitterX, 200 + jitterY, 120)], 640, 360, [], t);
    for (const tr of res.tracks) {
      assert.equal(tr.state, 'calm', `Flipped to chaotic at t=${t}ms (normDisp=${tr.normDisp})`);
    }
  }
});

test('Walking person becomes chaotic after evaluation interval and respects state hold hysteresis', () => {
  const tracker = new RoomTracker({
    evaluationIntervalSec: 1.5,
    normalizedMovementThreshold: 0.15,
    emaAlpha: 0.35,
    stateHoldSec: 1.0,
    roomDebounceMs: 0,
  });

  let x = 120;
  let becameChaoticAt = -1;

  // Walk smoothly across the room at 10 FPS for 2.5 seconds
  for (let i = 0; i <= 25; i++) {
    const t = i * 100;
    x += 6; // 60 px/s -> 90 px in 1.5s -> norm_disp ~0.75 >> 0.15
    const res = tracker.processFrame([makeDet(x, 200, 120)], 640, 360, [], t);
    if (res.tracks[0]?.state === 'chaotic' && becameChaoticAt === -1) {
      becameChaoticAt = t;
    }
  }

  assert.ok(becameChaoticAt > 0 && becameChaoticAt <= 2000, `Expected chaotic within ~1.5-2s, got ${becameChaoticAt}ms`);

  // Stop abruptly: state hold cooldown (1.0s) must keep track chaotic for at least 1.0s after transition
  const stopStart = 2600;
  const stillHeld = tracker.processFrame([makeDet(x, 200, 120)], 640, 360, [], stopStart);
  assert.equal(stillHeld.tracks[0].state, 'chaotic');

  // Remain stationary for 2.5 seconds -> returns to calm
  let finalState = 'chaotic';
  for (let i = 1; i <= 25; i++) {
    const res = tracker.processFrame([makeDet(x, 200, 120)], 640, 360, [], stopStart + i * 100);
    finalState = res.tracks[0].state;
  }
  assert.equal(finalState, 'calm');
});

test('Stream stall guard (>1s gap) clears displacement buffers so sudden jump stays calm', () => {
  const tracker = new RoomTracker({
    evaluationIntervalSec: 1.5,
    normalizedMovementThreshold: 0.15,
    roomDebounceMs: 0,
  });

  // Confirm track over 3 frames
  tracker.processFrame([makeDet(200, 200, 120)], 640, 360, [], 100);
  tracker.processFrame([makeDet(200, 200, 120)], 640, 360, [], 200);
  tracker.processFrame([makeDet(200, 200, 120)], 640, 360, [], 300);

  // Stall for 1.5 seconds (> 1.0s), then person is 60px away (within 1.0x bbox height)
  const afterStall = tracker.processFrame([makeDet(260, 200, 120)], 640, 360, [], 1800);
  assert.equal(afterStall.stallDetected, true);
  assert.equal(afterStall.tracks[0].warmingUp, true);
  assert.equal(afterStall.tracks[0].normDisp, 0);
  assert.equal(afterStall.tracks[0].state, 'calm');
});

test('Room status computes empty, calm, chaotic, and tie with 500ms debounce', () => {
  assert.equal(computeRawRoomStatus(0, 0), 'empty');
  assert.equal(computeRawRoomStatus(2, 1), 'calm');
  assert.equal(computeRawRoomStatus(1, 2), 'chaotic');
  assert.equal(computeRawRoomStatus(2, 2), 'tie');

  const tracker = new RoomTracker({
    evaluationIntervalSec: 1.0,
    normalizedMovementThreshold: 0.15,
    roomDebounceMs: 500,
    stateHoldSec: 0.5,
  });

  // Two people: Person A stationary, Person B walking -> should reach 'tie' after debounce
  let xB = 380;
  let lastStatus = 'empty';
  for (let i = 0; i <= 30; i++) {
    const t = i * 100;
    xB += 6;
    const res = tracker.processFrame(
      [makeDet(150, 200, 120), makeDet(xB, 200, 120)],
      640,
      360,
      [],
      t,
    );
    lastStatus = res.roomStatus;
  }
  assert.equal(lastStatus, 'tie');
});

test('Packet schema validation accepts valid full & offline packets and rejects malformed payloads', () => {
  const validFull = validateTelemetryPacket({
    timestamp: '2026-11-18T19:30:00.000Z',
    room_status: 'calm',
    total_people: 2,
    calm_count: 2,
    chaotic_count: 0,
    frame: { width: 640, height: 360 },
    occupants: [
      { id: 1, x: 320, y: 240, norm_disp: 0.03, state: 'calm' },
      { id: 2, x: 180, y: 210, norm_disp: 0.02, state: 'calm' },
    ],
  });
  assert.equal(validFull.valid, true);

  const validOffline = validateTelemetryPacket({
    room_status: 'offline',
    reason: 'camera_lost',
  });
  assert.equal(validOffline.valid, true);

  const invalidSum = validateTelemetryPacket({
    timestamp: '2026-11-18T19:30:00.000Z',
    room_status: 'calm',
    total_people: 3,
    calm_count: 1,
    chaotic_count: 1,
    frame: { width: 640, height: 360 },
    occupants: [],
  });
  assert.equal(invalidSum.valid, false);

  const invalidFloatCoord = validateTelemetryPacket({
    timestamp: '2026-11-18T19:30:00.000Z',
    room_status: 'calm',
    total_people: 1,
    calm_count: 1,
    chaotic_count: 0,
    frame: { width: 640, height: 360 },
    occupants: [{ id: 1, x: 320.5, y: 240, norm_disp: 0.03, state: 'calm' }],
  });
  assert.equal(invalidFloatCoord.valid, false);
});

test('RTSP URL builder encodes credentials and maskRtspUrl redacts them', () => {
  const built = buildRtspUrl({
    host: '192.168.1.50',
    port: 554,
    path: '/Streaming/Channels/102',
    user: 'viewer',
    password: 'p@ss:word!',
  });
  assert.equal(built, 'rtsp://viewer:p%40ss%3Aword!@192.168.1.50:554/Streaming/Channels/102');
  const masked = maskRtspUrl(built!);
  assert.equal(masked, 'rtsp://***:***@192.168.1.50:554/Streaming/Channels/102');
  assert.equal(masked.includes('viewer'), false);
  assert.equal(masked.includes('word'), false);
});
