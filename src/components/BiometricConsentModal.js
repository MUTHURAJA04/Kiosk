import React from 'react';
import {
  StyleSheet,
  View,
  Text,
  Modal,
  TouchableOpacity,
  ScrollView,
  SafeAreaView,
} from 'react-native';

/**
 * Phase 5 DPDP: Biometric Data Processing Consent Modal
 * Compliant with Digital Personal Data Protection Act (DPDP Act, 2023)
 */
export default function BiometricConsentModal({
  visible,
  employeeName = 'Employee',
  employeeId = '',
  onAccept,
  onDecline,
}) {
  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={onDecline}
    >
      <View style={styles.backdrop}>
        <SafeAreaView style={styles.safeArea}>
          <View style={styles.modalCard}>
            {/* Header */}
            <View style={styles.header}>
              <View style={styles.shieldIconContainer}>
                <Text style={styles.shieldIcon}>🛡️</Text>
              </View>
              <View style={styles.headerTextContainer}>
                <Text style={styles.title}>Biometric Data Consent</Text>
                <Text style={styles.subtitle}>DPDP Act (2023) Compliance Notice</Text>
              </View>
            </View>

            {/* Scrollable Notice */}
            <ScrollView style={styles.body} showsVerticalScrollIndicator={false}>
              <Text style={styles.greeting}>
                Hello <Text style={styles.boldText}>{employeeName}</Text> ({employeeId}),
              </Text>

              <Text style={styles.paragraph}>
                Before proceeding with face enrollment, please review and accept our biometric data processing terms:
              </Text>

              <View style={styles.pointRow}>
                <Text style={styles.pointNumber}>1.</Text>
                <View style={styles.pointContent}>
                  <Text style={styles.pointTitle}>Specified Purpose</Text>
                  <Text style={styles.pointText}>
                    Your facial biometric representations are collected solely for the purpose of verified contactless attendance tracking and identity authentication at this kiosk.
                  </Text>
                </View>
              </View>

              <View style={styles.pointRow}>
                <Text style={styles.pointNumber}>2.</Text>
                <View style={styles.pointContent}>
                  <Text style={styles.pointTitle}>No Photo Storage & Hardware Encryption</Text>
                  <Text style={styles.pointText}>
                    Raw facial photographs are never stored or retained. The system generates mathematical 512-dimensional vectors encrypted with AES-256-GCM using hardware keys held in the Android Keystore (TEE/StrongBox).
                  </Text>
                </View>
              </View>

              <View style={styles.pointRow}>
                <Text style={styles.pointNumber}>3.</Text>
                <View style={styles.pointContent}>
                  <Text style={styles.pointTitle}>Confidentiality & Access Control</Text>
                  <Text style={styles.pointText}>
                    Biometric templates are stored on-device and securely synced to your employer's cloud database with Row-Level Security (RLS). They are never sold or shared with unauthorized third parties.
                  </Text>
                </View>
              </View>

              <View style={styles.pointRow}>
                <Text style={styles.pointNumber}>4.</Text>
                <View style={styles.pointContent}>
                  <Text style={styles.pointTitle}>Right to Withdraw & Erasure</Text>
                  <Text style={styles.pointText}>
                    Consent is voluntary. You have the right to withdraw consent and request immediate deletion of all local and cloud biometric templates at any time.
                  </Text>
                </View>
              </View>

              <View style={styles.badgeContainer}>
                <Text style={styles.badgeText}>🔒 AES-256-GCM Hardware Encryption Enabled</Text>
              </View>
            </ScrollView>

            {/* Action Buttons */}
            <View style={styles.footer}>
              <TouchableOpacity
                style={styles.declineButton}
                onPress={onDecline}
                activeOpacity={0.7}
              >
                <Text style={styles.declineButtonText}>Decline & Exit</Text>
              </TouchableOpacity>

              <TouchableOpacity
                style={styles.acceptButton}
                onPress={onAccept}
                activeOpacity={0.8}
              >
                <Text style={styles.acceptButtonText}>I Agree & Proceed</Text>
              </TouchableOpacity>
            </View>
          </View>
        </SafeAreaView>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(15, 23, 42, 0.85)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 16,
  },
  safeArea: {
    width: '100%',
    maxWidth: 520,
  },
  modalCard: {
    backgroundColor: '#1e293b',
    borderRadius: 20,
    borderWidth: 1,
    borderColor: '#334155',
    maxHeight: '88%',
    overflow: 'hidden',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 10 },
    shadowOpacity: 0.5,
    shadowRadius: 20,
    elevation: 25,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 18,
    borderBottomWidth: 1,
    borderBottomColor: '#334155',
    backgroundColor: '#0f172a',
  },
  shieldIconContainer: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: '#1e293b',
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: 12,
  },
  shieldIcon: {
    fontSize: 24,
  },
  headerTextContainer: {
    flex: 1,
  },
  title: {
    fontSize: 18,
    fontWeight: '700',
    color: '#f8fafc',
  },
  subtitle: {
    fontSize: 12,
    color: '#38bdf8',
    marginTop: 2,
    fontWeight: '500',
  },
  body: {
    padding: 18,
    maxHeight: 380,
  },
  greeting: {
    fontSize: 14,
    color: '#cbd5e1',
    marginBottom: 8,
  },
  boldText: {
    fontWeight: '700',
    color: '#f8fafc',
  },
  paragraph: {
    fontSize: 13,
    color: '#94a3b8',
    lineHeight: 18,
    marginBottom: 16,
  },
  pointRow: {
    flexDirection: 'row',
    marginBottom: 14,
  },
  pointNumber: {
    fontSize: 14,
    fontWeight: '700',
    color: '#38bdf8',
    width: 22,
    marginTop: 1,
  },
  pointContent: {
    flex: 1,
  },
  pointTitle: {
    fontSize: 13,
    fontWeight: '700',
    color: '#e2e8f0',
    marginBottom: 2,
  },
  pointText: {
    fontSize: 12,
    color: '#94a3b8',
    lineHeight: 17,
  },
  badgeContainer: {
    backgroundColor: '#0284c720',
    borderColor: '#0284c7',
    borderWidth: 1,
    borderRadius: 8,
    padding: 10,
    alignItems: 'center',
    marginTop: 10,
    marginBottom: 12,
  },
  badgeText: {
    fontSize: 11,
    fontWeight: '600',
    color: '#38bdf8',
  },
  footer: {
    flexDirection: 'row',
    padding: 16,
    borderTopWidth: 1,
    borderTopColor: '#334155',
    backgroundColor: '#0f172a',
    gap: 12,
  },
  declineButton: {
    flex: 1,
    paddingVertical: 13,
    borderRadius: 10,
    backgroundColor: '#334155',
    alignItems: 'center',
  },
  declineButtonText: {
    fontSize: 14,
    fontWeight: '600',
    color: '#cbd5e1',
  },
  acceptButton: {
    flex: 1.4,
    paddingVertical: 13,
    borderRadius: 10,
    backgroundColor: '#0284c7',
    alignItems: 'center',
  },
  acceptButtonText: {
    fontSize: 14,
    fontWeight: '700',
    color: '#ffffff',
  },
});
