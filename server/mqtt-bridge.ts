import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import mqtt, { type MqttClient } from 'mqtt';
import type {
  BrokerConnectionState,
  MqttPublicConfig,
  OfflinePacket,
  RoomStatus,
  TelemetryPacket,
} from '../src/core/types.ts';
import { validateTelemetryPacket } from '../src/core/validation.ts';

export interface MqttBridgeOptions {
  host: string;
  port: number;
  topic: string;
  useLocalhostFallback: boolean;
  clearOldTopicOnChange: boolean;
  offlineOnTabClose: boolean;
  offlineGraceMs: number;
}

const VALID_HOST_REGEX = /^[a-zA-Z0-9._\-]{1,253}$/;

/**
 * Single authoritative MQTT client owned by the Node bridge (Section 6).
 *
 * Guarantees:
 *  - Unique clientId per connection: rastic-room-tracker-<random>
 *  - reconnectPeriod: 2000, connectTimeout: 5000, clean: true, QoS 0
 *  - Last Will & Testament: retained {"room_status":"offline"} on configured topic
 *  - Retained publishes on all status packets
 *  - Drops heartbeats when disconnected; keeps only most recent state-change packet
 *  - Publishes retained offline on clean shutdown, tab-close grace expiry, and camera_lost (>10s)
 *  - Clears old topic with empty retained payload when topic changes (configurable, default on)
 */
export class MqttBridge extends EventEmitter {
  private config: MqttBridgeOptions;
  private client: MqttClient | null = null;
  private clientId = '';
  private state: BrokerConnectionState = 'disconnected';
  private lastError: string | null = null;

  private pendingStateChangePacket: TelemetryPacket | OfflinePacket | null = null;
  private lastPublishedAt: number | null = null;
  private lastPublishedTopic: string | null = null;
  private lastPublishedStatus: RoomStatus | null = null;
  private isShuttingDown = false;

  constructor(options: MqttBridgeOptions) {
    super();
    this.config = { ...options };
  }

  public getState(): BrokerConnectionState {
    return this.state;
  }

  public getLastError(): string | null {
    return this.lastError;
  }

  public getLastPublishedMeta(): {
    lastPublishedAt: number | null;
    lastPublishedTopic: string | null;
    lastPublishedStatus: RoomStatus | null;
  } {
    return {
      lastPublishedAt: this.lastPublishedAt,
      lastPublishedTopic: this.lastPublishedTopic,
      lastPublishedStatus: this.lastPublishedStatus,
    };
  }

  public getActiveHost(): string {
    return this.config.useLocalhostFallback ? 'localhost' : this.config.host;
  }

  public getPublicConfig(): MqttPublicConfig {
    return {
      ...this.config,
      activeHost: this.getActiveHost(),
      clientId: this.clientId,
    };
  }

