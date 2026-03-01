import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import type { PairedDevice } from './types.js';

const PAIRED_DEVICES_FILE = 'paired-devices.json';
const STATE_FILE = 'state.json';

export class PluginStorage {
  private dataDir: string;

  constructor(baseDir: string) {
    this.dataDir = join(baseDir, '.clawhouse');
    if (!existsSync(this.dataDir)) {
      mkdirSync(this.dataDir, { recursive: true });
    }
  }

  // ---------------------------------------------------------------------------
  // Paired devices
  // ---------------------------------------------------------------------------

  loadPairedDevices(): Map<string, PairedDevice> {
    const filePath = join(this.dataDir, PAIRED_DEVICES_FILE);
    if (!existsSync(filePath)) {
      return new Map();
    }

    try {
      const raw = readFileSync(filePath, 'utf-8');
      const records: PairedDevice[] = JSON.parse(raw);
      const map = new Map<string, PairedDevice>();
      for (const device of records) {
        map.set(device.deviceId, device);
      }
      return map;
    } catch {
      return new Map();
    }
  }

  savePairedDevices(devices: Map<string, PairedDevice>): void {
    const filePath = join(this.dataDir, PAIRED_DEVICES_FILE);
    const records = Array.from(devices.values());
    writeFileSync(filePath, JSON.stringify(records, null, 2), 'utf-8');
  }

  addPairedDevice(device: PairedDevice): void {
    const devices = this.loadPairedDevices();
    devices.set(device.deviceId, device);
    this.savePairedDevices(devices);
  }

  updatePairedDevice(deviceId: string, updates: Partial<PairedDevice>): boolean {
    const devices = this.loadPairedDevices();
    const existing = devices.get(deviceId);
    if (!existing) return false;
    devices.set(deviceId, { ...existing, ...updates });
    this.savePairedDevices(devices);
    return true;
  }

  removePairedDevice(deviceId: string): boolean {
    const devices = this.loadPairedDevices();
    const removed = devices.delete(deviceId);
    if (removed) {
      this.savePairedDevices(devices);
    }
    return removed;
  }

  getPairedDevice(deviceId: string): PairedDevice | undefined {
    return this.loadPairedDevices().get(deviceId);
  }

  listPairedDevices(): PairedDevice[] {
    return Array.from(this.loadPairedDevices().values());
  }

  // ---------------------------------------------------------------------------
  // Generic plugin state (arbitrary JSON blob)
  // ---------------------------------------------------------------------------

  loadState<T extends Record<string, unknown>>(defaults: T): T {
    const filePath = join(this.dataDir, STATE_FILE);
    if (!existsSync(filePath)) {
      return defaults;
    }

    try {
      const raw = readFileSync(filePath, 'utf-8');
      return { ...defaults, ...(JSON.parse(raw) as Partial<T>) };
    } catch {
      return defaults;
    }
  }

  saveState<T extends Record<string, unknown>>(state: T): void {
    const filePath = join(this.dataDir, STATE_FILE);
    writeFileSync(filePath, JSON.stringify(state, null, 2), 'utf-8');
  }

  getDevicesWithPushTokens(): PairedDevice[] {
    return this.listPairedDevices().filter(
      (d) => d.pushToken && d.pushBundleId && d.pushEnvironment,
    );
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  get dataDirectory(): string {
    return this.dataDir;
  }
}
