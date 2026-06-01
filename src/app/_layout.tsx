import { DarkTheme, DefaultTheme, ThemeProvider } from 'expo-router';
import { useEffect, useState } from 'react';
import { useColorScheme } from 'react-native';
import 'react-native-get-random-values';
// 💡 FIXED: Imported useFonts from expo-font so it's globally accessible
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useFonts } from 'expo-font';

import { AnimatedSplashOverlay } from '@/components/animated-icon';
import AppTabs from '@/components/app-tabs';
import LandingScreen from './landing';

const PHANTOM_SESSION_KEY = 'solflip_phantom_session';

export default function TabLayout() {
  const colorScheme = useColorScheme();
  const [hasPhantomSession, setHasPhantomSession] = useState<boolean | null>(null);
  
  // ─── LOAD CUSTOM BINARY FONT ASSETS ──────────────────────────────────────
  const [loaded, error] = useFonts({
    'Orbitron': require('../../assets/fonts/Orbitron-Regular.ttf'),
    'Orbitron-Bold': require('../../assets/fonts/Orbitron-Bold.ttf'),
    'Orbitron-ExtraBold': require('../../assets/fonts/Orbitron-ExtraBold.ttf'),
    'Orbitron-SemiBold': require('../../assets/fonts/Orbitron-SemiBold.ttf'),
  });

  // ─── ERROR TRACKING LOG ──────────────────────────────────────────────────
  useEffect(() => {
    if (error) {
      console.error('Critical Error loading custom asset Orbitron.ttf:', error);
    }
  }, [error]);

  useEffect(() => {
    if (!loaded || error) return;

    let cancelled = false;

    const resolveSession = async () => {
      const phantomSession = await AsyncStorage.getItem(PHANTOM_SESSION_KEY);
      if (cancelled) return;
      setHasPhantomSession(Boolean(phantomSession));
    };

    void resolveSession();
    const intervalId = setInterval(() => {
      void resolveSession();
    }, 500);

    return () => {
      cancelled = true;
      clearInterval(intervalId);
    };
  }, [loaded, error]);

  // 💡 SAFETY VALVE: Hold rendering the core app navigation shell until the font file is ready.
  // This completely stops the "Sometimes font not loading" fallback glitch!
  if (!loaded && !error) {
    return (
      <ThemeProvider value={colorScheme === 'dark' ? DarkTheme : DefaultTheme}>
        <AnimatedSplashOverlay />
      </ThemeProvider>
    );
  }

  if (hasPhantomSession === null) {
    return (
      <ThemeProvider value={colorScheme === 'dark' ? DarkTheme : DefaultTheme}>
        <AnimatedSplashOverlay />
      </ThemeProvider>
    );
  }

  if (!hasPhantomSession) {
    return (
      <ThemeProvider value={colorScheme === 'dark' ? DarkTheme : DefaultTheme}>
        <LandingScreen />
      </ThemeProvider>
    );
  }

  return (
    <ThemeProvider value={colorScheme === 'dark' ? DarkTheme : DefaultTheme}>
      {/* Font is 100% loaded here, so child views can render flawlessly */}
      <AppTabs />
    </ThemeProvider>
  );
}