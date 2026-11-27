import { useRef, useState } from 'react';
import { ChevronDown, ChevronUp, Download, RotateCcw, Upload } from 'lucide-react';
import type {
  CocoModelBase,
  DisplacementMetricMode,
  RoiTestPointMode,
  TrackerSettings,
} from '../core/types';

interface TuningPanelProps {
  settings: TrackerSettings;
  onChange: (partial: Partial<TrackerSettings>) => void;
  onResetDefaults: () => void;
  onExportJson: () => void;
  onImportJson: (rawJson: string) => { ok: boolean; message: string };
}

interface SliderRowProps {
  id: string;
  label: string;
  value: number;
  displayValue: string;
  min: number;
  max: number;
  step: number;
  hint?: string;
  onChange: (val: number) => void;
}

function SliderRow({
  id,
  label,
  value,
  displayValue,
  min,
  max,
  step,
  hint,
  onChange,
}: SliderRowProps) {
  return (
    <div className="space-y-1.5">
      <div className="flex items-baseline justify-between gap-2">
        <label htmlFor={id} className="text-xs font-medium text-slate-700">
          {label}
        </label>
        <span className="font-mono-tabular text-xs font-semibold text-indigo-700">
          {displayValue}
        </span>
      </div>
      <input
        id={id}
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="glass-slider w-full"
      />
      {hint && <p className="text-[11px] text-slate-500 leading-tight">{hint}</p>}
    </div>
  );
}

