import 'dotenv/config';
import crypto from 'node:crypto';
import mqtt from 'mqtt';

const useFallback = process.env.BROKER_FALLBACK === 'true';
const host = useFallback ? 'localhost' : process.env.BROKER_HOST || 'rasticvm.internal';
const port = Number.parseInt(process.env.BROKER_PORT || '1883', 10) || 1883;
const topic = process.env.TOPIC || 'room/activity/status';
const brokerUrl = `mqtt://${host}:${port}`;

const clientId = `rastic-room-subscriber-${crypto.randomBytes(3).toString('hex')}`;
let lastStatus: string | null = null;
let receivedFirst = false;

console.log(`[subscriber] Connecting to ${brokerUrl} as ${clientId}...`);
console.log(`[subscriber] Subscribing to topic: ${topic}`);

const client = mqtt.connect(brokerUrl, {
  clientId,
  reconnectPeriod: 2000,
  connectTimeout: 5000,
  clean: true,
});

client.on('connect', () => {
  console.log(`[subscriber] Connected at ${new Date().toISOString()}`);
  client.subscribe(topic, { qos: 0 }, (err) => {
    if (err) {
      console.error(`[subscriber] Subscribe error: ${err.message}`);
    } else {
      console.log(`[subscriber] Listening for retained and live updates on "${topic}"...\n`);
    }
  });
});

client.on('message', (msgTopic, payloadBuf, packet) => {
  const receivedAt = new Date().toISOString();
  const raw = payloadBuf.toString('utf8').trim();
  const retainedTag = packet.retain ? ' [RETAINED]' : '';

  if (!raw) {
    console.log(`${receivedAt}${retainedTag} (${msgTopic}) <empty retained payload — topic cleared>`);
    return;
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    console.log(`${receivedAt}${retainedTag} (${msgTopic}) Non-JSON payload: ${raw}`);
    return;
  }

  // Tolerate missing fields (e.g. compact offline packets)
  const roomStatus = typeof parsed.room_status === 'string' ? parsed.room_status : 'unknown';
  const total = typeof parsed.total_people === 'number' ? parsed.total_people : '-';
  const calm = typeof parsed.calm_count === 'number' ? parsed.calm_count : '-';
  const chaotic = typeof parsed.chaotic_count === 'number' ? parsed.chaotic_count : '-';
  const reason = typeof parsed.reason === 'string' ? ` (reason: ${parsed.reason})` : '';

  const isStatusChange = lastStatus !== null && lastStatus !== roomStatus;
  if (!receivedFirst && packet.retain) {
    console.log(`${receivedAt} *** RETAINED STARTUP DELIVERY ***`);
  }
  receivedFirst = true;

  if (isStatusChange) {
    console.log(
      `\n>>> STATUS CHANGE: ${lastStatus?.toUpperCase()} -> ${roomStatus.toUpperCase()} at ${receivedAt} <<<`,
    );
  }
  lastStatus = roomStatus;

  console.log(
    `${receivedAt}${retainedTag} | status=${roomStatus}${reason} | total=${total} calm=${calm} chaotic=${chaotic}`,
  );
  console.log(`  raw: ${raw}`);
});

client.on('error', (err: Error & { code?: string | number }) => {
  if (err.code === 'ENOTFOUND' || err.code === 'EAI_AGAIN') {
    console.error(
      `[subscriber] DNS error resolving "${host}". Try BROKER_FALLBACK=true npm run subscribe for localhost:1883.`,
    );
  } else {
    console.error(`[subscriber] Connection error: ${err.message}`);
  }
});

process.on('SIGINT', () => {
  console.log('\n[subscriber] Disconnecting...');
  client.end(true, () => process.exit(0));
});
