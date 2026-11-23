import type { RawDetection } from './types';

export type SimBehavior = 'stationary' | 'walking' | 'pacing' | 'occluded_walk';
export type SimPreset = 'calm_studio' | 'active_lab' | 'tie_balance' | 'empty_room' | 'occlusion_test';

export interface SimPerson {
  id: number;
  label: string;
  x: number; // Normalized 0..1 center X
  y: number; // Normalized 0..1 feet Y
  vx: number;
  vy: number;
  behavior: SimBehavior;
  phase: number;
  heightNorm: number; // Height fraction of frame (0.20 - 0.36)
  accentColor: string;
  anchorX: number;
  anchorY: number;
}

const PASTEL_SILHOUETTE_PALETTE = [
  '#7C8CE0', // soft periwinkle
  '#5BB5A2', // misty mint-teal
  '#E58A9B', // dusty rose
  '#E0A463', // warm apricot
  '#9E82D9', // pastel lavender
  '#6BA6D6', // glacier blue
];

/**
 * Built-in synthetic room scene & detection generator (Section 7 Simulation Mode).
 * Draws a clean oblique architectural studio view with a foreground desk occluder,
 * doorway, and moving/stationary figures, emitting frame-accurate detections so the
 * full tracking, ROI exclusion, hysteresis, and MQTT bridge pipeline can be verified
 * without a physical camera or people in the room.
 */
export class RoomSimulation {
  private people: SimPerson[] = [];
  private nextId = 1;
  private lastTickMs = 0;
  private activePreset: SimPreset = 'calm_studio';

  // Desk occluder region in normalized coordinates (tests 1s occlusion grace period)
  public readonly deskRect = { x: 0.38, y: 0.56, w: 0.24, h: 0.24 };

  constructor(preset: SimPreset = 'calm_studio') {
    this.loadPreset(preset);
  }

  public getPreset(): SimPreset {
    return this.activePreset;
  }

  public getPeopleCount(): number {
    return this.people.length;
  }

  public loadPreset(preset: SimPreset): void {
    this.activePreset = preset;
    this.people = [];

    if (preset === 'empty_room') {
      return;
    }

    if (preset === 'calm_studio') {
      this.addPerson('stationary', 0.24, 0.72);
      this.addPerson('stationary', 0.68, 0.68);
      this.addPerson('walking', 0.52, 0.78);
      return;
    }

    if (preset === 'active_lab') {
      this.addPerson('walking', 0.22, 0.75);
      this.addPerson('pacing', 0.52, 0.72);
      this.addPerson('walking', 0.78, 0.66);
      this.addPerson('stationary', 0.32, 0.62);
      return;
    }

    if (preset === 'tie_balance') {
      this.addPerson('stationary', 0.25, 0.72);
      this.addPerson('stationary', 0.76, 0.70);
      this.addPerson('walking', 0.38, 0.78);
      this.addPerson('pacing', 0.60, 0.74);
      return;
    }

    if (preset === 'occlusion_test') {
      this.addPerson('occluded_walk', 0.22, 0.72);
      this.addPerson('stationary', 0.76, 0.68);
    }
  }

  public addPerson(behavior: SimBehavior, startX?: number, startY?: number): void {
    const id = this.nextId++;
    const x = startX ?? 0.2 + Math.random() * 0.6;
    const y = startY ?? 0.62 + Math.random() * 0.24;
    const speed = behavior === 'walking' ? 0.16 : behavior === 'occluded_walk' ? 0.19 : 0;
    const dir = Math.random() > 0.5 ? 1 : -1;

    this.people.push({
      id,
      label: `Sim ${id}`,
      x,
      y,
      vx: speed * dir,
      vy: behavior === 'walking' ? (Math.random() - 0.5) * 0.04 : 0,
      behavior,
      phase: Math.random() * Math.PI * 2,
      heightNorm: 0.24 + (y - 0.55) * 0.35, // Perspective scaling: closer = taller
      accentColor: PASTEL_SILHOUETTE_PALETTE[(id - 1) % PASTEL_SILHOUETTE_PALETTE.length],
      anchorX: x,
      anchorY: y,
    });
  }

  public clearPeople(): void {
    this.people = [];
    this.activePreset = 'empty_room';
  }

