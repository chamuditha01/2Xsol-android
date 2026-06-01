/**
 * landing.tsx  —  Drop this in your app/(tabs)/ or app/ directory.
 *
 * Flow:
 *  1. On mount, check AsyncStorage / SecureStore for a saved local keypair.
 *  2. If found → navigate straight to the game screen (index).
 *  3. If NOT found → show this landing screen.
 *  4. "CONNECT" button → tries Phantom deeplink first.
 *     - If Phantom is installed, it opens Phantom, user approves, deeplink
 *       returns with the public key, we save it, navigate to game.
 *     - If Phantom is NOT installed, we fall back to generating an embedded
 *       local keypair (same as the original flow) and go straight to game.
 *
 * Phantom deeplink docs: https://docs.phantom.app/phantom-deeplinks/provider-methods/connect
 *
 * IMPORTANT: Add your app scheme to app.json:
 *   "scheme": "solflip"
 *
 * And install:
 *   npx expo install expo-linking expo-crypto expo-secure-store
 *   (tweetnacl is already pulled in by @solana/web3.js)
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import * as web3 from '@solana/web3.js';
import bs58 from 'bs58';
import { Buffer } from 'buffer';
import * as Linking from 'expo-linking';
import { router } from 'expo-router';
import * as SecureStore from 'expo-secure-store';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
    Animated,
    Dimensions,
    Easing,
    Pressable,
    StyleSheet,
    Text,
    View
} from 'react-native';
import 'react-native-get-random-values';
import { SafeAreaView } from 'react-native-safe-area-context';
import Svg, { G, Path, Polygon } from 'react-native-svg';
import nacl from 'tweetnacl';

if (typeof (globalThis as any).Buffer === 'undefined') (globalThis as any).Buffer = Buffer;

// ─── Constants ────────────────────────────────────────────────────────────────
const LOCAL_WALLET_KEY          = 'solflip_local_keypair';
const PHANTOM_SESSION_KEY       = 'solflip_phantom_session';  // stores phantom pubkey
const APP_SCHEME                = 'soldoublerandroid';                  // must match app.json "scheme"
const PHANTOM_CONNECT_URL       = 'https://phantom.app/ul/v1/connect';

const { width: SW, height: SH } = Dimensions.get('window');

// ─── Palette (matches game screen) ───────────────────────────────────────────
const C = {
  bg:      '#080b10',
  surface: '#0d1318',
  glass:   '#111820',
  border:  '#1c2530',
  accent:  '#c3f306',
  purple:  '#9945FF',
  text:    '#e8edf2',
  muted:   '#5a6a7a',
  white:   '#FFFFFF',
  black:   '#000000',
};

// ─── Helpers ─────────────────────────────────────────────────────────────────
const serializeKeypair   = (kp: web3.Keypair) => JSON.stringify(Array.from(kp.secretKey));
const deserializeKeypair = (s: string) => web3.Keypair.fromSecretKey(Uint8Array.from(JSON.parse(s)));

async function safeGet(key: string): Promise<string | null> {
  try {
    const stored = await SecureStore.getItemAsync(key);
    if (stored != null) return stored;
  } catch {}
  return AsyncStorage.getItem(key);
}

async function safeSet(key: string, value: string): Promise<void> {
  try { await SecureStore.setItemAsync(key, value); } catch {}
  await AsyncStorage.setItem(key, value);
}

// ─── Phantom helpers ──────────────────────────────────────────────────────────
function buildConnectDeeplink(dappKeyPair: nacl.BoxKeyPair, nonce: Uint8Array): string {
  const params = new URLSearchParams({
    dapp_encryption_public_key: bs58.encode(dappKeyPair.publicKey),
    nonce:                       bs58.encode(nonce),
    redirect_link:               `${APP_SCHEME}://onConnect`,
    cluster:                     'devnet',
    app_url:                     `${APP_SCHEME}://`,
  });
  return `${PHANTOM_CONNECT_URL}?${params.toString()}`;
}

// ─── Component ────────────────────────────────────────────────────────────────
export default function LandingScreen() {
  const [checking,    setChecking]    = useState(true);
  const [connecting,  setConnecting]  = useState(false);
  const [statusMsg,   setStatusMsg]   = useState('');

  // Dapp keypair for Phantom E2E encryption — ephemeral per session
  const dappKP    = useRef<nacl.BoxKeyPair>(nacl.box.keyPair());
  const nonceRef  = useRef<Uint8Array>(nacl.randomBytes(24));

  // ── Coin spin animation ──────────────────────────────────────────────────
  const coinAnim = useRef(new Animated.Value(0)).current;
  const glowAnim = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    // Slow idle wobble
    Animated.loop(
      Animated.sequence([
        Animated.timing(coinAnim, { toValue: 1, duration: 2200, easing: Easing.inOut(Easing.sin), useNativeDriver: true }),
        Animated.timing(coinAnim, { toValue: 0, duration: 2200, easing: Easing.inOut(Easing.sin), useNativeDriver: true }),
      ])
    ).start();
    // Pulse glow
    Animated.loop(
      Animated.sequence([
        Animated.timing(glowAnim, { toValue: 1, duration: 1400, easing: Easing.inOut(Easing.ease), useNativeDriver: true }),
        Animated.timing(glowAnim, { toValue: 0, duration: 1400, easing: Easing.inOut(Easing.ease), useNativeDriver: true }),
      ])
    ).start();
  }, []);

  const coinScaleY = coinAnim.interpolate({ inputRange: [0, 0.5, 1], outputRange: [1, 0.08, 1] });
  const glowOpacity = glowAnim.interpolate({ inputRange: [0, 1], outputRange: [0.3, 0.9] });

  // ── On mount: check if already have a wallet ─────────────────────────────
  useEffect(() => {
    setChecking(false);
  }, []);

  // ── Handle Phantom deeplink return ──────────────────────────────────────
  useEffect(() => {
    const sub = Linking.addEventListener('url', ({ url }) => {
      if (!url.includes('onConnect')) return;
      void handlePhantomCallback(url);
    });
    // Also handle cold-start URL
    Linking.getInitialURL().then(url => {
      if (url && url.includes('onConnect')) void handlePhantomCallback(url);
    });
    return () => sub.remove();
  }, []);

  const handlePhantomCallback = useCallback(async (url: string) => {
    try {
      setStatusMsg('VERIFYING WALLET...');
      const parsed    = Linking.parse(url);
      const params    = parsed.queryParams as Record<string, string> | null;

      if (!params) throw new Error('No params in deeplink');

      // Error from Phantom
      if (params.errorCode) {
        setStatusMsg(`PHANTOM ERROR: ${params.errorMessage ?? params.errorCode}`);
        setConnecting(false);
        return;
      }

      const phantomEncPubKey = bs58.decode(params.phantom_encryption_public_key);
      const nonce            = bs58.decode(params.nonce);
      const encData          = bs58.decode(params.data);

      // Decrypt
      const sharedSecret = nacl.box.before(phantomEncPubKey, dappKP.current.secretKey);
      const decrypted    = nacl.box.open.after(encData, nonce, sharedSecret);
      if (!decrypted) throw new Error('Decryption failed');

      const { public_key: phantomPubKey } = JSON.parse(Buffer.from(decrypted).toString('utf8'));

      // Save phantom public key as the "wallet"
      await safeSet(PHANTOM_SESSION_KEY, phantomPubKey);

      setStatusMsg('CONNECTED!');
      setTimeout(() => router.replace('/'), 400);
    } catch (e: any) {
      console.error('Phantom callback error:', e);
      setStatusMsg('ERR: ' + (e?.message ?? 'Deeplink parse failed'));
      setConnecting(false);
    }
  }, []);

  // ── Main connect handler ─────────────────────────────────────────────────
  const handleConnect = useCallback(async () => {
    if (connecting) return;
    setConnecting(true);
    setStatusMsg('CHECKING PHANTOM...');

    try {
      const savedSession = await safeGet(PHANTOM_SESSION_KEY);
      const storedLocalWallet = await safeGet(LOCAL_WALLET_KEY);
      if (savedSession) {
        setStatusMsg('CONNECTED!');
        router.replace('/');
        return;
      }

      if (storedLocalWallet) {
        setStatusMsg('WALLET READY!');
        router.replace('/');
        return;
      }

      // Try to open Phantom
      const phantomUrl = buildConnectDeeplink(dappKP.current, nonceRef.current);
      const canOpen    = await Linking.canOpenURL('phantom://');

      if (canOpen) {
        setStatusMsg('OPENING PHANTOM...');
        await Linking.openURL(phantomUrl);
        // Wait for deeplink callback — handled in useEffect above
        return;
      }

      // Phantom not installed → fall back to local embedded wallet
      setStatusMsg('PHANTOM NOT FOUND — CREATING LOCAL WALLET...');
      await new Promise(r => setTimeout(r, 600));

      const kp         = web3.Keypair.generate();
      const serialized = serializeKeypair(kp);
      await safeSet(LOCAL_WALLET_KEY, serialized);

      setStatusMsg('WALLET READY!');
      setTimeout(() => router.replace('/'), 500);
    } catch (e: any) {
      console.error('connect error:', e);
      setStatusMsg('ERR: ' + (e?.message ?? 'Connection failed'));
      setConnecting(false);
    }
  }, [connecting]);

  // ── Splash while checking storage ───────────────────────────────────────
  if (checking) {
    return (
      <View style={s.checkingScreen}>
        <Animated.View style={{ opacity: glowOpacity }}>
          <Svg width={80} height={86} viewBox="0 0 597.86 643.33">
            <Path fill={C.accent} d="M596.49,327.98c-11.95,118.61-94.41,225.51-94.41,225.51-99.74,71.17-203.12,88.36-203.12,88.36-5.45-1.53-10.78-3.06-16.06-4.68-114.05-34.59-184.85-84.9-202.52-98.44-2.89-2.19-4.37-3.41-4.37-3.41C3.84,407.74,1.37,314.75,1.37,314.75,25.38,191.6,92.46,91.86,92.46,91.86,182.33,26.42,268.96,5.79,286.53,2.1c2.13-.45,3.23-.62,3.23-.62,41.69,5.87,78.35,16.77,109.39,29.34,76.79,31.04,119.41,72.19,119.41,72.19,71.37,113.19,77.92,225,77.92,225v-.03Z"/>
          </Svg>
        </Animated.View>
      </View>
    );
  }

  // ── Main Landing ─────────────────────────────────────────────────────────
  return (
    <SafeAreaView style={s.root}>

      {/* ── TOP BAR ────────────────────────────────────────────────────── */}
      <View style={s.topBar}>
        <Svg width={90} height={76} viewBox="0 0 280.37 153.25">
          <Polygon fill="#121314" points="88.99 10.55 20.04 1.63 2.98 60.61 26.28 67.8 7.44 79.17 4.25 151.62 87.17 141.34 122.66 146.25 125.48 134.93 130.67 151.62 184.37 142.25 206.49 150.17 232.7 145.71 252.18 133.6 270.02 111.48 277.39 76.63 267.2 37.76 243.89 14.65 206.76 4.54 183.55 14.19 185.83 8.45 131.13 12.64 128.58 19.65 126.76 12.73 88.99 10.55"/>
          <Polygon fill="#FFFFFF" points="48.56 58.96 21.62 50.61 30.73 19.23 79.25 22.47 89.96 41.41 88.55 72.56 44.39 99.42 42.03 110.75 65.59 107.93 64.64 97.63 91.53 92.35 86.13 126.61 20.04 134.66 22.15 87.89 65.55 61.76 64.18 42.32 49.26 43.45 48.56 58.96"/>
          <Polygon fill="#FFFFFF" points="91.19 25.48 117.04 27.12 128.39 61.02 140.15 26.82 165.29 25.11 143.09 78.26 165.93 130.54 141.03 134.93 127.85 93.61 115.91 130.8 91.81 127.19 112.7 76.52 91.19 25.48"/>
          <Path fill={C.accent} d="M263.15,78.19c-2.07,20.59-16.39,39.14-16.39,39.14-17.31,12.35-35.26,15.34-35.26,15.34-.95-.27-1.87-.53-2.79-.81-19.8-6-32.08-14.74-35.15-17.09-.5-.38-.76-.59-.76-.59-12.53-22.14-12.95-38.29-12.95-38.29,4.17-21.38,15.81-38.69,15.81-38.69,15.6-11.36,30.64-14.94,33.68-15.58.37-.08.56-.11.56-.11,7.24,1.02,13.6,2.91,18.99,5.09,13.33,5.39,20.73,12.53,20.73,12.53,12.39,19.65,13.53,39.05,13.53,39.05h0Z"/>
          <Path fill="#121314" d="M242.26,115.83c-12.46,10.42-28.25,14.79-33.54,16.03-19.8-6-32.08-14.74-35.15-17.09,9.73,6.72,35.35,14.49,35.35,14.49,14.64-2.83,31.62-15,31.62-15l1.72,1.57h0Z"/>
          <G>
            <Path fill="#121314" d="M236.98,43.63s-11.66-9.34-28.17-13.61c0,0-18.86,6.12-28.2,13.18,0,0-9.66,15.65-13.44,33.06,0,0,.6,12.66,11.17,32.05,0,0-7.26-19.99-7.7-30.71,0,0,6.46-21.22,12.92-30.96,0,0,13.2-9.25,25.89-12.85,0,0,7.7-.11,27.52,9.84h0Z" />
            <Path fill="#121314" d="M247.88,73.22s-5.47,17.88-14.69,32.63c0,0-14.24,10.59-29.44,14.85l2.38.76s15.86-3.1,29.13-13.15c0,0,10.54-16.95,13.02-31.74l-.4-3.34h0Z" />
            <Path fill="#121314" d="M254.11,65.3c-6.39-21.82-12.16-27.95-12.16-27.95-15.66-11.37-28.66-14.86-32.61-15.72.37-.08.56-.11.56-.11,7.24,1.02,13.6,2.91,18.99,5.09,9.04,4.29,15.24,9.67,15.24,9.67,6.72,9.41,9.87,28.36,9.98,29.02h0Z" />
            <Path fill="#121314" d="M231.68,55.55l-8.32,8.67c-.4.41-.95.65-1.52.65h-36.84c-.94,0-1.42-1.12-.77-1.8l8.32-8.67c.4-.41.95-.65,1.52-.65h36.84c.94,0,1.42,1.12.77,1.8h0Z" />
            <Path fill="#121314" d="M184.23,71.87l8.32,8.67c.4.41.95.65,1.52.65h36.84c.94,0,1.42-1.12.77-1.8l-8.32-8.67c-.4-.41-.95-.65-1.52-.65h-36.84c-.94,0-1.42,1.12-.77,1.8Z" />
            <Path fill="#121314" d="M231.68,88.19l-8.32,8.67c-.4.41-.95.65-1.52.65h-36.84c-.94,0-1.42-1.12-.77-1.8l8.32-8.67c.4-.41.95-.65,1.52-.65h36.84c.94,0,1.42,1.12.77,1.8Z" />
          </G>
        </Svg>

        {/* devnet chip */}
        <View style={s.networkChip}>
          <View style={s.networkDot} />
          <Text style={s.networkText}>DEVNET</Text>
        </View>
      </View>

      {/* ── BODY ────────────────────────────────────────────────────────── */}
      <View style={s.body}>

        {/* Scan-lines texture overlay */}
        <View style={s.scanlines} pointerEvents="none" />

        {/* Headline block */}
        <View style={s.headlineBlock}>
          <Text style={s.tagline}>PROVABLY FAIR</Text>
          <View style={s.dividerLine} />
          <Text style={s.headline}>COIN{'\n'}FLIP</Text>
          <View style={s.dividerLine} />
          <Text style={s.subline}>ON SOLANA</Text>
        </View>

        {/* Animated coin hero */}
        <View style={s.coinStage}>
          {/* Glow halo */}
          <Animated.View style={[s.coinGlow, { opacity: glowOpacity }]} />
          <Animated.View style={[s.coinWrapper, { transform: [{ perspective: 1000 }, { scaleY: coinScaleY }] }]}>
            <Svg width={200} height={215} viewBox="0 0 597.86 643.33">
              <Path fill={C.accent} d="M596.49,327.98c-11.95,118.61-94.41,225.51-94.41,225.51-99.74,71.17-203.12,88.36-203.12,88.36-5.45-1.53-10.78-3.06-16.06-4.68-114.05-34.59-184.85-84.9-202.52-98.44-2.89-2.19-4.37-3.41-4.37-3.41C3.84,407.74,1.37,314.75,1.37,314.75,25.38,191.6,92.46,91.86,92.46,91.86,182.33,26.42,268.96,5.79,286.53,2.1c2.13-.45,3.23-.62,3.23-.62,41.69,5.87,78.35,16.77,109.39,29.34,76.79,31.04,119.41,72.19,119.41,72.19,71.37,113.19,77.92,225,77.92,225v-.03Z"/>
              <Path fill="#121314" d="M476.14,544.83c-71.76,60.04-162.74,85.21-193.24,92.34-114.05-34.59-184.85-84.9-202.52-98.44,56.07,38.73,203.69,83.48,203.69,83.48,84.36-16.32,182.18-86.41,182.18-86.41l9.9,9.05v-.03Z"/>
              <G fill="#121314">
                <Path d="M445.72,128.83s-67.17-53.8-162.29-78.43c0,0-108.65,35.24-162.48,75.94,0,0-55.67,90.18-77.44,190.49,0,0,3.43,72.96,64.33,184.65,0,0-41.83-115.15-44.35-176.96,0,0,37.23-122.27,74.46-178.35,0,0,76.08-53.32,149.15-74.01,0,0,44.35-.65,158.57,56.67h.06Z" />
                <Path d="M508.55,299.34s-31.53,103.04-84.65,188c0,0-82.04,61.01-169.61,85.53l13.73,4.37s91.37-17.85,167.85-75.77c0,0,60.73-97.64,75.03-182.86l-2.33-19.27h-.03Z" />
                <Path d="M415.19,197.53l-47.93,49.97c-2.3,2.38-5.45,3.75-8.77,3.75h-212.26c-5.39,0-8.17-6.47-4.43-10.36l47.93-49.97c2.3-2.38,5.45-3.75,8.77-3.75h212.26c5.39,0,8.17,6.47,4.43,10.36h0Z" />
                <Path d="M141.84,291.57l47.93,49.97c2.3,2.38,5.45,3.75,8.77,3.75h212.26c5.39,0,8.17-6.47,4.43-10.36l-47.93-49.97c-2.3-2.38-5.45-3.75-8.77-3.75h-212.26c-5.39,0-8.17,6.47-4.43,10.36Z" />
                <Path d="M415.19,385.58l-47.93,49.97c-2.3,2.38-5.45,3.75-8.77,3.75h-212.26c-5.39,0-8.17-6.47-4.43-10.36l47.93-49.97c2.3-2.38,5.45-3.75,8.77-3.75h212.26c5.39,0,8.17,6.47,4.43,10.36Z" />
              </G>
            </Svg>
          </Animated.View>
        </View>

        {/* Status line (shown during connect) */}
        {!!statusMsg && (
          <Text style={s.statusMsg}>{statusMsg}</Text>
        )}

        {/* CONNECT BUTTON */}
        <View style={s.connectBtnContainer}>
          <View style={s.connectBtnShadow} />
          <Pressable
            style={({ pressed }) => [s.connectBtn, pressed && { opacity: 0.85 }]}
            onPress={handleConnect}
            disabled={connecting}
          >
            {connecting ? (
              <Text style={s.connectBtnText}>CONNECTING...</Text>
            ) : (
              <Text style={s.connectBtnText}>CONNECT</Text>
            )}
          </Pressable>
        </View>

        {/* Fine print */}
        <Text style={s.finePrint}>
          connects via phantom · falls back to local wallet
        </Text>

      </View>
    </SafeAreaView>
  );
}

