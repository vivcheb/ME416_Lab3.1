import { useEffect, useState } from 'react';
import { CheckCircle2, KeyRound, Radio, RefreshCw, ShieldCheck, Video, XCircle } from 'lucide-react';
import type {
  BridgeStatusPayload,
  CameraTestResult,
  StreamProfile,
} from '../core/types';
import type { PersistedMqttPrefs } from '../utils/storage';

interface SettingsViewProps {
  bridgeStatus: BridgeStatusPayload | null;
  apiFetch: (url: string, init?: RequestInit) => Promise<Response>;
  onStatusUpdated: () => Promise<void>;
  onMqttPrefsSaved: (prefs: PersistedMqttPrefs) => void;
  authRequired: boolean;
  accessToken: string;
  onSetAccessToken: (token: string) => void;
}

export function SettingsView({
  bridgeStatus,
  apiFetch,
  onStatusUpdated,
  onMqttPrefsSaved,
  authRequired,
  accessToken,
  onSetAccessToken,
}: SettingsViewProps) {
  // Camera form state (password is write-only and NEVER populated from server)
  const [camHost, setCamHost] = useState('');
  const [camPort, setCamPort] = useState(554);
  const [camPath, setCamPath] = useState('/h264Preview_01_sub');
  const [camUser, setCamUser] = useState('');
  const [camPassword, setCamPassword] = useState('');
  const [streamProfile, setStreamProfile] = useState<StreamProfile>('sub');
  const [targetFps, setTargetFps] = useState(15);
  const [scaleWidth, setScaleWidth] = useState(640);
  const [camSaving, setCamSaving] = useState(false);
  const [camNotice, setCamNotice] = useState<{ ok: boolean; text: string } | null>(null);

  const [testingCamera, setTestingCamera] = useState(false);
  const [testResult, setTestResult] = useState<CameraTestResult | null>(null);

  // MQTT form state
  const [mqttHost, setMqttHost] = useState('rasticvm.internal');
  const [mqttPort, setMqttPort] = useState(1883);
  const [mqttTopic, setMqttTopic] = useState('room/activity/status');
  const [useLocalhostFallback, setUseLocalhostFallback] = useState(false);
  const [clearOldTopicOnChange, setClearOldTopicOnChange] = useState(true);
  const [offlineOnTabClose, setOfflineOnTabClose] = useState(true);
  const [offlineGraceMs, setOfflineGraceMs] = useState(5000);
  const [mqttSaving, setMqttSaving] = useState(false);
  const [mqttNotice, setMqttNotice] = useState<{ ok: boolean; text: string } | null>(null);

  const [tokenInput, setTokenInput] = useState(accessToken);
  const [syncedFromServer, setSyncedFromServer] = useState(false);

  useEffect(() => {
    if (!bridgeStatus || syncedFromServer) return;
    const c = bridgeStatus.cameraConfig;
    setCamHost(c.host || '');
    setCamPort(c.port || 554);
    setCamPath(c.path || '/h264Preview_01_sub');
    setCamUser(c.user || '');
    setStreamProfile(c.streamProfile || 'sub');
    setTargetFps(c.targetFps || 15);
    setScaleWidth(c.scaleWidth || 640);

    const m = bridgeStatus.mqttConfig;
    setMqttHost(m.host || 'rasticvm.internal');
    setMqttPort(m.port || 1883);
    setMqttTopic(m.topic || 'room/activity/status');
    setUseLocalhostFallback(Boolean(m.useLocalhostFallback));
    setClearOldTopicOnChange(m.clearOldTopicOnChange !== false);
    setOfflineOnTabClose(m.offlineOnTabClose !== false);
    setOfflineGraceMs(m.offlineGraceMs ?? 5000);
    setSyncedFromServer(true);
  }, [bridgeStatus, syncedFromServer]);

  const handleSaveCamera = async (e: React.FormEvent) => {
    e.preventDefault();
    setCamSaving(true);
    setCamNotice(null);
    try {
      const res = await apiFetch('/api/settings/camera', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          host: camHost,
          port: camPort,
          path: camPath,
          user: camUser,
          password: camPassword, // Write-only; cleared immediately after submit
          streamProfile,
          targetFps,
          scaleWidth,
        }),
      });
      const data = (await res.json()) as { ok?: boolean; error?: string };
      if (!res.ok || !data.ok) {
        setCamNotice({ ok: false, text: data.error || 'Failed to save camera settings.' });
      } else {
        setCamPassword(''); // Never retain password in browser state
        setCamNotice({ ok: true, text: 'Camera settings applied on bridge. Credentials masked.' });
        await onStatusUpdated();
      }
    } catch {
      setCamNotice({ ok: false, text: 'Could not reach bridge server.' });
    } finally {
      setCamSaving(false);
    }
  };

  const handleTestCamera = async () => {
    setTestingCamera(true);
    setTestResult(null);
    try {
      const res = await apiFetch('/api/camera/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          host: camHost,
          port: camPort,
          path: camPath,
          user: camUser,
          password: camPassword,
        }),
      });
      const data = (await res.json()) as CameraTestResult;
      setTestResult(data);
    } catch {
      setTestResult({
        ok: false,
        code: 'network_error',
        message: 'Unable to reach bridge /api/camera/test endpoint.',
      });
    } finally {
      setTestingCamera(false);
    }
  };

  const handleSaveMqtt = async (e: React.FormEvent) => {
    e.preventDefault();
    setMqttSaving(true);
    setMqttNotice(null);
    try {
      const payload: PersistedMqttPrefs = {
        host: mqttHost,
        port: mqttPort,
        topic: mqttTopic,
        useLocalhostFallback,
        clearOldTopicOnChange,
        offlineOnTabClose,
        offlineGraceMs,
      };
      const res = await apiFetch('/api/settings/mqtt', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = (await res.json()) as { ok?: boolean; error?: string };
      if (!res.ok || !data.ok) {
        setMqttNotice({ ok: false, text: data.error || 'Failed to update MQTT settings.' });
      } else {
        onMqttPrefsSaved(payload);
        setMqttNotice({ ok: true, text: 'MQTT configuration applied — bridge reconnecting.' });
        await onStatusUpdated();
      }
    } catch {
      setMqttNotice({ ok: false, text: 'Could not reach bridge server.' });
    } finally {
      setMqttSaving(false);
    }
  };

  return (
    <div className="space-y-6">
      {/* LAN Access Token prompt (only highlighted if server requires ACCESS_TOKEN) */}
      {authRequired && (
        <div className="liquid-glass rounded-2xl p-5 border-amber-300/80 bg-amber-50/70">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div className="flex items-start gap-3">
              <KeyRound className="h-5 w-5 text-amber-700 mt-0.5 shrink-0" aria-hidden="true" />
              <div>
                <h2 className="text-sm font-semibold text-amber-950">
                  Bridge Access Token Required
                </h2>
                <p className="text-xs text-amber-900">
                  This bridge has <code className="font-mono-tabular">ACCESS_TOKEN</code> enabled
                  for LAN protection. Enter the token below (kept in memory only).
                </p>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <input
                type="password"
                value={tokenInput}
                onChange={(e) => setTokenInput(e.target.value)}
                placeholder="Enter access token"
                className="glass-input rounded-xl px-3 py-2 text-xs text-slate-900"
              />
              <button
                type="button"
                onClick={() => onSetAccessToken(tokenInput.trim())}
                className="pastel-3d-btn rounded-xl px-4 py-2 text-xs font-semibold cursor-pointer whitespace-nowrap"
              >
                Unlock Bridge
              </button>
            </div>
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2 items-start">
        {/* Camera RTSP Settings Panel */}
        <form onSubmit={handleSaveCamera} className="liquid-glass rounded-2xl p-6 space-y-5">
          <div className="flex items-start justify-between gap-4">
            <div className="flex items-center gap-2.5">
              <Video className="h-5 w-5 text-indigo-600" aria-hidden="true" />
              <div>
                <h2 className="text-base font-semibold text-slate-900">
                  5MP PoE IP Camera (RTSP Bridge)
                </h2>
                <p className="text-xs text-slate-500">
                  TCP transport enforced. Credentials are stored server-side only and masked in all responses.
                </p>
              </div>
            </div>
          </div>

          {bridgeStatus?.cameraConfig.maskedUrl && (
            <div className="rounded-xl bg-white/60 border border-white/85 px-3.5 py-2.5 text-xs">
              <span className="text-slate-500">Active masked URI: </span>
              <span className="font-mono-tabular text-slate-800 break-all">
                {bridgeStatus.cameraConfig.maskedUrl}
              </span>
            </div>
          )}

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <div className="sm:col-span-2 space-y-1">
              <label htmlFor="cam-host" className="text-xs font-medium text-slate-700">
                Camera IP / Hostname
              </label>
              <input
                id="cam-host"
                type="text"
                value={camHost}
                onChange={(e) => setCamHost(e.target.value)}
                placeholder="192.168.1.100"
                className="glass-input w-full rounded-xl px-3 py-2 text-sm font-mono-tabular text-slate-900"
              />
            </div>

            <div className="space-y-1">
              <label htmlFor="cam-port" className="text-xs font-medium text-slate-700">
                RTSP Port
              </label>
              <input
                id="cam-port"
                type="number"
                min={1}
                max={65535}
                value={camPort}
                onChange={(e) => setCamPort(Number(e.target.value))}
                className="glass-input w-full rounded-xl px-3 py-2 text-sm font-mono-tabular text-slate-900"
              />
            </div>
          </div>

          <div className="space-y-1">
            <label htmlFor="cam-path" className="text-xs font-medium text-slate-700">
              Sub-Stream RTSP Path
            </label>
            <input
              id="cam-path"
              type="text"
              value={camPath}
              onChange={(e) => setCamPath(e.target.value)}
              placeholder="/h264Preview_01_sub"
              className="glass-input w-full rounded-xl px-3 py-2 text-sm font-mono-tabular text-slate-900"
            />
            <p className="text-[11px] text-slate-500">
              Examples (verify in camera manual): Reolink{' '}
              <code className="font-mono-tabular">/h264Preview_01_sub</code> · Hikvision{' '}
              <code className="font-mono-tabular">/Streaming/Channels/102</code> · Dahua{' '}
              <code className="font-mono-tabular">/cam/realmonitor?channel=1&amp;subtype=1</code>
            </p>
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div className="space-y-1">
              <label htmlFor="cam-user" className="text-xs font-medium text-slate-700">
                View-Only Username
              </label>
              <input
                id="cam-user"
                type="text"
                autoComplete="off"
                value={camUser}
                onChange={(e) => setCamUser(e.target.value)}
                placeholder="roomviewer (never admin)"
                className="glass-input w-full rounded-xl px-3 py-2 text-sm text-slate-900"
              />
            </div>

            <div className="space-y-1">
              <label htmlFor="cam-pass" className="text-xs font-medium text-slate-700">
                Password (write-only)
              </label>
              <input
                id="cam-pass"
                type="password"
                autoComplete="new-password"
                value={camPassword}
                onChange={(e) => setCamPassword(e.target.value)}
                placeholder={
                  bridgeStatus?.cameraConfig.hasPassword
                    ? 'Stored on server (leave blank to keep)'
                    : 'Enter view-only password'
                }
                className="glass-input w-full rounded-xl px-3 py-2 text-sm text-slate-900"
              />
            </div>
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <div className="space-y-1">
              <label htmlFor="cam-profile" className="text-xs font-medium text-slate-700">
                Stream Profile
              </label>
              <select
                id="cam-profile"
                value={streamProfile}
                onChange={(e) => setStreamProfile(e.target.value as StreamProfile)}
                className="glass-input w-full rounded-xl px-3 py-2 text-xs text-slate-900"
              >
                <option value="sub">Sub Stream (inference)</option>
                <option value="main">Main Stream (≤1280px)</option>
              </select>
            </div>

            <div className="space-y-1">
              <label htmlFor="cam-fps" className="text-xs font-medium text-slate-700">
                Target FPS
              </label>
              <input
                id="cam-fps"
                type="number"
                min={1}
                max={30}
                value={targetFps}
                onChange={(e) => setTargetFps(Number(e.target.value))}
                className="glass-input w-full rounded-xl px-3 py-2 text-sm font-mono-tabular text-slate-900"
              />
            </div>

            <div className="space-y-1">
              <label htmlFor="cam-width" className="text-xs font-medium text-slate-700">
                Scale Width (px)
              </label>
              <select
                id="cam-width"
                value={scaleWidth}
                onChange={(e) => setScaleWidth(Number(e.target.value))}
                className="glass-input w-full rounded-xl px-3 py-2 text-xs font-mono-tabular text-slate-900"
              >
                <option value={480}>480 px</option>
                <option value={640}>640 px (recommended)</option>
                <option value={960}>960 px</option>
                {streamProfile === 'main' && <option value={1280}>1280 px (main max)</option>}
              </select>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-3 pt-1">
            <button
              type="submit"
              disabled={camSaving}
              className="pastel-3d-btn rounded-xl px-4 py-2.5 text-xs font-semibold cursor-pointer whitespace-nowrap"
            >
              {camSaving ? 'Applying…' : 'Save & Apply Camera'}
            </button>

            <button
              type="button"
              disabled={testingCamera}
              onClick={() => void handleTestCamera()}
              className="glass-btn inline-flex items-center gap-1.5 rounded-xl px-4 py-2.5 text-xs font-semibold text-slate-800 cursor-pointer whitespace-nowrap"
            >
              <RefreshCw
                className={`h-3.5 w-3.5 ${testingCamera ? 'animate-spin' : ''}`}
                aria-hidden="true"
              />
              {testingCamera ? 'Probing RTSP…' : 'Test Connection'}
            </button>
          </div>

          {camNotice && (
            <p className={`text-xs font-medium ${camNotice.ok ? 'text-teal-700' : 'text-rose-700'}`}>
              {camNotice.text}
            </p>
          )}

          {testResult && (
            <div
              className={`rounded-xl border p-3.5 text-xs space-y-1 ${
                testResult.ok
                  ? 'bg-teal-50/85 border-teal-200 text-teal-950'
                  : 'bg-rose-50/85 border-rose-200 text-rose-950'
              }`}
            >
              <div className="flex items-center gap-2 font-semibold">
                {testResult.ok ? (
                  <CheckCircle2 className="h-4 w-4 text-teal-600 shrink-0" aria-hidden="true" />
                ) : (
                  <XCircle className="h-4 w-4 text-rose-600 shrink-0" aria-hidden="true" />
                )}
                <span>
                  {testResult.ok ? 'RTSP Probe Succeeded' : `Probe Failed (${testResult.code})`}
                </span>
              </div>
              <p>{testResult.message}</p>
              {testResult.ok && (
                <p className="font-mono-tabular text-[11px] text-teal-800">
                  Codec: {testResult.codec || 'unknown'} · Resolution: {testResult.width || '?'}×
                  {testResult.height || '?'} · FPS: {testResult.fps || '?'}
                </p>
              )}
            </div>
          )}
        </form>

        {/* MQTT Broker Settings Panel */}
        <form onSubmit={handleSaveMqtt} className="liquid-glass rounded-2xl p-6 space-y-5">
          <div className="flex items-center gap-2.5">
            <Radio className="h-5 w-5 text-teal-600" aria-hidden="true" />
            <div>
              <h2 className="text-base font-semibold text-slate-900">
                MQTT Broker & Telemetry Publishing
              </h2>
              <p className="text-xs text-slate-500">
                QoS 0, retained publishes, LWT offline packet. Changes reconnect the bridge MQTT client.
              </p>
            </div>
          </div>

          {bridgeStatus?.mqttConfig && (
            <div className="rounded-xl bg-white/60 border border-white/85 px-3.5 py-2.5 text-xs space-y-1">
              <div>
                <span className="text-slate-500">Active target: </span>
                <span className="font-mono-tabular text-slate-900">
                  mqtt://{bridgeStatus.mqttConfig.activeHost}:{bridgeStatus.mqttConfig.port}
                </span>
              </div>
              <div>
                <span className="text-slate-500">Client ID: </span>
                <span className="font-mono-tabular text-slate-700">
                  {bridgeStatus.mqttConfig.clientId || 'connecting…'}
                </span>
              </div>
              {bridgeStatus.brokerError && (
                <p className="text-rose-700 font-medium pt-0.5">{bridgeStatus.brokerError}</p>
              )}
            </div>
          )}

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <div className="sm:col-span-2 space-y-1">
              <label htmlFor="mqtt-host" className="text-xs font-medium text-slate-700">
                Broker Host
              </label>
              <input
                id="mqtt-host"
                type="text"
                value={mqttHost}
                onChange={(e) => setMqttHost(e.target.value)}
                disabled={useLocalhostFallback}
                placeholder="rasticvm.internal"
                className="glass-input w-full rounded-xl px-3 py-2 text-sm font-mono-tabular text-slate-900 disabled:opacity-55"
              />
            </div>

            <div className="space-y-1">
              <label htmlFor="mqtt-port" className="text-xs font-medium text-slate-700">
                Port
              </label>
              <input
                id="mqtt-port"
                type="number"
                min={1}
                max={65535}
                value={mqttPort}
                onChange={(e) => setMqttPort(Number(e.target.value))}
                className="glass-input w-full rounded-xl px-3 py-2 text-sm font-mono-tabular text-slate-900"
              />
            </div>
          </div>

          <div className="space-y-1">
            <label htmlFor="mqtt-topic" className="text-xs font-medium text-slate-700">
              Publish Topic
            </label>
            <input
              id="mqtt-topic"
              type="text"
              value={mqttTopic}
              onChange={(e) => setMqttTopic(e.target.value)}
              placeholder="room/activity/status"
              className="glass-input w-full rounded-xl px-3 py-2 text-sm font-mono-tabular text-slate-900"
            />
          </div>

          <div className="space-y-3 pt-1">
            <label className="flex items-start gap-3 cursor-pointer">
              <input
                type="checkbox"
                checked={useLocalhostFallback}
                onChange={(e) => setUseLocalhostFallback(e.target.checked)}
                className="mt-0.5 h-4 w-4 rounded border-slate-300 text-indigo-600 focus:ring-indigo-500"
              />
              <div>
                <span className="text-xs font-semibold text-slate-800">
                  Use localhost fallback (localhost:1883)
                </span>
                <p className="text-[11px] text-slate-500">
                  One-toggle switch for local Mosquitto testing when rasticvm.internal is unreachable.
                </p>
              </div>
            </label>

            <label className="flex items-start gap-3 cursor-pointer">
              <input
                type="checkbox"
                checked={clearOldTopicOnChange}
                onChange={(e) => setClearOldTopicOnChange(e.target.checked)}
                className="mt-0.5 h-4 w-4 rounded border-slate-300 text-indigo-600 focus:ring-indigo-500"
              />
              <div>
                <span className="text-xs font-semibold text-slate-800">
                  Clear old topic retained message on topic change
                </span>
                <p className="text-[11px] text-slate-500">
                  Publishes an empty retained payload to the previous topic before reconnecting.
                </p>
              </div>
            </label>

            <label className="flex items-start gap-3 cursor-pointer">
              <input
                type="checkbox"
                checked={offlineOnTabClose}
                onChange={(e) => setOfflineOnTabClose(e.target.checked)}
                className="mt-0.5 h-4 w-4 rounded border-slate-300 text-indigo-600 focus:ring-indigo-500"
              />
              <div>
                <span className="text-xs font-semibold text-slate-800">
                  Publish offline when dashboard closes (grace period: {Math.round(offlineGraceMs / 1000)}s)
                </span>
                <p className="text-[11px] text-slate-500">
                  Waits {offlineGraceMs} ms after WebSocket disconnect so page refreshes do not flap status.
                </p>
              </div>
            </label>
          </div>

          <div className="flex flex-wrap items-center gap-3 pt-1">
            <button
              type="submit"
              disabled={mqttSaving}
              className="pastel-3d-btn rounded-xl px-4 py-2.5 text-xs font-semibold cursor-pointer whitespace-nowrap"
            >
              {mqttSaving ? 'Reconnecting…' : 'Save & Reconnect Broker'}
            </button>
          </div>

          {mqttNotice && (
            <p className={`text-xs font-medium ${mqttNotice.ok ? 'text-teal-700' : 'text-rose-700'}`}>
              {mqttNotice.text}
            </p>
          )}

          <div className="border-t border-slate-200/70 pt-4 flex items-start gap-2.5 text-[11px] text-slate-500">
            <ShieldCheck className="h-4 w-4 text-teal-600 shrink-0 mt-0.5" aria-hidden="true" />
            <span>
              Security note: Keep the camera on a dedicated lab LAN or camera VLAN. Never expose
              RTSP port 554 to the internet, and set <code className="font-mono-tabular">ACCESS_TOKEN</code> in{' '}
              <code className="font-mono-tabular">.env</code> if binding the bridge beyond{' '}
              <code className="font-mono-tabular">127.0.0.1</code>.
            </span>
          </div>
        </form>
      </div>
    </div>
  );
}