  /**
   * Advances simulation state, renders the architectural room frame to the canvas,
   * and returns synthetic person detections in pixel coordinates (with realistic micro-jitter).
   */
  public stepAndRender(
    ctx: CanvasRenderingContext2D,
    width: number,
    height: number,
    nowMs: number,
  ): RawDetection[] {
    const dt = this.lastTickMs === 0 ? 0.033 : Math.min(0.15, Math.max(0.001, (nowMs - this.lastTickMs) / 1000));
    this.lastTickMs = nowMs;

    // Update synthetic actors
    for (const p of this.people) {
      p.phase += dt * (p.behavior === 'stationary' ? 1.4 : 6.2);

      if (p.behavior === 'stationary') {
        // Gentle standing breathing sway (stays strictly calm over 60s+)
        p.x = p.anchorX + Math.sin(p.phase * 0.7) * 0.002;
        p.y = p.anchorY + Math.cos(p.phase * 0.5) * 0.001;
      } else if (p.behavior === 'pacing') {
        // Pacing back and forth rapidly around anchor
        p.x = p.anchorX + Math.sin(p.phase * 0.65) * 0.13;
        p.y = p.anchorY + Math.cos(p.phase * 0.4) * 0.025;
      } else if (p.behavior === 'walking' || p.behavior === 'occluded_walk') {
        p.x += p.vx * dt;
        p.y += p.vy * dt;
        if (p.x < 0.14) {
          p.x = 0.14;
          p.vx = Math.abs(p.vx);
        } else if (p.x > 0.86) {
          p.x = 0.86;
          p.vx = -Math.abs(p.vx);
        }
        if (p.y < 0.56) {
          p.y = 0.56;
          p.vy = Math.abs(p.vy);
        } else if (p.y > 0.88) {
          p.y = 0.88;
          p.vy = -Math.abs(p.vy);
        }
      }
      // Perspective height based on oblique camera depth (Y)
      p.heightNorm = Math.min(0.38, Math.max(0.18, 0.21 + (p.y - 0.52) * 0.42));
    }

    // Render room backdrop (bright oblique studio with soft glass-pastel architecture)
    this.drawRoomBackdrop(ctx, width, height);

    // Depth-sort people by feet Y (farther drawn first)
    const sorted = [...this.people].sort((a, b) => a.y - b.y);
    const detections: RawDetection[] = [];

    for (const p of sorted) {
      // Check if person is temporarily behind the foreground desk (simulates <=0.85s occlusion)
      const behindDesk =
        p.behavior === 'occluded_walk' &&
        p.x > this.deskRect.x + 0.04 &&
        p.x < this.deskRect.x + this.deskRect.w - 0.04;

      const boxH = p.heightNorm * height;
      const boxW = boxH * 0.44;
      const cx = p.x * width;
      const feetY = p.y * height;

      this.drawPersonFigure(ctx, cx, feetY, boxW, boxH, p, behindDesk ? 0.28 : 1);

      if (!behindDesk) {
        // Add subtle realistic detector jitter (~1.5px) to verify EMA anti-jitter filter
        const jitterX = Math.sin(nowMs * 0.017 + p.id * 3.1) * 1.4;
        const jitterY = Math.cos(nowMs * 0.013 + p.id * 1.9) * 1.2;
        const jitterH = Math.sin(nowMs * 0.011 + p.id) * 1.8;

        detections.push({
          x: cx - boxW * 0.5 + jitterX,
          y: feetY - boxH + jitterY,
          width: boxW,
          height: boxH + jitterH,
          score: 0.82 + Math.sin(nowMs * 0.004 + p.id) * 0.08,
          class: 'person',
        });
      }
    }

    // Draw foreground translucent glass desk on top of occluded walkers
    this.drawForegroundDesk(ctx, width, height);

    return detections;
  }

  private drawRoomBackdrop(ctx: CanvasRenderingContext2D, w: number, h: number): void {
    // Wall gradient (soft daylight gallery studio)
    const wallGrad = ctx.createLinearGradient(0, 0, w, h * 0.55);
    wallGrad.addColorStop(0, '#E9EEF9');
    wallGrad.addColorStop(0.5, '#F2F4FB');
    wallGrad.addColorStop(1, '#EDE8F6');
    ctx.fillStyle = wallGrad;
    ctx.fillRect(0, 0, w, h * 0.52);

    // Floor gradient
    const floorGrad = ctx.createLinearGradient(0, h * 0.5, 0, h);
    floorGrad.addColorStop(0, '#DFE6F2');
    floorGrad.addColorStop(1, '#CCD6E6');
    ctx.fillStyle = floorGrad;
    ctx.fillRect(0, h * 0.5, w, h * 0.5);

    // Subtle perspective floor grid lines
    ctx.save();
    ctx.strokeStyle = 'rgba(120, 140, 178, 0.22)';
    ctx.lineWidth = 1;
    const horizonY = h * 0.5;
    for (let i = 1; i <= 5; i++) {
      const t = i / 5;
      const y = horizonY + Math.pow(t, 1.45) * (h - horizonY);
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(w, y);
      ctx.stroke();
    }
    const vanishX = w * 0.5;
    for (let i = -4; i <= 4; i++) {
      ctx.beginPath();
      ctx.moveTo(vanishX + i * (w * 0.09), horizonY);
      ctx.lineTo(vanishX + i * (w * 0.24), h);
      ctx.stroke();
    }

    // Back wall architectural doorway (left — great spot to test Draw Ignore Zone!)
    ctx.fillStyle = 'rgba(186, 199, 224, 0.55)';
    ctx.fillRect(w * 0.06, h * 0.14, w * 0.13, h * 0.36);
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.75)';
    ctx.lineWidth = 1.5;
    ctx.strokeRect(w * 0.06, h * 0.14, w * 0.13, h * 0.36);

