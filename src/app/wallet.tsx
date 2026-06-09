import 'react-native-get-random-values';

import AsyncStorage from '@react-native-async-storage/async-storage';
import * as web3 from '@solana/web3.js';
import bs58 from 'bs58';
import { Buffer } from 'buffer';
import * as ExpoLinking from 'expo-linking';
import { router } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
    ActivityIndicator,
    Alert,
    Linking,
    Platform,
    Pressable,
    ScrollView,
    StyleSheet,
    Text,
    TextInput,
    TouchableOpacity,
    View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import Svg, { G, Path, Polygon } from 'react-native-svg';
import nacl from 'tweetnacl';
import WalletNavbarMenu from '../components/wallet-navbar-menu';

if (typeof (globalThis as any).Buffer === 'undefined') (globalThis as any).Buffer = Buffer;

const HELIUS_RPC = 'https://devnet.helius-rpc.com/?api-key=3d1eb615-02f9-4796-ac88-be5f07f93ba5';
const LOCAL_WALLET_KEY = 'solflip_local_keypair';
const DEFAULT_MAIN_WALLET_ADDRESS = process.env.EXPO_PUBLIC_MAIN_WALLET_ADDRESS ?? '';
const PHANTOM_DEEPLINK_BASE = 'https://phantom.app/ul/v1';
const PHANTOM_APP_URL = 'https://example.com';
const PHANTOM_REDIRECT_LINK = 'soldoublerandroid://wallet';
const PHANTOM_SESSION_KEY = 'solflip_phantom_session';
const MAIN_WALLET_ADDRESS_KEY = 'solflip_main_wallet_address';
const PHANTOM_DAPP_KEYPAIR_KEY = 'solflip_phantom_dapp_keypair';
const PHANTOM_ENCRYPTION_PUBLIC_KEY_KEY = 'solflip_phantom_encryption_public_key';

const C = {
  bg: '#000000',
  surface: '#000000',
  border: '#1c2530',
  accent: '#C3F306', // Precision neon yellow-lime match
  text: '#FFFFFF',
  muted: '#5a6a7a',
};

const connection = new web3.Connection(HELIUS_RPC, {
  commitment: 'confirmed',
  fetch: (url, options) => fetch(url as string, options as RequestInit),
});

const secureStorage = {
  getItem: async (key: string) => {
    try {
      const mod = await import('expo-secure-store');
      const stored = await mod.getItemAsync(key);
      if (stored != null) return stored;
    } catch {
    }
    return AsyncStorage.getItem(key);
  },
};

const serializeKeypair = (keypair: web3.Keypair) =>
  JSON.stringify(Array.from(keypair.secretKey));

const deserializeKeypair = (serialized: string) =>
  web3.Keypair.fromSecretKey(Uint8Array.from(JSON.parse(serialized)));

const serializeBoxKeypair = (keypair: nacl.BoxKeyPair) =>
  JSON.stringify({
    publicKey: Array.from(keypair.publicKey),
    secretKey: Array.from(keypair.secretKey),
  });

const deserializeBoxKeypair = (serialized: string): nacl.BoxKeyPair => {
  const parsed = JSON.parse(serialized) as {
    publicKey: number[];
    secretKey: number[];
  };
  return {
    publicKey: Uint8Array.from(parsed.publicKey),
    secretKey: Uint8Array.from(parsed.secretKey),
  };
};

const walletAddressToPublicKey = (address: string) => {
  try {
    return new web3.PublicKey(address);
  } catch {
    return new web3.PublicKey(Buffer.from(address, 'base64'));
  }
};

const normalizeAmount = (value: string) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return Math.floor(parsed * web3.LAMPORTS_PER_SOL);
};

