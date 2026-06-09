import AsyncStorage from '@react-native-async-storage/async-storage';
import * as web3 from '@solana/web3.js';
import bs58 from 'bs58';
import { Buffer } from 'buffer';
import * as Linking from 'expo-linking';
import { router } from 'expo-router';
import { useVideoPlayer, VideoView } from 'expo-video';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Pressable,
  StyleSheet,
  Text,
  View
} from 'react-native';
import 'react-native-get-random-values';
import { SafeAreaView } from 'react-native-safe-area-context';
import nacl from 'tweetnacl';

const coinVideo = require('../../assets/videos/3d coin.mp4');

if (typeof (globalThis as any).Buffer === 'undefined') (globalThis as any).Buffer = Buffer;

// ─── Constants ────────────────────────────────────────────────────────────────
const PHANTOM_SESSION_KEY = 'solflip_phantom_session';
const MAIN_WALLET_ADDRESS_KEY = 'solflip_main_wallet_address';
const PHANTOM_DAPP_KEYPAIR_KEY = 'solflip_phantom_dapp_keypair';
const PHANTOM_ENCRYPTION_PUBLIC_KEY_KEY = 'solflip_phantom_encryption_public_key';

const APP_SCHEME = 'soldoublerandroid';
const PHANTOM_CONNECT_URL = 'https://phantom.app/ul/v1/connect';

// ─── Palette ──────────────────────────────────────────────────────────────────
const C = {
  bg: '#000000',
  accent: '#c3f306',
  white: '#FFFFFF',
  black: '#000000',
  muted: '#5a6a7a',
};

// ─── Phantom helpers ──────────────────────────────────────────────────────────
function buildConnectDeeplink(dappKeyPair: nacl.BoxKeyPair, nonce: Uint8Array): string {
  const params = new URLSearchParams({
    dapp_encryption_public_key: bs58.encode(dappKeyPair.publicKey),
    nonce: bs58.encode(nonce),
    redirect_link: `${APP_SCHEME}://onConnect`,
    cluster: 'devnet',
    app_url: `${APP_SCHEME}://`,
  });
  return `${PHANTOM_CONNECT_URL}?${params.toString()}`;
}

export default function LandingScreen() {
  const [connecting, setConnecting] = useState(false);
  const [statusMsg, setStatusMsg] = useState('');

  const dappKP = useRef<nacl.BoxKeyPair>(nacl.box.keyPair());
  const nonceRef = useRef<Uint8Array>(nacl.randomBytes(24));

  const player = useVideoPlayer(coinVideo, (player) => {
    player.loop = true;
    player.play();
  });

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
      const parsed = Linking.parse(url);
      const params = parsed.queryParams as Record<string, string> | null;

      if (!params) throw new Error('No params in deeplink');

      if (params.errorCode) {
        setStatusMsg(`PHANTOM ERROR: ${params.errorMessage ?? params.errorCode}`);
        setConnecting(false);
        return;
      }

      const phantomEncPubKey = bs58.decode(params.phantom_encryption_public_key);
      const nonce = bs58.decode(params.nonce);
      const encData = bs58.decode(params.data);

      const sharedSecret = nacl.box.before(phantomEncPubKey, dappKP.current.secretKey);
      const decrypted = nacl.box.open.after(encData, nonce, sharedSecret);
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
      {/* Center area: coin + status message */}
      <View style={s.body}>
        <View style={s.coinStage}>
          <VideoView
            style={s.video}
            player={player}
            fullscreenOptions={{ enable: false }}
            nativeControls={false}
            contentFit="contain"
          />
        </View>

        {!!statusMsg && (
          <Text style={s.statusMsg}>{statusMsg}</Text>
        )}
      </View>

      {/* Bottom-pinned connect button */}
      <View style={s.bottomSection}>
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
              <Text style={s.connectBtnText}>connect</Text>
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
    gap: 24,
  },
  bottomSection: {
    paddingHorizontal: 28,
    paddingBottom: 24,
  },
  coinStage: {
    alignItems: 'center',
    justifyContent: 'center',
    width: '100%',
    height: '100%',
    aspectRatio: 1,
  },
  video: {
    width: '60%',
    height: '100%',
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
    fontFamily: 'Orbitron-SemiBold',
    fontSize: 24,
    color: C.black,
    letterSpacing: -0.5,

  },
});
