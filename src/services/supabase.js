import 'react-native-url-polyfill/auto';
import { AppState } from 'react-native';
import { createClient } from '@supabase/supabase-js';
import AsyncStorage from '../utils/AsyncStorage';

const supabaseUrl = 'https://bztspepijnvskcwjwjeb.supabase.co';
const supabaseAnonKey = 'sb_publishable_WmVF8jHtS-OYJd6OnhD6wQ_KjU63bf6';

export const supabase = createClient(supabaseUrl, supabaseAnonKey, {
  auth: {
    storage: AsyncStorage,
    autoRefreshToken: true,
    persistSession: true,
    detectSessionInUrl: false,
  },
});

// Auto-refresh Lifecycle Listener
AppState.addEventListener('change', (state) => {
  if (state === 'active') {
    supabase.auth.startAutoRefresh();
  } else {
    supabase.auth.stopAutoRefresh();
  }
});

/**
 * Remote Force Logout Listener (Kiosk Security)
 * Subscribes to realtime organization_settings changes
 */
export function subscribeToRemoteLogout(onLogoutRequired) {
  const channel = supabase
    .channel('kiosk_security')
    .on(
      'postgres_changes',
      {
        event: 'UPDATE',
        schema: 'public',
        table: 'organization_settings',
        filter: 'key=eq.kiosk_session_version',
      },
      () => {
        if (typeof onLogoutRequired === 'function') {
          onLogoutRequired();
        }
      }
    )
    .subscribe();

  return () => {
    supabase.removeChannel(channel);
  };
}

/**
 * Realtime Employee Directory Listener
 * Subscribes to realtime INSERT, UPDATE, DELETE on employees table
 */
export function subscribeToEmployeeChanges(onChange) {
  const channel = supabase
    .channel('realtime_employees')
    .on(
      'postgres_changes',
      {
        event: '*',
        schema: 'public',
        table: 'employees',
      },
      (payload) => {
        if (typeof onChange === 'function') {
          onChange(payload);
        }
      }
    )
    .subscribe();

  return () => {
    supabase.removeChannel(channel);
  };
}

export default supabase;