export default function WalletTab() {
  const [appWalletAddress, setAppWalletAddress] = useState('');
  const [appWalletBalance, setAppWalletBalance] = useState(0);
  const [mainWalletAddress, setMainWalletAddress] = useState(DEFAULT_MAIN_WALLET_ADDRESS);
  const [amount, setAmount] = useState('0.1');
  const [loadingWallet, setLoadingWallet] = useState(true);
  const [connecting, setConnecting] = useState(false);
  const [depositing, setDepositing] = useState(false);
  const [withdrawing, setWithdrawing] = useState(false);
  const [status, setStatus] = useState('LOAD_APP_WALLET');

  const localWalletRef = useRef<web3.Keypair | null>(null);
  const phantomSessionRef = useRef('');
  const phantomDappKeypairRef = useRef<nacl.BoxKeyPair | null>(null);
  const phantomEncryptionPublicKeyRef = useRef('');

  const encryptPayload = useCallback((payload: Record<string, unknown>, sharedSecret: Uint8Array) => {
    const nonce = nacl.randomBytes(24);
    const encoded = Buffer.from(JSON.stringify(payload), 'utf8');
    const encrypted = nacl.box.after(encoded, nonce, sharedSecret);
    return {
      nonce: bs58.encode(nonce),
      payload: bs58.encode(encrypted),
    };
  }, []);

  const decryptPayload = useCallback((data: string, nonce: string, sharedSecret: Uint8Array) => {
    const decrypted = nacl.box.open.after(bs58.decode(data), bs58.decode(nonce), sharedSecret);
    if (!decrypted) throw new Error('Unable to decrypt Phantom response.');
    return JSON.parse(Buffer.from(decrypted).toString('utf8')) as Record<string, unknown>;
  }, []);

  const waitForPhantomRedirect = useCallback(async (urlToOpen: string, timeoutMs = 120000) => {
    return await new Promise<string>((resolve, reject) => {
      let settled = false;
      const cleanup = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timeoutId);
        subscription.remove();
      };
      const handleUrl = ({ url }: { url: string }) => {
        if (!url.startsWith(PHANTOM_REDIRECT_LINK)) return;
        cleanup();
        resolve(url);
      };
      const subscription = Linking.addEventListener('url', handleUrl);
      const timeoutId = setTimeout(() => {
        cleanup();
        reject(new Error('Phantom deeplink timed out.'));
      }, timeoutMs);

      void Linking.openURL(urlToOpen).catch(error => {
        cleanup();
        reject(error);
      });
      void Linking.getInitialURL().then(initialUrl => {
        if (initialUrl && initialUrl.startsWith(PHANTOM_REDIRECT_LINK)) {
          cleanup();
          resolve(initialUrl);
        }
      });
    });
  }, []);

  const loadLocalWallet = useCallback(async () => {
    setLoadingWallet(true);
    setStatus('load_app_wallet');
    try {
      const stored = await secureStorage.getItem(LOCAL_WALLET_KEY);
      const keypair = stored ? deserializeKeypair(stored) : web3.Keypair.generate();
      if (!stored) {
        await AsyncStorage.setItem(LOCAL_WALLET_KEY, serializeKeypair(keypair));
      }
      localWalletRef.current = keypair;
      setAppWalletAddress(keypair.publicKey.toBase58());
      setStatus('app_wallet_ready');
    } catch (error) {
      console.warn('loadLocalWallet error', error);
      Alert.alert('Wallet Error', 'Unable to load the app wallet.');
      setStatus('app_wallet_error');
    } finally {
      setLoadingWallet(false);
    }
  }, []);

  const fetchAppBalance = useCallback(async () => {
    if (!appWalletAddress) return;
    try {
      const balance = await connection.getBalance(new web3.PublicKey(appWalletAddress));
      setAppWalletBalance(balance / web3.LAMPORTS_PER_SOL);
    } catch (error) {
      console.warn('fetchAppBalance error', error);
    }
  }, [appWalletAddress]);

  const loadMainWallet = useCallback(async () => {
    try {
      const savedSession = await AsyncStorage.getItem(PHANTOM_SESSION_KEY);
      const savedAddress = await AsyncStorage.getItem(MAIN_WALLET_ADDRESS_KEY);
      const savedDappKeypair = await AsyncStorage.getItem(PHANTOM_DAPP_KEYPAIR_KEY);
      const savedEncryptionPublicKey = await AsyncStorage.getItem(PHANTOM_ENCRYPTION_PUBLIC_KEY_KEY);

      if (savedSession) phantomSessionRef.current = savedSession;
      if (savedAddress) setMainWalletAddress(savedAddress);
      if (savedDappKeypair) phantomDappKeypairRef.current = deserializeBoxKeypair(savedDappKeypair);
      if (savedEncryptionPublicKey) phantomEncryptionPublicKeyRef.current = savedEncryptionPublicKey;
    } catch (error) {
      console.warn('loadMainWallet error', error);
    }
  }, []);

  useEffect(() => {
    void loadLocalWallet();
    void loadMainWallet();
  }, [loadLocalWallet, loadMainWallet]);

  useEffect(() => {
    if (!appWalletAddress) return;
    void fetchAppBalance();
  }, [appWalletAddress, fetchAppBalance]);

  const disconnectPhantom = useCallback(async () => {
    try {
      await AsyncStorage.multiRemove([
        PHANTOM_SESSION_KEY,
        MAIN_WALLET_ADDRESS_KEY,
        PHANTOM_DAPP_KEYPAIR_KEY,
        PHANTOM_ENCRYPTION_PUBLIC_KEY_KEY,
      ]);
      setMainWalletAddress('');
      phantomSessionRef.current = '';
      phantomDappKeypairRef.current = null;
      phantomEncryptionPublicKeyRef.current = '';
      setStatus('phantom_disconnected');
      Alert.alert('Phantom Disconnected', 'Phantom wallet has been disconnected.');
    } catch (error: any) {
      console.warn('disconnectPhantom error', error);
      Alert.alert('Error', 'Failed to disconnect Phantom wallet.');
    }
  }, []);

  const depositToAppWallet = useCallback(() => {
    const lamports = normalizeAmount(amount);
    if (!lamports) {
      Alert.alert('Deposit', 'Enter a valid amount in SOL.');
      return;
    }
    if (!appWalletAddress) {
      Alert.alert('Deposit', 'App wallet is not ready yet.');
      return;
    }
    if (!mainWalletAddress) {
      Alert.alert('Deposit', 'Connect Phantom or paste your main wallet address first.');
      return;
    }
    if (Platform.OS === 'web') {
      Alert.alert('Deposit', 'Phantom deposit requires a mobile build.');
      return;
    }

    setDepositing(true);
    setStatus('depositing_from_phantom');

    void (async () => {
      try {
        const dappKeypair = phantomDappKeypairRef.current;
        const session = phantomSessionRef.current;

        if (!dappKeypair || !session) throw new Error('Connect Phantom first.');

        const mainPubkey = walletAddressToPublicKey(mainWalletAddress);
        const appPubkey = new web3.PublicKey(appWalletAddress);
        const latest = await connection.getLatestBlockhash('confirmed');

        const tx = new web3.Transaction().add(
          web3.SystemProgram.transfer({ fromPubkey: mainPubkey, toPubkey: appPubkey, lamports })
        );

        tx.feePayer = mainPubkey;
        tx.recentBlockhash = latest.blockhash;

        if (!phantomEncryptionPublicKeyRef.current) throw new Error('Missing Phantom encryption key. Reconnect Phantom.');

        const sharedSecret = nacl.box.before(bs58.decode(phantomEncryptionPublicKeyRef.current), dappKeypair.secretKey);
        const txBytes = tx.serialize({ requireAllSignatures: false, verifySignatures: false });
        const { nonce, payload } = encryptPayload({ session, transaction: bs58.encode(txBytes) }, sharedSecret);

        const responseUrl = await waitForPhantomRedirect(
          `${PHANTOM_DEEPLINK_BASE}/signTransaction?` +
            new URLSearchParams({
              dapp_encryption_public_key: bs58.encode(dappKeypair.publicKey),
              nonce,
              redirect_link: PHANTOM_REDIRECT_LINK,
              payload,
            }).toString()
        );

        const queryParams = ExpoLinking.parse(responseUrl).queryParams as Record<string, string | undefined>;
        const signedResponse = decryptPayload(queryParams.data ?? '', queryParams.nonce ?? '', sharedSecret);
        const signedTransaction = String(signedResponse.transaction ?? signedResponse.signed_transaction ?? '');

        if (!signedTransaction) throw new Error('Phantom did not return a signed transaction.');

        const signedTx = web3.Transaction.from(bs58.decode(signedTransaction));
        const signatures = [
          await connection.sendRawTransaction(signedTx.serialize(), {
            skipPreflight: false,
            preflightCommitment: 'confirmed',
          }),
        ];

        Alert.alert('Deposit complete', `Signature: ${signatures[0]}`);
        setStatus('deposit_complete');
        await fetchAppBalance();
      } catch (error: any) {
        console.warn('depositToAppWallet error', error);
        Alert.alert('Deposit failed', error?.message ?? 'Unable to deposit.');
        setStatus('deposit_failed');
      } finally {
        setDepositing(false);
      }
    })();
  }, [amount, appWalletAddress, fetchAppBalance, mainWalletAddress]);

  const withdrawToMainWallet = useCallback(async () => {
    const lamports = normalizeAmount(amount);
    if (!lamports) {
      Alert.alert('Withdraw', 'Enter a valid amount in SOL.');
      return;
    }
    if (!mainWalletAddress) {
      Alert.alert('Withdraw', 'Paste your main wallet address first.');
      return;
    }
    if (!localWalletRef.current || !appWalletAddress) {
      Alert.alert('Withdraw', 'App wallet is not ready yet.');
      return;
    }

    const appWalletBalanceLamports = Math.floor(appWalletBalance * web3.LAMPORTS_PER_SOL);
    if (appWalletBalanceLamports < lamports) {
      Alert.alert('Withdraw', 'Not enough balance in the app wallet.');
      return;
    }

    setWithdrawing(true);
    setStatus('withdrawing_to_phantom');
    try {
      const appWallet = localWalletRef.current;
      const recipient = new web3.PublicKey(mainWalletAddress);
      const latest = await connection.getLatestBlockhash('confirmed');

      const tx = new web3.Transaction().add(
        web3.SystemProgram.transfer({ fromPubkey: appWallet.publicKey, toPubkey: recipient, lamports })
      );
      tx.feePayer = appWallet.publicKey;
      tx.recentBlockhash = latest.blockhash;
      tx.sign(appWallet);

      const signature = await connection.sendRawTransaction(tx.serialize(), {
        skipPreflight: false,
        preflightCommitment: 'confirmed',
      });

      await connection.confirmTransaction(
        { signature, blockhash: latest.blockhash, lastValidBlockHeight: latest.lastValidBlockHeight },
        'confirmed'
      );

      Alert.alert('Withdraw complete', `Signature: ${signature}`);
      setStatus('withdraw_complete');
      await fetchAppBalance();
    } catch (error: any) {
      console.warn('withdrawToMainWallet error', error);
      Alert.alert('Withdraw failed', error?.message ?? 'Unable to withdraw.');
      setStatus('withdraw_failed');
    } finally {
      setWithdrawing(false);
    }
  }, [amount, appWalletAddress, appWalletBalance, fetchAppBalance, mainWalletAddress]);

  return (
    <SafeAreaView style={s.root}>
      <View style={s.topBar}>
         <Pressable style={s.brandWrapper} onPress={() => router.push('/')}>
                  <Svg id="reference-one" width={90} height={76} viewBox="0 0 280.37 153.25">
                    <Polygon fill="#121314" points="88.99 10.55 20.04 1.63 2.98 60.61 26.28 67.8 7.44 79.17 4.25 151.62 87.17 141.34 122.66 146.25 125.48 134.93 130.67 151.62 184.37 142.25 206.49 150.17 232.7 145.71 252.18 133.6 270.02 111.48 277.39 76.63 267.2 37.76 243.89 14.65 206.76 4.54 183.55 14.19 185.83 8.45 131.13 12.64 128.58 19.65 126.76 12.73 88.99 10.55"/>
                    <Polygon fill="#FFFFFF" points="48.56 58.96 21.62 50.61 30.73 19.23 79.25 22.47 89.96 41.41 88.55 72.56 44.39 99.42 42.03 110.75 65.59 107.93 64.64 97.63 91.53 92.35 86.13 126.61 20.04 134.66 22.15 87.89 65.55 61.76 64.18 42.32 49.26 43.45 48.56 58.96"/>
                    <Polygon fill="#FFFFFF" points="91.19 25.48 117.04 27.12 128.39 61.02 140.15 26.82 165.29 25.11 143.09 78.26 165.93 130.54 141.03 134.93 127.85 93.61 115.91 130.8 91.81 127.19 112.7 76.52 91.19 25.48"/>
                    <Path fill="#c3f306" d="M263.15,78.19c-2.07,20.59-16.39,39.14-16.39,39.14-17.31,12.35-35.26,15.34-35.26,15.34-.95-.27-1.87-.53-2.79-.81-19.8-6-32.08-14.74-35.15-17.09-.5-.38-.76-.59-.76-.59-12.53-22.14-12.95-38.29-12.95-38.29,4.17-21.38,15.81-38.69,15.81-38.69,15.6-11.36,30.64-14.94,33.68-15.58.37-.08.56-.11.56-.11,7.24,1.02,13.6,2.91,18.99,5.09,13.33,5.39,20.73,12.53,20.73,12.53,12.39,19.65,13.53,39.05,13.53,39.05h0Z"/>
                    <Path fill="#121314" d="M242.26,115.83c-12.46,10.42-28.25,14.79-33.54,16.03-19.8-6-32.08-14.74-35.15-17.09,9.73,6.72,35.35,14.49,35.35,14.49,14.64-2.83,31.62-15,31.62-15l1.72,1.57h0Z"/>
                    <G>
                      <Path fill="#121314" d="M236.98,43.63s-11.66-9.34-28.17-13.61c0,0-18.86,6.12-28.2,13.18,0,0-9.66,15.65-13.44,33.06,0,0,.6,12.66,11.17,32.05,0,0-7.26-19.99-7.7-30.71,0,0,6.46-21.22,12.92-30.96,0,0,13.2-9.25,25.89-12.85,0,0,7.7-.11,27.52,9.84h0Z" />
                      <Path fill="#121314" d="M247.88,73.22s-5.47,17.88-14.69,32.63c0,0-14.24,10.59-29.44,14.85l2.38.76s15.86-3.1,29.13-13.15c0,0,10.54-16.95,13.02-31.74l-.4-3.34h0Z" />
                      <Path fill="#121314" d="M254.11,65.3c-6.39-21.82-12.16-27.95-12.16-27.95-15.66-11.37-28.66-14.86-32.61-15.72.37-.08.56-.11.56-.11,7.24,1.02,13.6,2.91,18.99,5.09,9.04,4.29,15.24,9.67,15.24,9.67,6.72,9.41,9.87,28.36,9.98,29.02h0Z" />
                      <Path fill="#121314" d="M242.26,115.83s13.48-20.07,12.92-36.84c0,0-3.04,18.45-14.64,35.27" />
                      <Path fill="#121314" d="M231.68,55.55l-8.32,8.67c-.4.41-.95.65-1.52.65h-36.84c-.94,0-1.42-1.12-.77-1.8l8.32-8.67c.4-.41.95-.65,1.52-.65h36.84c.94,0,1.42,1.12.77,1.8h0Z" />
                      <Path fill="#121314" d="M184.23,71.87l8.32,8.67c.4.41.95.65,1.52.65h36.84c.94,0,1.42-1.12.77-1.8l-8.32-8.67c-.4-.41-.95-.65-1.52-.65h-36.84c-.94,0-1.42,1.12-.77,1.8Z" />
                      <Path fill="#121314" d="M231.68,88.19l-8.32,8.67c-.4.41-.95.65-1.52.65h-36.84c-.94,0-1.42-1.12-.77-1.8l8.32-8.67c.4-.41.95-.65,1.52-.65h36.84c.94,0,1.42,1.12.77,1.8Z" />
                    </G>
                  </Svg>
                </Pressable>

        <WalletNavbarMenu
          balanceLabel={loadingWallet ? '...' : appWalletBalance.toFixed(2)}
          walletAddress={appWalletAddress ?? ''}
        />
      </View>
      <ScrollView contentContainerStyle={s.scroll} showsVerticalScrollIndicator={false}>
        
        {/* HEAD TITLE AREA */}
        <View style={s.hero}>
          <Text style={s.kicker}>terminal wallet link</Text>
          <Text style={s.title}>funds portal</Text>
          <Text style={s.subtitle}>
            Bridge assets into your localized betting instance or withdraw accumulated wins instantly.
          </Text>
        </View>

        {/* COMPONENT CARD 1: LOCAL APP INSTANCE WALLET */}
        <View style={s.brutalistCard}>
          <View style={s.cardHeader}>
            <Text style={s.cardTitle}>app instance wallet</Text>
            <View style={[s.badgePlate, { backgroundColor: loadingWallet ? '#1c2530' : '#FFFFFF' }]}>
              <Text style={[s.badgeText, { color: '#080b10' }]}>
                {loadingWallet ? 'syncing' : 'ready'}
              </Text>
            </View>
          </View>
          <Text style={s.addressText} numberOfLines={1}>
            {appWalletAddress ? appWalletAddress.toLowerCase() : 'generating keypair block...'}
          </Text>
          <Text style={s.balanceText}>{appWalletBalance.toFixed(3)} sol</Text>
        </View>

        {/* COMPONENT CARD 2: EXTERNAL PAYLOAD TARGET LINK */}
        <View style={s.brutalistCard}>
          <View style={s.cardHeader}>
            <Text style={s.cardTitle}>main wallet deployment target</Text>
            <View style={[s.badgePlate, { backgroundColor: mainWalletAddress ? '#C3F306' : '#1c2530' }]}>
              <Text style={[s.badgeText, { color: '#080b10' }]}>
                {mainWalletAddress ? 'active' : 'unlinked'}
              </Text>
            </View>
          </View>
          
          <TextInput
            style={s.flatInputText}
            value={mainWalletAddress}
            onChangeText={setMainWalletAddress}
            placeholder="paste target 58-hash public key"
            placeholderTextColor={C.muted}
            autoCapitalize="none"
            autoCorrect={false}
          />

          <View style={s.buttonContainer}>
            <View style={s.buttonShadow} />
            <TouchableOpacity
              activeOpacity={0.9}
              style={s.btnCreate}
              onPress={() => { void disconnectPhantom(); }}
            >
              <Text style={s.btnCreateText}>disconnect phantom mobile app</Text>
            </TouchableOpacity>
          </View>
        </View>

        {/* COMPONENT CARD 3: ESCROW TRANSFER AMOUNT ROUTER */}
        <View style={s.brutalistCard}>
          <Text style={s.cardTitle}>transaction asset weight</Text>
          
          <TextInput
            style={s.flatInputText}
            value={amount}
            onChangeText={setAmount}
            placeholder="0.00 sol"
            placeholderTextColor={C.muted}
            keyboardType="decimal-pad"
          />

          <View style={s.actionRow}>
            {/* DEPOSIT ACTION BUTTON */}
            <View style={[s.buttonContainer, { flex: 1, marginTop: 10, marginBottom: 0 }]}>
              <View style={s.buttonShadow} />
              <TouchableOpacity
                activeOpacity={0.9}
                style={[s.btnCreate, depositing && s.btnDisabled]}
                onPress={() => { void depositToAppWallet(); }}
                disabled={depositing}
              >
                {depositing ? (
                  <ActivityIndicator color="#000" />
                ) : (
                  <Text style={s.btnCreateText}>deposit</Text>
                )}
              </TouchableOpacity>
            </View>

            {/* WITHDRAW ACTION BUTTON */}
            <View style={[s.buttonContainer, { flex: 1, marginTop: 10, marginBottom: 0 }]}>
              <View style={s.buttonShadow} />
              <TouchableOpacity
                activeOpacity={0.9}
                style={[s.btnCreate, withdrawing && s.btnDisabled]}
                onPress={() => { void withdrawToMainWallet(); }}
                disabled={withdrawing}
              >
                {withdrawing ? (
                  <ActivityIndicator color="#000" />
                ) : (
                  <Text style={s.btnCreateText}>withdraw</Text>
                )}
              </TouchableOpacity>
            </View>
          </View>
        </View>

        {/* LOG SYSTEM HARD STATUS DEPLOYMENT PANEL */}
        <View style={s.statusCardFrame}>
          <Text style={s.statusLabel}>system engine log status</Text>
          <Text style={s.statusText}>{status.toLowerCase()}</Text>
        </View>

      </ScrollView>
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: C.bg,
  },
  topBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 24,
    paddingVertical: 6,
  },
  brandWrapper: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  scroll: {
    paddingHorizontal: 24,
    paddingTop: 12,
    paddingBottom: 32,
    gap: 20,
  },
  hero: {
    paddingVertical: 4,
  },
  kicker: {
    fontFamily: 'Orbitron',
    fontSize: 11,
    color: C.accent,
    letterSpacing: 1.5,
    textTransform: 'uppercase',
  },
  title: {
    fontFamily: 'Orbitron',
    fontSize: 26,
    color: C.text,
    textTransform: 'lowercase',
    marginVertical: 4,
  },
  subtitle: {
    fontFamily: 'Orbitron',
    fontSize: 12,
    color: C.muted,
    lineHeight: 18,
    textTransform: 'lowercase',
  },
  
  // ─── BRUTALIST GRID ELEMENT CARDS ────────────────────────────────────────
  brutalistCard: {
    backgroundColor: 'transparent',
    borderColor: '#1c2530',
    borderBottomWidth: 1,
    paddingVertical: 18,
    paddingHorizontal: 4,
    gap: 14,
  },
  cardHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  cardTitle: {
    fontFamily: 'Orbitron',
    fontSize: 13,
    color: C.text,
    textTransform: 'lowercase',
  },
  badgePlate: {
    paddingHorizontal: 10,
    paddingVertical: 3,
    borderRadius: 0,
  },
  badgeText: {
    fontFamily: 'Orbitron',
    fontSize: 10,
    fontWeight: '900',
    textTransform: 'uppercase',
  },
  addressText: {
    fontFamily: 'Orbitron',
    fontSize: 14,
    color: '#C3F306',
  },
  balanceText: {
    fontFamily: 'Orbitron',
    fontSize: 24,
    color: C.text,
    textTransform: 'lowercase',
  },
  
  // ─── RIGID FORM ENTRY INPUT LAYERS ────────────────────────────────────────
  flatInputText: {
    backgroundColor: '#151618',
    borderColor: '#1c2530',
    borderWidth: 2,
    borderRadius: 0,
    paddingHorizontal: 14,
    paddingVertical: 12,
    color: C.text,
    fontFamily: 'Orbitron',
    fontSize: 15,
  },
  actionRow: {
    flexDirection: 'row',
    gap: 16,
    width: '100%',
  },
  
  // ─── BRUTALIST INTERACTION ACTUATORS ──────────────────────────────────────
  buttonContainer: {
    position: 'relative',
    height: 56,
    marginTop: 20,
    marginBottom: 12,
  },
  buttonShadow: {
    position: 'absolute',
    top: 6,
    left: 6,
    right: -6,
    bottom: -6,
    backgroundColor: '#FFFFFF',
    borderRadius: 0,
  },
  btnCreate: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: '#D1FF00', // Neon lime/yellow color
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 0,
    borderWidth: 0,
  },
  btnCreateText: {
    fontFamily: 'Orbitron-SemiBold',
    fontSize: 16,
    color: '#000000',
    letterSpacing: -0.5,
    textTransform: 'lowercase',
  },
  btnDisabled: {
    opacity: 0.5,
  },
  
  // ─── BOTTOM SYSTEM DIAGNOSTIC COMPONENT ───────────────────────────────────
  statusCardFrame: {
    backgroundColor: '#151618',
    borderColor: '#1c2530',
    borderWidth: 1,
    borderRadius: 0,
    padding: 14,
    marginTop: 8,
  },
  statusLabel: {
    fontFamily: 'Orbitron',
    fontSize: 10,
    color: C.muted,
    textTransform: 'lowercase',
  },
  statusText: {
    fontFamily: 'Orbitron',
    fontSize: 13,
    color: C.text,
    marginTop: 4,
  },
});