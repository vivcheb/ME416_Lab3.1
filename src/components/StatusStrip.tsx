import type {
  BridgeConnectionState,
  BrokerConnectionState,
  CameraConnectionState,
  RoomStatus,
  VideoSourceType,
} from '../core/types';

interface StatusStripProps {
  roomStatus: RoomStatus;
  rawRoomStatus: RoomStatus;
  offlineReason?: string | null;
  totalPeople: number;
  calmCount: number;
  chaoticCount: number;
  cameraState: CameraConnectionState;
  bridgeState: BridgeConnectionState;
  brokerState: BrokerConnectionState;
  source: VideoSourceType;
  brokerHostLabel: string;
}

const ROOM_STATUS_THEMES: Record<
  RoomStatus,
  {
    label: string;
    glyph: string;
    subtitle: string;
    surface: string;
    text: string;
    accentText: string;
    border: string;
  }
> = {
  calm: {
    label: 'Calm',
    glyph: '●',
    subtitle: 'Majority of occupants are stationary or moving gently',
    surface: 'from-[#E5FAF4]/92 via-[#EFFCF8]/86 to-[#D7F5EC]/82',
    text: 'text-teal-950',
    accentText: 'text-teal-700',
    border: 'border-teal-200/80',
  },
  chaotic: {
    label: 'Chaotic',
    glyph: '▲',
    subtitle: 'Elevated multi-person movement exceeding normalized threshold',
    surface: 'from-[#FFE9EF]/92 via-[#FFF2F5]/86 to-[#FFDCE5]/82',
    text: 'text-rose-950',
    accentText: 'text-rose-700',
    border: 'border-rose-200/80',
  },
  tie: {
    label: 'Tie',
    glyph: '◆',
    subtitle: 'Equal number of calm and chaotic occupants detected',
    surface: 'from-[#FEF3DA]/92 via-[#FFF8EA]/86 to-[#FDE9C2]/82',
    text: 'text-amber-950',
    accentText: 'text-amber-700',
    border: 'border-amber-200/80',
  },
  empty: {
    label: 'Empty',
    glyph: '○',
    subtitle: 'No confirmed occupants inside the monitored area',
    surface: 'from-[#ECEBFF]/92 via-[#F4F3FF]/86 to-[#E2E0FF]/82',
    text: 'text-indigo-950',
    accentText: 'text-indigo-700',
    border: 'border-indigo-200/80',
  },
  offline: {
    label: 'Offline',
    glyph: '✖',
    subtitle: 'Camera feed unavailable — normal status resumes when frames return',
    surface: 'from-[#ECEFF6]/92 via-[#F4F6FA]/86 to-[#E3E7F0]/82',
    text: 'text-slate-900',
    accentText: 'text-slate-600',
    border: 'border-slate-300/80',
  },
};

function connectionColor(state: string): { dot: string; text: string; label: string } {
  if (state === 'streaming' || state === 'connected') {
    return {
      dot: 'bg-teal-500',
      text: 'text-teal-800',
      label: state === 'streaming' ? 'Streaming' : 'Connected',
    };
  }
  if (state === 'reconnecting') {
    return {
      dot: 'bg-amber-500',
      text: 'text-amber-800',
      label: 'Reconnecting',
    };
  }
  return {
    dot: 'bg-rose-500',
    text: 'text-rose-800',
    label: state === 'offline' ? 'Offline' : 'Disconnected',
  };
}

