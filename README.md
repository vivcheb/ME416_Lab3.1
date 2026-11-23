# Lumina Room Tracker (5MP PoE AI Turret Camera)

Real-time room occupancy and activity telemetry web application and Node.js MQTT bridge for 5-megapixel PoE AI turret IP cameras (wired Ethernet, RTSP/ONVIF).

---

## Quick Start

```bash
npm install
cp .env.example .env
# Edit .env with your view-only camera RTSP URL and MQTT broker settings
npm run build
npm start
```

Open `http://localhost:3000`. In development mode with live Vite middleware, run `npm run dev`.

---

## 1. PoE Wiring, Static IP & View-Only Camera Account

1. **Power & Network**: Connect your 5 MP turret camera via Cat5e/Cat6 Ethernet to an **802.3af PoE switch** or PoE injector on the same lab LAN (or routed camera VLAN) as the host running this app and the MQTT broker.
2. **Static IP / DHCP Reservation**: Assign a static IP or router DHCP reservation (e.g., `192.168.1.100`) so the RTSP endpoint never changes after a reboot.
3. **Create a Dedicated View-Only User**:
   - In the camera's web admin panel, create a dedicated non-admin account (e.g., `roomviewer`) with **Live View / RTSP** permissions only.
   - **Never** use the camera's `admin` account in `.env`.
   - URL-encode special characters in the password (`@` -> `%40`, `:` -> `%3A`, `#` -> `%23`).
4. **Never Expose RTSP to the Internet**: Keep port 554 strictly inside the lab LAN or dedicated camera VLAN.

---

## 2. Finding Your Camera's RTSP Path & Recommended Stream Settings

RTSP paths vary by manufacturer — confirm the exact URI in your camera manual:

| Manufacturer | Example Sub-Stream Path (verify in manual) |
| :--- | :--- |
| **Reolink** | `/h264Preview_01_sub` |
| **Hikvision** | `/Streaming/Channels/102` |
| **Dahua / Amcrest** | `/cam/realmonitor?channel=1&subtype=1` |

### Recommended Camera Encoder Settings

- **Sub stream (used for browser inference)**: `640×360` or `640×480`, **10–15 fps**, **H.264**, `512–1024 kbps`, keyframe interval (I-frame) equal to frame rate.
- **Main stream (5 MP)**: Never decoded directly in the browser. If you enable High-Res Display mode, the Node bridge downscales it server-side with `ffmpeg` to at most `1280px` wide while keeping inference lightweight.
- **Image hygiene**: Disable camera OSD timestamps/watermarks where possible, and prefer a fixed exposure ceiling over aggressive auto-exposure so motion blur stays consistent.

---

## 3. Mounting Guidance (Accuracy Impact)

- **Height & Tilt**: Mount at **2.2–3.0 m**, angled obliquely across the room rather than straight top-down. Steep overhead angles degrade `coco-ssd` person detection and make bounding-box height a poor distance proxy.
- **Backlight & Screens**: Avoid pointing directly at bright windows, mirrors, or TV screens (or mask them with **Draw Ignore Zone**).
- **IR Night Mode**: Grayscale infrared footage slightly lowers person confidence scores; consider lowering **Detection Confidence** from `0.55` to `0.45` in dark rooms.
- **Barrel Distortion**: Wide-angle turret lenses exhibit mild edge distortion; no dewarping is required, though distance-normalized movement thresholds are most accurate near the central 80% of the frame.

---

## 4. Installing `ffmpeg` & Testing Camera Connectivity

The bridge spawns `ffmpeg` over TCP (`-rtsp_transport tcp -fflags nobuffer -flags low_delay -an`) to eliminate packet loss on Wi-Fi-bridged lab networks.

- **Linux / Ubuntu**: `sudo apt update && sudo apt install -y ffmpeg`
- **macOS**: `brew install ffmpeg`
- **Alternative (`ffmpeg-static`)**: `npm install ffmpeg-static` and set `FFMPEG_PATH=./node_modules/ffmpeg-static/ffmpeg` in `.env`.

### Test Camera from CLI

```bash
npm run test:camera
```

Reports authentication failures (`401`), bad RTSP path (`404`), timeouts, or the stream's actual codec, resolution, and frame rate without printing credentials.

### Fake RTSP Stream for Development (MediaMTX + ffmpeg)

Test the full RTSP -> ffmpeg -> MJPEG pipeline without a physical camera:

```bash
# 1. Start MediaMTX RTSP server on port 8554
docker run --rm -it -p 8554:8554 bluenviron/mediamtx:latest

# 2. Loop any local MP4 test clip as an RTSP stream
ffmpeg -re -stream_loop -1 -i sample-room.mp4 -c:v libx264 -preset ultrafast -f rtsp -rtsp_transport tcp rtsp://127.0.0.1:8554/sub

# 3. Set CAMERA_RTSP_URL=rtsp://127.0.0.1:8554/sub in .env and start the bridge
```