export function TuningPanel({
  settings,
  onChange,
  onResetDefaults,
  onExportJson,
  onImportJson,
}: TuningPanelProps) {
  const [showAdvanced, setShowAdvanced] = useState(true);
  const [importNotice, setImportNotice] = useState<{ ok: boolean; text: string } | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const handleImportFile = async (file: File | undefined) => {
    if (!file) return;
    const text = await file.text();
    const res = onImportJson(text);
    setImportNotice({ ok: res.ok, text: res.message });
    window.setTimeout(() => setImportNotice(null), 4000);
  };

  return (
    <aside className="liquid-glass rounded-2xl p-5 flex flex-col gap-5">
      <div className="flex items-center justify-between gap-2">
        <div>
          <h2 className="text-base font-semibold text-slate-900">Live Detection & Motion Tuning</h2>
          <p className="text-xs text-slate-500">All adjustments apply immediately without reload</p>
        </div>
      </div>

      {/* 5 Primary Required Sliders (Section 5) */}
      <div className="space-y-4">
        <SliderRow
          id="slider-eval-interval"
          label="Evaluation interval"
          value={settings.evaluationIntervalSec}
          displayValue={`${settings.evaluationIntervalSec.toFixed(1)} s`}
          min={0.5}
          max={5.0}
          step={0.1}
          hint="Rolling time window for normalized displacement"
          onChange={(v) => onChange({ evaluationIntervalSec: v })}
        />

        <SliderRow
          id="slider-move-threshold"
          label="Normalized movement threshold"
          value={settings.normalizedMovementThreshold}
          displayValue={`${settings.normalizedMovementThreshold.toFixed(2)}× h`}
          min={0.05}
          max={0.5}
          step={0.01}
          hint="Displacement ÷ smoothed box height to trigger chaotic"
          onChange={(v) => onChange({ normalizedMovementThreshold: v })}
        />

        <SliderRow
          id="slider-confidence"
          label="Detection confidence"
          value={settings.detectionConfidence}
          displayValue={settings.detectionConfidence.toFixed(2)}
          min={0.2}
          max={0.95}
          step={0.01}
          hint="Lower to ~0.45 in grayscale IR night mode"
          onChange={(v) => onChange({ detectionConfidence: v })}
        />

        <SliderRow
          id="slider-ema-alpha"
          label="EMA smoothing factor (alpha)"
          value={settings.emaAlpha}
          displayValue={settings.emaAlpha.toFixed(2)}
          min={0.05}
          max={1.0}
          step={0.05}
          hint="Lower resists bbox jitter; higher responds faster"
          onChange={(v) => onChange({ emaAlpha: v })}
        />

        <SliderRow
          id="slider-heartbeat"
          label="MQTT heartbeat interval"
          value={settings.mqttHeartbeatIntervalSec}
          displayValue={`${settings.mqttHeartbeatIntervalSec} s`}
          min={1}
          max={60}
          step={1}
          hint="State changes still publish immediately (<200 ms)"
          onChange={(v) => onChange({ mqttHeartbeatIntervalSec: v })}
        />
      </div>

      <div className="border-t border-slate-200/70 pt-3">
        <button
          type="button"
          onClick={() => setShowAdvanced((v) => !v)}
          className="flex w-full items-center justify-between text-xs font-semibold text-slate-700 hover:text-indigo-700 cursor-pointer py-1"
        >
          <span>Tracking, Model & Overlay Parameters</span>
          {showAdvanced ? (
            <ChevronUp className="h-4 w-4 text-slate-500" aria-hidden="true" />
          ) : (
            <ChevronDown className="h-4 w-4 text-slate-500" aria-hidden="true" />
          )}
        </button>

        {showAdvanced && (
          <div className="mt-3.5 space-y-4">
            <SliderRow
              id="slider-grace-frames"
              label="Grace period (occlusion)"
              value={settings.graceFrames}
              displayValue={`${settings.graceFrames} frames`}
              min={15}
              max={30}
              step={1}
              hint="Retains lost track ID with 1.0s time fallback"
              onChange={(v) => onChange({ graceFrames: v })}
            />

            <SliderRow
              id="slider-state-hold"
              label="State hold / cooldown"
              value={settings.stateHoldSec}
              displayValue={`${settings.stateHoldSec.toFixed(1)} s`}
              min={0.5}
              max={5.0}
              step={0.1}
              onChange={(v) => onChange({ stateHoldSec: v })}
            />

            <SliderRow
              id="slider-room-debounce"
              label="Room status debounce"
              value={settings.roomDebounceMs}
              displayValue={`${settings.roomDebounceMs} ms`}
              min={0}
              max={3000}
              step={100}
              onChange={(v) => onChange({ roomDebounceMs: v })}
            />

            <SliderRow
              id="slider-min-height"
              label="Minimum box height"
              value={settings.minBoxHeightFraction}
              displayValue={`${Math.round(settings.minBoxHeightFraction * 100)}%`}
              min={0.02}
              max={0.3}
              step={0.01}
              hint="Drops distant background noise"
              onChange={(v) => onChange({ minBoxHeightFraction: v })}
            />

            <SliderRow
              id="slider-match-dist"
              label="Max match distance"
              value={settings.maxMatchDistanceMultiple}
              displayValue={`${settings.maxMatchDistanceMultiple.toFixed(1)}× h`}
              min={0.5}
              max={2.5}
              step={0.1}
              onChange={(v) => onChange({ maxMatchDistanceMultiple: v })}
            />

            {/* Model, Inference Size, Displacement Mode, ROI Test Point */}
            <div className="grid grid-cols-2 gap-3 pt-1">
              <div className="space-y-1">
                <label htmlFor="select-model" className="text-[11px] font-medium text-slate-600">
                  coco-ssd Model
                </label>
                <select
                  id="select-model"
                  value={settings.modelBase}
                  onChange={(e) => onChange({ modelBase: e.target.value as CocoModelBase })}
                  className="glass-input w-full rounded-xl px-2.5 py-2 text-xs text-slate-800"
                >
                  <option value="lite_mobilenet_v2">lite_mobilenet_v2</option>
                  <option value="mobilenet_v2">mobilenet_v2</option>
                </select>
              </div>

              <div className="space-y-1">
                <label htmlFor="select-inf-width" className="text-[11px] font-medium text-slate-600">
                  Inference Width
                </label>
                <select
                  id="select-inf-width"
                  value={settings.inferenceWidth}
                  onChange={(e) => onChange({ inferenceWidth: Number(e.target.value) })}
                  className="glass-input w-full rounded-xl px-2.5 py-2 text-xs font-mono-tabular text-slate-800"
                >
                  <option value={320}>320 px</option>
                  <option value={480}>480 px</option>
                  <option value={640}>640 px</option>
                  <option value={960}>960 px</option>
                </select>
              </div>

              <div className="space-y-1">
                <label htmlFor="select-disp-mode" className="text-[11px] font-medium text-slate-600">
                  Motion Metric
                </label>
                <select
                  id="select-disp-mode"
                  value={settings.displacementMode}
                  onChange={(e) =>
                    onChange({ displacementMode: e.target.value as DisplacementMetricMode })
                  }
                  className="glass-input w-full rounded-xl px-2.5 py-2 text-xs text-slate-800"
                >
                  <option value="net">Net Euclidean</option>
                  <option value="path_length">Path Length (pacing)</option>
                </select>
              </div>

              <div className="space-y-1">
                <label htmlFor="select-roi-point" className="text-[11px] font-medium text-slate-600">
                  ROI Test Point
                </label>
                <select
                  id="select-roi-point"
                  value={settings.roiTestPoint}
                  onChange={(e) => onChange({ roiTestPoint: e.target.value as RoiTestPointMode })}
                  className="glass-input w-full rounded-xl px-2.5 py-2 text-xs text-slate-800"
                >
                  <option value="bottom_center">Bottom-center (feet)</option>
                  <option value="bbox_center">Bbox center</option>
                </select>
              </div>
            </div>

            {/* Flip Horizontal (Mirror), Flip Vertical (Invert) & Debug toggles */}
            <div className="grid grid-cols-2 gap-2.5 pt-1">
              <button
                type="button"
                onClick={() => onChange({ mirrorVideo: !settings.mirrorVideo })}
                className={`rounded-xl px-3 py-2 text-xs font-medium transition-colors cursor-pointer whitespace-nowrap ${
                  settings.mirrorVideo
                    ? 'bg-indigo-600 text-white shadow-sm'
                    : 'glass-btn text-slate-700'
                }`}
              >
                Flip H (Mirror): {settings.mirrorVideo ? 'On' : 'Off'}
              </button>

              <button
                type="button"
                onClick={() => onChange({ flipVertical: !settings.flipVertical })}
                className={`rounded-xl px-3 py-2 text-xs font-medium transition-colors cursor-pointer whitespace-nowrap ${
                  settings.flipVertical
                    ? 'bg-indigo-600 text-white shadow-sm'
                    : 'glass-btn text-slate-700'
                }`}
              >
                Flip V (Invert): {settings.flipVertical ? 'On' : 'Off'}
              </button>
            </div>

            <button
              type="button"
              onClick={() => onChange({ debugOverlay: !settings.debugOverlay })}
              className={`w-full rounded-xl px-3 py-2 text-xs font-medium transition-colors cursor-pointer whitespace-nowrap ${
                settings.debugOverlay
                  ? 'bg-indigo-600 text-white shadow-sm'
                  : 'glass-btn text-slate-700'
              }`}
            >
              Debug Overlay: {settings.debugOverlay ? 'On' : 'Off'}
            </button>
          </div>
        )}
      </div>

      {/* Persistence actions */}
      <div className="border-t border-slate-200/70 pt-4 space-y-2.5">
        <div className="grid grid-cols-3 gap-2">
          <button
            type="button"
            onClick={onResetDefaults}
            className="glass-btn inline-flex items-center justify-center gap-1.5 rounded-xl px-2.5 py-2 text-xs font-medium cursor-pointer whitespace-nowrap"
          >
            <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />
            Reset
          </button>

          <button
            type="button"
            onClick={onExportJson}
            className="glass-btn inline-flex items-center justify-center gap-1.5 rounded-xl px-2.5 py-2 text-xs font-medium cursor-pointer whitespace-nowrap"
          >
            <Download className="h-3.5 w-3.5" aria-hidden="true" />
            Export
          </button>

          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            className="glass-btn inline-flex items-center justify-center gap-1.5 rounded-xl px-2.5 py-2 text-xs font-medium cursor-pointer whitespace-nowrap"
          >
            <Upload className="h-3.5 w-3.5" aria-hidden="true" />
            Import
          </button>
        </div>

        <input
          ref={fileInputRef}
          type="file"
          accept="application/json,.json"
          className="hidden"
          onChange={(e) => {
            void handleImportFile(e.target.files?.[0]);
            e.target.value = '';
          }}
        />

        {importNotice && (
          <p
            className={`text-xs font-medium ${
              importNotice.ok ? 'text-teal-700' : 'text-rose-700'
            }`}
          >
            {importNotice.text}
          </p>
        )}
        <p className="text-[11px] text-slate-500">
          Settings & ROI polygons persist locally. Camera credentials stay server-side in .env only.
        </p>
      </div>
    </aside>
  );
}