  public connect(): void {
    this.disconnectClientOnly();
    this.isShuttingDown = false;

    const host = this.getActiveHost();
    const port = this.config.port;
    const topic = this.config.topic;

    this.clientId = `rastic-room-tracker-${crypto.randomBytes(4).toString('hex')}`;
    const brokerUrl = `mqtt://${host}:${port}`;

    this.setState('reconnecting', null);
    this.emitLog('info', `Connecting MQTT client (${this.clientId}) to ${brokerUrl} [topic: ${topic}]`);

    const client = mqtt.connect(brokerUrl, {
      clientId: this.clientId,
      reconnectPeriod: 2000,
      connectTimeout: 5000,
      clean: true,
      will: {
        topic,
        payload: Buffer.from(JSON.stringify({ room_status: 'offline' })),
        qos: 0,
        retain: true,
      },
    });

    this.client = client;

    client.on('connect', () => {
      if (this.client !== client) return;
      this.setState('connected', null);
      this.emitLog('success', `Connected to MQTT broker at ${brokerUrl} (QoS 0, retained LWT armed).`);

      // Flush latest retained state-change packet buffered while disconnected
      if (this.pendingStateChangePacket) {
        const packet = this.pendingStateChangePacket;
        this.pendingStateChangePacket = null;
        this.publishValidated(packet, true);
      }
    });

    client.on('reconnect', () => {
      if (this.client !== client || this.isShuttingDown) return;
      this.setState('reconnecting', this.lastError);
    });

    client.on('offline', () => {
      if (this.client !== client || this.isShuttingDown) return;
      this.setState('disconnected', this.lastError || `Broker ${host}:${port} unreachable.`);
    });

    client.on('error', (err: Error & { code?: string | number }) => {
      if (this.client !== client) return;
      const code = typeof err.code === 'string' ? err.code : '';
      let friendly = err.message;
      if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') {
        friendly = `DNS lookup failed for "${host}". Enable "Use localhost fallback" or verify lab LAN DNS.`;
      } else if (code === 'ECONNREFUSED') {
        friendly = `Connection refused by ${host}:${port}. Is the MQTT broker (Mosquitto) running?`;
      } else if (code === 'ETIMEDOUT') {
        friendly = `Timed out connecting to ${host}:${port}.`;
      }
      this.setState('disconnected', friendly);
      this.emitLog('error', `MQTT broker error: ${friendly}`);
    });
  }

  /**
   * Updates MQTT settings from UI/API, optionally clearing the old topic's retained payload,
   * then reconnects with the new broker host/port/LWT topic.
   */
  public async updateConfig(next: Partial<MqttBridgeOptions>): Promise<{ ok: boolean; error?: string }> {
    const candidateHost = (next.host ?? this.config.host).trim();
    const candidatePort = Number(next.port ?? this.config.port);
    const candidateTopic = (next.topic ?? this.config.topic).trim();

    if (!candidateHost || !VALID_HOST_REGEX.test(candidateHost)) {
      return { ok: false, error: 'Invalid broker host name.' };
    }
    if (!Number.isInteger(candidatePort) || candidatePort < 1 || candidatePort > 65535) {
      return { ok: false, error: 'Broker port must be an integer between 1 and 65535.' };
    }
    if (!candidateTopic || candidateTopic.includes('#') || candidateTopic.includes('+') || /[\r\n\0]/.test(candidateTopic)) {
      return { ok: false, error: 'Topic must be a valid non-wildcard MQTT topic.' };
    }

    const oldTopic = this.config.topic;
    const topicChanged = oldTopic !== candidateTopic;
    const shouldClearOld = next.clearOldTopicOnChange ?? this.config.clearOldTopicOnChange;

    // Clear stale retained message on previous topic if requested and currently connected
    if (topicChanged && shouldClearOld && this.client?.connected) {
      await new Promise<void>((resolve) => {
        this.client!.publish(oldTopic, '', { qos: 0, retain: true }, () => {
          this.emitLog('info', `Cleared stale retained payload on previous topic "${oldTopic}".`);
          resolve();
        });
      });
    }

    this.config = {
      host: candidateHost,
      port: candidatePort,
      topic: candidateTopic,
      useLocalhostFallback: next.useLocalhostFallback ?? this.config.useLocalhostFallback,
      clearOldTopicOnChange: shouldClearOld,
      offlineOnTabClose: next.offlineOnTabClose ?? this.config.offlineOnTabClose,
      offlineGraceMs: Math.max(0, Math.min(60000, Number(next.offlineGraceMs ?? this.config.offlineGraceMs))),
    };

    this.connect();
    return { ok: true };
  }

  /**
   * Validates and publishes a browser-originated telemetry packet.
   * The bridge never invents occupancy status; invalid payloads are rejected.
   */
  public publishTelemetry(rawPayload: unknown, isStateChange: boolean): { ok: boolean; error?: string } {
    const result = validateTelemetryPacket(rawPayload);
    if (!result.valid || !result.packet) {
      this.emitLog('warn', `Rejected invalid telemetry packet: ${result.error}`);
      return { ok: false, error: result.error };
    }
    this.publishValidated(result.packet, isStateChange);
    return { ok: true };
  }

  /**
   * Publishes a retained offline status packet (used for camera_lost, tab_closed, shutdown).
   */
  public publishOffline(reason?: 'camera_lost' | 'shutdown' | 'tab_closed'): Promise<void> {
    const payload: OfflinePacket = reason
      ? { room_status: 'offline', reason }
      : { room_status: 'offline' };

    return new Promise((resolve) => {
      if (!this.client || !this.client.connected) {
        this.pendingStateChangePacket = payload;
        this.lastPublishedStatus = 'offline';
        this.emitLog(
          'warn',
          `Broker offline — buffered offline status (${reason ?? 'unspecified'}) for publish on reconnect.`,
          payload,
        );
        resolve();
        return;
      }

      const json = JSON.stringify(payload);
      this.client.publish(this.config.topic, json, { qos: 0, retain: true }, () => {
        this.lastPublishedAt = Date.now();
        this.lastPublishedTopic = this.config.topic;
        this.lastPublishedStatus = 'offline';
        this.emit('published', { topic: this.config.topic, payload, isStateChange: true });
        this.emitLog('warn', `Published retained offline (${reason ?? 'manual'}) to ${this.config.topic}`, payload);
        resolve();
      });
    });
  }

  /**
   * Clean SIGINT/SIGTERM shutdown: publishes retained offline and closes MQTT socket cleanly.
   */
  public async shutdown(): Promise<void> {
    this.isShuttingDown = true;
    if (this.client?.connected) {
      await this.publishOffline('shutdown');
    }
    await new Promise<void>((resolve) => {
      if (!this.client) {
        resolve();
        return;
      }
      const c = this.client;
      this.client = null;
      c.end(false, {}, () => resolve());
      setTimeout(resolve, 1000);
    });
  }

  private publishValidated(packet: TelemetryPacket | OfflinePacket, isStateChange: boolean): void {
    if (!this.client || !this.client.connected) {
      if (isStateChange) {
        // Keep ONLY the most recent state-change packet to publish on reconnect
        this.pendingStateChangePacket = packet;
      }
      // Drop heartbeats when disconnected (never queue stale telemetry)
      return;
    }

    const json = JSON.stringify(packet);
    this.client.publish(this.config.topic, json, { qos: 0, retain: true }, (err) => {
      if (err) {
        this.emitLog('error', `MQTT publish failed: ${err.message}`);
        return;
      }
      this.lastPublishedAt = Date.now();
      this.lastPublishedTopic = this.config.topic;
      this.lastPublishedStatus = packet.room_status;
      this.emit('published', { topic: this.config.topic, payload: packet, isStateChange });
    });
  }

  private disconnectClientOnly(): void {
    if (this.client) {
      const old = this.client;
      this.client = null;
      try {
        old.removeAllListeners();
        old.end(true);
      } catch {
        // ignore
      }
    }
  }

  private setState(nextState: BrokerConnectionState, errorMsg: string | null): void {
    const changed = this.state !== nextState || this.lastError !== errorMsg;
    this.state = nextState;
    this.lastError = errorMsg;
    if (changed) {
      this.emit('state', { state: this.state, error: this.lastError });
    }
  }

  private emitLog(level: 'info' | 'warn' | 'error' | 'success', message: string, payload?: unknown): void {
    this.emit('log', { level, message, payload });
  }
}
