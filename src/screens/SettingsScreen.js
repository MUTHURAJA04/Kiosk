import React, { useState, useEffect, useCallback } from 'react';
import {
  StyleSheet,
  Text,
  View,
  ScrollView,
  TouchableOpacity,
  Switch,
  Alert,
  ActivityIndicator,
} from 'react-native';
import { useIsFocused } from '@react-navigation/native';
import AsyncStorage from '../utils/AsyncStorage';
import { FaceMatcher } from '../services/faceMatcher';
import {
  getUsersCount,
  getAttendanceLogsCount,
  clearAllUsers,
  purgeAttendanceLogs,
  deleteBiometrics,
  getAllEmployees,
} from '../database/db';
import { TableLogger } from '../utils/TableLogger';
import { syncAll } from '../services/syncService';
import { NativeFacePipeline } from '../services/nativeFacePipeline';

// Storage keys
export const STORAGE_KEYS = {
  MATCH_THRESHOLD: '@kiosk_match_threshold',
  COOLDOWN_MS: '@kiosk_cooldown_ms',
  BURST_FRAMES: '@kiosk_burst_frames',
  DEBUG_LOGGING: '@kiosk_debug_logging',
};

// Default tuning constants
export const DEFAULT_SETTINGS = {
  MATCH_THRESHOLD: 0.70,
  COOLDOWN_MS: 5000,
  BURST_FRAMES: 3,
  DEBUG_LOGGING: false,
};

