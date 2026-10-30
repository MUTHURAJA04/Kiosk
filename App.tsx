import React, { useEffect } from 'react';
import { StatusBar, Text, useWindowDimensions } from 'react-native';
import { NavigationContainer } from '@react-navigation/native';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { SafeAreaProvider, useSafeAreaInsets } from 'react-native-safe-area-context';

import SplashScreen from './src/screens/SplashScreen';
import LoginScreen from './src/screens/LoginScreen';
import AttendanceScreen from './src/screens/AttendanceScreen';
import EnrollmentScreen from './src/screens/EnrollmentScreen';
import RegisterScreen from './src/screens/RegisterScreen';
import SettingsScreen from './src/screens/SettingsScreen';
import { getDb } from './src/database/db';
import { startSyncWorker, stopSyncWorker } from './src/services/syncService';
import { NativeFacePipeline } from './src/services/nativeFacePipeline';
import ttsService from './src/services/ttsService';
import {
  AdminSecurityProvider,
  useAdminSecurity,
  navigationRef,
} from './src/context/AdminSecurityContext';
import AdminPasscodeModal from './src/components/AdminPasscodeModal';

const RootStack = createNativeStackNavigator();
const Tab = createBottomTabNavigator();
const EnrollmentStack = createNativeStackNavigator();

/**
 * Stack Navigator for the Employee Directory & Dedicated Fullscreen Face Registration
 */
function EnrollmentStackNavigator() {
  const { width, height } = useWindowDimensions();
  const isTablet = Math.min(width, height) >= 600;

  return (
    <EnrollmentStack.Navigator
      screenOptions={{
        headerStyle: { backgroundColor: '#0f172a' },
        headerTintColor: '#f8fafc',
        headerTitleStyle: { fontWeight: '700', fontSize: isTablet ? 18 : 16 },
      }}
    >
      <EnrollmentStack.Screen
        name="EnrollmentList"
        component={EnrollmentScreen}
        options={{
          title: 'Employee Directory',
        }}
      />
      <EnrollmentStack.Screen
        name="RegisterFace"
        component={RegisterScreen}
        options={{
          headerShown: false,
          animation: 'slide_from_right',
        }}
      />
    </EnrollmentStack.Navigator>
  );
}

/**
 * Main Kiosk Tabs (Attendance, Employees Directory, Settings)
 * Dynamic insets calculation prevents overlap with Android 3-button nav or gesture bar.
 */
function MainTabs() {
  const {
    isAdminUnlocked,
    isModalVisible,
    targetLabel,
    requestAdminAccess,
    cancelAdminAccess,
    verifyAndUnlock,
    resetInactivityTimer,
  } = useAdminSecurity();

  // Dynamic layout calculations directly from native safe-area and window hooks
  const insets = useSafeAreaInsets();
  const { width, height } = useWindowDimensions();
  const isTablet = Math.min(width, height) >= 600;

  const baseHeight = isTablet ? 70 : 60;
  const tabBarHeight = baseHeight + insets.bottom;
  const tabBarPaddingBottom = insets.bottom > 0 ? insets.bottom : (isTablet ? 10 : 8);
  const iconSize = isTablet ? 22 : 18;
  const labelFontSize = isTablet ? 14 : 12;

  return (
    <>
      <Tab.Navigator
        screenOptions={{
          headerStyle: { backgroundColor: '#0f172a' },
          headerTintColor: '#f8fafc',
          headerTitleStyle: { fontWeight: '700', fontSize: isTablet ? 18 : 16 },
          tabBarStyle: {
            backgroundColor: '#0f172a',
            borderTopColor: '#1e293b',
            borderTopWidth: 1,
            height: tabBarHeight,
            paddingBottom: tabBarPaddingBottom,
            paddingTop: isTablet ? 10 : 8,
          },
          tabBarActiveTintColor: '#38bdf8',
          tabBarInactiveTintColor: '#64748b',
          tabBarLabelStyle: {
            fontSize: labelFontSize,
            fontWeight: '600',
          },
          tabBarItemStyle: {
            justifyContent: 'center',
            alignItems: 'center',
          },
        }}
      >
        <Tab.Screen
          name="Attendance"
          component={AttendanceScreen}
          options={{
            headerShown: false,
            title: 'Kiosk Attendance',
            tabBarLabel: 'Attendance',
            tabBarIcon: ({ color }) => (
              <Text style={{ color, fontSize: iconSize }}>📸</Text>
            ),
          }}
          listeners={{
            tabPress: () => {
              if (isAdminUnlocked) {
                resetInactivityTimer();
              }
            },
          }}
        />
        <Tab.Screen
          name="Enrollment"
          component={EnrollmentStackNavigator}
          options={{
            headerShown: false,
            tabBarLabel: 'Employees',
            tabBarIcon: ({ color }) => (
              <Text style={{ color, fontSize: iconSize }}>👥</Text>
            ),
          }}
          listeners={({ navigation }) => ({
            tabPress: (e) => {
              if (!isAdminUnlocked) {
                e.preventDefault();
                requestAdminAccess('Enrollment', () => {
                  navigation.navigate('Enrollment');
                });
              } else {
                resetInactivityTimer();
              }
            },
          })}
        />
        <Tab.Screen
          name="Settings"
          component={SettingsScreen}
          options={{
            title: 'Kiosk Settings',
            tabBarLabel: 'Settings',
            tabBarIcon: ({ color }) => (
              <Text style={{ color, fontSize: iconSize }}>⚙️</Text>
            ),
          }}
          listeners={({ navigation }) => ({
            tabPress: (e) => {
              if (!isAdminUnlocked) {
                e.preventDefault();
                requestAdminAccess('Settings', () => {
                  navigation.navigate('Settings');
                });
              } else {
                resetInactivityTimer();
              }
            },
          })}
        />
      </Tab.Navigator>

      <AdminPasscodeModal
        visible={isModalVisible}
        targetLabel={targetLabel}
        onVerify={verifyAndUnlock}
        onCancel={cancelAdminAccess}
      />
    </>
  );
}

export default function App() {
  useEffect(() => {
    // 1. Initialize SQLite database tables & schema
    try {
      getDb();
      console.log('[App] SQLite database initialized.');
    } catch (e) {
      console.error('[App] Database init error:', e);
    }

    // 2. Warm-up unified Native Face Pipeline (ML Kit + GPU/NNAPI/CPU EdgeFace)
    NativeFacePipeline.init().then((info) => {
      console.log('[App] NativeFacePipeline initialized:', info);
    }).catch((err) => {
      console.warn('[App] NativeFacePipeline init error:', err);
    });

    // 3. Start offline cloud sync queue worker
    startSyncWorker(15000);

    // 4. Pre-warm Native Tamil TTS engine
    ttsService.initTts().catch((err) => {
      console.warn('[App] Native TTS init warning:', err?.message || err);
    });

    return () => {
      stopSyncWorker();
    };
  }, []);

  return (
    <SafeAreaProvider>
      <AdminSecurityProvider>
        <StatusBar barStyle="light-content" backgroundColor="#0a0f1d" />
        <NavigationContainer ref={navigationRef}>
          <RootStack.Navigator
            initialRouteName="Splash"
            screenOptions={{
              headerShown: false,
            }}
          >
            <RootStack.Screen name="Splash" component={SplashScreen} />
            <RootStack.Screen name="Login" component={LoginScreen} />
            <RootStack.Screen name="MainTabs" component={MainTabs} />
          </RootStack.Navigator>
        </NavigationContainer>
      </AdminSecurityProvider>
    </SafeAreaProvider>
  );
}
