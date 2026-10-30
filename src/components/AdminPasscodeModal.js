import React, { useState, useEffect, useRef } from 'react';
import {
  StyleSheet,
  View,
  Text,
  Modal,
  TouchableOpacity,
  Animated,
  useWindowDimensions,
} from 'react-native';

const PIN_LENGTH = 4;

export default function AdminPasscodeModal({
  visible,
  targetLabel = 'Admin Controls',
  onVerify,
  onCancel,
}) {
  const { width } = useWindowDimensions();
  const [pin, setPin] = useState('');
  const [errorText, setErrorText] = useState('');
  const [isVerifying, setIsVerifying] = useState(false);

  // Shake animation on wrong PIN
  const shakeAnim = useRef(new Animated.Value(0)).current;

  // Reset state whenever modal visibility changes
  useEffect(() => {
    if (visible) {
      setPin('');
      setErrorText('');
      setIsVerifying(false);
      shakeAnim.setValue(0);
    }
  }, [visible, shakeAnim]);

  /**
   * Triggers a horizontal shake animation for invalid PIN
   */
  const triggerShake = () => {
    Animated.sequence([
      Animated.timing(shakeAnim, { toValue: 10, duration: 60, useNativeDriver: true }),
      Animated.timing(shakeAnim, { toValue: -10, duration: 60, useNativeDriver: true }),
      Animated.timing(shakeAnim, { toValue: 8, duration: 60, useNativeDriver: true }),
      Animated.timing(shakeAnim, { toValue: -8, duration: 60, useNativeDriver: true }),
      Animated.timing(shakeAnim, { toValue: 0, duration: 60, useNativeDriver: true }),
    ]).start();
  };

  /**
   * Handles digit press from on-screen keypad
   */
  const handleDigitPress = (digit) => {
    if (isVerifying || pin.length >= PIN_LENGTH) return;
    setErrorText('');

    const newPin = pin + digit;
    setPin(newPin);

    // Auto-verify as soon as 4 digits are completed
    if (newPin.length === PIN_LENGTH) {
      setIsVerifying(true);
      setTimeout(() => {
        const isValid = onVerify(newPin);
        if (!isValid) {
          setErrorText('Incorrect PIN. Please try again.');
          triggerShake();
          setPin('');
          setIsVerifying(false);
        }
      }, 100);
    }
  };

  /**
   * Backspace / Delete last digit
   */
  const handleBackspace = () => {
    if (isVerifying) return;
    setErrorText('');
    setPin((prev) => prev.slice(0, -1));
  };

  /**
   * Cancel and dismiss
   */
  const handleCancel = () => {
    setPin('');
    setErrorText('');
    if (typeof onCancel === 'function') {
      onCancel();
    }
  };

  if (!visible) return null;

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={handleCancel}
      statusBarTranslucent
    >
      <View style={styles.backdrop}>
        <Animated.View
          style={[
            styles.card,
            { maxWidth: Math.min(width - 32, 400) },
            { transform: [{ translateX: shakeAnim }] },
          ]}
        >
          {/* Header Icon & Title */}
          <View style={styles.header}>
            <View style={styles.iconCircle}>
              <Text style={styles.iconText}>🔒</Text>
            </View>
            <Text style={styles.title}>Admin Verification</Text>
            <Text style={styles.subtitle}>
              Enter 4-digit PIN to access{'\n'}
              <Text style={styles.targetHighlight}>{targetLabel}</Text>
            </Text>
          </View>

          {/* 4-Digit PIN Indicators */}
          <View style={styles.dotsRow}>
            {[0, 1, 2, 3].map((index) => {
              const isFilled = pin.length > index;
              const hasError = Boolean(errorText);
              return (
                <View
                  key={index}
                  style={[
                    styles.dotBox,
                    isFilled && styles.dotBoxFilled,
                    hasError && styles.dotBoxError,
                  ]}
                >
                  {isFilled && (
                    <View
                      style={[
                        styles.dotInner,
                        hasError && styles.dotInnerError,
                      ]}
                    />
                  )}
                </View>
              );
            })}
          </View>

          {/* Error Message */}
          <View style={styles.errorContainer}>
            {errorText ? (
              <Text style={styles.errorText}>{errorText}</Text>
            ) : null}
          </View>

          {/* On-Screen Kiosk Keypad */}
          <View style={styles.keypad}>
            {/* Row 1 */}
            <View style={styles.keypadRow}>
              {['1', '2', '3'].map((digit) => (
                <TouchableOpacity
                  key={digit}
                  style={styles.keyButton}
                  onPress={() => handleDigitPress(digit)}
                  activeOpacity={0.6}
                >
                  <Text style={styles.keyText}>{digit}</Text>
                </TouchableOpacity>
              ))}
            </View>

            {/* Row 2 */}
            <View style={styles.keypadRow}>
              {['4', '5', '6'].map((digit) => (
                <TouchableOpacity
                  key={digit}
                  style={styles.keyButton}
                  onPress={() => handleDigitPress(digit)}
                  activeOpacity={0.6}
                >
                  <Text style={styles.keyText}>{digit}</Text>
                </TouchableOpacity>
              ))}
            </View>

            {/* Row 3 */}
            <View style={styles.keypadRow}>
              {['7', '8', '9'].map((digit) => (
                <TouchableOpacity
                  key={digit}
                  style={styles.keyButton}
                  onPress={() => handleDigitPress(digit)}
                  activeOpacity={0.6}
                >
                  <Text style={styles.keyText}>{digit}</Text>
                </TouchableOpacity>
              ))}
            </View>

            {/* Row 4: Cancel, 0, Backspace */}
            <View style={styles.keypadRow}>
              <TouchableOpacity
                style={[styles.keyButton, styles.cancelKeyButton]}
                onPress={handleCancel}
                activeOpacity={0.6}
              >
                <Text style={styles.cancelKeyText}>Cancel</Text>
              </TouchableOpacity>

              <TouchableOpacity
                style={styles.keyButton}
                onPress={() => handleDigitPress('0')}
                activeOpacity={0.6}
              >
                <Text style={styles.keyText}>0</Text>
              </TouchableOpacity>

              <TouchableOpacity
                style={[styles.keyButton, styles.backspaceKeyButton]}
                onPress={handleBackspace}
                activeOpacity={0.6}
              >
                <Text style={styles.backspaceKeyText}>⌫</Text>
              </TouchableOpacity>
            </View>
          </View>
        </Animated.View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(10, 15, 29, 0.88)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 16,
  },
  card: {
    width: '100%',
    backgroundColor: '#0f172a',
    borderRadius: 24,
    padding: 24,
    borderWidth: 1.5,
    borderColor: '#1e293b',
    alignItems: 'center',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 12 },
    shadowOpacity: 0.5,
    shadowRadius: 20,
    elevation: 24,
  },
  header: {
    alignItems: 'center',
    marginBottom: 20,
  },
  iconCircle: {
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: 'rgba(56, 189, 248, 0.12)',
    borderWidth: 1.5,
    borderColor: 'rgba(56, 189, 248, 0.3)',
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: 12,
  },
  iconText: {
    fontSize: 26,
  },
  title: {
    fontSize: 20,
    fontWeight: '800',
    color: '#f8fafc',
    letterSpacing: 0.4,
    marginBottom: 4,
  },
  subtitle: {
    fontSize: 13,
    color: '#94a3b8',
    textAlign: 'center',
    lineHeight: 18,
  },
  targetHighlight: {
    color: '#38bdf8',
    fontWeight: '700',
  },
  dotsRow: {
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
    gap: 16,
    marginBottom: 12,
  },
  dotBox: {
    width: 48,
    height: 48,
    borderRadius: 14,
    backgroundColor: '#1e293b',
    borderWidth: 2,
    borderColor: '#334155',
    justifyContent: 'center',
    alignItems: 'center',
  },
  dotBoxFilled: {
    borderColor: '#38bdf8',
    backgroundColor: 'rgba(56, 189, 248, 0.08)',
  },
  dotBoxError: {
    borderColor: '#ef4444',
    backgroundColor: 'rgba(239, 68, 68, 0.08)',
  },
  dotInner: {
    width: 14,
    height: 14,
    borderRadius: 7,
    backgroundColor: '#38bdf8',
  },
  dotInnerError: {
    backgroundColor: '#ef4444',
  },
  errorContainer: {
    height: 24,
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: 16,
  },
  errorText: {
    fontSize: 13,
    fontWeight: '700',
    color: '#ef4444',
  },
  hintText: {
    fontSize: 12,
    color: '#64748b',
  },
  keypad: {
    width: '100%',
    gap: 12,
  },
  keypadRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    gap: 12,
  },
  keyButton: {
    flex: 1,
    height: 58,
    borderRadius: 16,
    backgroundColor: '#1e293b',
    borderWidth: 1,
    borderColor: '#334155',
    justifyContent: 'center',
    alignItems: 'center',
  },
  keyText: {
    fontSize: 22,
    fontWeight: '700',
    color: '#f8fafc',
  },
  cancelKeyButton: {
    backgroundColor: 'transparent',
    borderColor: '#334155',
  },
  cancelKeyText: {
    fontSize: 14,
    fontWeight: '700',
    color: '#94a3b8',
  },
  backspaceKeyButton: {
    backgroundColor: 'rgba(15, 23, 42, 0.6)',
    borderColor: '#334155',
  },
  backspaceKeyText: {
    fontSize: 20,
    fontWeight: '700',
    color: '#cbd5e1',
  },
});
