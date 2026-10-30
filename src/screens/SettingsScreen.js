import React, { useState, useEffect } from 'react';
import {
  StyleSheet,
  Text,
  View,
  ScrollView,
  TouchableOpacity,
  Alert,
  ActivityIndicator,
  StatusBar,
  Modal,
  TextInput,
} from 'react-native';
import { syncAll } from '../services/syncService';
import { supabase, subscribeToRemoteLogout } from '../services/supabase';
import { useAdminSecurity } from '../context/AdminSecurityContext';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

export default function SettingsScreen({ navigation }) {
  const insets = useSafeAreaInsets();
  const { updateAdminPin, lockAdmin } = useAdminSecurity();

  // Cloud state
  const [isSyncingCloud, setIsSyncingCloud] = useState(false);
  const [syncStatusText, setSyncStatusText] = useState('Idle');
  const [adminEmail, setAdminEmail] = useState('');

  // PIN Change Modal State
  const [showPinChangeModal, setShowPinChangeModal] = useState(false);
  const [newPinInput, setNewPinInput] = useState('');
  const [pinChangeError, setPinChangeError] = useState('');

  // Remote force logout subscriber
  useEffect(() => {
    const unsub = subscribeToRemoteLogout(() => {
      Alert.alert('Session Terminated', 'Remote administrator invalidated this session.');
      supabase.auth.signOut().finally(() => {
        navigation.reset({ index: 0, routes: [{ name: 'Login' }] });
      });
    });

    supabase.auth
      .getUser()
      .then(({ data }) => {
        if (data?.user?.email) {
          setAdminEmail(data.user.email);
        }
      })
      .catch(() => {});

    return () => {
      if (unsub) unsub();
    };
  }, [navigation]);

  /**
   * Trigger Manual Cloud Sync with Supabase
   */
  const handleTriggerSync = async () => {
    setIsSyncingCloud(true);
    setSyncStatusText('Syncing with Supabase...');
    try {
      const res = await syncAll();
      const summary = `Staff pushed: ${res.pushedUsers || 0}\nTemplates pushed: ${res.pushedTemplates || 0}\nTemplates pulled: ${res.pulledTemplates || 0}\nLogs synced: ${res.pushedLogs || 0}`;
      setSyncStatusText(`Last Sync: ${new Date().toLocaleTimeString()}`);
      Alert.alert('Cloud Sync Complete', summary);
    } catch (err) {
      console.error('[SettingsScreen] Cloud sync error:', err);
      setSyncStatusText(`Sync error: ${err.message}`);
      Alert.alert('Cloud Sync Error', err.message);
    } finally {
      setIsSyncingCloud(false);
    }
  };

  /**
   * Terminal Sign Out
   */
  const handleSignOut = () => {
    Alert.alert('Sign Out', 'Lock this kiosk terminal and return to the login screen?', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Sign Out',
        style: 'destructive',
        onPress: async () => {
          try {
            await supabase.auth.signOut();
          } catch (_) {}
          navigation.reset({ index: 0, routes: [{ name: 'Login' }] });
        },
      },
    ]);
  };

  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={[
        styles.contentContainer,
        { paddingBottom: Math.max(insets.bottom + 24, 40) },
      ]}
    >
      <StatusBar barStyle="light-content" backgroundColor="#0f172a" />

      {/* TOP: Simple Cloud Sync Button */}
      <View style={styles.topSyncContainer}>
        <TouchableOpacity
          style={[styles.topSyncButton, isSyncingCloud && styles.buttonDisabled]}
          onPress={handleTriggerSync}
          disabled={isSyncingCloud}
          activeOpacity={0.7}
        >
          {isSyncingCloud ? (
            <ActivityIndicator size="small" color="#0f172a" style={{ marginRight: 8 }} />
          ) : (
            <Text style={styles.topSyncIcon}>🔄</Text>
          )}
          <Text style={styles.topSyncText}>
            {isSyncingCloud ? 'Syncing...' : 'Sync With Cloud Now'}
          </Text>
        </TouchableOpacity>
        {syncStatusText !== 'Idle' && (
          <Text style={styles.topSyncStatusText}>{syncStatusText}</Text>
        )}
      </View>

      {/* SECTION: Administrator Session & Terminal Security */}
      <View style={styles.card}>
        <View style={styles.cardHeader}>
          <Text style={styles.cardIcon}>🛡️</Text>
          <Text style={styles.cardTitle}>Admin Gate & Security</Text>
        </View>

        <Text style={styles.adminInfoText}>
          Connected as: <Text style={styles.boldWhite}>{adminEmail || 'Supervisor'}</Text>
        </Text>

        {/* 4-digit PIN setting row */}
        <View style={styles.securityRow}>
          <View style={{ flex: 1 }}>
            <Text style={styles.securityTitle}>Admin Gate Passcode</Text>
            <Text style={styles.securitySub}>
              Active PIN: <Text style={styles.securityPinText}>••••</Text>
            </Text>
          </View>
          <TouchableOpacity
            style={styles.changePinButton}
            onPress={() => {
              setNewPinInput('');
              setPinChangeError('');
              setShowPinChangeModal(true);
            }}
            activeOpacity={0.7}
          >
            <Text style={styles.changePinButtonText}>Change PIN</Text>
          </TouchableOpacity>
        </View>

        {/* Immediate Lock Admin Session */}
        <TouchableOpacity
          style={styles.lockSessionButton}
          onPress={() => {
            Alert.alert('Lock Admin Session', 'Lock admin privileges and return immediately to the Attendance camera?', [
              { text: 'Cancel', style: 'cancel' },
              {
                text: 'Lock Now',
                style: 'default',
                onPress: lockAdmin,
              },
            ]);
          }}
          activeOpacity={0.7}
        >
          <Text style={styles.lockSessionButtonText}>🔒 Lock Admin Session Now</Text>
        </TouchableOpacity>

        {/* Full Terminal Sign Out */}
        <TouchableOpacity
          style={styles.signOutButton}
          onPress={handleSignOut}
          activeOpacity={0.7}
        >
          <Text style={styles.signOutButtonText}>🚪 Sign Out Administrator</Text>
        </TouchableOpacity>
      </View>

      {/* Modal: Change Admin PIN */}
      <Modal
        visible={showPinChangeModal}
        transparent
        animationType="fade"
        onRequestClose={() => setShowPinChangeModal(false)}
      >
        <View style={styles.modalBackdrop}>
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>Set New Admin PIN</Text>
            <Text style={styles.modalSubtitle}>
              Enter a new 4-digit numeric passcode to secure Enrollment and Settings tabs.
            </Text>

            <TextInput
              style={styles.pinTextInput}
              value={newPinInput}
              onChangeText={(val) => {
                const cleaned = val.replace(/[^0-9]/g, '').slice(0, 4);
                setNewPinInput(cleaned);
                setPinChangeError('');
              }}
              placeholder="••••"
              placeholderTextColor="#64748b"
              keyboardType="number-pad"
              maxLength={4}
              secureTextEntry
              autoFocus
            />

            {pinChangeError ? (
              <Text style={styles.modalErrorText}>{pinChangeError}</Text>
            ) : null}

            <View style={styles.modalActionsRow}>
              <TouchableOpacity
                style={styles.modalCancelBtn}
                onPress={() => setShowPinChangeModal(false)}
              >
                <Text style={styles.modalCancelText}>Cancel</Text>
              </TouchableOpacity>

              <TouchableOpacity
                style={styles.modalSaveBtn}
                onPress={async () => {
                  if (newPinInput.length !== 4) {
                    setPinChangeError('PIN must be exactly 4 digits');
                    return;
                  }
                  try {
                    await updateAdminPin(newPinInput);
                    setShowPinChangeModal(false);
                    Alert.alert('PIN Updated', 'New 4-digit admin PIN has been saved successfully.');
                  } catch (e) {
                    setPinChangeError(e?.message || 'Failed to update PIN');
                  }
                }}
              >
                <Text style={styles.modalSaveText}>Save PIN</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>
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
    maxWidth: 720,
    alignSelf: 'center',
  },
  topSyncContainer: {
    marginBottom: 16,
    alignItems: 'center',
  },
  topSyncButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#38bdf8',
    borderRadius: 14,
    paddingVertical: 14,
    paddingHorizontal: 24,
    width: '100%',
    shadowColor: '#38bdf8',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.25,
    shadowRadius: 8,
    elevation: 4,
  },
  topSyncIcon: {
    fontSize: 16,
    marginRight: 8,
  },
  topSyncText: {
    color: '#0f172a',
    fontSize: 15,
    fontWeight: '700',
  },
  topSyncStatusText: {
    marginTop: 8,
    fontSize: 12,
    color: '#94a3b8',
    fontWeight: '500',
  },
  buttonDisabled: {
    opacity: 0.6,
  },
  card: {
    backgroundColor: '#1e293b',
    borderRadius: 16,
    padding: 18,
    marginBottom: 16,
    borderWidth: 1,
    borderColor: '#334155',
  },
  cardHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 16,
  },
  cardIcon: {
    fontSize: 20,
    marginRight: 10,
  },
  cardTitle: {
    fontSize: 17,
    fontWeight: '700',
    color: '#f8fafc',
  },
  adminInfoText: {
    fontSize: 14,
    color: '#94a3b8',
    marginBottom: 16,
    paddingHorizontal: 4,
  },
  boldWhite: {
    color: '#f8fafc',
    fontWeight: '700',
  },
  securityRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: '#0f172a',
    borderRadius: 12,
    padding: 14,
    marginBottom: 14,
    borderWidth: 1,
    borderColor: '#334155',
  },
  securityTitle: {
    fontSize: 14,
    fontWeight: '700',
    color: '#f8fafc',
    marginBottom: 2,
  },
  securitySub: {
    fontSize: 12,
    color: '#94a3b8',
  },
  securityPinText: {
    color: '#38bdf8',
    fontWeight: '700',
    letterSpacing: 2,
  },
  changePinButton: {
    backgroundColor: 'rgba(56, 189, 248, 0.12)',
    borderRadius: 8,
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderWidth: 1,
    borderColor: 'rgba(56, 189, 248, 0.3)',
  },
  changePinButtonText: {
    color: '#38bdf8',
    fontSize: 13,
    fontWeight: '700',
  },
  lockSessionButton: {
    backgroundColor: '#1e293b',
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#eab308',
    marginBottom: 12,
  },
  lockSessionButtonText: {
    color: '#facc15',
    fontSize: 15,
    fontWeight: '700',
  },
  signOutButton: {
    backgroundColor: '#334155',
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#475569',
  },
  signOutButtonText: {
    color: '#f8fafc',
    fontSize: 15,
    fontWeight: '700',
  },
  modalBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(10, 15, 29, 0.85)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 20,
  },
  modalCard: {
    width: '100%',
    maxWidth: 380,
    backgroundColor: '#0f172a',
    borderRadius: 20,
    padding: 24,
    borderWidth: 1.5,
    borderColor: '#334155',
    alignItems: 'center',
  },
  modalTitle: {
    fontSize: 19,
    fontWeight: '800',
    color: '#f8fafc',
    marginBottom: 8,
  },
  modalSubtitle: {
    fontSize: 13,
    color: '#94a3b8',
    textAlign: 'center',
    lineHeight: 18,
    marginBottom: 20,
  },
  pinTextInput: {
    width: '100%',
    height: 56,
    backgroundColor: '#1e293b',
    borderRadius: 12,
    borderWidth: 1.5,
    borderColor: '#38bdf8',
    color: '#f8fafc',
    fontSize: 24,
    fontWeight: '800',
    textAlign: 'center',
    letterSpacing: 12,
    marginBottom: 12,
  },
  modalErrorText: {
    color: '#ef4444',
    fontSize: 13,
    fontWeight: '700',
    marginBottom: 12,
  },
  modalActionsRow: {
    flexDirection: 'row',
    gap: 12,
    width: '100%',
    marginTop: 8,
  },
  modalCancelBtn: {
    flex: 1,
    paddingVertical: 13,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#475569',
    alignItems: 'center',
  },
  modalCancelText: {
    color: '#94a3b8',
    fontSize: 14,
    fontWeight: '600',
  },
  modalSaveBtn: {
    flex: 1,
    paddingVertical: 13,
    borderRadius: 10,
    backgroundColor: '#38bdf8',
    alignItems: 'center',
  },
  modalSaveText: {
    color: '#0f172a',
    fontSize: 14,
    fontWeight: '700',
  },
  footer: {
    alignItems: 'center',
    paddingVertical: 20,
  },
  footerText: {
    color: '#64748b',
    fontSize: 13,
    fontWeight: '500',
  },
  footerSubText: {
    color: '#475569',
    fontSize: 11,
    marginTop: 4,
  },
});
