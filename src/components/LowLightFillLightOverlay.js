import React, { useEffect } from 'react';
import { StyleSheet, View } from 'react-native';
import { NativeFacePipeline } from '../services/nativeFacePipeline';

/**
 * Phase 4: Screen Fill-Light Overlay
 * When face brightness is below 60 for 500ms, provides bright white screen perimeter illumination
 * and sets hardware screen brightness to maximum (1.0).
 * Restores original brightness automatically when exiting or when ambient light recovers.
 */
export default function LowLightFillLightOverlay({ active = false }) {
  useEffect(() => {
    if (active) {
      console.log('[LowLight] Activating Screen Fill-Light at 100% brightness');
      NativeFacePipeline.setScreenBrightness(1.0).catch(console.warn);
    } else {
      NativeFacePipeline.restoreScreenBrightness().catch(console.warn);
    }

    return () => {
      NativeFacePipeline.restoreScreenBrightness().catch(console.warn);
    };
  }, [active]);

  if (!active) return null;

  return (
    <View style={StyleSheet.absoluteFill} pointerEvents="none">
      {/* Outer High-Luminance White Fill Border */}
      <View style={styles.topBar} />
      <View style={styles.bottomBar} />
      <View style={styles.leftBar} />
      <View style={styles.rightBar} />

      {/* Gentle central translucent glow */}
      <View style={styles.centerGlow} />
    </View>
  );
}

const styles = StyleSheet.create({
  topBar: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    height: 70,
    backgroundColor: '#ffffff',
    shadowColor: '#ffffff',
    shadowOffset: { width: 0, height: 10 },
    shadowOpacity: 0.9,
    shadowRadius: 20,
    elevation: 25,
    zIndex: 15,
  },
  bottomBar: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    height: 70,
    backgroundColor: '#ffffff',
    shadowColor: '#ffffff',
    shadowOffset: { width: 0, height: -10 },
    shadowOpacity: 0.9,
    shadowRadius: 20,
    elevation: 25,
    zIndex: 15,
  },
  leftBar: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    left: 0,
    width: 60,
    backgroundColor: '#ffffff',
    shadowColor: '#ffffff',
    shadowOffset: { width: 10, height: 0 },
    shadowOpacity: 0.9,
    shadowRadius: 20,
    elevation: 25,
    zIndex: 15,
  },
  rightBar: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    right: 0,
    width: 60,
    backgroundColor: '#ffffff',
    shadowColor: '#ffffff',
    shadowOffset: { width: -10, height: 0 },
    shadowOpacity: 0.9,
    shadowRadius: 20,
    elevation: 25,
    zIndex: 15,
  },
  centerGlow: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(255, 255, 255, 0.35)',
    zIndex: 14,
  },
});
