import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { PluginStorage } from '../src/storage.js';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import type { PairedDevice } from '../src/types.js';

describe('PluginStorage', () => {
  let storage: PluginStorage;
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'clawhouse-test-'));
    storage = new PluginStorage(tempDir);
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  describe('paired devices', () => {
    const device: PairedDevice = {
      deviceId: 'test-device-001',
      deviceName: 'Jason\'s iPhone',
      platform: 'ios',
      appVersion: '0.1.0',
      pairedAt: 1700000000000,
      lastSeenAt: 1700000000000,
    };

    it('should add and retrieve a paired device', () => {
      storage.addPairedDevice(device);
      const retrieved = storage.getPairedDevice('test-device-001');
      expect(retrieved).toEqual(device);
    });

    it('should list all paired devices', () => {
      storage.addPairedDevice(device);
      storage.addPairedDevice({
        ...device,
        deviceId: 'test-device-002',
        deviceName: 'iPad',
      });

      const list = storage.listPairedDevices();
      expect(list).toHaveLength(2);
    });

    it('should update a paired device', () => {
      storage.addPairedDevice(device);
      const updated = storage.updatePairedDevice('test-device-001', {
        lastSeenAt: 1700001000000,
        deviceName: 'New Name',
      });

      expect(updated).toBe(true);
      const retrieved = storage.getPairedDevice('test-device-001');
      expect(retrieved?.lastSeenAt).toBe(1700001000000);
      expect(retrieved?.deviceName).toBe('New Name');
      // Unchanged fields should persist
      expect(retrieved?.pairedAt).toBe(1700000000000);
    });

    it('should return false when updating non-existent device', () => {
      const updated = storage.updatePairedDevice('non-existent', { lastSeenAt: 0 });
      expect(updated).toBe(false);
    });

    it('should remove a paired device', () => {
      storage.addPairedDevice(device);
      const removed = storage.removePairedDevice('test-device-001');
      expect(removed).toBe(true);
      expect(storage.getPairedDevice('test-device-001')).toBeUndefined();
    });

    it('should persist across storage instances', () => {
      storage.addPairedDevice(device);

      // Create a new storage instance pointing to the same directory
      const storage2 = new PluginStorage(tempDir);
      const retrieved = storage2.getPairedDevice('test-device-001');
      expect(retrieved).toEqual(device);
    });

    it('should store and retrieve push token', () => {
      storage.addPairedDevice(device);
      storage.updatePairedDevice('test-device-001', {
        pushToken: 'abc123token',
        pushBundleId: 'com.clawhouse.ClawHouse',
        pushEnvironment: 'development',
      });

      const retrieved = storage.getPairedDevice('test-device-001');
      expect(retrieved?.pushToken).toBe('abc123token');
      expect(retrieved?.pushBundleId).toBe('com.clawhouse.ClawHouse');
      expect(retrieved?.pushEnvironment).toBe('development');
    });

    it('should return devices with push tokens via getDevicesWithPushTokens', () => {
      // Device without push token
      storage.addPairedDevice(device);

      // Device with push token
      const deviceWithPush = {
        ...device,
        deviceId: 'test-device-002',
        deviceName: 'iPad',
        pushToken: 'token-002',
        pushBundleId: 'com.clawhouse.ClawHouse',
        pushEnvironment: 'development' as const,
      };
      storage.addPairedDevice(deviceWithPush);

      const pushDevices = storage.getDevicesWithPushTokens();
      expect(pushDevices).toHaveLength(1);
      expect(pushDevices[0]?.deviceId).toBe('test-device-002');
    });
  });

  describe('generic state', () => {
    it('should load defaults when no state file exists', () => {
      const state = storage.loadState({ counter: 0, name: 'default' });
      expect(state).toEqual({ counter: 0, name: 'default' });
    });

    it('should save and load state', () => {
      storage.saveState({ counter: 42, name: 'test' });
      const state = storage.loadState({ counter: 0, name: 'default' });
      expect(state.counter).toBe(42);
      expect(state.name).toBe('test');
    });
  });
});