    // Back wall window (right — daylight highlight)
    const winGrad = ctx.createLinearGradient(w * 0.72, h * 0.12, w * 0.92, h * 0.36);
    winGrad.addColorStop(0, 'rgba(255, 255, 255, 0.92)');
    winGrad.addColorStop(1, 'rgba(218, 236, 255, 0.75)');
    ctx.fillStyle = winGrad;
    ctx.fillRect(w * 0.72, h * 0.12, w * 0.2, h * 0.22);
    ctx.strokeStyle = 'rgba(165, 180, 210, 0.5)';
    ctx.strokeRect(w * 0.72, h * 0.12, w * 0.2, h * 0.22);

    // Subtle horizon baseboard
    ctx.strokeStyle = 'rgba(148, 163, 194, 0.45)';
    ctx.beginPath();
    ctx.moveTo(0, horizonY);
    ctx.lineTo(w, horizonY);
    ctx.stroke();
    ctx.restore();
  }

  private drawForegroundDesk(ctx: CanvasRenderingContext2D, w: number, h: number): void {
    const dx = this.deskRect.x * w;
    const dy = this.deskRect.y * h;
    const dw = this.deskRect.w * w;
    const dh = this.deskRect.h * h;

    ctx.save();
    // Soft floor shadow
    ctx.fillStyle = 'rgba(78, 96, 134, 0.14)';
    ctx.beginPath();
    ctx.roundRect(dx + 6, dy + dh - 8, dw - 12, 16, 8);
    ctx.fill();

    // Frosted pastel desk body (occlusion barrier)
    const deskGrad = ctx.createLinearGradient(dx, dy, dx, dy + dh);
    deskGrad.addColorStop(0, 'rgba(255, 255, 255, 0.88)');
    deskGrad.addColorStop(1, 'rgba(222, 232, 248, 0.85)');
    ctx.fillStyle = deskGrad;
    ctx.beginPath();
    ctx.roundRect(dx, dy + dh * 0.18, dw, dh * 0.82, 10);
    ctx.fill();

    // Desk top bevel
    ctx.fillStyle = 'rgba(255, 255, 255, 0.95)';
    ctx.beginPath();
    ctx.roundRect(dx - 4, dy + dh * 0.1, dw + 8, dh * 0.16, 6);
    ctx.fill();
    ctx.strokeStyle = 'rgba(148, 163, 194, 0.45)';
    ctx.lineWidth = 1;
    ctx.stroke();

    // Small architectural caption on desk
    ctx.fillStyle = 'rgba(100, 116, 148, 0.65)';
    ctx.font = '500 10px "DM Sans", system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('Desk Occluder', dx + dw * 0.5, dy + dh * 0.62);
    ctx.restore();
  }

  private drawPersonFigure(
    ctx: CanvasRenderingContext2D,
    cx: number,
    feetY: number,
    boxW: number,
    boxH: number,
    person: SimPerson,
    alpha: number,
  ): void {
    ctx.save();
    ctx.globalAlpha = alpha;

    const topY = feetY - boxH;
    const headR = boxH * 0.115;
    const stride = person.behavior === 'stationary' ? 0 : Math.sin(person.phase) * boxW * 0.24;

    // Ground contact shadow
    ctx.fillStyle = 'rgba(65, 82, 120, 0.18)';
    ctx.beginPath();
    ctx.ellipse(cx, feetY, boxW * 0.42, boxH * 0.045, 0, 0, Math.PI * 2);
    ctx.fill();

    // Legs
    ctx.strokeStyle = '#3B4866';
    ctx.lineWidth = Math.max(4, boxW * 0.16);
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(cx - boxW * 0.14, topY + boxH * 0.56);
    ctx.lineTo(cx - boxW * 0.14 + stride, feetY - 3);
    ctx.moveTo(cx + boxW * 0.14, topY + boxH * 0.56);
    ctx.lineTo(cx + boxW * 0.14 - stride, feetY - 3);
    ctx.stroke();

    // Torso capsule (soft 3D pastel shading)
    const torsoGrad = ctx.createLinearGradient(cx - boxW * 0.35, topY + boxH * 0.22, cx + boxW * 0.35, topY + boxH * 0.6);
    torsoGrad.addColorStop(0, '#FFFFFF');
    torsoGrad.addColorStop(0.28, person.accentColor);
    torsoGrad.addColorStop(1, '#3D4C70');
    ctx.fillStyle = torsoGrad;
    ctx.beginPath();
    ctx.roundRect(cx - boxW * 0.36, topY + boxH * 0.23, boxW * 0.72, boxH * 0.38, boxW * 0.28);
    ctx.fill();

    // Head sphere with specular highlight
    const headGrad = ctx.createRadialGradient(
      cx - headR * 0.35,
      topY + headR * 0.9,
      headR * 0.15,
      cx,
      topY + headR * 1.15,
      headR,
    );
    headGrad.addColorStop(0, '#FFFFFF');
    headGrad.addColorStop(0.55, '#E4D8CE');
    headGrad.addColorStop(1, '#B9A69A');
    ctx.fillStyle = headGrad;
    ctx.beginPath();
    ctx.arc(cx, topY + headR * 1.15, headR, 0, Math.PI * 2);
    ctx.fill();

    ctx.restore();
  }
}
