import { Download } from 'lucide-react';

export type WorkspaceTab = 'monitor' | 'settings' | 'telemetry' | 'guide';

interface TopBarProps {
  activeTab: WorkspaceTab;
  onSelectTab: (tab: WorkspaceTab) => void;
  onExportSettings: () => void;
}

const NAV_ITEMS: Array<{ id: WorkspaceTab; label: string }> = [
  { id: 'monitor', label: 'Monitor' },
  { id: 'settings', label: 'Camera & MQTT' },
  { id: 'telemetry', label: 'Telemetry' },
  { id: 'guide', label: 'Lab Guide' },
];

/**
 * Clean 3-zone Liquid Glass Top Bar Contract:
 *   [Brand title, one line] — [4 single-line nav links] — [1 primary action]
 */
export function TopBar({ activeTab, onSelectTab, onExportSettings }: TopBarProps) {
  return (
    <header className="sticky top-0 z-30 border-b border-white/80 bg-white/65 backdrop-blur-2xl">
      <div className="mx-auto flex max-w-[1440px] items-center justify-between gap-8 px-4 py-3.5 sm:px-6">
        {/* Zone 1: Single-line brand wordmark */}
        <button
          type="button"
          onClick={() => onSelectTab('monitor')}
          className="text-left font-semibold tracking-tight text-slate-900 text-lg whitespace-nowrap shrink-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 rounded-md"
          style={{ fontFamily: 'var(--font-display)' }}
        >
          Lumina Room Tracker
        </button>

        {/* Zone 2: Clean single-line text navigation links */}
        <nav aria-label="Workspace sections" className="flex items-center gap-6 overflow-x-auto">
          {NAV_ITEMS.map((item) => {
            const active = activeTab === item.id;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => onSelectTab(item.id)}
                className={`relative py-1 text-sm font-medium whitespace-nowrap shrink-0 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 rounded ${
                  active
                    ? 'text-indigo-700'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                {item.label}
                {active && (
                  <span
                    aria-hidden="true"
                    className="absolute right-0 bottom-0 left-0 h-[2px] rounded-full bg-indigo-500"
                  />
                )}
              </button>
            );
          })}
        </nav>

        {/* Zone 3: Single primary action */}
        <div className="shrink-0">
          <button
            type="button"
            onClick={onExportSettings}
            className="pastel-3d-btn inline-flex items-center gap-2 rounded-xl px-4 py-2 text-xs font-semibold whitespace-nowrap shrink-0 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:ring-offset-2"
          >
            <Download className="h-3.5 w-3.5" aria-hidden="true" />
            Export Config
          </button>
        </div>
      </div>
    </header>
  );
}
