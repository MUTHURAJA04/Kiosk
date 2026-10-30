import React from 'react';
import { StyleSheet, Text, View } from 'react-native';

/**
 * Standard Status Color Palette
 */
export const STATUS_COLORS = {
  idle: '#64748b',       // Neutral Slate (Waiting for face)
  detecting: '#64748b',  // Neutral Slate
  adjusting: '#f59e0b',  // Amber / Orange (Quality failure / adjustment)
  verifying: '#06b6d4',  // Cyan (Attendance verification hold)
  capturing: '#10b981',  // Emerald Green (Capturing clean frame)
  success: '#10b981',    // Emerald Green (Success punch / Capture complete)
  error: '#ef4444',      // Red (Access denied / Collision)
  cooldown: '#f97316',   // Vivid Orange
};

/**
 * Normalizes case-insensitive status string to standard palette keys
 */
export function resolvePillColor(status) {
  if (!status) return STATUS_COLORS.idle;
  const s = String(status).toLowerCase();
  if (s.includes('adjust') || s === 'positioning') return STATUS_COLORS.adjusting;
  if (s.includes('verify')) return STATUS_COLORS.verifying;
  if (s.includes('captur')) return STATUS_COLORS.capturing;
  if (s.includes('success') || s === 'match_verified') return STATUS_COLORS.success;
  if (s.includes('error') || s === 'access_denied') return STATUS_COLORS.error;
  if (s.includes('cooldown')) return STATUS_COLORS.cooldown;
  return STATUS_COLORS.idle;
}

/**
 * Reusable Centralized Status Pill Component
 * Positioned in a fixed, safe location (horizontally centered, above the face frame)
 * Displays ONLY the single action prompt or status message (No step dots, No numerical counters).
 */
export default function CentralizedStatusPill({
  status = 'idle',
  message = null,
  mode = 'attendance',
  userName = null,
}) {
  const pillColor = resolvePillColor(status);
  const normalizedStatus = String(status).toLowerCase();

  // Resolve message text (clean, action-driven, without numerical clutter)
  const resolveMessage = () => {
    if (message) return message;

    if (mode === 'registration') {
      if (normalizedStatus.includes('success')) return '✔ Face Enrolled';
      if (normalizedStatus.includes('captur')) return 'Hold steady';
      if (normalizedStatus.includes('adjust')) return 'Hold still and look at camera';
      if (normalizedStatus.includes('verify') || normalizedStatus === 'ready') return 'Ready';
      return 'Align face inside box';
    }

    // Attendance mode
    if (normalizedStatus.includes('success') || normalizedStatus === 'match_verified') {
      return `✔ Verified: ${userName || 'Access Granted'}`;
    }
    if (normalizedStatus.includes('error') || normalizedStatus === 'access_denied') {
      return '✖ Unknown Face';
    }
    if (normalizedStatus.includes('cooldown')) {
      return '⏱ Please wait...';
    }
    if (normalizedStatus.includes('verify')) {
      return '⚡ Verifying... Hold steady';
    }
    if (normalizedStatus.includes('adjust')) {
      return 'Hold still and look at camera';
    }
    return 'Align face inside box';
  };

  return (
    <View style={[styles.pillContainer, { borderColor: pillColor }]}>
      <Text style={styles.pillText}>
        {resolveMessage()}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  pillContainer: {
    alignSelf: 'center',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(15, 23, 42, 0.92)',
    paddingVertical: 10,
    paddingHorizontal: 22,
    borderRadius: 22,
    borderWidth: 1.5,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 3 },
    shadowOpacity: 0.35,
    shadowRadius: 5,
    elevation: 6,
    maxWidth: '94%',
  },
  pillText: {
    color: '#ffffff',
    fontSize: 14,
    fontWeight: '700',
    letterSpacing: 0.3,
    textAlign: 'center',
    lineHeight: 20,
  },
});