export default function SettingsScreen({ navigation }) {
  const isFocused = useIsFocused();

  // Database stats
  const [userCount, setUserCount] = useState(0);
  const [logCount, setLogCount] = useState(0);
  const [memoryCacheCount, setMemoryCacheCount] = useState(0);
  const [isLoadingStats, setIsLoadingStats] = useState(false);

  // Biometric tuning
  const [threshold, setThreshold] = useState(DEFAULT_SETTINGS.MATCH_THRESHOLD);
  const [cooldownMs, setCooldownMs] = useState(DEFAULT_SETTINGS.COOLDOWN_MS);
  const [burstFrames, setBurstFrames] = useState(DEFAULT_SETTINGS.BURST_FRAMES);
  const [debugLogging, setDebugLogging] = useState(DEFAULT_SETTINGS.DEBUG_LOGGING);

  // Cloud & DPDP state
  const [isSyncingCloud, setIsSyncingCloud] = useState(false);
  const [syncStatusText, setSyncStatusText] = useState('Idle');

  /**
   * Refreshes live database record counts and cache state
   */
  const refreshStats = useCallback(() => {
    setIsLoadingStats(true);
    try {
      const users = getUsersCount();
      const logs = getAttendanceLogsCount();
      const cached = FaceMatcher.getEnrolledUsers();
      setUserCount(users);
      setLogCount(logs);
      setMemoryCacheCount(cached.length);
    } catch (err) {
      console.error('[SettingsScreen] Failed to fetch stats:', err);
    } finally {
      setIsLoadingStats(false);
    }
  }, []);

  /**
   * Loads persisted settings from AsyncStorage
   */
  const loadPersistedSettings = useCallback(async () => {
    try {
      const storedThreshold = await AsyncStorage.getItem(STORAGE_KEYS.MATCH_THRESHOLD);
      if (storedThreshold !== null) {
        const parsed = parseFloat(storedThreshold);
        // Automatically upgrade legacy loose threshold (< 0.45) to high-accuracy 0.55
        const validThreshold = parsed < 0.45 ? 0.55 : parsed;
        setThreshold(validThreshold);
        if (validThreshold !== parsed) {
          await AsyncStorage.setItem(STORAGE_KEYS.MATCH_THRESHOLD, validThreshold.toString());
        }
      }

      const storedCooldown = await AsyncStorage.getItem(STORAGE_KEYS.COOLDOWN_MS);
      if (storedCooldown !== null) {
        setCooldownMs(parseInt(storedCooldown, 10));
      }

      const storedBurst = await AsyncStorage.getItem(STORAGE_KEYS.BURST_FRAMES);
      if (storedBurst !== null) {
        setBurstFrames(parseInt(storedBurst, 10));
      }

      const storedDebug = await AsyncStorage.getItem(STORAGE_KEYS.DEBUG_LOGGING);
      if (storedDebug !== null) {
        const isDebug = storedDebug === 'true';
        setDebugLogging(isDebug);
        TableLogger.setDebugLogging(isDebug);
      }
    } catch (err) {
      console.error('[SettingsScreen] Failed to load settings:', err);
    }
  }, []);

  // Refresh counts and reload settings on mount and screen focus
  useEffect(() => {
    if (isFocused) {
      refreshStats();
      loadPersistedSettings();
    }
  }, [isFocused, refreshStats, loadPersistedSettings]);

  /**
   * 1. Force Reload Gallery Cache
   */
  const handleReloadCache = async () => {
    try {
      setIsLoadingStats(true);
      const loaded = await FaceMatcher.loadEnrolledUsers();
      setMemoryCacheCount(loaded.length);
      refreshStats();
      Alert.alert(
        'Gallery Cache Reloaded',
        `Gallery cache reloaded (${loaded.length} users in memory).`
      );
    } catch (err) {
      console.error('[SettingsScreen] Cache reload failed:', err);
      Alert.alert('Cache Error', 'Failed to reload gallery cache.');
    } finally {
      setIsLoadingStats(false);
    }
  };

  /**
   * 2. Clear All Registered Users (Destructive)
   */
  const handleClearUsers = () => {
    Alert.alert(
      'Clear All Registered Users?',
      'This will permanently delete all employee face embeddings and profiles from SQLite. This cannot be undone.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Confirm',
          style: 'destructive',
          onPress: async () => {
            try {
              clearAllUsers();
              FaceMatcher.clearCache();
              refreshStats();
              Alert.alert('Cleared', 'All registered users deleted.');
            } catch (err) {
              console.error('[SettingsScreen] Failed to delete users:', err);
              Alert.alert('Error', 'Failed to delete users.');
            }
          },
        },
      ]
    );
  };

  /**
   * 3. Purge Attendance Logs (Destructive)
   */
  const handlePurgeLogs = () => {
    Alert.alert(
      'Wipe Attendance History?',
      'Wipe all stored check-in and check-out logs from local storage?',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Confirm',
          style: 'destructive',
          onPress: async () => {
            try {
              purgeAttendanceLogs();
              refreshStats();
              Alert.alert('Purged', 'Attendance logs cleared.');
            } catch (err) {
              console.error('[SettingsScreen] Failed to purge logs:', err);
              Alert.alert('Error', 'Failed to purge attendance logs.');
            }
          },
        },
      ]
    );
  };

  /**
   * Phase 5: Trigger Manual Cloud Sync with Supabase
   */
  const handleTriggerSync = async () => {
    setIsSyncingCloud(true);
    setSyncStatusText('Syncing with Supabase...');
    try {
      const res = await syncAll();
      const summary = `Users pushed: ${res.pushedUsers}\nTemplates pushed: ${res.pushedTemplates}\nTemplates pulled: ${res.pulledTemplates}\nLogs synced: ${res.pushedLogs}`;
      setSyncStatusText(`Last Sync: ${new Date().toLocaleTimeString()}`);
      refreshStats();
      Alert.alert('Cloud Sync Complete', summary);
    } catch (err) {
      console.error('[SettingsScreen] Cloud sync error:', err);
      setSyncStatusText(`Error: ${err.message}`);
      Alert.alert('Cloud Sync Error', err.message);
    } finally {
      setIsSyncingCloud(false);
    }
  };

  /**
   * Phase 5 DPDP: Withdraw Biometric Consent & Delete Biometrics
   */
  const handleWithdrawAllConsent = () => {
    Alert.alert(
      'Withdraw Consent & Delete Biometrics',
      'Under the DPDP Act (2023), this action will permanently delete all facial templates from local and cloud storage. Identity records will be retained, but employees must re-enroll before checking in.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete All Biometrics',
          style: 'destructive',
          onPress: async () => {
            try {
              const allUsers = getAllEmployees();
              for (const u of allUsers) {
                deleteBiometrics(u.id);
                if (NativeFacePipeline.isAvailable()) {
                  await NativeFacePipeline.removeUser(u.id);
                }
              }
              FaceMatcher.clearCache();
              refreshStats();
              // Trigger sync to push soft-deletions to cloud
              syncAll().catch(() => {});
              Alert.alert('Biometrics Deleted', 'All facial templates have been erased from memory and queued for cloud erasure.');
            } catch (err) {
              console.error('[SettingsScreen] Failed to delete biometrics:', err);
              Alert.alert('Error', 'Failed to delete biometrics.');
            }
          },
        },
      ]
    );
  };

  /**
   * Adjust Recognition Threshold [-0.05 / +0.05]
   */
  const adjustThreshold = async (delta) => {
    const nextVal = Math.max(0.4, Math.min(0.8, parseFloat((threshold + delta).toFixed(2))));
    setThreshold(nextVal);
    await AsyncStorage.setItem(STORAGE_KEYS.MATCH_THRESHOLD, nextVal.toString());
  };

  /**
   * Select Attendance Cooldown
   */
  const handleSelectCooldown = async (ms) => {
    setCooldownMs(ms);
    await AsyncStorage.setItem(STORAGE_KEYS.COOLDOWN_MS, ms.toString());
  };

  /**
   * Select Burst Frame Count (3 or 5)
   */
  const handleSelectBurst = async (frames) => {
    setBurstFrames(frames);
    await AsyncStorage.setItem(STORAGE_KEYS.BURST_FRAMES, frames.toString());
  };

  /**
   * Toggle Debug Logging
   */
  const handleToggleDebugLogging = async (val) => {
    setDebugLogging(val);
    TableLogger.setDebugLogging(val);
    await AsyncStorage.setItem(STORAGE_KEYS.DEBUG_LOGGING, val ? 'true' : 'false');
  };

  const cooldownOptions = [
    { label: '5s', value: 5000 },
    { label: '10s', value: 10000 },
    { label: '30s', value: 30000 },
    { label: '60s', value: 60000 },
  ];

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.contentContainer}>
      {/* SECTION 1: Local Database & Cache Controls */}
      <View style={styles.card}>
        <View style={styles.cardHeader}>
          <Text style={styles.cardIcon}>💾</Text>
          <Text style={styles.cardTitle}>Local Database & Cache Controls</Text>
        </View>

        <View style={styles.statsRow}>
          <View style={styles.statBox}>
            <Text style={styles.statValue}>{isLoadingStats ? '...' : userCount}</Text>
            <Text style={styles.statLabel}>Enrolled Users</Text>
          </View>
          <View style={styles.statBox}>
            <Text style={styles.statValue}>{isLoadingStats ? '...' : logCount}</Text>
            <Text style={styles.statLabel}>Attendance Logs</Text>
          </View>
          <View style={styles.statBox}>
            <Text style={styles.statValue}>{isLoadingStats ? '...' : memoryCacheCount}</Text>
            <Text style={styles.statLabel}>In-Memory Cache</Text>
          </View>
        </View>

        <TouchableOpacity
          style={styles.actionButton}
          onPress={handleReloadCache}
          activeOpacity={0.7}
        >
          {isLoadingStats ? (
            <ActivityIndicator size="small" color="#0f172a" />
          ) : (
            <Text style={styles.actionButtonText}>🔄 Force Reload Gallery Cache</Text>
          )}
        </TouchableOpacity>
      </View>

      {/* SECTION 2: Biometric & Inference Tuning */}
      <View style={styles.card}>
        <View style={styles.cardHeader}>
          <Text style={styles.cardIcon}>🎯</Text>
          <Text style={styles.cardTitle}>Biometric & Inference Tuning</Text>
        </View>

        {/* Match Threshold */}
        <View style={styles.settingItem}>
          <View style={styles.settingTextCol}>
            <Text style={styles.settingTitle}>Match Threshold</Text>
            <Text style={styles.settingDescription}>
              Cosine similarity cutoff (0.40 – 0.80). Higher = strictly prevents employee collisions.
            </Text>
          </View>
          <View style={styles.stepperContainer}>
            <TouchableOpacity
              style={[styles.stepperButton, threshold <= 0.4 && styles.stepperButtonDisabled]}
              onPress={() => adjustThreshold(-0.05)}
              disabled={threshold <= 0.4}
            >
              <Text style={styles.stepperButtonText}>−</Text>
            </TouchableOpacity>
            <View style={styles.stepperValueContainer}>
              <Text style={styles.stepperValue}>{threshold.toFixed(2)}</Text>
            </View>
            <TouchableOpacity
              style={[styles.stepperButton, threshold >= 0.8 && styles.stepperButtonDisabled]}
              onPress={() => adjustThreshold(0.05)}
              disabled={threshold >= 0.8}
            >
              <Text style={styles.stepperButtonText}>+</Text>
            </TouchableOpacity>
          </View>
        </View>

        {/* Cooldown Period */}
        <View style={styles.settingItemCol}>
          <Text style={styles.settingTitle}>Attendance Cooldown Period</Text>
          <Text style={styles.settingDescription}>
            Prevents repeated double check-ins within the specified timeframe.
          </Text>
          <View style={styles.optionButtonGroup}>
            {cooldownOptions.map((opt) => {
              const isSelected = cooldownMs === opt.value;
              return (
                <TouchableOpacity
                  key={opt.value}
                  style={[styles.optionButton, isSelected && styles.optionButtonActive]}
                  onPress={() => handleSelectCooldown(opt.value)}
                  activeOpacity={0.7}
                >
                  <Text
                    style={[styles.optionButtonText, isSelected && styles.optionButtonTextActive]}
                  >
                    {opt.label}
                  </Text>
                </TouchableOpacity>
              );
            })}
          </View>
        </View>

        {/* Burst Frame Enrollment Count */}
        <View style={styles.settingItemCol}>
          <Text style={styles.settingTitle}>Burst Frame Enrollment Count</Text>
          <Text style={styles.settingDescription}>
            Number of face snapshots averaged to build the 512-d biometric embedding.
          </Text>
          <View style={styles.optionButtonGroup}>
            {[3, 5].map((frames) => {
              const isSelected = burstFrames === frames;
              return (
                <TouchableOpacity
                  key={frames}
                  style={[
                    styles.optionButton,
                    styles.optionButtonHalf,
                    isSelected && styles.optionButtonActive,
                  ]}
                  onPress={() => handleSelectBurst(frames)}
                  activeOpacity={0.7}
                >
                  <Text
                    style={[styles.optionButtonText, isSelected && styles.optionButtonTextActive]}
                  >
                    {frames} Frames
                  </Text>
                </TouchableOpacity>
              );
            })}
          </View>
        </View>

        {/* Debug Logging Mode */}
        <View style={styles.settingItem}>
          <View style={styles.settingTextCol}>
            <Text style={styles.settingTitle}>Debug Logging Mode</Text>
            <Text style={styles.settingDescription}>
              Outputs structured audit tables to console during live inference cycles.
            </Text>
          </View>
          <Switch
            value={debugLogging}
            onValueChange={handleToggleDebugLogging}
            trackColor={{ false: '#334155', true: '#38bdf8' }}
            thumbColor={debugLogging ? '#0f172a' : '#94a3b8'}
          />
        </View>

        {/* Phase 6: Calibration & ROC Analysis Shortcut */}
        <TouchableOpacity
          style={[styles.actionButton, styles.calibrationLaunchBtn]}
          onPress={() => navigation?.navigate('Enrollment', { screen: 'Calibration' })}
          activeOpacity={0.7}
        >
          <Text style={styles.calibrationLaunchBtnText}>
            📊 Open Biometric Calibration & FAR/FRR Curve (Phase 6)
          </Text>
        </TouchableOpacity>
      </View>

      {/* SECTION 3: Cloud Synchronization & Hardware Keystore (Phase 5) */}
      <View style={styles.card}>
        <View style={styles.cardHeader}>
          <Text style={styles.cardIcon}>☁️</Text>
          <Text style={styles.cardTitle}>Cloud Synchronization & Security (Phase 5)</Text>
        </View>

        <View style={styles.securityStatusBox}>
          <Text style={styles.securityStatusIcon}>🔒</Text>
          <View style={styles.securityStatusTextCol}>
            <Text style={styles.securityStatusTitle}>Android Keystore Protection Active</Text>
            <Text style={styles.securityStatusDesc}>
              Templates are encrypted with AES-256-GCM in hardware. Decryption occurs only in native RAM.
            </Text>
          </View>
        </View>

        <View style={styles.syncStatusRow}>
          <Text style={styles.syncStatusLabel}>Status:</Text>
          <Text style={styles.syncStatusValue}>{syncStatusText}</Text>
        </View>

        <TouchableOpacity
          style={[styles.actionButton, styles.syncButton]}
          onPress={handleTriggerSync}
          disabled={isSyncingCloud}
          activeOpacity={0.7}
        >
          {isSyncingCloud ? (
            <ActivityIndicator size="small" color="#ffffff" />
          ) : (
            <Text style={styles.syncButtonText}>🔄 Sync With Cloud (Templates & Logs)</Text>
          )}
        </TouchableOpacity>
      </View>

      {/* SECTION 4: DPDP Compliance & Biometric Rights (Phase 5) */}
      <View style={styles.card}>
        <View style={styles.cardHeader}>
          <Text style={styles.cardIcon}>🛡️</Text>
          <Text style={styles.cardTitle}>DPDP Act (2023) Compliance & Privacy</Text>
        </View>
        <Text style={styles.dpdpNoticeText}>
          Employees have the right to withdraw biometric consent and request complete erasure of their facial vectors from both local kiosk and cloud storage at any time.
        </Text>

        <TouchableOpacity
          style={[styles.dangerButton, styles.withdrawButton]}
          onPress={handleWithdrawAllConsent}
          activeOpacity={0.7}
        >
          <Text style={styles.dangerButtonText}>🚫 Withdraw Consent & Delete Biometrics</Text>
        </TouchableOpacity>
      </View>

      {/* SECTION 5: Destructive Actions */}
      <View style={[styles.card, styles.dangerCard]}>
        <View style={styles.cardHeader}>
          <Text style={styles.cardIcon}>⚠️</Text>
          <Text style={[styles.cardTitle, styles.dangerTitle]}>Destructive Actions</Text>
        </View>
        <Text style={styles.dangerDescription}>
          The following actions will permanently erase local device storage. Exercise caution.
        </Text>

        <TouchableOpacity
          style={styles.dangerButton}
          onPress={handleClearUsers}
          activeOpacity={0.7}
        >
          <Text style={styles.dangerButtonText}>🗑️ Clear All Registered Users</Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={styles.dangerButton}
          onPress={handlePurgeLogs}
          activeOpacity={0.7}
        >
          <Text style={styles.dangerButtonText}>🧹 Purge Attendance Logs</Text>
        </TouchableOpacity>
      </View>

      {/* Footer Info */}
      <View style={styles.footer}>
        <Text style={styles.footerText}>Face Recognition Kiosk • EdgeFace-S Int8/FP32</Text>
        <Text style={styles.footerSubText}>Powered by React Native, OP-SQLite & Fast-TFLite</Text>
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#0f172a',
  },
  contentContainer: {
    padding: 16,
    paddingBottom: 40,
    width: '100%',
    maxWidth: 760,
    alignSelf: 'center',
  },
  header: {
    marginBottom: 20,
  },
  headerTitle: {
    fontSize: 22,
    fontWeight: '800',
    color: '#f8fafc',
    letterSpacing: 0.3,
  },
  headerSubtitle: {
    fontSize: 13,
    color: '#94a3b8',
    marginTop: 4,
  },
  card: {
    backgroundColor: '#1e293b',
    borderRadius: 14,
    padding: 16,
    marginBottom: 16,
    borderWidth: 1,
    borderColor: '#334155',
  },
  cardHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 14,
  },
  cardIcon: {
    fontSize: 18,
    marginRight: 8,
  },
  cardTitle: {
    fontSize: 16,
    fontWeight: '700',
    color: '#f8fafc',
  },
  statsRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 16,
  },
  statBox: {
    flex: 1,
    backgroundColor: '#0f172a',
    borderRadius: 10,
    paddingVertical: 12,
    paddingHorizontal: 8,
    alignItems: 'center',
    marginHorizontal: 4,
    borderWidth: 1,
    borderColor: '#334155',
  },
  statValue: {
    fontSize: 20,
    fontWeight: '800',
    color: '#38bdf8',
  },
  statLabel: {
    fontSize: 11,
    color: '#94a3b8',
    marginTop: 4,
    textAlign: 'center',
    fontWeight: '500',
  },
  actionButton: {
    backgroundColor: '#38bdf8',
    borderRadius: 10,
    paddingVertical: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
  actionButtonText: {
    color: '#0f172a',
    fontSize: 14,
    fontWeight: '700',
  },
  settingItem: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#334155',
  },
  settingItemCol: {
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#334155',
  },
  settingTextCol: {
    flex: 1,
    marginRight: 12,
  },
  settingTitle: {
    fontSize: 14,
    fontWeight: '600',
    color: '#f8fafc',
  },
  settingDescription: {
    fontSize: 12,
    color: '#94a3b8',
    marginTop: 2,
    lineHeight: 16,
  },
  stepperContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#0f172a',
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#334155',
  },
  stepperButton: {
    paddingVertical: 8,
    paddingHorizontal: 14,
  },
  stepperButtonDisabled: {
    opacity: 0.3,
  },
  stepperButtonText: {
    color: '#38bdf8',
    fontSize: 18,
    fontWeight: '700',
  },
  stepperValueContainer: {
    minWidth: 44,
    alignItems: 'center',
  },
  stepperValue: {
    color: '#f8fafc',
    fontSize: 15,
    fontWeight: '700',
  },
  optionButtonGroup: {
    flexDirection: 'row',
    marginTop: 10,
    justifyContent: 'space-between',
  },
  optionButton: {
    flex: 1,
    backgroundColor: '#0f172a',
    borderRadius: 8,
    paddingVertical: 10,
    alignItems: 'center',
    marginHorizontal: 3,
    borderWidth: 1,
    borderColor: '#334155',
  },
  optionButtonHalf: {
    marginHorizontal: 4,
  },
  optionButtonActive: {
    backgroundColor: '#38bdf8',
    borderColor: '#38bdf8',
  },
  optionButtonText: {
    fontSize: 13,
    fontWeight: '600',
    color: '#94a3b8',
  },
  optionButtonTextActive: {
    color: '#0f172a',
    fontWeight: '700',
  },
  dangerCard: {
    borderColor: '#7f1d1d',
    backgroundColor: '#1e1b24',
  },
  dangerTitle: {
    color: '#f87171',
  },
  dangerDescription: {
    fontSize: 12,
    color: '#fca5a5',
    marginBottom: 14,
    lineHeight: 16,
  },
  dangerButton: {
    backgroundColor: '#7f1d1d',
    borderRadius: 10,
    paddingVertical: 12,
    alignItems: 'center',
    marginBottom: 10,
    borderWidth: 1,
    borderColor: '#b91c1c',
  },
  dangerButtonText: {
    color: '#fef2f2',
    fontSize: 13,
    fontWeight: '700',
  },
  securityStatusBox: {
    flexDirection: 'row',
    backgroundColor: '#0284c715',
    borderWidth: 1,
    borderColor: '#0284c740',
    borderRadius: 10,
    padding: 12,
    marginBottom: 12,
    alignItems: 'center',
  },
  securityStatusIcon: {
    fontSize: 22,
    marginRight: 10,
  },
  securityStatusTextCol: {
    flex: 1,
  },
  securityStatusTitle: {
    fontSize: 13,
    fontWeight: '700',
    color: '#38bdf8',
  },
  securityStatusDesc: {
    fontSize: 11,
    color: '#94a3b8',
    marginTop: 2,
    lineHeight: 15,
  },
  syncStatusRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingVertical: 8,
    marginBottom: 8,
  },
  syncStatusLabel: {
    fontSize: 13,
    color: '#94a3b8',
  },
  syncStatusValue: {
    fontSize: 13,
    fontWeight: '600',
    color: '#e2e8f0',
  },
  syncButton: {
    backgroundColor: '#0284c7',
  },
  syncButtonText: {
    color: '#ffffff',
    fontSize: 13,
    fontWeight: '700',
  },
  dpdpNoticeText: {
    fontSize: 12,
    color: '#94a3b8',
    lineHeight: 17,
    marginBottom: 14,
  },
  withdrawButton: {
    backgroundColor: '#991b1b',
    borderColor: '#dc2626',
    marginBottom: 0,
  },
  calibrationLaunchBtn: {
    marginTop: 14,
    backgroundColor: '#334155',
    borderWidth: 1,
    borderColor: '#0284c7',
  },
  calibrationLaunchBtnText: {
    color: '#38bdf8',
    fontSize: 13,
    fontWeight: '700',
  },
  footer: {
    alignItems: 'center',
    marginTop: 8,
  },
  footerText: {
    color: '#64748b',
    fontSize: 12,
    fontWeight: '600',
  },
  footerSubText: {
    color: '#475569',
    fontSize: 11,
    marginTop: 2,
  },
});
