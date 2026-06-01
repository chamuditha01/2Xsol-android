import AsyncStorage from '@react-native-async-storage/async-storage';
import * as web3 from '@solana/web3.js';
import bs58 from 'bs58';
import { Buffer } from 'buffer';
import * as Linking from 'expo-linking';
import { router } from 'expo-router';
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
import Svg, { G, Path } from 'react-native-svg';
import nacl from 'tweetnacl';

if (typeof (globalThis as any).Buffer === 'undefined') (globalThis as any).Buffer = Buffer;

// ─── Constants ────────────────────────────────────────────────────────────────
const PHANTOM_SESSION_KEY       = 'solflip_phantom_session';
const MAIN_WALLET_ADDRESS_KEY   = 'solflip_main_wallet_address';
const PHANTOM_DAPP_KEYPAIR_KEY  = 'solflip_phantom_dapp_keypair';
const PHANTOM_ENCRYPTION_PUBLIC_KEY_KEY = 'solflip_phantom_encryption_public_key';

const APP_SCHEME                = 'soldoublerandroid';
const PHANTOM_CONNECT_URL       = 'https://phantom.app/ul/v1/connect';

// ─── Palette ──────────────────────────────────────────────────────────────────
const C = {
  bg:      '#080b10',
  accent:  '#c3f306',
  white:   '#FFFFFF',
  black:   '#000000',
  muted:   '#5a6a7a',
};

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

export default function LandingScreen() {
  const [connecting,  setConnecting]  = useState(false);
  const [statusMsg,   setStatusMsg]   = useState('');

  const dappKP    = useRef<nacl.BoxKeyPair>(nacl.box.keyPair());
  const nonceRef  = useRef<Uint8Array>(nacl.randomBytes(24));

  const coinAnim = useRef(new Animated.Value(0)).current;
  const glowAnim = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    Animated.loop(
      Animated.sequence([
        Animated.timing(coinAnim, { toValue: 1, duration: 2200, easing: Easing.inOut(Easing.sin), useNativeDriver: true }),
        Animated.timing(coinAnim, { toValue: 0, duration: 2200, easing: Easing.inOut(Easing.sin), useNativeDriver: true }),
      ])
    ).start();
    Animated.loop(
      Animated.sequence([
        Animated.timing(glowAnim, { toValue: 1, duration: 1400, easing: Easing.inOut(Easing.ease), useNativeDriver: true }),
        Animated.timing(glowAnim, { toValue: 0, duration: 1400, easing: Easing.inOut(Easing.ease), useNativeDriver: true }),
      ])
    ).start();
  }, []);

  const coinScaleY = coinAnim.interpolate({ inputRange: [0, 0.5, 1], outputRange: [1, 0.08, 1] });
  const glowOpacity = glowAnim.interpolate({ inputRange: [0, 1], outputRange: [0.3, 0.9] });

  // ── Handle Phantom deeplink return ──────────────────────────────────────
  useEffect(() => {
    const sub = Linking.addEventListener('url', ({ url }) => {
      if (!url.includes('onConnect')) return;
      void handlePhantomCallback(url);
    });
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

      if (params.errorCode) {
        setStatusMsg(`PHANTOM ERROR: ${params.errorMessage ?? params.errorCode}`);
        setConnecting(false);
        return;
      }

      const phantomEncPubKey = bs58.decode(params.phantom_encryption_public_key);
      const nonce            = bs58.decode(params.nonce);
      const encData          = bs58.decode(params.data);

      const sharedSecret = nacl.box.before(phantomEncPubKey, dappKP.current.secretKey);
      const decrypted    = nacl.box.open.after(encData, nonce, sharedSecret);
      if (!decrypted) throw new Error('Decryption failed');

      const decryptedData = JSON.parse(Buffer.from(decrypted).toString('utf8'));
      const phantomPubKey = decryptedData.public_key ?? decryptedData.address;
      const session = decryptedData.session;

      if (!phantomPubKey || !session) throw new Error('Decrypted data was incomplete');

      const normalizedAddress = new web3.PublicKey(phantomPubKey).toBase58();

      // Save phantom credentials consistently
      await AsyncStorage.multiSet([
        [PHANTOM_SESSION_KEY, session],
        [MAIN_WALLET_ADDRESS_KEY, normalizedAddress],
        [PHANTOM_DAPP_KEYPAIR_KEY, JSON.stringify({
          publicKey: Array.from(dappKP.current.publicKey),
          secretKey: Array.from(dappKP.current.secretKey),
        })],
        [PHANTOM_ENCRYPTION_PUBLIC_KEY_KEY, bs58.encode(phantomEncPubKey)],
      ]);

      setStatusMsg('CONNECTED!');
      setTimeout(() => router.replace('/'), 400);
    } catch (e: any) {
      console.error('Phantom callback error:', e);
      setStatusMsg('ERR: ' + (e?.message ?? 'Deeplink parse failed'));
      setConnecting(false);
    }
  }, []);

  const handleConnect = useCallback(async () => {
    if (connecting) return;
    setConnecting(true);
    setStatusMsg('CHECKING PHANTOM...');

    try {
      const savedSession = await AsyncStorage.getItem(PHANTOM_SESSION_KEY);
      if (savedSession) {
        setStatusMsg('CONNECTED!');
        router.replace('/');
        return;
      }

      const phantomUrl = buildConnectDeeplink(dappKP.current, nonceRef.current);
      setStatusMsg('OPENING PHANTOM...');
      await Linking.openURL(phantomUrl);
    } catch (e: any) {
      console.error('connect error:', e);
      setStatusMsg('ERR: ' + (e?.message ?? 'Connection failed'));
      setConnecting(false);
    }
  }, [connecting]);

  return (
    <SafeAreaView style={s.root}>
      <View style={s.body}>
        {/* Animated coin hero */}
        <View style={s.coinStage}>
          <Animated.View style={[s.coinGlow, { opacity: glowOpacity }]} />
          <Animated.View style={[s.coinWrapper, { transform: [{ perspective: 1000 }, { scaleY: coinScaleY }] }]}>
            <Svg width={220} height={220} viewBox="0 0 597.86 643.33">
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

        {/* Status message */}
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
              <Text style={s.connectBtnText}>CONNECT PHANTOM</Text>
            )}
          </Pressable>
        </View>
      </View>
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: C.bg,
  },
  body: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 28,
    gap: 40,
  },
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
    shadowColor: C.accent,
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.6,
    shadowRadius: 40,
    elevation: 20,
  },
  coinWrapper: {
    width: 200,
    height: 215,
    alignItems: 'center',
    justifyContent: 'center',
  },
  statusMsg: {
    fontFamily: 'Orbitron',
    fontSize: 12,
    color: C.accent,
    letterSpacing: 1.5,
    textAlign: 'center',
    minHeight: 20,
  },
  connectBtnContainer: {
    position: 'relative',
    width: '100%',
    height: 74,
  },
  connectBtnShadow: {
    position: 'absolute',
    top: 8,
    left: 8,
    right: -8,
    bottom: -8,
    backgroundColor: C.white,
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
  },
  connectBtnText: {
    fontFamily: 'Orbitron',
    fontSize: 24,
    color: C.black,
    letterSpacing: -0.5,
    fontWeight: '900',
  },
});
