import * as http2 from 'node:http2';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';

export interface APNsConfig {
  keyId: string;
  teamId: string;
  keyPath: string;
}

export interface PushPayload {
  deviceToken: string;
  bundleId: string;
  environment: 'development' | 'production';
  title: string;
  body: string;
  data?: Record<string, unknown>;
}

export class APNsSender {
  private config: APNsConfig;
  private privateKey: string;
  private cachedJWT: string | null = null;
  private cachedJWTExpiry: number = 0;

  constructor(config: APNsConfig) {
    this.config = config;
    this.privateKey = fs.readFileSync(config.keyPath, 'utf-8');
  }

  async send(payload: PushPayload): Promise<{ ok: boolean; status?: number; reason?: string }> {
    const host = payload.environment === 'production'
      ? 'api.push.apple.com'
      : 'api.sandbox.push.apple.com';

    const jwt = this.getJWT();
    const apnsPayload = JSON.stringify({
      aps: {
        alert: { title: payload.title, body: payload.body },
        sound: 'default',
        'mutable-content': 1,
      },
      ...payload.data,
    });

    return new Promise((resolve) => {
      const client = http2.connect(`https://${host}`);

      client.on('error', () => {
        resolve({ ok: false, reason: 'CONNECTION_ERROR' });
      });

      const headers: http2.OutgoingHttpHeaders = {
        ':method': 'POST',
        ':path': `/3/device/${payload.deviceToken}`,
        'authorization': `bearer ${jwt}`,
        'apns-topic': payload.bundleId,
        'apns-push-type': 'alert',
        'apns-priority': '10',
        'apns-expiration': '0',
      };

      const req = client.request(headers);
      let responseData = '';
      let statusCode = 0;

      req.on('response', (headers) => {
        statusCode = headers[':status'] as number;
      });

      req.on('data', (chunk: Buffer) => {
        responseData += chunk.toString();
      });

      req.on('end', () => {
        client.close();
        if (statusCode === 200) {
          resolve({ ok: true, status: 200 });
        } else {
          let reason = 'UNKNOWN';
          try {
            const parsed = JSON.parse(responseData);
            reason = parsed.reason ?? 'UNKNOWN';
          } catch { /* ignore parse error */ }
          resolve({ ok: false, status: statusCode, reason });
        }
      });

      req.on('error', () => {
        client.close();
        resolve({ ok: false, reason: 'REQUEST_ERROR' });
      });

      req.write(apnsPayload);
      req.end();
    });
  }

  async sendToAll(
    devices: Array<{ pushToken: string; pushBundleId: string; pushEnvironment: 'development' | 'production' }>,
    notification: { title: string; body: string; data?: Record<string, unknown> },
  ): Promise<void> {
    await Promise.allSettled(
      devices.map((device) =>
        this.send({
          deviceToken: device.pushToken,
          bundleId: device.pushBundleId,
          environment: device.pushEnvironment,
          title: notification.title,
          body: notification.body,
          data: notification.data,
        }),
      ),
    );
  }

  private getJWT(): string {
    const now = Math.floor(Date.now() / 1000);

    // Cache JWT for 50 minutes (APNs tokens valid for 60 min)
    if (this.cachedJWT && now < this.cachedJWTExpiry) {
      return this.cachedJWT;
    }

    const header = Buffer.from(JSON.stringify({
      alg: 'ES256',
      kid: this.config.keyId,
    })).toString('base64url');

    const claims = Buffer.from(JSON.stringify({
      iss: this.config.teamId,
      iat: now,
    })).toString('base64url');

    const signingInput = `${header}.${claims}`;
    const signer = crypto.createSign('SHA256');
    signer.update(signingInput);
    const derSignature = signer.sign(this.privateKey);

    // Convert DER signature to raw r||s format for ES256
    const rawSignature = this.derToRaw(derSignature);
    const signature = rawSignature.toString('base64url');

    this.cachedJWT = `${signingInput}.${signature}`;
    this.cachedJWTExpiry = now + 50 * 60; // 50 minutes

    return this.cachedJWT;
  }

  private derToRaw(derSig: Buffer): Buffer {
    // DER: 0x30 [total-len] 0x02 [r-len] [r] 0x02 [s-len] [s]
    let offset = 2; // skip 0x30 and total length
    if (derSig[1]! > 128) offset += derSig[1]! - 128;

    // Read r
    offset++; // skip 0x02
    const rLen = derSig[offset]!;
    offset++;
    let r = derSig.subarray(offset, offset + rLen);
    offset += rLen;

    // Read s
    offset++; // skip 0x02
    const sLen = derSig[offset]!;
    offset++;
    let s = derSig.subarray(offset, offset + sLen);

    // Pad or trim to 32 bytes each
    r = this.padOrTrim(r, 32);
    s = this.padOrTrim(s, 32);

    return Buffer.concat([r, s]);
  }

  private padOrTrim(buf: Buffer, length: number): Buffer {
    if (buf.length === length) return buf;
    if (buf.length > length) return buf.subarray(buf.length - length);
    const padded = Buffer.alloc(length);
    buf.copy(padded, length - buf.length);
    return padded;
  }
}