// ─── Styles ──────────────────────────────────────────────────────────────────
const s = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: C.bg,
  },
  checkingScreen: {
    flex: 1,
    backgroundColor: C.bg,
    alignItems: 'center',
    justifyContent: 'center',
  },

  // ── Top bar ──────────────────────────────────────────────────────────────
  topBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 24,
    paddingVertical: 5,
  },
  networkChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    borderWidth: 1,
    borderColor: C.border,
    paddingHorizontal: 12,
    paddingVertical: 6,
    backgroundColor: C.glass,
  },
  networkDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: C.accent,
  },
  networkText: {
    fontFamily: 'Orbitron',
    fontSize: 10,
    color: C.accent,
    letterSpacing: 2,
  },

  // ── Body ─────────────────────────────────────────────────────────────────
  body: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 28,
    paddingBottom: 40,
    paddingTop: 8,
    overflow: 'hidden',
  },

  // Subtle scanline overlay
  scanlines: {
    ...StyleSheet.absoluteFill,
    opacity: 0.04,
    backgroundColor: 'transparent',
    // A repeating gradient isn't natively supported in RN —
    // this gives a faint tinted dark overlay instead.
    // For true scanlines, replace with an Image of a 1×2 transparent/black stripe tile.
  },

  // ── Headline ─────────────────────────────────────────────────────────────
  headlineBlock: {
    alignItems: 'center',
    gap: 10,
    paddingTop: 8,
  },
  tagline: {
    fontFamily: 'Orbitron',
    fontSize: 11,
    color: C.muted,
    letterSpacing: 4,
  },
  dividerLine: {
    width: 120,
    height: 1,
    backgroundColor: C.border,
  },
  headline: {
    fontFamily: 'Orbitron',
    fontSize: 56,
    color: C.white,
    letterSpacing: -1,
    textAlign: 'center',
    lineHeight: 58,
    // Bold stroke effect via shadows
    textShadowColor: C.accent,
    textShadowOffset: { width: 0, height: 0 },
    textShadowRadius: 18,
  },
  subline: {
    fontFamily: 'Orbitron',
    fontSize: 13,
    color: C.accent,
    letterSpacing: 6,
  },

  // ── Coin stage ───────────────────────────────────────────────────────────
  coinStage: {
    alignItems: 'center',
    justifyContent: 'center',
    width: 220,
    height: 220,
  },
  coinGlow: {
    position: 'absolute',
    width: 220,
    height: 220,
    borderRadius: 110,
    backgroundColor: C.accent,
    // React Native shadow (iOS)
    shadowColor: C.accent,
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.6,
    shadowRadius: 40,
    // Android elevation glow approximation
    elevation: 20,
  },
  coinWrapper: {
    width: 200,
    height: 215,
    alignItems: 'center',
    justifyContent: 'center',
  },

  // ── Status msg ───────────────────────────────────────────────────────────
  statusMsg: {
    fontFamily: 'Orbitron',
    fontSize: 11,
    color: C.accent,
    letterSpacing: 1.5,
    textAlign: 'center',
    minHeight: 20,
  },

  // ── Connect button ───────────────────────────────────────────────────────
  connectBtnContainer: {
    position: 'relative',
    width: '100%',
    height: 74,
    marginTop: 8,
  },
  connectBtnShadow: {
    position: 'absolute',
    top: 8,
    left: 8,
    right: -8,
    bottom: -8,
    backgroundColor: C.white,
    borderRadius: 0,
  },
  connectBtn: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: C.accent,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 0,
  },
  connectBtnText: {
    fontFamily: 'Orbitron',
    fontSize: 30,
    color: C.black,
    letterSpacing: -0.5,
    textShadowColor: C.black,
    textShadowRadius: 1,
  },

  // ── Fine print ───────────────────────────────────────────────────────────
  finePrint: {
    fontFamily: 'Orbitron',
    fontSize: 9,
    color: C.muted,
    letterSpacing: 1,
    textAlign: 'center',
    marginTop: 16,
  },
});
