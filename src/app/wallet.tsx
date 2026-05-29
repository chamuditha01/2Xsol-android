import 'react-native-get-random-values';

import AsyncStorage from '@react-native-async-storage/async-storage';
import * as web3 from '@solana/web3.js';
import bs58 from 'bs58';
import { Buffer } from 'buffer';
import * as ExpoLinking from 'expo-linking';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
    ActivityIndicator,
    Alert,
    Linking,
    Platform,
    ScrollView,
    StyleSheet,
    Text,
    TextInput,
    TouchableOpacity,
    View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import nacl from 'tweetnacl';

if (typeof (globalThis as any).Buffer === 'undefined') (globalThis as any).Buffer = Buffer;

const HELIUS_RPC = 'https://devnet.helius-rpc.com/?api-key=3d1eb615-02f9-4796-ac88-be5f07f93ba5';
const LOCAL_WALLET_KEY = 'solflip_local_keypair';
const DEFAULT_MAIN_WALLET_ADDRESS = process.env.EXPO_PUBLIC_MAIN_WALLET_ADDRESS ?? '';
const PHANTOM_DEEPLINK_BASE = 'https://phantom.app/ul/v1';
const PHANTOM_APP_URL = 'https://example.com';
const PHANTOM_REDIRECT_LINK = 'soldoublerandroid://wallet';
const PHANTOM_SESSION_KEY = 'solflip_main_wallet_session';
const MAIN_WALLET_ADDRESS_KEY = 'solflip_main_wallet_address';
const PHANTOM_DAPP_KEYPAIR_KEY = 'solflip_phantom_dapp_keypair';
const PHANTOM_ENCRYPTION_PUBLIC_KEY_KEY = 'solflip_phantom_encryption_public_key';

const C = {
  bg: '#080b10',
  surface: '#151618',
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
      return await mod.getItemAsync(key);
    } catch {
      return AsyncStorage.getItem(key);
    }
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

  const connectPhantom = useCallback(async () => {
    if (Platform.OS === 'web') {
      Alert.alert('Phantom', 'Connect on a mobile build to use Phantom.');
      return;
    }
    setConnecting(true);
    setStatus('connecting_phantom');
    try {
      const dappKeypair = nacl.box.keyPair();
      phantomDappKeypairRef.current = dappKeypair;
      await AsyncStorage.setItem(PHANTOM_DAPP_KEYPAIR_KEY, serializeBoxKeypair(dappKeypair));

      const connectParams = new URLSearchParams({
        app_url: PHANTOM_APP_URL,
        dapp_encryption_public_key: bs58.encode(dappKeypair.publicKey),
        cluster: 'devnet',
        redirect_link: PHANTOM_REDIRECT_LINK,
      });

      const responseUrl = await waitForPhantomRedirect(`${PHANTOM_DEEPLINK_BASE}/connect?${connectParams.toString()}`);
      const queryParams = ExpoLinking.parse(responseUrl).queryParams as Record<string, string | undefined>;

      const sharedSecret = nacl.box.before(bs58.decode(queryParams.phantom_encryption_public_key ?? ''), dappKeypair.secretKey);
      const response = decryptPayload(queryParams.data ?? '', queryParams.nonce ?? '', sharedSecret);

      const publicKey = String(response.public_key ?? response.address ?? '');
      const session = String(response.session ?? '');
      const phantomEncryptionPublicKey = String(queryParams.phantom_encryption_public_key ?? '');

      if (!publicKey || !session) throw new Error('Phantom connect response was incomplete.');

      const normalizedAddress = walletAddressToPublicKey(publicKey).toBase58();
      phantomSessionRef.current = session;
      phantomEncryptionPublicKeyRef.current = phantomEncryptionPublicKey;
      setMainWalletAddress(normalizedAddress);
      await AsyncStorage.multiSet([
        [PHANTOM_SESSION_KEY, session],
        [MAIN_WALLET_ADDRESS_KEY, normalizedAddress],
        [PHANTOM_ENCRYPTION_PUBLIC_KEY_KEY, phantomEncryptionPublicKey],
      ]);
      setStatus('phantom_connected');
      Alert.alert('Phantom Connected', `Main wallet: ${normalizedAddress}`);
    } catch (error: any) {
      console.warn('connectPhantom error', error);
      Alert.alert('Phantom', error?.message ?? 'Unable to connect Phantom.');
      setStatus('phantom_connect_failed');
    } finally {
      setConnecting(false);
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

          <TouchableOpacity
            activeOpacity={0.8}
            style={[s.hollowOutlineBtn, connecting && s.disabledOpacity]}
            onPress={() => { void connectPhantom(); }}
            disabled={connecting}
          >
            {connecting ? (
              <ActivityIndicator color={C.accent} />
            ) : (
              <Text style={s.hollowBtnText}>connect phantom mobile app</Text>
            )}
          </TouchableOpacity>
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
            <TouchableOpacity
              activeOpacity={0.8}
              style={[s.hollowOutlineBtn, { flex: 1 }, depositing && s.disabledOpacity]}
              onPress={() => { void depositToAppWallet(); }}
              disabled={depositing}
            >
              {depositing ? (
                <ActivityIndicator color={C.accent} />
              ) : (
                <Text style={s.hollowBtnText}>deposit</Text>
              )}
            </TouchableOpacity>

            {/* WITHDRAW ACTION BUTTON */}
            <TouchableOpacity
              activeOpacity={0.8}
              style={[s.solidAccentBtn, { flex: 1 }, withdrawing && s.disabledOpacity]}
              onPress={() => { void withdrawToMainWallet(); }}
              disabled={withdrawing}
            >
              {withdrawing ? (
                <ActivityIndicator color="#080b10" />
              ) : (
                <Text style={s.solidBtnText}>withdraw</Text>
              )}
            </TouchableOpacity>
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
  solidAccentBtn: {
    height: 44,
    backgroundColor: '#C3F306',
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 0,
  },
  solidBtnText: {
    fontFamily: 'Orbitron',
    fontSize: 15,
    color: '#080b10',
    fontWeight: '900',
    textTransform: 'lowercase',
  },
  hollowOutlineBtn: {
    height: 44,
    backgroundColor: '#151618',
    borderWidth: 2,
    borderColor: '#FFFFFF',
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 0,
  },
  hollowBtnText: {
    fontFamily: 'Orbitron',
    fontSize: 15,
    color: '#FFFFFF',
    textTransform: 'lowercase',
  },
  disabledOpacity: {
    opacity: 0.3,
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