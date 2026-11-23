import { useEffect, useRef, useState } from 'react';
import { Pause, Play, Trash2 } from 'lucide-react';
import type { TelemetryLogEntry, TelemetryPacket } from '../core/types';

interface TelemetryConsoleProps {
  logs: TelemetryLogEntry[];
  paused: boolean;
  onTogglePause: () => void;
  onClear: () => void;
  latestPacket: TelemetryPacket | null;
  topic: string;
  compact?: boolean;
}

type LogFilter = 'all' | 'transition' | 'mqtt' | 'camera' | 'infra';

export function TelemetryConsole({
  logs,
  paused,
  onTogglePause,
  onClear,
  latestPacket,
  topic,
  compact = false,
}: TelemetryConsoleProps) {
  const [filter, setFilter] = useState<LogFilter>('all');
  const scrollRef = useRef<HTMLDivElement | null>(null);

  const filtered = logs.filter((entry) => {
    if (filter === 'all') return true;
    if (filter === 'infra') return entry.category === 'bridge' || entry.category === 'broker';
    return entry.category === filter;
  });

  useEffect(() => {
    if (!paused && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [filtered.length, paused]);

  const levelColor = (level: TelemetryLogEntry['level']) => {
    if (level === 'error') return 'text-rose-700';
    if (level === 'warn') return 'text-amber-800';
    if (level === 'success') return 'text-teal-700';
    return 'text-slate-700';
  };

  return (
    <section className="grid grid-cols-1 gap-6 lg:grid-cols-12 items-start">
      {/* Scrolling Telemetry Console (capped at 200 lines) */}
      <div
        className={`${
          compact ? 'lg:col-span-8' : 'lg:col-span-8'
        } liquid-glass rounded-2xl p-5 flex flex-col gap-3.5`}
      >
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-base font-semibold text-slate-900">Telemetry Console</h2>
            <p className="text-xs text-slate-500">
              Timestamped transitions, outgoing MQTT packets, and bridge events (max 200 lines)
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {/* Interactive segmented filter */}
            <div className="flex items-center gap-1 rounded-xl bg-white/60 border border-white/80 p-1">
              {(
                [
                  ['all', 'All'],
                  ['transition', 'Transitions'],
                  ['mqtt', 'MQTT'],
                  ['camera', 'Camera'],
                  ['infra', 'Bridge'],
                ] as const
              ).map(([id, label]) => (
                <button
                  key={id}
                  type="button"
                  onClick={() => setFilter(id)}
                  className={`rounded-lg px-2.5 py-1 text-xs font-medium transition-colors cursor-pointer whitespace-nowrap ${
                    filter === id
                      ? 'bg-indigo-600 text-white shadow-sm'
                      : 'text-slate-600 hover:text-slate-900'
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>

            <button
              type="button"
              onClick={onTogglePause}
              className="glass-btn inline-flex items-center gap-1.5 rounded-xl px-3 py-1.5 text-xs font-medium cursor-pointer whitespace-nowrap"
            >
              {paused ? (
                <>
                  <Play className="h-3.5 w-3.5 text-teal-600" aria-hidden="true" />
                  Resume
                </>
              ) : (
                <>
                  <Pause className="h-3.5 w-3.5 text-slate-600" aria-hidden="true" />
                  Pause
                </>
              )}
            </button>

            <button
              type="button"
              onClick={onClear}
              className="glass-btn inline-flex items-center gap-1.5 rounded-xl px-3 py-1.5 text-xs font-medium text-slate-700 cursor-pointer whitespace-nowrap"
            >
              <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
              Clear
            </button>
          </div>
        </div>

        <div
          ref={scrollRef}
          className={`${
            compact ? 'h-60' : 'h-[440px]'
          } overflow-y-auto rounded-xl bg-white/75 border border-slate-200/80 p-3 font-mono-tabular text-xs space-y-2`}
        >
          {filtered.length === 0 ? (
            <div className="flex h-full items-center justify-center text-slate-400">
              No telemetry events captured yet.
            </div>
          ) : (
            filtered.map((entry) => (
              <div
                key={entry.id}
                className="border-b border-slate-100 pb-2 last:border-b-0 last:pb-0"
              >
                <div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-0.5">
                  <span className="text-[11px] text-slate-400 shrink-0">
                    {entry.timestamp.slice(11, 23)}
                  </span>
                  <span className="text-[11px] font-semibold uppercase text-indigo-600 shrink-0">
                    {entry.category}
                  </span>
                  <span className={`${levelColor(entry.level)} break-words`}>
                    {entry.summary}
                  </span>
                </div>
                {entry.payload !== undefined && (
                  <pre className="mt-1 overflow-x-auto rounded-lg bg-slate-50/90 px-2.5 py-1.5 text-[11px] text-slate-600">
                    {JSON.stringify(entry.payload)}
                  </pre>
                )}
              </div>
            ))
          )}
        </div>
      </div>

      {/* Latest Outgoing MQTT JSON Packet Preview */}
      <div className="lg:col-span-4 liquid-glass rounded-2xl p-5 flex flex-col gap-3">
        <div className="flex items-baseline justify-between gap-2">
          <h3 className="text-base font-semibold text-slate-900">Latest MQTT Payload</h3>
          <span className="font-mono-tabular text-[11px] text-indigo-700 truncate">{topic}</span>
        </div>
        <p className="text-xs text-slate-500">
          Integer pixel coordinates in processed frame (un-mirrored, origin top-left), QoS 0,{' '}
          <code className="font-mono-tabular">retain: true</code>.
        </p>

        <pre className="overflow-x-auto rounded-xl bg-white/80 border border-slate-200/80 p-3.5 font-mono-tabular text-[11.5px] leading-relaxed text-slate-800 max-h-[360px] overflow-y-auto">
          {latestPacket
            ? JSON.stringify(latestPacket, null, 2)
            : JSON.stringify({ room_status: 'offline' }, null, 2)}
        </pre>
      </div>
    </section>
  );
}
