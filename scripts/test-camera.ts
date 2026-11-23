import 'dotenv/config';
import { maskRtspUrl, testCameraConnection } from '../server/rtsp-stream.ts';

async function main() {
  const url = (process.env.CAMERA_RTSP_URL || '').trim();
  if (!url) {
    console.error('[test:camera] CAMERA_RTSP_URL is not set in .env.');
    process.exit(1);
  }

  console.log(`[test:camera] Probing ${maskRtspUrl(url)} over RTSP/TCP...`);
  const result = await testCameraConnection(url, 8000);

  if (result.ok) {
    console.log('[test:camera] SUCCESS');
    console.log(`  URL:        ${result.maskedUrl}`);
    console.log(`  Codec:      ${result.codec ?? 'unknown'}`);
    console.log(`  Resolution: ${result.width ?? '?'}x${result.height ?? '?'}`);
    console.log(`  Frame rate: ${result.fps ?? '?'} fps`);
    process.exit(0);
  } else {
    console.error(`[test:camera] FAILED (${result.code})`);
    console.error(`  ${result.message}`);
    process.exit(1);
  }
}

void main();
