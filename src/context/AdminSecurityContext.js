import React, { createContext, useContext, useState, useEffect, useRef, useCallback } from 'react';
import AsyncStorage from '../utils/AsyncStorage';
import { createNavigationContainerRef } from '@react-navigation/native';

export const navigationRef = createNavigationContainerRef();

const ADMIN_PIN_STORAGE_KEY = '@kiosk_admin_pin';
const DEFAULT_ADMIN_PIN = '1234';
const AUTO_RELOCK_TIMEOUT_MS = 2 * 60 * 1000; // 2 minutes inactivity timeout

const AdminSecurityContext = createContext({
  isAdminUnlocked: false,
  isModalVisible: false,
  pendingTarget: null,
  targetLabel: '',
  adminPin: DEFAULT_ADMIN_PIN,
  timeRemainingSeconds: 0,
  requestAdminAccess: () => {},
  cancelAdminAccess: () => {},
  verifyAndUnlock: () => false,
  lockAdmin: () => {},
  resetInactivityTimer: () => {},
  updateAdminPin: async () => {},
});

export function AdminSecurityProvider({ children }) {
  // In-memory unlock state — NEVER persisted to storage so restarts start locked
  const [isAdminUnlocked, setIsAdminUnlocked] = useState(false);
  const [adminPin, setAdminPin] = useState(DEFAULT_ADMIN_PIN);

  // Modal display states
  const [isModalVisible, setIsModalVisible] = useState(false);
  const [pendingTarget, setPendingTarget] = useState(null);
  const [targetLabel, setTargetLabel] = useState('');
  const [pendingCallback, setPendingCallback] = useState(null);

  // Auto-relock timer ref
  const relockTimerRef = useRef(null);
  const lockCallbackRef = useRef(null);

  // 1. Load custom PIN from local storage on mount
  useEffect(() => {
    AsyncStorage.getItem(ADMIN_PIN_STORAGE_KEY)
      .then((stored) => {
        if (stored && /^\d{4}$/.test(stored)) {
          setAdminPin(stored);
        } else {
          setAdminPin(DEFAULT_ADMIN_PIN);
          AsyncStorage.setItem(ADMIN_PIN_STORAGE_KEY, DEFAULT_ADMIN_PIN).catch(() => {});
        }
      })
      .catch((err) => {
        console.warn('[AdminSecurity] Error loading PIN from storage:', err);
      });
  }, []);

  /**
   * Safely redirects the terminal back to the public Attendance screen
   */
  const redirectToAttendance = useCallback(() => {
    if (navigationRef.isReady()) {
      const currentRoute = navigationRef.getCurrentRoute();
      const currentName = currentRoute?.name;
      // If user is currently on an admin-restricted screen, bounce back to Attendance
      if (currentName !== 'Attendance' && currentName !== 'Login' && currentName !== 'Splash') {
        console.log(`[AdminSecurity] Auto-relock: Redirecting from "${currentName}" back to "Attendance"`);
        navigationRef.navigate('MainTabs', { screen: 'Attendance' });
      }
    }
  }, []);

  /**
   * Locks the admin session immediately
   */
  const lockAdmin = useCallback(() => {
    if (relockTimerRef.current) {
      clearTimeout(relockTimerRef.current);
      relockTimerRef.current = null;
    }
    console.log('[AdminSecurity] Admin session locked.');
    setIsAdminUnlocked(false);
    redirectToAttendance();
  }, [redirectToAttendance]);

  /**
   * Resets the 2-minute auto-relock inactivity countdown
   */
  const resetInactivityTimer = useCallback(() => {
    if (relockTimerRef.current) {
      clearTimeout(relockTimerRef.current);
    }
    relockTimerRef.current = setTimeout(() => {
      console.log('[AdminSecurity] 2-minute inactivity threshold reached. Auto-relocking admin session.');
      lockAdmin();
    }, AUTO_RELOCK_TIMEOUT_MS);
  }, [lockAdmin]);

  // Keep lockAdmin ref fresh for timer
  useEffect(() => {
    lockCallbackRef.current = lockAdmin;
  }, [lockAdmin]);

  // Clear timer on unmount
  useEffect(() => {
    return () => {
      if (relockTimerRef.current) {
        clearTimeout(relockTimerRef.current);
      }
    };
  }, []);

  /**
   * Called when a tab press is intercepted
   */
  const requestAdminAccess = useCallback((targetRoute, onSuccess) => {
    const label =
      targetRoute === 'Enrollment'
        ? 'Employee Directory'
        : targetRoute === 'Settings'
        ? 'Terminal Settings'
        : targetRoute;

    setPendingTarget(targetRoute);
    setTargetLabel(label);
    setPendingCallback(() => onSuccess);
    setIsModalVisible(true);
  }, []);

  /**
   * Cancels PIN entry and keeps user on current screen (Attendance)
   */
  const cancelAdminAccess = useCallback(() => {
    setIsModalVisible(false);
    setPendingTarget(null);
    setPendingCallback(null);
  }, []);

  /**
   * Verifies the 4-digit PIN against the active admin PIN
   */
  const verifyAndUnlock = useCallback(
    (inputPin) => {
      if (inputPin === adminPin) {
        console.log('[AdminSecurity] PIN verified. Granting admin access.');
        setIsAdminUnlocked(true);
        setIsModalVisible(false);
        resetInactivityTimer();

        // Execute pending navigation if provided
        if (typeof pendingCallback === 'function') {
          try {
            pendingCallback();
          } catch (e) {
            console.warn('[AdminSecurity] Navigation callback error:', e);
          }
        }

        setPendingTarget(null);
        setPendingCallback(null);
        return true;
      }
      return false;
    },
    [adminPin, pendingCallback, resetInactivityTimer]
  );

  /**
   * Updates the admin PIN
   */
  const updateAdminPin = useCallback(async (newPin) => {
    if (!newPin || !/^\d{4}$/.test(newPin)) {
      throw new Error('PIN must be exactly 4 digits');
    }
    await AsyncStorage.setItem(ADMIN_PIN_STORAGE_KEY, newPin);
    setAdminPin(newPin);
    console.log('[AdminSecurity] Admin PIN successfully updated.');
  }, []);

  return (
    <AdminSecurityContext.Provider
      value={{
        isAdminUnlocked,
        isModalVisible,
        pendingTarget,
        targetLabel,
        adminPin,
        requestAdminAccess,
        cancelAdminAccess,
        verifyAndUnlock,
        lockAdmin,
        resetInactivityTimer,
        updateAdminPin,
      }}
    >
      {children}
    </AdminSecurityContext.Provider>
  );
}

export function useAdminSecurity() {
  const context = useContext(AdminSecurityContext);
  if (!context) {
    throw new Error('useAdminSecurity must be used within an AdminSecurityProvider');
  }
  return context;
}

export default AdminSecurityContext;
