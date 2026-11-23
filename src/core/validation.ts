import type { OfflinePacket, RoomStatus, TelemetryPacket } from './types.ts';

const VALID_ROOM_STATUSES = new Set<RoomStatus>(['calm', 'chaotic', 'tie', 'empty', 'offline']);
const VALID_PERSON_STATES = new Set(['calm', 'chaotic']);
const VALID_OFFLINE_REASONS = new Set(['camera_lost', 'shutdown', 'tab_closed']);

export interface ValidationResult {
  valid: boolean;
  error?: string;
  packet?: TelemetryPacket | OfflinePacket;
}

/**
 * Validates outgoing/incoming telemetry payloads against the Section 6 packet schema.
 * Accepts both full activity packets and compact offline packets.
 */
export function validateTelemetryPacket(input: unknown): ValidationResult {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { valid: false, error: 'Payload must be a JSON object' };
  }

  const obj = input as Record<string, unknown>;
  const roomStatus = obj.room_status;

  if (typeof roomStatus !== 'string' || !VALID_ROOM_STATUSES.has(roomStatus as RoomStatus)) {
    return { valid: false, error: 'Invalid or missing room_status' };
  }

  // Offline packet may omit counts, frame, and occupants
  if (roomStatus === 'offline') {
    if (obj.reason !== undefined) {
      if (typeof obj.reason !== 'string' || !VALID_OFFLINE_REASONS.has(obj.reason)) {
        return { valid: false, error: 'Invalid offline reason' };
      }
      return {
        valid: true,
        packet: {
          room_status: 'offline',
          reason: obj.reason as 'camera_lost' | 'shutdown' | 'tab_closed',
        },
      };
    }
    return { valid: true, packet: { room_status: 'offline' } };
  }

  // Full telemetry packet validation
  if (typeof obj.timestamp !== 'string' || Number.isNaN(Date.parse(obj.timestamp))) {
    return { valid: false, error: 'Invalid or missing ISO timestamp' };
  }

  if (
    typeof obj.total_people !== 'number' ||
    !Number.isInteger(obj.total_people) ||
    obj.total_people < 0
  ) {
    return { valid: false, error: 'total_people must be a non-negative integer' };
  }

  if (
    typeof obj.calm_count !== 'number' ||
    !Number.isInteger(obj.calm_count) ||
    obj.calm_count < 0
  ) {
    return { valid: false, error: 'calm_count must be a non-negative integer' };
  }

  if (
    typeof obj.chaotic_count !== 'number' ||
    !Number.isInteger(obj.chaotic_count) ||
    obj.chaotic_count < 0
  ) {
    return { valid: false, error: 'chaotic_count must be a non-negative integer' };
  }

  if (obj.calm_count + obj.chaotic_count !== obj.total_people) {
    return { valid: false, error: 'calm_count + chaotic_count must equal total_people' };
  }

  if (!obj.frame || typeof obj.frame !== 'object' || Array.isArray(obj.frame)) {
    return { valid: false, error: 'Missing frame dimensions object' };
  }

  const frame = obj.frame as Record<string, unknown>;
  if (
    typeof frame.width !== 'number' ||
    !Number.isInteger(frame.width) ||
    frame.width <= 0 ||
    typeof frame.height !== 'number' ||
    !Number.isInteger(frame.height) ||
    frame.height <= 0
  ) {
    return { valid: false, error: 'frame.width and frame.height must be positive integers' };
  }

  if (!Array.isArray(obj.occupants)) {
    return { valid: false, error: 'occupants must be an array' };
  }

  const occupants: TelemetryPacket['occupants'] = [];
  for (let i = 0; i < obj.occupants.length; i++) {
    const occ = obj.occupants[i] as Record<string, unknown>;
    if (!occ || typeof occ !== 'object' || Array.isArray(occ)) {
      return { valid: false, error: `occupants[${i}] must be an object` };
    }
    if (typeof occ.id !== 'number' || !Number.isInteger(occ.id) || occ.id < 1) {
      return { valid: false, error: `occupants[${i}].id must be a positive integer` };
    }
    if (typeof occ.x !== 'number' || !Number.isInteger(occ.x)) {
      return { valid: false, error: `occupants[${i}].x must be an integer pixel coordinate` };
    }
    if (typeof occ.y !== 'number' || !Number.isInteger(occ.y)) {
      return { valid: false, error: `occupants[${i}].y must be an integer pixel coordinate` };
    }
    if (typeof occ.norm_disp !== 'number' || !Number.isFinite(occ.norm_disp) || occ.norm_disp < 0) {
      return { valid: false, error: `occupants[${i}].norm_disp must be a non-negative finite number` };
    }
    if (typeof occ.state !== 'string' || !VALID_PERSON_STATES.has(occ.state)) {
      return { valid: false, error: `occupants[${i}].state must be "calm" or "chaotic"` };
    }

    occupants.push({
      id: occ.id,
      x: occ.x,
      y: occ.y,
      norm_disp: Number(occ.norm_disp.toFixed(4)),
      state: occ.state as 'calm' | 'chaotic',
    });
  }

  return {
    valid: true,
    packet: {
      timestamp: obj.timestamp,
      room_status: roomStatus as RoomStatus,
      total_people: obj.total_people,
      calm_count: obj.calm_count,
      chaotic_count: obj.chaotic_count,
      frame: { width: frame.width, height: frame.height },
      occupants,
    },
  };
}
