export function LabGuideView() {
  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
      <section className="liquid-glass rounded-2xl p-6 space-y-4">
        <h2 className="text-lg font-semibold text-slate-900">
          01. PoE Turret Wiring & Mounting Guidance
        </h2>
        <div className="space-y-3 text-sm text-slate-700 leading-relaxed">
          <p>
            Connect the 5 MP turret IP camera over wired Ethernet to an{' '}
            <strong>802.3af PoE switch</strong> or injector on the same lab LAN/VLAN as the bridge
            host and MQTT broker. Assign a static IP or DHCP reservation, and create a dedicated{' '}
            <strong>view-only camera user</strong> (never use the admin account).
          </p>
          <ul className="list-disc pl-5 space-y-1.5 text-xs text-slate-600">
            <li>
              <strong>Height & angle:</strong> Mount at <strong>2.2–3.0 m</strong> tilted obliquely
              into the room. Steep top-down views hurt <code className="font-mono-tabular">coco-ssd</code>{' '}
              accuracy and make bounding-box height a weak distance normalizer.
            </li>
            <li>
              <strong>Sub stream (inference):</strong> Configure{' '}
              <code className="font-mono-tabular">640×360</code> or{' '}
              <code className="font-mono-tabular">640×480</code>, 10–15 fps, H.264, 512–1024 kbps,
              with keyframe interval equal to FPS. Disable camera OSD watermarks.
            </li>
            <li>
              <strong>IR night mode:</strong> Grayscale night frames yield slightly lower scores —
              drop <em>Detection confidence</em> from 0.55 to ~0.45 and mask bright windows or TVs
              using <strong>Draw Ignore Zone</strong>.
            </li>
          </ul>
        </div>
      </section>

      <section className="liquid-glass rounded-2xl p-6 space-y-4">
        <h2 className="text-lg font-semibold text-slate-900">
          02. Local Mosquitto & CLI Test Commands
        </h2>
        <div className="space-y-3 text-xs text-slate-700">
          <p>Start a local anonymous Mosquitto broker for offline testing:</p>
          <pre className="overflow-x-auto rounded-xl bg-white/80 border border-slate-200/80 p-3 font-mono-tabular text-[11px] text-slate-800">
{`docker run --rm -it -p 1883:1883 eclipse-mosquitto:2 \\
  sh -c 'printf "listener 1883\\nallow_anonymous true\\n" > /tmp/m.conf && mosquitto -c /tmp/m.conf'`}
          </pre>

          <p>Run the included CLI tools from the project root:</p>
          <pre className="overflow-x-auto rounded-xl bg-white/80 border border-slate-200/80 p-3 font-mono-tabular text-[11px] text-slate-800">
{`npm run test:camera   # Probe CAMERA_RTSP_URL (codec, res, fps, 401/404)
npm run subscribe     # Live MQTT subscriber with retained startup check
npm test              # Pure unit tests (EMA, ROI, tracking, hysteresis)`}
          </pre>
        </div>
      </section>

      <section className="liquid-glass rounded-2xl p-6 space-y-4">
        <h2 className="text-lg font-semibold text-slate-900">
          03. Fake RTSP Stream (MediaMTX + ffmpeg)
        </h2>
        <div className="space-y-3 text-xs text-slate-700">
          <p>
            Exercise the real <code className="font-mono-tabular">ffmpeg</code> TCP RTSP-to-MJPEG
            pipeline and watchdog locally without a physical PoE camera:
          </p>
          <pre className="overflow-x-auto rounded-xl bg-white/80 border border-slate-200/80 p-3 font-mono-tabular text-[11px] text-slate-800">
{`# Terminal 1: Start MediaMTX RTSP server
docker run --rm -it -p 8554:8554 bluenviron/mediamtx:latest

# Terminal 2: Loop a recorded room video into RTSP
ffmpeg -re -stream_loop -1 -i room-sample.mp4 \\
  -c:v libx264 -preset ultrafast -f rtsp -rtsp_transport tcp \\
  rtsp://127.0.0.1:8554/sub`}
          </pre>
        </div>
      </section>

      <section className="liquid-glass rounded-2xl p-6 space-y-4">
        <h2 className="text-lg font-semibold text-slate-900">
          04. ESP32 / Arduino MQTT Consumer Snippet
        </h2>
        <div className="space-y-3 text-xs text-slate-700">
          <p>
            Subscribers must tolerate missing fields on compact{' '}
            <code className="font-mono-tabular">{`{"room_status":"offline"}`}</code> packets:
          </p>
          <pre className="overflow-x-auto rounded-xl bg-white/80 border border-slate-200/80 p-3 font-mono-tabular text-[11px] text-slate-800">
{`StaticJsonDocument<1024> doc;
if (!deserializeJson(doc, payload, length)) {
  const char* status = doc["room_status"] | "offline";
  int total = doc["total_people"] | 0;
  // Drive LEDs, signage, or HVAC relay based on status
}`}
          </pre>
        </div>
      </section>
    </div>
  );
}
