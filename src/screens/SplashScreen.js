import React, { useEffect, useRef } from 'react';
import {
  StyleSheet,
  View,
  Text,
  Animated,
  Easing,
  StatusBar,
  useWindowDimensions,
} from 'react-native';
import { supabase } from '../services/supabase';
import { EmployeeStorage } from '../services/employeeStorage';

export default function SplashScreen({ navigation }) {
  const { width, height } = useWindowDimensions();
  const pulseAnim = useRef(new Animated.Value(1)).current;
  const fadeAnim = useRef(new Animated.Value(0)).current;
  const rotateAnim = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    // 1. Futuristic Pulse & Rotate Animation
    Animated.timing(fadeAnim, {
      toValue: 1,
      duration: 600,
      useNativeDriver: true,
    }).start();

    Animated.loop(
      Animated.sequence([
        Animated.timing(pulseAnim, {
          toValue: 1.15,
          duration: 900,
          easing: Easing.inOut(Easing.ease),
          useNativeDriver: true,
        }),
        Animated.timing(pulseAnim, {
          toValue: 1,
          duration: 900,
          easing: Easing.inOut(Easing.ease),
          useNativeDriver: true,
        }),
      ])
    ).start();

    Animated.loop(
      Animated.timing(rotateAnim, {
        toValue: 1,
        duration: 8000,
        easing: Easing.linear,
        useNativeDriver: true,
      })
    ).start();

    // 2. Instant Cache Warm: Reads local AsyncStorage into memory (<50ms)
    EmployeeStorage.init().catch((err) => {
      console.warn('[SplashScreen] EmployeeStorage warm-up warning:', err);
    });

    const prepareAndNavigate = async () => {
      // Minimum display time for biometric boot screen
      const minDisplayPromise = new Promise((resolve) => setTimeout(resolve, 1800));

      // Instant local session check (AsyncStorage under the hood)
      const sessionPromise = supabase.auth.getSession().catch(() => ({ data: { session: null } }));

      // Concurrently perform background incremental delta-sync
      const syncPromise = EmployeeStorage.syncEmployeesFromCloud().catch((err) => {
        console.warn('[SplashScreen] Sync error:', err);
        return [];
      });

      // Run all concurrently
      const [, sessionResult] = await Promise.all([
        minDisplayPromise,
        sessionPromise,
        syncPromise,
      ]);

      const session = sessionResult?.data?.session;
      const destination = session ? 'MainTabs' : 'Login';

      // Smooth transition to destination
      Animated.timing(fadeAnim, {
        toValue: 0,
        duration: 350,
        useNativeDriver: true,
      }).start(() => {
        navigation.replace(destination);
      });
    };

    prepareAndNavigate();
  }, [navigation, fadeAnim, pulseAnim, rotateAnim]);

  const spin = rotateAnim.interpolate({
    inputRange: [0, 1],
    outputRange: ['0deg', '360deg'],
  });

  return (
    <View style={styles.container}>
      <StatusBar barStyle="light-content" backgroundColor="#0a0f1d" />

      <Animated.View style={[styles.contentContainer, { opacity: fadeAnim }]}>
        {/* Biometric Scanner Visual */}
        <View style={styles.scannerRingWrapper}>
          <Animated.View
            style={[
              styles.scannerOuterRing,
              {
                transform: [{ rotate: spin }],
              },
            ]}
          />
          <Animated.View
            style={[
              styles.scannerIconWrapper,
              {
                transform: [{ scale: pulseAnim }],
              },
            ]}
          >
            <Text style={styles.biometricGlyph}>👤</Text>
          </Animated.View>
        </View>

        {/* Brand & Terminal Identity */}
        <Text style={styles.brandTitle}>EdgeFace Kiosk</Text>
        <Text style={styles.brandSubtitle}>High-Precision Biometric Terminal</Text>

        {/* Status Indicator */}
        <View style={styles.statusPill}>
          <View style={styles.statusDot} />
          <Text style={styles.statusText}>Warming Neural Inference Engine...</Text>
        </View>

        {/* Footer Hardware & Security Badge */}
        <View style={styles.footer}>
          <Text style={styles.footerText}>SIMD-Accelerated MobileFaceNet 512-D</Text>
          <Text style={styles.footerVersion}>Offline-First Cloud Sync v2.5</Text>
        </View>
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#0a0f1d',
    justifyContent: 'center',
    alignItems: 'center',
  },
  contentContainer: {
    alignItems: 'center',
    justifyContent: 'center',
    width: '100%',
    paddingHorizontal: 24,
  },
  scannerRingWrapper: {
    width: 140,
    height: 140,
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: 32,
  },
  scannerOuterRing: {
    position: 'absolute',
    width: 130,
    height: 130,
    borderRadius: 65,
    borderWidth: 2,
    borderColor: '#38bdf8',
    borderStyle: 'dashed',
    opacity: 0.7,
  },
  scannerIconWrapper: {
    width: 90,
    height: 90,
    borderRadius: 45,
    backgroundColor: 'rgba(56, 189, 248, 0.12)',
    borderWidth: 1.5,
    borderColor: '#38bdf8',
    justifyContent: 'center',
    alignItems: 'center',
    shadowColor: '#38bdf8',
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.6,
    shadowRadius: 16,
    elevation: 8,
  },
  biometricGlyph: {
    fontSize: 42,
  },
  brandTitle: {
    fontSize: 28,
    fontWeight: '800',
    color: '#f8fafc',
    letterSpacing: 0.8,
    marginBottom: 6,
  },
  brandSubtitle: {
    fontSize: 14,
    color: '#94a3b8',
    fontWeight: '500',
    marginBottom: 28,
  },
  statusPill: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#1e293b',
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: '#334155',
  },
  statusDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: '#38bdf8',
    marginRight: 8,
  },
  statusText: {
    fontSize: 12,
    color: '#cbd5e1',
    fontWeight: '600',
  },
  footer: {
    position: 'absolute',
    bottom: -160,
    alignItems: 'center',
  },
  footerText: {
    fontSize: 12,
    color: '#64748b',
    fontWeight: '500',
  },
  footerVersion: {
    fontSize: 11,
    color: '#475569',
    marginTop: 4,
  },
});