*(Optional lower-latency transport: for sub-250ms WebRTC display, you can front the camera with `go2rtc` or `MediaMTX`, while keeping the same-origin `/stream.mjpg` default for untainted canvas inference.)*

---

## 5. Offline Model Bundling, HTTPS & Foreground Tab Notes

- **Offline-Capable Runtime**: `@tensorflow/tfjs`, `@tensorflow-models/coco-ssd`, and UI fonts (`@fontsource/*`) are installed locally via npm. To serve `coco-ssd` weights 100% offline with zero external requests, place `model.json` and shard binaries under:
  - `public/models/lite_mobilenet_v2/model.json`
  - `public/models/mobilenet_v2/model.json`
  The browser automatically loads `/models/<modelBase>/model.json` first.
- **Secure Context (HTTPS)**: Opening on `http://localhost:3000` is a secure context (local webcam works). When accessing the dashboard from another machine on the LAN, terminate TLS with a reverse proxy (Caddy/nginx) or local mkcert certificate so `navigator.mediaDevices` remains available, and set `ACCESS_TOKEN` in `.env`.
- **Foreground Tab Requirement**: Browsers throttle `requestAnimationFrame` and timers in background tabs, pausing detection. Keep the dashboard tab visible or run it in its own dedicated window.

---

## 6. MQTT Packet Schema, Local Mosquitto Testing & ESP32 Consumer

### Packet Schema (Published to `TOPIC`, default `room/activity/status`, QoS 0, `retain: true`)

Coordinates `x` and `y` are integers in processed stream pixels (un-mirrored, origin top-left). Multiply by `main_width / frame.width` if converting to 5 MP coordinates.

```json
{
  "timestamp": "2026-11-18T19:30:00.000Z",
  "room_status": "calm",
  "total_people": 4,
  "calm_count": 3,
  "chaotic_count": 1,
  "frame": { "width": 640, "height": 360 },
  "occupants": [
    { "id": 1, "x": 320, "y": 240, "norm_disp": 0.03, "state": "calm" }
  ]
}
```

Offline packets (LWT, clean `SIGINT`/`SIGTERM`, tab closed past grace period, or camera lost > 10 s):

```json
{ "room_status": "offline", "reason": "camera_lost" }
```

### Run a Local Mosquitto Broker (Offline Testing)

```bash
docker run --rm -it -p 1883:1883 eclipse-mosquitto:2 \
  sh -c 'printf "listener 1883\nallow_anonymous true\n" > /tmp/m.conf && mosquitto -c /tmp/m.conf'
```

Toggle **Use localhost fallback** in the UI (or set `BROKER_FALLBACK=true` in `.env`), then run the test subscriber:

```bash
npm run subscribe
```

### ESP32 / Arduino Subscriber Snippet

```cpp
#include <ArduinoJson.h>
// Inside PubSubClient callback(char* topic, byte* payload, unsigned int length):
StaticJsonDocument<1024> doc;
if (!deserializeJson(doc, payload, length)) {
  const char* status = doc["room_status"] | "offline";
  int total = doc["total_people"] | 0; // Tolerate missing fields on offline packets
  if (strcmp(status, "chaotic") == 0) {
    // Trigger alert LED / actuator
  }
}
```

---

## 7. Running Unit Tests

```bash
npm test
```

Covers EMA smoothing, ray-casting point-in-polygon, track matching and 1s grace period, 3-frame confirmation, hysteresis state hold, room status (`empty`, `calm`, `chaotic`, `tie`) with debounce, stream stall guard, packet schema validation, and RTSP credential masking.

---

## 8. Troubleshooting

- **Wrong RTSP Path (404)**: Run `npm run test:camera` and confirm sub-stream URI in camera manual.
- **401 Auth Errors**: Confirm view-only user permissions and URL-encode special characters in password.
- **Stream Lag**: Reduce sub-stream keyframe interval to match FPS (`15`), lower `STREAM_WIDTH` to `480` or `640`, and confirm TCP transport.
- **H.265 Not Decoding**: Switch camera sub-stream codec from H.265/HEVC to **H.264** (or ensure host `ffmpeg` includes `hevc` decoder).
- **`rasticvm.internal` Not Resolving**: Confirm host is on the lab VLAN/DNS, or click **Use localhost fallback** in the MQTT settings panel.
- **WebGL Fallback (CPU Warning)**: Enable hardware acceleration in browser flags or switch model to `lite_mobilenet_v2` and width to `480px`.
- **Background-Tab Throttling**: Keep the dashboard in a visible dedicated window so browser timers do not pause detection.
