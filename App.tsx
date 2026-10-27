import React, { useEffect } from 'react';
import { StatusBar, Text } from 'react-native';
import { NavigationContainer } from '@react-navigation/native';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import AttendanceScreen from './src/screens/AttendanceScreen';
import EnrollmentScreen from './src/screens/EnrollmentScreen';
import RegisterScreen from './src/screens/RegisterScreen';
import SettingsScreen from './src/screens/SettingsScreen';
import CalibrationScreen from './src/screens/CalibrationScreen';
import { getDb } from './src/database/db';
import { startSyncWorker, stopSyncWorker } from './src/services/syncService';
import { NativeFacePipeline } from './src/services/nativeFacePipeline';

const Tab = createBottomTabNavigator();
const Stack = createNativeStackNavigator();

/**
 * Stack Navigator for the Employee Directory & Dedicated Fullscreen Face Registration
 */
function EnrollmentStackNavigator() {
  return (
    <Stack.Navigator
      screenOptions={{
        headerStyle: { backgroundColor: '#0f172a' },
        headerTintColor: '#f8fafc',
        headerTitleStyle: { fontWeight: '700' },
      }}
    >
      <Stack.Screen
        name="EnrollmentList"
        component={EnrollmentScreen}
        options={{
          title: 'Employee Directory',
        }}
      />
      <Stack.Screen
        name="RegisterFace"
        component={RegisterScreen}
        options={{
          headerShown: false, // Dedicated camera screen has its own top header & back button
          animation: 'slide_from_right',
        }}
      />
      <Stack.Screen
        name="Calibration"
        component={CalibrationScreen}
        options={{
          title: 'Biometric Calibration (Phase 6)',
          animation: 'slide_from_right',
        }}
      />
    </Stack.Navigator>
  );
}

export default function App() {
  useEffect(() => {
    // Initialize SQLite database tables & schema
    try {
      getDb();
      console.log('[App] SQLite database initialized.');
    } catch (e) {
      console.error('[App] Database init error:', e);
    }

    // Warm-up unified Native Face Pipeline (ML Kit + GPU/NNAPI/CPU EdgeFace)
    NativeFacePipeline.init().then((info) => {
      console.log('[App] NativeFacePipeline initialized:', info);
    }).catch((err) => {
      console.warn('[App] NativeFacePipeline init error:', err);
    });

    // Start offline cloud sync queue worker
    startSyncWorker(15000);

    return () => {
      stopSyncWorker();
    };
  }, []);

  return (
    <SafeAreaProvider>
      <StatusBar barStyle="light-content" backgroundColor="#0f172a" />
      <NavigationContainer>
        <Tab.Navigator
          screenOptions={{
            headerStyle: { backgroundColor: '#0f172a' },
            headerTintColor: '#f8fafc',
            headerTitleStyle: { fontWeight: '700' },
            tabBarStyle: {
              backgroundColor: '#0f172a',
              borderTopColor: '#1e293b',
              height: 64,
              paddingBottom: 10,
              paddingTop: 8,
            },
            tabBarActiveTintColor: '#38bdf8',
            tabBarInactiveTintColor: '#64748b',
            tabBarLabelStyle: {
              fontSize: 13,
              fontWeight: '600',
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
                <Text style={{ color, fontSize: 18 }}>📸</Text>
              ),
            }}
          />
          <Tab.Screen
            name="Enrollment"
            component={EnrollmentStackNavigator}
            options={{
              headerShown: false,
              tabBarLabel: 'Employees',
              tabBarIcon: ({ color }) => (
                <Text style={{ color, fontSize: 18 }}>👥</Text>
              ),
            }}
          />
          <Tab.Screen
            name="Settings"
            component={SettingsScreen}
            options={{
              title: 'Kiosk Settings',
              tabBarLabel: 'Settings',
              tabBarIcon: ({ color }) => (
                <Text style={{ color, fontSize: 18 }}>⚙️</Text>
              ),
            }}
          />
        </Tab.Navigator>
      </NavigationContainer>
    </SafeAreaProvider>
  );
}