export function StatusStrip({
  roomStatus,
  rawRoomStatus,
  offlineReason,
  totalPeople,
  calmCount,
  chaoticCount,
  cameraState,
  bridgeState,
  brokerState,
  source,
  brokerHostLabel,
}: StatusStripProps) {
  const theme = ROOM_STATUS_THEMES[roomStatus];
  const camMeta = connectionColor(cameraState);
  const bridgeMeta = connectionColor(bridgeState);
  const brokerMeta = connectionColor(brokerState);

  const isDebouncing = rawRoomStatus !== roomStatus && roomStatus !== 'offline';

  return (
    <section aria-label="Room activity overview" className="space-y-4">
      {/* Primary Row: Prominent Room Status Banner + 3 Tactile 3D Pastel KPI Chambers */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-12 items-stretch">
        {/* Prominent Room Status Banner */}
        <div
          className={`lg:col-span-6 rounded-2xl border ${theme.border} bg-gradient-to-br ${theme.surface} p-5 backdrop-blur-xl shadow-[0_12px_28px_-14px_rgba(72,90,136,0.16),0_3px_0_0_rgba(255,255,255,0.7),inset_0_2px_2px_rgba(255,255,255,0.92)] flex flex-col justify-between`}
        >
          <div className="flex items-start justify-between gap-4">
            <div className="space-y-1">
              <p className="text-xs font-medium text-slate-600">Room Activity Status</p>
              <div className="flex items-baseline gap-2.5">
                <span className={`text-xl ${theme.accentText}`} aria-hidden="true">
                  {theme.glyph}
                </span>
                <h1 className={`text-3xl font-bold tracking-tight ${theme.text}`}>
                  {theme.label}
                </h1>
              </div>
            </div>

            {isDebouncing && (
              <span className="font-mono-tabular text-xs font-medium text-slate-600">
                Debouncing → {rawRoomStatus}
              </span>
            )}
            {roomStatus === 'offline' && offlineReason && (
              <span className="font-mono-tabular text-xs font-medium text-slate-700">
                reason: {offlineReason}
              </span>
            )}
          </div>

          <p className="mt-3 text-sm text-slate-700 leading-snug">{theme.subtitle}</p>
        </div>

        {/* 3 KPI Chambers */}
        <div className="lg:col-span-6 grid grid-cols-3 gap-4">
          <div className="pastel-3d-card rounded-2xl p-5 flex flex-col justify-between">
            <span className="text-xs font-medium text-slate-600">Total People</span>
            <div className="mt-3 flex items-baseline justify-between gap-2">
              <span className="font-mono-tabular text-4xl font-bold tracking-tight text-slate-900">
                {totalPeople}
              </span>
              <span className="text-xs text-slate-500">confirmed</span>
            </div>
          </div>

          <div className="pastel-3d-card rounded-2xl p-5 flex flex-col justify-between">
            <span className="text-xs font-medium text-teal-800">Calm Count</span>
            <div className="mt-3 flex items-baseline justify-between gap-2">
              <span className="font-mono-tabular text-4xl font-bold tracking-tight text-teal-800">
                {calmCount}
              </span>
              <span className="text-xs text-teal-700/80">steady</span>
            </div>
          </div>

          <div className="pastel-3d-card rounded-2xl p-5 flex flex-col justify-between">
            <span className="text-xs font-medium text-rose-800">Chaotic Count</span>
            <div className="mt-3 flex items-baseline justify-between gap-2">
              <span className="font-mono-tabular text-4xl font-bold tracking-tight text-rose-700">
                {chaoticCount}
              </span>
              <span className="text-xs text-rose-700/80">moving</span>
            </div>
          </div>
        </div>
      </div>

      {/* Clean Unboxed Live Connection Telemetry Row (zero static pill boxes) */}
      <div className="liquid-glass rounded-2xl px-5 py-3 flex flex-wrap items-center justify-between gap-x-8 gap-y-2 text-xs">
        <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
          <div className="flex items-center gap-2 whitespace-nowrap">
            <span className={`h-2 w-2 rounded-full ${camMeta.dot}`} aria-hidden="true" />
            <span className="text-slate-500">Camera ↔ Bridge</span>
            <span className={`font-semibold ${camMeta.text}`}>{camMeta.label}</span>
            {source !== 'ip_camera' && (
              <span className="text-slate-400">
                ({source === 'simulation' ? 'Sim active' : 'Webcam active'})
              </span>
            )}
          </div>

          <span className="hidden sm:inline text-slate-300" aria-hidden="true">
            ·
          </span>

          <div className="flex items-center gap-2 whitespace-nowrap">
            <span className={`h-2 w-2 rounded-full ${bridgeMeta.dot}`} aria-hidden="true" />
            <span className="text-slate-500">Browser ↔ Bridge</span>
            <span className={`font-semibold ${bridgeMeta.text}`}>{bridgeMeta.label}</span>
          </div>

          <span className="hidden sm:inline text-slate-300" aria-hidden="true">
            ·
          </span>

          <div className="flex items-center gap-2 whitespace-nowrap">
            <span className={`h-2 w-2 rounded-full ${brokerMeta.dot}`} aria-hidden="true" />
            <span className="text-slate-500">Bridge ↔ Broker</span>
            <span className={`font-semibold ${brokerMeta.text}`}>{brokerMeta.label}</span>
            <span className="font-mono-tabular text-slate-500">({brokerHostLabel})</span>
          </div>
        </div>

        <span className="text-slate-500 hidden xl:inline">
          Keep dashboard tab visible in foreground to prevent browser detection throttling
        </span>
      </div>
    </section>
  );
}
