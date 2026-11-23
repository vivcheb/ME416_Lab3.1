import type { Point, PolygonZone, RawDetection, RoiTestPointMode } from './types.ts';

/**
 * Ray-casting point-in-polygon algorithm.
 * Works for convex and concave polygons in normalized (0..1) or pixel coordinates.
 * Returns true if the point lies inside the polygon (polygons with < 3 vertices return false).
 */
export function pointInPolygon(point: Point, polygon: Point[]): boolean {
  if (!polygon || polygon.length < 3) {
    return false;
  }

  let inside = false;
  const { x, y } = point;

  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const xi = polygon[i].x;
    const yi = polygon[i].y;
    const xj = polygon[j].x;
    const yj = polygon[j].y;

    // Check if the horizontal ray to +infinity intersects edge (i, j)
    const intersects =
      (yi > y) !== (yj > y) &&
      x < ((xj - xi) * (y - yi)) / (yj - yi) + xi;

    if (intersects) {
      inside = !inside;
    }
  }

  return inside;
}

/**
 * Returns true if a normalized point (0..1, 0..1) falls inside any exclusion zone.
 */
export function isPointInAnyZone(normalizedPoint: Point, zones: PolygonZone[]): boolean {
  for (const zone of zones) {
    if (zone.points.length >= 3 && pointInPolygon(normalizedPoint, zone.points)) {
      return true;
    }
  }
  return false;
}

/**
 * Computes the normalized (0..1) test point for a detection bounding box.
 * - 'bottom_center': feet position (recommended default for oblique camera views)
 * - 'bbox_center': geometric center of the bounding box
 */
export function getDetectionTestPointNormalized(
  box: Pick<RawDetection, 'x' | 'y' | 'width' | 'height'>,
  frameWidth: number,
  frameHeight: number,
  mode: RoiTestPointMode = 'bottom_center',
): Point {
  const safeW = Math.max(1, frameWidth);
  const safeH = Math.max(1, frameHeight);
  const cx = (box.x + box.width * 0.5) / safeW;
  const cy =
    mode === 'bottom_center'
      ? (box.y + box.height) / safeH
      : (box.y + box.height * 0.5) / safeH;

  return {
    x: Math.min(1, Math.max(0, cx)),
    y: Math.min(1, Math.max(0, cy)),
  };
}

/**
 * Checks whether a detection should be excluded by any ROI ignore zone.
 */
export function isDetectionExcluded(
  box: Pick<RawDetection, 'x' | 'y' | 'width' | 'height'>,
  frameWidth: number,
  frameHeight: number,
  zones: PolygonZone[],
  mode: RoiTestPointMode = 'bottom_center',
): boolean {
  if (!zones || zones.length === 0) {
    return false;
  }
  const testPoint = getDetectionTestPointNormalized(box, frameWidth, frameHeight, mode);
  return isPointInAnyZone(testPoint, zones);
}

/**
 * Calculates Euclidean distance between two points.
 */
export function distanceBetween(a: Point, b: Point): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return Math.hypot(dx, dy);
}
