import AsyncStorage from '@react-native-async-storage/async-storage';
import * as web3 from '@solana/web3.js';
import * as borsh from 'borsh';
import bs58 from 'bs58';
import { Buffer } from 'buffer';
import { router } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Animated,
  Clipboard,
  Dimensions,
  Easing,
  FlatList,
  Modal,
  Platform, Pressable, RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View
} from 'react-native';
import 'react-native-get-random-values';
import { SafeAreaView } from 'react-native-safe-area-context';
import Svg, { G, Path, Polygon } from 'react-native-svg';
import 'react-native-url-polyfill/auto';
import WalletNavbarMenu from '../components/wallet-navbar-menu';

// ─── Polyfill ────────────────────────────────────────────────────────────────
if (typeof (globalThis as any).Buffer === 'undefined') (globalThis as any).Buffer = Buffer;

// ─── Constants ───────────────────────────────────────────────────────────────
const PROGRAM_ID = new web3.PublicKey(
  process.env.EXPO_PUBLIC_PROGRAM_ID ?? 'YOUR_PROGRAM_ID'
);
const HELIUS_RPC =
  process.env.EXPO_PUBLIC_HELIUS_RPC ?? 'https://api.devnet.solana.com';
const BACKEND_URL =
  process.env.EXPO_PUBLIC_BACKEND_URL ?? 'http://localhost:3001';
const LOCAL_WALLET_KEY = 'solflip_local_keypair';
const LOCAL_WALLET_AIRDROP_KEY = 'solflip_local_airdrop_attempt';
// Byte offsets for Game struct (Borsh, matches Rust exactly)
// player_one       [32]  offset   0
// player_two       [32]  offset  32
// amount            u64  offset  64
// player_one_side    u8  offset  72
// status             u8  offset  73  ← 1=Open, 2=Joined
// padding            [6] offset  74
// game_id            u64 offset  80
// server_hash       [32] offset  88
// client_seed_a     [32] offset 120
// client_seed_b     [32] offset 152
// TOTAL                          184  (allocated 200)
const GAME_SIZE    = 200;
const HISTORY_SIZE = 280;

const OFFSET_PLAYER_ONE = 0;
const OFFSET_PLAYER_TWO = 32;
const OFFSET_AMOUNT     = 64;
const OFFSET_STATUS     = 73;
const OFFSET_GAME_ID    = 80;

const MIN_BET = 0.01;
const MAX_BET = 10;

// ─── Borsh Schema — Game PDA ─────────────────────────────────────────────────
// Must match Rust struct field order exactly
class GameAccount {
  player_one:      Uint8Array;
  player_two:      Uint8Array;
  amount:          bigint;
  player_one_side: number;
  status:          number;
  padding:         Uint8Array;
  game_id:         bigint;
  server_hash:     Uint8Array;
  client_seed_a:   Uint8Array;
  client_seed_b:   Uint8Array;

  constructor(f: any) {
    this.player_one      = f.player_one;
    this.player_two      = f.player_two;
    this.amount          = f.amount;
    this.player_one_side = f.player_one_side;
    this.status          = f.status;
    this.padding         = f.padding;
    this.game_id         = f.game_id;
    this.server_hash     = f.server_hash;
    this.client_seed_a   = f.client_seed_a;
    this.client_seed_b   = f.client_seed_b;
  }
}

const gameSchema: any = new Map([[GameAccount, {
  kind: 'struct',
  fields: [
    ['player_one',      [32]],
    ['player_two',      [32]],
    ['amount',          'u64'],
    ['player_one_side', 'u8'],
    ['status',          'u8'],
    ['padding',         [6]],   // FIX: was [2], now [6] to match Rust
    ['game_id',         'u64'], // FIX: field order matches Rust struct
    ['server_hash',     [32]],
    ['client_seed_a',   [32]],
    ['client_seed_b',   [32]],
  ],
}]]);

// ─── Borsh Schema — History PDA ──────────────────────────────────────────────
// Written by backend settler — read-only in frontend
class GameHistoryAccount {
  game_id:         bigint;
  player_one:      Uint8Array;
  player_two:      Uint8Array;
  amount:          bigint;
  winner:          Uint8Array;
  winner_side:     number;
  player_one_side: number;
  padding:         Uint8Array;
  server_seed:     Uint8Array;
  server_hash:     Uint8Array;
  client_seed_a:   Uint8Array;
  client_seed_b:   Uint8Array;
  flip_byte:       number;
  padding2:        Uint8Array;
  timestamp_slot:  bigint;

  constructor(f: any) {
    this.game_id         = f.game_id;
    this.player_one      = f.player_one;
    this.player_two      = f.player_two;
    this.amount          = f.amount;
    this.winner          = f.winner;
    this.winner_side     = f.winner_side;
    this.player_one_side = f.player_one_side;
    this.padding         = f.padding;
    this.server_seed     = f.server_seed;
    this.server_hash     = f.server_hash;
    this.client_seed_a   = f.client_seed_a;
    this.client_seed_b   = f.client_seed_b;
    this.flip_byte       = f.flip_byte;
    this.padding2        = f.padding2;
    this.timestamp_slot  = f.timestamp_slot;
  }
}

const historySchema: any = new Map([[GameHistoryAccount, {
  kind: 'struct',
  fields: [
    ['game_id',         'u64'],
    ['player_one',      [32]],
    ['player_two',      [32]],
    ['amount',          'u64'],
    ['winner',          [32]],
    ['winner_side',     'u8'],
    ['player_one_side', 'u8'],
    ['padding',         [6]],
    ['server_seed',     [32]],
    ['server_hash',     [32]],
    ['client_seed_a',   [32]],
    ['client_seed_b',   [32]],
    ['flip_byte',       'u8'],
    ['padding2',        [7]],
    ['timestamp_slot',  'u64'],
  ],
}]]);

// ─── Helpers ─────────────────────────────────────────────────────────────────
const connection = new web3.Connection(HELIUS_RPC, {
  commitment: 'confirmed',
  fetch: (url, options) => fetch(url as string, options as RequestInit),
});

const hex   = (bytes: ArrayLike<number>) => Buffer.from(bytes).toString('hex');
const SOL   = (lam: bigint | number) => Number(lam) / web3.LAMPORTS_PER_SOL;
const short = (k = '', h = 6, t = 4) => k ? `${k.slice(0, h)}…${k.slice(-t)}` : '?';

// Raw byte parse — avoids Borsh strict slice issues entirely
function parseGameRaw(data: Buffer): OpenGame | null {
  try {
    if (!data || data.length < GAME_SIZE) return null;
    if (data.every(b => b === 0)) return null;

    const status  = data.readUInt8(OFFSET_STATUS);
    const gameId  = data.readBigUInt64LE(OFFSET_GAME_ID);
    const amount  = data.readBigUInt64LE(OFFSET_AMOUNT);
    const side    = data.readUInt8(OFFSET_STATUS - 1); // player_one_side at 72

    const playerOne = new web3.PublicKey(data.slice(OFFSET_PLAYER_ONE, OFFSET_PLAYER_ONE + 32));
    const playerTwo = new web3.PublicKey(data.slice(OFFSET_PLAYER_TWO, OFFSET_PLAYER_TWO + 32));

    return { pubkey: null as any, player_one: playerOne, player_two: playerTwo,
             amount, player_one_side: side, status, game_id: gameId };
  } catch { return null; }
}

// History parse via Borsh unchecked
function parseHistoryRaw(data: Buffer): HistoryItem | null {
  try {
    const d = (borsh as any).deserializeUnchecked(
      historySchema, GameHistoryAccount, data
    ) as GameHistoryAccount;
    return {
      gameId:     String(d.game_id),
      playerOne:  new web3.PublicKey(d.player_one).toBase58(),
      playerTwo:  new web3.PublicKey(d.player_two).toBase58(),
      winner:     new web3.PublicKey(d.winner).toBase58(),
      winnerSide: d.winner_side === 0 ? 'HEADS' : 'TAILS',
      amount:     SOL(d.amount),
      seedA:      hex(d.client_seed_a),
      seedB:      hex(d.client_seed_b),
      serverSeed: hex(d.server_seed),
      serverHash: hex(d.server_hash),
      slot:       Number(d.timestamp_slot),
    };
  } catch { return null; }
}

// Secure storage with AsyncStorage fallback
const secureStorage = {
  getItem: async (key: string): Promise<string | null> => {
    try {
      const mod = await import('expo-secure-store');
      return await mod.getItemAsync(key);
    } catch (e) {
      console.warn('SecureStore getItem failed, trying AsyncStorage:', e);
      return AsyncStorage.getItem(key);
    }
  },
  setItem: async (key: string, value: string): Promise<void> => {
    try {
      const mod = await import('expo-secure-store');
      await mod.setItemAsync(key, value);
      // Also write to AsyncStorage as backup
      await AsyncStorage.setItem(key, value);
    } catch (e) {
      console.warn('SecureStore setItem failed, using AsyncStorage only:', e);
      await AsyncStorage.setItem(key, value);
    }
  },
  deleteItem: async (key: string): Promise<void> => {
    try {
      const mod = await import('expo-secure-store');
      await mod.deleteItemAsync(key);
    } catch { /* ignore */ }
    await AsyncStorage.removeItem(key);
  },
};

const serializeKeypair   = (kp: web3.Keypair) => JSON.stringify(Array.from(kp.secretKey));
const deserializeKeypair = (s: string) => web3.Keypair.fromSecretKey(Uint8Array.from(JSON.parse(s)));

async function ensureDevnetFunds(pk: web3.PublicKey) {
  const bal = await connection.getBalance(pk);
  if (bal >= web3.LAMPORTS_PER_SOL * 0.05) return;
  const last = Number(await AsyncStorage.getItem(LOCAL_WALLET_AIRDROP_KEY) ?? '0');
  if (Date.now() - last < 24 * 3600 * 1000) return;
  await AsyncStorage.setItem(LOCAL_WALLET_AIRDROP_KEY, String(Date.now()));
  try {
    const sig    = await connection.requestAirdrop(pk, web3.LAMPORTS_PER_SOL);
    const latest = await connection.getLatestBlockhash('confirmed');
    await connection.confirmTransaction({ signature: sig, ...latest }, 'confirmed');
  } catch (e: any) {
    if (!String(e?.message).includes('Rate limit')) throw e;
  }
}

// ─── Types ───────────────────────────────────────────────────────────────────
interface OpenGame {
  pubkey:          web3.PublicKey;
  player_one:      web3.PublicKey;
  player_two:      web3.PublicKey;
  amount:          bigint;
  player_one_side: number;
  status:          number;
  game_id:         bigint;
}

interface HistoryItem {
  gameId:     string;
  playerOne:  string;
  playerTwo:  string;
  winner:     string;
  winnerSide: 'HEADS' | 'TAILS';
  amount:     number;
  seedA:      string;
  seedB:      string;
  serverSeed: string;
  serverHash: string;
  slot:       number;
}

// ─── Palette ─────────────────────────────────────────────────────────────────
const C = {
  bg:      '#080b10',
  surface: '#0d1318',
  glass:   '#111820',
  border:  '#1c2530',
  accent:  '#14F195',
  purple:  '#9945FF',
  text:    '#e8edf2',
  muted:   '#5a6a7a',
  danger:  '#FF4545',
  gold:    '#F7C948',
};

const { width: SW } = Dimensions.get('window');

// ─────────────────────────────────────────────────────────────────────────────
// MAIN SCREEN
// ─────────────────────────────────────────────────────────────────────────────
export default function HomeScreen() {
  // ── Wallet ──────────────────────────────────────────────────────────────
  const [walletKey,     setWalletKey]     = useState<web3.PublicKey | null>(null);
  const [walletLoading, setWalletLoading] = useState(true);
  const [balance,       setBalance]       = useState(0);
  const localWallet = useRef<web3.Keypair | null>(null);

  // ── Game UI ──────────────────────────────────────────────────────────────
  const [wager,       setWager]       = useState('0.1');
  const [side,        setSide]        = useState(0); // 0=HEADS 1=TAILS
  const [openGames,   setOpenGames]   = useState<OpenGame[]>([]);
  const [gameHistory, setGameHistory] = useState<HistoryItem[]>([]);
  const [refreshing,  setRefreshing]  = useState(false);

  // ── Flow ─────────────────────────────────────────────────────────────────
  // phase: 'idle' | 'creating' | 'waiting' | 'joined' | 'settling' | 'done'
  const [phase,     setPhase]     = useState<string>('idle');
  const [systemMsg, setSystemMsg] = useState('LOBBY_READY');
  const [resultModal,  setResultModal]  = useState<'WON' | 'LOST' | null>(null);
  const [resultSide,   setResultSide]   = useState<number | null>(null);
  const [resultAmount, setResultAmount] = useState(0);
  const [selectedHist, setSelectedHist] = useState<HistoryItem | null>(null);

  // ── Refs ─────────────────────────────────────────────────────────────────
  const activePda    = useRef<web3.PublicKey | null>(null);
  const balBefore    = useRef(0);
  const lastGameId   = useRef<number | null>(null);
  const mySide       = useRef(0);
  const histSubRef   = useRef<number | null>(null);
  const settledRef   = useRef(false);
  const gameSubRef   = useRef<number | null>(null);
  const histInFlight = useRef(false);
  const histLastAt   = useRef(0);
  const histRetry    = useRef<ReturnType<typeof setTimeout> | null>(null);
  const settlePollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const settleLogsRef = useRef<number | null>(null);
  const settleStartedAtRef = useRef(0);
  const fetchHistoryRef = useRef<((force?: boolean) => Promise<void>) | null>(null);

  // ── Coin animation ────────────────────────────────────────────────────────
  const coinAnim   = useRef(new Animated.Value(0)).current;
  const flipLoop   = useRef<Animated.CompositeAnimation | null>(null);
  const flipping   = phase === 'waiting' || phase === 'joined' || phase === 'settling';

  useEffect(() => {
    if (flipping) {
      flipLoop.current = Animated.loop(Animated.sequence([
        Animated.timing(coinAnim, { toValue: 1, duration: 600, easing: Easing.inOut(Easing.sin), useNativeDriver: true }),
        Animated.timing(coinAnim, { toValue: 0, duration: 600, easing: Easing.inOut(Easing.sin), useNativeDriver: true }),
      ]));
      flipLoop.current.start();
    } else {
      flipLoop.current?.stop();
      coinAnim.setValue(0);
    }
    return () => flipLoop.current?.stop();
  }, [flipping]);

  const coinScaleY = coinAnim.interpolate({ inputRange: [0, 0.5, 1], outputRange: [1, 0.05, 1] });
  const settlingCoinTranslateY = coinAnim.interpolate({ inputRange: [0, 0.5, 1], outputRange: [120, 0, -120] });
  const settlingCoinRotateX = useRef(new Animated.Value(0)).current;
  // ─────────────────────────────────────────────────────────────────────────
  // WALLET INIT
  // ─────────────────────────────────────────────────────────────────────────
const loadWallet = useCallback(async () => {
  setWalletLoading(true);
  try {
    // Try SecureStore first, then AsyncStorage as fallback
    let stored: string | null = null;
    try {
      const mod = await import('expo-secure-store');
      stored = await mod.getItemAsync(LOCAL_WALLET_KEY);
    } catch {
      stored = await AsyncStorage.getItem(LOCAL_WALLET_KEY);
    }

    // Also check AsyncStorage backup
    if (!stored) {
      stored = await AsyncStorage.getItem(LOCAL_WALLET_KEY);
    }

    if (stored) {
      // Existing wallet found — restore it
      const kp = deserializeKeypair(stored);
      localWallet.current = kp;
      setWalletKey(kp.publicKey);
      console.log('Wallet restored:', kp.publicKey.toBase58());
    } else {
      // No wallet anywhere — create new one
      const kp = web3.Keypair.generate();
      const serialized = serializeKeypair(kp);

      // Save to both storages immediately
      try {
        const mod = await import('expo-secure-store');
        await mod.setItemAsync(LOCAL_WALLET_KEY, serialized);
      } catch { /* ignore */ }
      await AsyncStorage.setItem(LOCAL_WALLET_KEY, serialized);

      localWallet.current = kp;
      setWalletKey(kp.publicKey);
      console.log('New wallet created:', kp.publicKey.toBase58());
    }

    await ensureDevnetFunds(localWallet.current!.publicKey);
  } catch (e: any) {
    Alert.alert('Wallet Error', e.message);
  } finally {
    setWalletLoading(false);
  }
}, []);

  useEffect(() => { void loadWallet(); }, [loadWallet]);

  // ─────────────────────────────────────────────────────────────────────────
  // BALANCE
  // ─────────────────────────────────────────────────────────────────────────
  const refreshBalance = useCallback(async (): Promise<number> => {
    if (!walletKey) return 0;
    const raw = await connection.getBalance(walletKey);
    const bal = raw / web3.LAMPORTS_PER_SOL;
    setBalance(bal);
    return bal;
  }, [walletKey]);

  useEffect(() => { if (walletKey) void refreshBalance(); }, [walletKey]);

  // ─────────────────────────────────────────────────────────────────────────
  // SEND TX (local wallet signs directly — no wallet adapter needed)
  // ─────────────────────────────────────────────────────────────────────────
  const sendTx = useCallback(async (tx: web3.Transaction): Promise<string> => {
  const kp = localWallet.current;
  if (!kp) throw new Error('Wallet not ready');

  const latest = await connection.getLatestBlockhash('finalized');
  tx.feePayer        = kp.publicKey;
  tx.recentBlockhash = latest.blockhash;
  tx.sign(kp);

  const rawTx = tx.serialize();
  console.log('TX BYTES LEN:', rawTx.length);

  const sig = await connection.sendRawTransaction(rawTx, {
    skipPreflight:       true,   // ← THIS must be true
    preflightCommitment: 'confirmed',
    maxRetries:          3,
  });

  console.log('TX SENT sig:', sig);

  const confirm = await connection.confirmTransaction(
    {
      signature:            sig,
      blockhash:            latest.blockhash,
      lastValidBlockHeight: latest.lastValidBlockHeight,
    },
    'confirmed'
  );

  if (confirm.value.err) {
    // Fetch logs from chain for real error detail
    try {
      const txDetail = await connection.getTransaction(sig, {
        commitment: 'confirmed',
        maxSupportedTransactionVersion: 0,
      });
      console.log('TX LOGS:', txDetail?.meta?.logMessages);
      throw new Error(
        'Transaction failed: ' +
        JSON.stringify(confirm.value.err) +
        ' | logs: ' +
        JSON.stringify(txDetail?.meta?.logMessages)
      );
    } catch (fetchErr: any) {
      throw new Error('Transaction failed: ' + JSON.stringify(confirm.value.err));
    }
  }

  return sig;
}, []);

  // ─────────────────────────────────────────────────────────────────────────
  // ACTIVE GAME WATCHER
  // Subscribes to game PDA account changes.
  // Backend settler wipes account to zeros on settlement.
  // ─────────────────────────────────────────────────────────────────────────
  const unsubGame = useCallback(() => {
    if (gameSubRef.current !== null) {
      connection.removeAccountChangeListener(gameSubRef.current);
      gameSubRef.current = null;
    }
  }, []);

  // Helper: fetch a single history item by gameId from on-chain PDAs
  const getHistoryByGameId = useCallback(async (gameId: number) => {
    try {
      const accounts = await connection.getProgramAccounts(PROGRAM_ID, {
        filters: [{ dataSize: HISTORY_SIZE }],
        commitment: 'confirmed',
      });

      for (const { account } of accounts) {
        const buf  = Buffer.isBuffer(account.data) ? account.data : Buffer.from(account.data as any);
        const item = parseHistoryRaw(buf);
        if (item && String(gameId) === String(item.gameId)) return item;
      }
    } catch (e) {
      console.error('getHistoryByGameId:', e);
    }
    return null;
  }, []);

  const clearSettlingWatchers = useCallback(() => {
    if (settlePollRef.current) {
      clearInterval(settlePollRef.current);
      settlePollRef.current = null;
    }
    if (settleLogsRef.current !== null) {
      try { connection.removeOnLogsListener(settleLogsRef.current); } catch {}
      settleLogsRef.current = null;
    }
  }, [connection]);


  const onSettled = useCallback(async () => {
    if (settledRef.current) return;
    settledRef.current = true;
    unsubGame();

    setPhase('settling');
    setSystemMsg('VERIFYING_OUTCOME...');
    settleStartedAtRef.current = Date.now();

    clearSettlingWatchers();

    // Match the webapp flow: give the backend a brief moment to write the
    // history PDA, then resolve from history first and balance second.
    await new Promise(resolve => setTimeout(resolve, 2500));

    let won: boolean | null = null;
    const gid = lastGameId.current;

    try {
      if (gid != null) {
        const history = await getHistoryByGameId(gid);
        console.log('history lookup for settlement', {
          gameId: gid,
          found: !!history,
        });

        if (history) {
          won = (() => {
            try { return !!walletKey && new web3.PublicKey(history.winner).equals(walletKey); }
            catch { return history.winner === walletKey?.toBase58(); }
          })();

          console.log('winner selected from history', {
            gameId: gid,
            winnerPubkey: history.winner,
            myPubkey: walletKey ? walletKey.toBase58() : null,
            winnerSide: history.winnerSide,
            won,
          });

          applyHistoryResult(history);
          return;
        }
      }
    } catch (e) {
      console.warn('history lookup failed:', e);
    }

    if (won === null) {
      const newBal = await refreshBalance();
      won = newBal > balBefore.current;
      console.log('winner selected from balance fallback', {
        newBal,
        balanceBefore: balBefore.current,
        won,
      });
    }

    const selectedSide = won ? mySide.current : (mySide.current === 0 ? 1 : 0);
    console.log('final winner decision', {
      won,
      selectedSide,
      resultLabel: won ? 'WON' : 'LOST',
    });

    setResultSide(selectedSide);
    setResultAmount(won ? parseFloat(wager) : 0);
    setResultModal(won ? 'WON' : 'LOST');
    setSystemMsg(won ? 'SETTLED: YOU WON' : 'SETTLED: YOU LOST');
    setPhase('done');
    activePda.current = null;
    settledRef.current = false;

    setTimeout(() => { void fetchHistoryRef.current?.(true); }, 3000);
  }, [clearSettlingWatchers, getHistoryByGameId, refreshBalance, unsubGame, walletKey]);

  const subscribeToGame = useCallback((pda: web3.PublicKey) => {
    unsubGame();
    const id = connection.onAccountChange(
      pda,
      (info) => {
        // Zeros = account closed after settlement
        if (!info.data || info.data.length === 0 || Buffer.from(info.data).every(b => b === 0)) {
          void onSettled();
          return;
        }

        // Parse raw bytes — no Borsh strict slice issues
        const buf    = Buffer.from(info.data);
        const status = buf.readUInt8(OFFSET_STATUS);

        if (status === 2) {
          // Both players joined — backend settler will now settle
          setSystemMsg('OPPONENT_JOINED!');
          setPhase('joined');
        }
        // status=1 = still open, waiting
        // status=3 would be settled — but account gets wiped before we see it
      },
      'confirmed'
    );
    gameSubRef.current = id;
  }, [connection, onSettled, unsubGame]);

  // Cleanup on unmount
  useEffect(() => () => {
    unsubGame();
    if (histRetry.current) clearTimeout(histRetry.current);
    clearSettlingWatchers();
    if (histSubRef.current !== null) { try { connection.removeProgramAccountChangeListener(histSubRef.current); } catch {} histSubRef.current = null; }
  }, [clearSettlingWatchers, connection, unsubGame]);

  // ─────────────────────────────────────────────────────────────────────────
  // FETCH OPEN GAMES
  // Filter to GAME_SIZE=200 so we never accidentally parse history PDAs
  // ─────────────────────────────────────────────────────────────────────────
  const fetchGames = useCallback(async () => {
    try {
      const accounts = await connection.getProgramAccounts(PROGRAM_ID, {
        filters: [{ dataSize: GAME_SIZE }],
        commitment: 'confirmed',
      });

      const games: OpenGame[] = [];
      for (const { pubkey, account } of accounts) {
        const buf  = Buffer.isBuffer(account.data)
          ? account.data
          : Buffer.from(account.data as any);
        const game = parseGameRaw(buf);
        if (game && game.status === 1) {
          games.push({ ...game, pubkey });
        }
      }
      setOpenGames(games);
    } catch (e) { console.error('fetchGames:', e); }
  }, []);

  // Poll every 5s while idle, pause during active game flow
  useEffect(() => {
    if (!walletKey) return;
    void fetchGames();
    if (phase === 'creating' || phase === 'settling') return;
    const t = setInterval(fetchGames, 5000);
    return () => clearInterval(t);
  }, [walletKey, phase, fetchGames]);

  // ─────────────────────────────────────────────────────────────────────────
  // FETCH HISTORY — reads on-chain history PDAs (size=280)
  // Written by backend settler. Primary source, no log parsing needed.
  // ─────────────────────────────────────────────────────────────────────────
  const fetchHistory = useCallback(async (force = false) => {
    const now = Date.now();
    if (histInFlight.current) return;
    if (!force && now - histLastAt.current < 15000) return;
    histInFlight.current = true;
    try {
      const accounts = await connection.getProgramAccounts(PROGRAM_ID, {
        filters: [{ dataSize: HISTORY_SIZE }],
        commitment: 'confirmed',
      });

      const items: HistoryItem[] = [];
      for (const { account } of accounts) {
        const buf  = Buffer.isBuffer(account.data)
          ? account.data
          : Buffer.from(account.data as any);
        const item = parseHistoryRaw(buf);
        if (item) items.push(item);
      }
      items.sort((a, b) => Number(b.gameId) - Number(a.gameId));

      setGameHistory(prev => {
        const seen   = new Set(prev.map(x => x.gameId));
        const merged = [...prev];
        for (const item of items) {
          if (!seen.has(item.gameId)) { merged.push(item); seen.add(item.gameId); }
        }
        return merged.sort((a, b) => Number(b.gameId) - Number(a.gameId));
      });

      histLastAt.current = now;
    } catch (e) {
      console.error('fetchHistory:', e);
      if (histRetry.current) clearTimeout(histRetry.current);
      histRetry.current = setTimeout(() => fetchHistory(true), 10000);
    } finally {
      histInFlight.current = false;
    }
  }, []);
  useEffect(() => {
    fetchHistoryRef.current = fetchHistory;
  }, [fetchHistory]);
  useEffect(() => { if (walletKey) void fetchHistory(false); }, [walletKey]);

  // Apply a history item: set UI state and cleanup
  const applyHistoryResult = useCallback((history: HistoryItem) => {
    console.log('applyHistoryResult', history);
    clearSettlingWatchers();
    const youWon = (() => {
      try { return !!walletKey && new web3.PublicKey(history.winner).equals(walletKey); }
      catch { return history.winner === walletKey?.toBase58(); }
    })();
    setResultSide(history.winnerSide === 'HEADS' ? 0 : 1);
    setResultAmount(history.amount);
    setResultModal(youWon ? 'WON' : 'LOST');
    setSystemMsg(youWon ? 'SETTLED: YOU WON' : 'SETTLED: YOU LOST');
    setPhase('done');
    activePda.current = null;
    settledRef.current = false;
    // cleanup listeners
    if (histSubRef.current !== null) { try { connection.removeProgramAccountChangeListener(histSubRef.current); } catch{} histSubRef.current = null; }
    if (gameSubRef.current !== null) { try { connection.removeAccountChangeListener(gameSubRef.current); } catch{} gameSubRef.current = null; }
    // refresh history list
    setTimeout(() => fetchHistory(true), 500);
  }, [walletKey, fetchHistory, clearSettlingWatchers]);

  // Subscribe to program account changes for history PDAs matching gameId
  const subscribeToHistory = useCallback((gameId: number) => {
    if (histSubRef.current !== null) {
      try { connection.removeProgramAccountChangeListener(histSubRef.current); } catch {};
      histSubRef.current = null;
    }

    // game_id is at offset 0 in history account (u64 little-endian)
    const buf = Buffer.alloc(8);
    buf.writeBigUInt64LE(BigInt(gameId));
    const b58 = bs58.encode(buf);

    const id = connection.onProgramAccountChange(
      PROGRAM_ID,
      (ka: any) => {
        try {
          const raw = ka.account?.data ?? ka.accountInfo?.data ?? ka.value?.account?.data ?? ka.value?.accountInfo?.data;
          if (!raw) return;
          const accBuf = Buffer.isBuffer(raw) ? raw : Buffer.from(raw as any);
          const item = parseHistoryRaw(accBuf);
          if (item && String(item.gameId) === String(gameId)) {
            console.log('realtime history received for', gameId, item);
            applyHistoryResult(item);
          }
        } catch (e) { console.error('onProgramAccountChange err:', e); }
      },
      'confirmed',
      [{ dataSize: HISTORY_SIZE }, { memcmp: { offset: 0, bytes: b58 } }]
    );

    histSubRef.current = id;
  }, [applyHistoryResult]);

  // ─────────────────────────────────────────────────────────────────────────
  // CREATE GAME
  // ─────────────────────────────────────────────────────────────────────────
  const createGame = async () => {
  if (!walletKey || walletLoading || phase !== 'idle') return;
  const wagerF = parseFloat(wager);
  if (isNaN(wagerF) || wagerF < MIN_BET || wagerF > MAX_BET) {
    Alert.alert('Invalid Wager', `Bet must be between ${MIN_BET} and ${MAX_BET} SOL`);
    return;
  }

  setPhase('creating');
  setSystemMsg('REQUESTING_SERVER_HASH...');
  try {
    // 1. Get server hash from backend
    const gameId = Math.floor(Date.now() / 1000);
    const res    = await fetch(`${BACKEND_URL}/generate-game`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ gameId }),
    });
    if (!res.ok) throw new Error(`Backend error: ${res.status}`);
    const { serverHash } = await res.json();
    const serverHashBytes = Array.isArray(serverHash)
      ? serverHash
      : Array.from(Buffer.from(serverHash, 'hex'));

    // 2. Client seed A
    const clientSeedA = Array.from(crypto.getRandomValues(new Uint8Array(32)));

    // 3. Derive PDA
    // Use Uint8Array for gameId buffer — Buffer.alloc + writeBigUInt64LE
    // works fine for PDA derivation (no copy involved)
    const gameIdBufForPda = Buffer.alloc(8);
    gameIdBufForPda.writeBigUInt64LE(BigInt(gameId));
    const [pda] = await web3.PublicKey.findProgramAddress(
      [Buffer.from('game'), walletKey.toBuffer(), gameIdBufForPda],
      PROGRAM_ID
    );

    // 4. Build instruction data via Uint8Array.set()
    // ─────────────────────────────────────────────────────────────────
    // Buffer.copy() and spread [...arr] are both broken in the React
    // Native Buffer polyfill for typed arrays.
    // Uint8Array.set() is the only reliable method in RN.
    //
    // Layout (82 bytes total):
    //   [0]      u8   variant = 0 (CreateGame)
    //   [1..8]   u64  game_id  (little-endian)
    //   [9..16]  u64  amount   (little-endian)
    //   [17]     u8   side     (0=HEADS, 1=TAILS)
    //   [18..49] [32] server_hash
    //   [50..81] [32] client_seed_a
    // ─────────────────────────────────────────────────────────────────
    const lamports  = BigInt(Math.round(wagerF * web3.LAMPORTS_PER_SOL));

    const gameIdArr = new Uint8Array(8);
    const amountArr = new Uint8Array(8);
    new DataView(gameIdArr.buffer).setBigUint64(0, BigInt(gameId), true);
    new DataView(amountArr.buffer).setBigUint64(0, lamports,       true);

    const ixData    = new Uint8Array(82);
    ixData[0]       = 0;                                      // variant
    ixData.set(gameIdArr,                      1);            // game_id
    ixData.set(amountArr,                      9);            // amount
    ixData[17]      = side;                                   // side
    ixData.set(Uint8Array.from(serverHashBytes), 18);         // server_hash
    ixData.set(Uint8Array.from(clientSeedA),     50);         // client_seed_a

    const data = Buffer.from(ixData);

    // Sanity check in dev — remove before mainnet
    console.log('ix len:', data.length);                      // 82
    console.log('variant:', data[0]);                         // 0
    console.log('side:', data[17]);                           // 0 or 1
    console.log('hash[0..3]:', Array.from(data.slice(18, 22)));  // non-zero
    console.log('seed[0..3]:', Array.from(data.slice(50, 54)));  // non-zero

    // 5. Build transaction
    // Accounts: [game_pda(w), player_one(signer,w), system_program]
    const tx = new web3.Transaction().add(
      new web3.TransactionInstruction({
        keys: [
          { pubkey: pda,                          isSigner: false, isWritable: true  },
          { pubkey: walletKey,                    isSigner: true,  isWritable: true  },
          { pubkey: web3.SystemProgram.programId, isSigner: false, isWritable: false },
        ],
        programId: PROGRAM_ID,
        data,
      })
    );

    // 6. Sign and send
    setSystemMsg('SIGNING_TRANSACTION...');
    const sig = await sendTx(tx);
    console.log('createGame OK sig:', sig);
    // remember game id for settlement lookup
    lastGameId.current = gameId;
    // subscribe for realtime history write
    subscribeToHistory(gameId);

    // 7. Snapshot balance AFTER confirmed (bet + rent already deducted)
    balBefore.current  = await refreshBalance();
    mySide.current     = side;
    activePda.current  = pda;
    settledRef.current = false;

    // 8. Subscribe — backend settler wipes account on settlement
    subscribeToGame(pda);

    setPhase('waiting');
    setSystemMsg('Game Created');
    void fetchGames();

  } catch (e: any) {
    console.error('createGame error:', e?.message);
    console.error('createGame logs:', e?.logs);
    setSystemMsg('ERR: ' + (e?.message ?? 'Unknown error'));
    setPhase('idle');
  }
};
  // ─────────────────────────────────────────────────────────────────────────
  // JOIN GAME
  // ─────────────────────────────────────────────────────────────────────────
 const joinGame = async (game: OpenGame) => {
  if (!walletKey || walletLoading || phase !== 'idle') return;
  if (game.player_one.equals(walletKey)) {
    Alert.alert('Error', 'Cannot join your own lobby');
    return;
  }

  setPhase('creating');
  setSystemMsg('JOINING_MATCH...');
  try {
    const clientSeedB = Array.from(crypto.getRandomValues(new Uint8Array(32)));

    // Layout: [u8 variant=1][32 client_seed_b]
    const ixData = new Uint8Array(33);
    ixData[0] = 1;
    ixData.set(Uint8Array.from(clientSeedB), 1);
    const data = Buffer.from(ixData);

    const tx = new web3.Transaction().add(
      new web3.TransactionInstruction({
        keys: [
          { pubkey: game.pubkey,                  isSigner: false, isWritable: true  },
          { pubkey: walletKey,                    isSigner: true,  isWritable: true  },
          { pubkey: web3.SystemProgram.programId, isSigner: false, isWritable: false },
        ],
        programId: PROGRAM_ID,
        data,
      })
    );

    setSystemMsg('SIGNING_TRANSACTION...');
    await sendTx(tx);

    // remember game id so settler lookup can find history PDA
    lastGameId.current = Number(game.game_id);
    // subscribe for realtime history write
    subscribeToHistory(Number(game.game_id));

    balBefore.current  = await refreshBalance();
    mySide.current     = game.player_one_side === 0 ? 1 : 0;
    activePda.current  = game.pubkey;
    settledRef.current = false;

    subscribeToGame(game.pubkey);

    setPhase('joined');
    setSystemMsg('MATCH_LIVE: AWAITING_SETTLER...');
    void fetchGames();
  } catch (e: any) {
    console.error('joinGame error:', e?.message);
    setSystemMsg('ERR: ' + (e?.message ?? 'Unknown error'));
    setPhase('idle');
  }
};

  // ─────────────────────────────────────────────────────────────────────────
  // CANCEL GAME
  // ─────────────────────────────────────────────────────────────────────────
  const cancelGame = async (game: OpenGame) => {
    if (!walletKey || !game.player_one.equals(walletKey)) return;
    setSystemMsg('CANCELLING...');
    try {
      const data = Buffer.alloc(1);
      data.writeUInt8(3, 0); // variant=3 CancelGame

      const tx = new web3.Transaction().add(
        new web3.TransactionInstruction({
          keys: [
            { pubkey: game.pubkey, isSigner: false, isWritable: true },
            { pubkey: walletKey,   isSigner: true,  isWritable: true },
          ],
          programId: PROGRAM_ID,
          data,
        })
      );

      await sendTx(tx);
      setSystemMsg('LOBBY_CANCELLED: REFUNDED');
      unsubGame();
      activePda.current = null;
      setPhase('idle');
      void refreshBalance();
      void fetchGames();
    } catch (e: any) {
      setSystemMsg('ERR: ' + (e.message ?? 'Unknown error'));
    }
  };

  // ─────────────────────────────────────────────────────────────────────────
  // PULL TO REFRESH
  // ─────────────────────────────────────────────────────────────────────────
  const onRefresh = async () => {
    setRefreshing(true);
    await Promise.all([fetchGames(), refreshBalance(), fetchHistory(true)]);
    setRefreshing(false);
  };

  // ─────────────────────────────────────────────────────────────────────────
  // RENDER HELPERS
  // ─────────────────────────────────────────────────────────────────────────
  const inGame = phase !== 'idle' && phase !== 'done';
  const busy   = phase === 'creating';
  const isLoseResult = resultModal === 'LOST';
  const resultCoinMainFill = isLoseResult ? '#121314' : '#c3f306';
  const resultCoinDetailFill = isLoseResult ? '#8A8D90' : '#121314';

const renderLobbyCard = ({ item }: { item: OpenGame }) => {
  const own    = walletKey && item.player_one.equals(walletKey);
  const pubStr = item.pubkey.toBase58();
  
  // 1. Convert BigInt lamports safely into a number string
  const rawSolNumber = Number(item.amount) / web3.LAMPORTS_PER_SOL;
  
  // 2. Force the trailing zero immediately at the string generation level
  const formattedSolString = rawSolNumber.toFixed(2); 

  return (
    <View style={s.lobbyCard}>
      <View style={s.lobbyCardTop}>
        {/* 3. Use the pre-formatted string directly here */}
        <Text style={s.lobbyAmount}>{formattedSolString} SOL</Text>
        <View style={[s.chip, { backgroundColor: item.player_one_side === 0 ? C.accent + '22' : C.purple + '22' }]}>
          <Text style={[s.chipText, { color: item.player_one_side === 0 ? C.accent : C.purple }]}>
            {item.player_one_side === 0 ? 'HEADS' : 'TAILS'}
          </Text>
        </View>
      </View>
      <Text style={s.lobbyMeta}>PDA: {short(pubStr)}</Text>
      <Text style={s.lobbyMeta}>BY: {short(item.player_one.toBase58())}</Text>
      <View style={s.lobbyActions}>
        {own ? (
          <>
            <Text style={s.ownLabel}>YOUR LOBBY</Text>
            <TouchableOpacity
              style={[s.btnDanger, inGame && s.btnDisabled]}
              onPress={() => cancelGame(item)}
              disabled={inGame}
            >
              <Text style={s.btnDangerText}>CANCEL</Text>
            </TouchableOpacity>
          </>
        ) : (
          <TouchableOpacity
            style={[s.btnJoin, (!walletKey || inGame) && s.btnDisabled]}
            onPress={() => joinGame(item)}
            disabled={!walletKey || inGame}
          >
            <Text style={s.btnJoinText}>JOIN {formattedSolString} SOL</Text>
          </TouchableOpacity>
        )}
      </View>
    </View>
  );
};
const verticalTumbleX = settlingCoinRotateX.interpolate({
    inputRange: [0, 1],
    outputRange: ['0deg', '720deg'], // 720 degrees creates two full clean vertical flips
  });
  // ─────────────────────────────────────────────────────────────────────────
  // RENDER
  // ─────────────────────────────────────────────────────────────────────────
 if (phase === 'settling') {
  return (
   <View style={s.settlingScreen}>
      <Animated.View
        style={[
          s.settlingCoin,
          {
            transform: [
              { perspective: 1000 },              // Enhances 3D depth perspective for the flip
              { translateY: settlingCoinTranslateY },
              { rotateX: verticalTumbleX },       // Locks the spin strictly to the vertical X-Axis
              { scaleY: coinScaleY },
            ],
          },
        ]}
      >
        {/* ─── NATIVE VECTOR ARCADE COIN ASSET ─── */}
        <Svg width={200} height={215} viewBox="0 0 597.86 643.33">
          {/* Base Layer: High-Contrast Neon Lime Face Accent Plate */}
          <Path 
            fill="#c3f306" 
            d="M596.49,327.98c-11.95,118.61-94.41,225.51-94.41,225.51-99.74,71.17-203.12,88.36-203.12,88.36-5.45-1.53-10.78-3.06-16.06-4.68-114.05-34.59-184.85-84.9-202.52-98.44-2.89-2.19-4.37-3.41-4.37-3.41C3.84,407.74,1.37,314.75,1.37,314.75,25.38,191.6,92.46,91.86,92.46,91.86,182.33,26.42,268.96,5.79,286.53,2.1c2.13-.45,3.23-.62,3.23-.62,41.69,5.87,78.35,16.77,109.39,29.34,76.79,31.04,119.41,72.19,119.41,72.19,71.37,113.19,77.92,225,77.92,225v-.03Z"
          />
          
          {/* Bottom Hard Edge Drop Shadow Vector Rim */}
          <Path 
            fill="#121314" 
            d="M476.14,544.83c-71.76,60.04-162.74,85.21-193.24,92.34-114.05-34.59-184.85-84.9-202.52-98.44,56.07,38.73,203.69,83.48,203.69,83.48,84.36-16.32,182.18-86.41,182.18-86.41l9.9,9.05v-.03Z"
          />
          
          {/* Main Structural Detail Group Lines & Core Solana Crest */}
          <G fill="#121314">
            <Path d="M445.72,128.83s-67.17-53.8-162.29-78.43c0,0-108.65,35.24-162.48,75.94,0,0-55.67,90.18-77.44,190.49,0,0,3.43,72.96,64.33,184.65,0,0-41.83-115.15-44.35-176.96,0,0,37.23-122.27,74.46-178.35,0,0,76.08-53.32,149.15-74.01,0,0,44.35-.65,158.57,56.67h.06Z" />
            <Path d="M508.55,299.34s-31.53,103.04-84.65,188c0,0-82.04,61.01-169.61,85.53l13.73,4.37s91.37-17.85,167.85-75.77c0,0,60.73-97.64,75.03-182.86l-2.33-19.27h-.03Z" />
            <Path d="M544.44,253.69c-36.8-125.74-70.06-161.01-70.06-161.01C384.14,27.18,309.26,7.04,286.5,2.1c2.13-.45,3.23-.62,3.23-.62,41.69,5.87,78.35,16.77,109.39,29.34,52.1,24.74,87.83,55.73,87.83,55.73,38.71,54.23,56.87,163.39,57.49,167.17v-.03Z" />
            <Path d="M476.14,544.83s77.64-115.61,74.43-212.23c0,0-17.51,106.27-84.36,203.18" />
            
            {/* Solana Crest Segment: Top Row Parallelogram */}
            <Path d="M415.19,197.53l-47.93,49.97c-2.3,2.38-5.45,3.75-8.77,3.75h-212.26c-5.39,0-8.17-6.47-4.43-10.36l47.93-49.97c2.3-2.38,5.45-3.75,8.77-3.75h212.26c5.39,0,8.17,6.47,4.43,10.36h0Z" />
            {/* Solana Crest Segment: Middle Row Parallelogram */}
            <Path d="M141.84,291.57l47.93,49.97c2.3,2.38,5.45,3.75,8.77,3.75h212.26c5.39,0,8.17-6.47,4.43-10.36l-47.93-49.97c-2.3-2.38-5.45-3.75-8.77-3.75h-212.26c-5.39,0-8.17,6.47-4.43,10.36Z" />
            {/* Solana Crest Segment: Bottom Row Parallelogram */}
            <Path d="M415.19,385.58l-47.93,49.97c-2.3,2.38-5.45,3.75-8.77,3.75h-212.26c-5.39,0-8.17-6.47-4.43-10.36l47.93-49.97c2.3,2.38,5.45,3.75,8.77,3.75h212.26c5.39,0,8.17,6.47,4.43,10.36Z" />
          </G>
        </Svg>
      </Animated.View>
    </View>
  );
}

  return (
    <SafeAreaView style={s.root}>

      {/* ── TOP BAR ───────────────────────────────────────────────────────── */}
 <View style={s.topBar}>
  {/* Left Brand Area: Chunky "2X" Text + Coin Emblem */}
  <Pressable style={s.brandWrapper} onPress={() => router.push('/')}>

<Svg 
      id="reference-one" 
      width={90}          // Explicitly sets display width (adjust to match top bar)
      height={76}         // Explicitly sets display height
      viewBox="0 0 280.37 153.25"
    >
      {/* Background Outer Framework Shape */}
      <Polygon 
        fill="#121314" // Ink black base backdrop mapping
        points="88.99 10.55 20.04 1.63 2.98 60.61 26.28 67.8 7.44 79.17 4.25 151.62 87.17 141.34 122.66 146.25 125.48 134.93 130.67 151.62 184.37 142.25 206.49 150.17 232.7 145.71 252.18 133.6 270.02 111.48 277.39 76.63 267.2 37.76 243.89 14.65 206.76 4.54 183.55 14.19 185.83 8.45 131.13 12.64 128.58 19.65 126.76 12.73 88.99 10.55"
      />

      {/* Chunky Digit '2' Graphic Shape Layer */}
      <Polygon 
        fill="#FFFFFF" // Fixed from class cls-2
        points="48.56 58.96 21.62 50.61 30.73 19.23 79.25 22.47 89.96 41.41 88.55 72.56 44.39 99.42 42.03 110.75 65.59 107.93 64.64 97.63 91.53 92.35 86.13 126.61 20.04 134.66 22.15 87.89 65.55 61.76 64.18 42.32 49.26 43.45 48.56 58.96"
      />

      {/* Chunky Character 'X' Graphic Shape Layer */}
      <Polygon 
        fill="#FFFFFF" // Fixed from class cls-2
        points="91.19 25.48 117.04 27.12 128.39 61.02 140.15 26.82 165.29 25.11 143.09 78.26 165.93 130.54 141.03 134.93 127.85 93.61 115.91 130.8 91.81 127.19 112.7 76.52 91.19 25.48"
      />

      {/* Main Solana Coin Neon Fill Base Circle */}
      <Path 
        fill="#c3f306" // Fixed from class cls-1
        d="M263.15,78.19c-2.07,20.59-16.39,39.14-16.39,39.14-17.31,12.35-35.26,15.34-35.26,15.34-.95-.27-1.87-.53-2.79-.81-19.8-6-32.08-14.74-35.15-17.09-.5-.38-.76-.59-.76-.59-12.53-22.14-12.95-38.29-12.95-38.29,4.17-21.38,15.81-38.69,15.81-38.69,15.6-11.36,30.64-14.94,33.68-15.58.37-.08.56-.11.56-.11,7.24,1.02,13.6,2.91,18.99,5.09,13.33,5.39,20.73,12.53,20.73,12.53,12.39,19.65,13.53,39.05,13.53,39.05h0Z"
      />

      {/* Secondary Bottom Shadow Lip Overlay */}
      <Path 
        fill="#121314"
        d="M242.26,115.83c-12.46,10.42-28.25,14.79-33.54,16.03-19.8-6-32.08-14.74-35.15-17.09,9.73,6.72,35.35,14.49,35.35,14.49,14.64-2.83,31.62-15,31.62-15l1.72,1.57h0Z"
      />

      {/* Solana Nested Inner Geometric Rings and Segment Bars Group */}
      <G>
        <Path fill="#121314" d="M236.98,43.63s-11.66-9.34-28.17-13.61c0,0-18.86,6.12-28.2,13.18,0,0-9.66,15.65-13.44,33.06,0,0,.6,12.66,11.17,32.05,0,0-7.26-19.99-7.7-30.71,0,0,6.46-21.22,12.92-30.96,0,0,13.2-9.25,25.89-12.85,0,0,7.7-.11,27.52,9.84h0Z" />
        <Path fill="#121314" d="M247.88,73.22s-5.47,17.88-14.69,32.63c0,0-14.24,10.59-29.44,14.85l2.38.76s15.86-3.1,29.13-13.15c0,0,10.54-16.95,13.02-31.74l-.4-3.34h0Z" />
        <Path fill="#121314" d="M254.11,65.3c-6.39-21.82-12.16-27.95-12.16-27.95-15.66-11.37-28.66-14.86-32.61-15.72.37-.08.56-.11.56-.11,7.24,1.02,13.6,2.91,18.99,5.09,9.04,4.29,15.24,9.67,15.24,9.67,6.72,9.41,9.87,28.36,9.98,29.02h0Z" />
        <Path fill="#121314" d="M242.26,115.83s13.48-20.07,12.92-36.84c0,0-3.04,18.45-14.64,35.27" />
        
        {/* Top Slanted Horizontal Bar Track */}
        <Path fill="#121314" d="M231.68,55.55l-8.32,8.67c-.4.41-.95.65-1.52.65h-36.84c-.94,0-1.42-1.12-.77-1.8l8.32-8.67c.4-.41.95-.65,1.52-.65h36.84c.94,0,1.42,1.12.77,1.8h0Z" />
        
        {/* Center Slanted Horizontal Bar Track */}
        <Path fill="#121314" d="M184.23,71.87l8.32,8.67c.4.41.95.65,1.52.65h36.84c.94,0,1.42-1.12.77-1.8l-8.32-8.67c-.4-.41-.95-.65-1.52-.65h-36.84c-.94,0-1.42,1.12-.77,1.8Z" />
        
        {/* Bottom Slanted Horizontal Bar Track */}
        <Path fill="#121314" d="M231.68,88.19l-8.32,8.67c-.4.41-.95.65-1.52.65h-36.84c-.94,0-1.42-1.12-.77-1.8l8.32-8.67c.4-.41.95-.65,1.52-.65h36.84c.94,0,1.42,1.12.77,1.8Z" />
      </G>
    </Svg>
  </Pressable>

  {/* Right Balance Display Box with Brutalist Hard Shadow */}
 <WalletNavbarMenu
  balanceLabel={walletLoading ? '...' : balance.toFixed(1)}
  walletAddress={walletKey?.toBase58() ?? ''}
 />
</View>

      <ScrollView
  style={{ flex: 1 }}
  contentContainerStyle={s.scroll}
  scrollEnabled={false} // 👈 This completely locks vertical and horizontal scrolling
  refreshControl={
    <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={C.accent} />
  }
  showsVerticalScrollIndicator={false}
>
  {/* Your child elements here */}

        {/* ── HERO COIN ────────────────────────────────────────────────────── */}
        <View style={s.heroSection}>
  <Animated.View
    style={[
      s.coin,
      {
        transform: [
  { perspective: 1000 }, // Creates 3D depth for the vertical tilt/tumble
  {
    // 💡 FIXED: Changed from rotateY to rotateX for a vertical coin toss tumble
    rotateX: coinAnim.interpolate({
      inputRange: [0, 1],
      outputRange: ['0deg', '180deg'], // Tumbles forward and backward over its horizontal axis
    }),
  },
],
      },
    ]}
  >
    {/* Your exact SVG inline coin structure stays perfectly sharp during the animation */}
    <Svg id="reference-one" width={220} height={220} viewBox="0 0 597.86 643.33">
      {/* Main Solana Coin Neon Fill Base Circle */}
      <Path 
        fill="#c3f306" 
        d="M596.49,327.98c-11.95,118.61-94.41,225.51-94.41,225.51-99.74,71.17-203.12,88.36-203.12,88.36-5.45-1.53-10.78-3.06-16.06-4.68-114.05-34.59-184.85-84.9-202.52-98.44-2.89-2.19-4.37-3.41-4.37-3.41C3.84,407.74,1.37,314.75,1.37,314.75,25.38,191.6,92.46,91.86,92.46,91.86,182.33,26.42,268.96,5.79,286.53,2.1c2.13-.45,3.23-.62,3.23-.62,41.69,5.87,78.35,16.77,109.39,29.34,76.79,31.04,119.41,72.19,119.41,72.19,71.37,113.19,77.92,225,77.92,225v-.03Z"
      />
      {/* Secondary Bottom Shadow Lip Overlay */}
      <Path 
        fill="#121314" 
        d="M476.14,544.83c-71.76,60.04-162.74,85.21-193.24,92.34-114.05-34.59-184.85-84.9-202.52-98.44,56.07,38.73,203.69,83.48,203.69,83.48,84.36-16.32,182.18-86.41,182.18-86.41l9.9,9.05v-.03Z"
      />
      <G>
        <Path fill="#121314" d="M445.72,128.83s-67.17-53.8-162.29-78.43c0,0-108.65,35.24-162.48,75.94,0,0-55.67,90.18-77.44,190.49,0,0,3.43,72.96,64.33,184.65,0,0-41.83-115.15-44.35-176.96,0,0,37.23-122.27,74.46-178.35,0,0,76.08-53.32,149.15-74.01,0,0,44.35-.65,158.57,56.67h.06Z" />
        <Path fill="#121314" d="M508.55,299.34s-31.53,103.04-84.65,188c0,0-82.04,61.01-169.61,85.53l13.73,4.37s91.37-17.85,167.85-75.77c0,0,60.73-97.64,75.03-182.86l-2.33-19.27h-.03Z" />
        <Path fill="#121314" d="M544.44,253.69c-36.8-125.74-70.06-161.01-70.06-161.01C384.14,27.18,309.26,7.04,286.5,2.1c2.13-.45,3.23-.62,3.23-.62,41.69,5.87,78.35,16.77,109.39,29.34,52.1,24.74,87.83,55.73,87.83,55.73,38.71,54.23,56.87,163.39,57.49,167.17v-.03Z" />
        <Path fill="#121314" d="M476.14,544.83s77.64-115.61,74.43-212.23c0,0-17.51,106.27-84.36,203.18" />
        
        {/* Top Slanted Horizontal Bar Track */}
        <Path fill="#121314" d="M415.19,197.53l-47.93,49.97c-2.3,2.38-5.45,3.75-8.77,3.75h-212.26c-5.39,0-8.17-6.47-4.43-10.36l47.93-49.97c2.3-2.38,5.45-3.75,8.77-3.75h212.26c5.39,0,8.17,6.47,4.43,10.36h0Z" />
        
        {/* Center Slanted Horizontal Bar Track */}
        <Path fill="#121314" d="M141.84,291.57l47.93,49.97c2.3,2.38,5.45,3.75,8.77,3.75h212.26c5.39,0,8.17-6.47,4.43-10.36l-47.93-49.97c-2.3-2.38-5.45-3.75-8.77-3.75h-212.26c-5.39,0-8.17,6.47-4.43,10.36Z" />
        
        {/* Bottom Slanted Horizontal Bar Track */}
        <Path fill="#121314" d="M415.19,385.58l-47.93,49.97c-2.3,2.38-5.45,3.75-8.77,3.75h-212.26c-5.39,0-8.17-6.47-4.43-10.36l47.93-49.97c2.3-2.38,5.45-3.75,8.77-3.75h212.26c5.39,0,8.17,6.47,4.43,10.36Z" />
      </G>
    </Svg>
  </Animated.View>
</View>

          
        {/* ── CONTROLS ─────────────────────────────────────────────────────── */}
        <View style={s.glassPanel}>

  <Text style={s.wagerLabel}>wager amount</Text>

<View style={s.inputWrapper}>
  {/* The gray block shadow layer underneath */}
  <View style={s.inputShadow} />
  
  {/* The main borderless white container box */}
  <View style={s.inputMainBox}>
    
    {/* Left Numeric Entry Field */}
    <TextInput
      style={s.wagerInput}
      value={wager}
      onChangeText={setWager}
      keyboardType="decimal-pad"
      editable={!inGame}
      selectionColor="#151618"
      placeholderTextColor="#a0a4a8"
    />
    
    {/* Center Vertical Arrow Toggle Indicator */}
    <View style={s.arrowToggleColumn}>
      <View style={s.upTriangle} />
      <View style={s.downTriangle} />
    </View>
    
    {/* Right Currency Token Label Ticker */}
    <Text style={s.inputTicker}>SOL</Text>
    
  </View>
</View>
<View style={s.quickRow}>
  {['0.05','0.1', '1','2','5' ].map(v => (
    <TouchableOpacity
      key={v}
      activeOpacity={0.8}
      style={[
        s.quickBtn, 
        wager === v ? s.quickBtnActive : s.quickBtnInactive
      ]}
      onPress={() => !inGame && setWager(v)}
      disabled={inGame}
    >
      <Text style={[s.quickBtnText, wager === v && s.textActiveLime]}>
        {v}
      </Text>
    </TouchableOpacity>
  ))}
</View>
<View style={s.sideToggleRow}>
  {/* HEADS BUTTON */}
  <TouchableOpacity
    activeOpacity={0.8}
    style={[s.sideBtn, side === 0 ? s.sideBtnActive : s.sideBtnInactive]}
    onPress={() => !inGame && setSide(0)}
    disabled={inGame}
  >
    <Text style={[s.sideBtnText, side === 0 ? s.textActiveDark : s.textInactiveWhite]}>
      heads
    </Text>
  </TouchableOpacity>
  
  {/* TAILS BUTTON */}
  <TouchableOpacity
    activeOpacity={0.8}
    style={[s.sideBtn, side === 1 ? s.sideBtnActive : s.sideBtnInactive]}
    onPress={() => !inGame && setSide(1)}
    disabled={inGame}
  >
    <Text style={[s.sideBtnText, side === 1 ? s.textActiveDark : s.textInactiveWhite]}>
      tails
    </Text>
  </TouchableOpacity>
</View>
       

{/* Quick Selection Pills Row */}


          

          <View style={s.buttonContainer}>
  {/* The brutalist white block shadow underneath */}
  <View style={s.buttonShadow} />

  {/* Your updated main button */}
  <TouchableOpacity
    activeOpacity={0.9}
    style={[s.btnCreate, (busy || inGame || !walletKey) && s.btnDisabled]}
    onPress={createGame}
    disabled={busy || inGame || !walletKey}
  >
    {busy ? (
      <ActivityIndicator color="#000" />
    ) : (
      <Text style={s.btnCreateText}>
        {inGame ? systemMsg : 'flip'}
      </Text>
    )}
  </TouchableOpacity>
</View>

        </View>

        {/*<View style={s.section}> ── ACTIVE LOBBIES ───────────────────────────────────────────────── */}
        
           <View style={{display:'none'}}>
          <View style={s.sectionHead}>
            <Text style={s.sectionTitle}>ACTIVE LOBBIES</Text>
            <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center' }}>
              <TouchableOpacity style={s.refreshBtn} onPress={fetchGames}>
                <Text style={s.refreshBtnText}>↻ REFRESH</Text>
              </TouchableOpacity>
              <View style={s.badge}>
                <Text style={s.badgeText}>{openGames.length}</Text>
              </View>
            </View>
          </View>
          {openGames.length === 0
            ? <Text style={s.emptyText}>No open lobbies. Create one above.</Text>
            : (
              <FlatList
                data={openGames}
                keyExtractor={item => item.pubkey.toBase58()}
                renderItem={renderLobbyCard}
                horizontal
                showsHorizontalScrollIndicator={false}
                contentContainerStyle={{ gap: 12 }}
              />
            )
          }
        </View>

        {/*<View style={s.section}> ── HISTORY ──────────────────────────────────────────────────────── */}
        
          <View style={{display:'none'}}>
          <View style={s.sectionHead}>
            <Text style={s.sectionTitle}>FLIP HISTORY</Text>
            <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center' }}>
              <TouchableOpacity style={s.refreshBtn} onPress={() => fetchHistory(true)}>
                <Text style={s.refreshBtnText}>↻ REFRESH</Text>
              </TouchableOpacity>
              <View style={s.badge}><Text style={s.badgeText}>{gameHistory.length}</Text></View>
            </View>
          </View>

          {/* Pill bar */}
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={s.pillBar}>
            {[...gameHistory].reverse().map((h, i) => (
              <TouchableOpacity
                key={h.gameId || i}
                style={[
                  s.pill,
                  { backgroundColor: h.winnerSide === 'HEADS' ? C.accent : C.purple },
                  i === 0 && s.pillNew,
                ]}
                onPress={() => setSelectedHist(h)}
              >
                <Text style={s.pillText}>{h.winnerSide === 'HEADS' ? 'H' : 'T'}</Text>
              </TouchableOpacity>
            ))}
            {gameHistory.length === 0 && <Text style={s.emptyText}>No history yet.</Text>}
          </ScrollView>

          {/* History list */}
          {gameHistory.slice(0, 20).map((h, i) => (
            <TouchableOpacity key={h.gameId || i} style={s.histRow} onPress={() => setSelectedHist(h)}>
              <View style={[s.histDot, { backgroundColor: h.winnerSide === 'HEADS' ? C.accent : C.purple }]} />
              <Text style={s.histGameId}>#{h.gameId}</Text>
              <View style={[s.chip, { backgroundColor: h.winnerSide === 'HEADS' ? C.accent + '22' : C.purple + '22' }]}>
                <Text style={[s.chipText, { color: h.winnerSide === 'HEADS' ? C.accent : C.purple }]}>{h.winnerSide}</Text>
              </View>
              <Text style={s.histAmt}>{h.amount > 0 ? `${h.amount} SOL` : '—'}</Text>
              <Text style={s.histArr}>›</Text>
            </TouchableOpacity>
          ))}
        </View>

        <View style={{ height: 40 }} />
      </ScrollView>

      {/* ── RESULT MODAL (DYNAMIC WIN/LOSE FULL SCREEN OVERLAY) ──────────────────────────────────────────────────── */}
<Modal 
  visible={!!resultModal} 
  transparent={false} // True native full screen backdrop coverage
  animationType="fade"
  onRequestClose={() => { setResultModal(null); setPhase('idle'); }}
>  
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
          balanceLabel={balance.toFixed(1)}
          walletAddress={walletKey?.toBase58() ?? ''}
        />
      </View>

    
  <View style={s.fullScreenOverlay}>
    
    {/* Upper Status Notification Text */}
    <View style={s.horizontalLineWhite} />
    <Text style={s.winHeadlineText}>
      {resultModal === 'WON' ? 'you won!' : 'you lost!'}
    </Text>
    
    <View style={s.horizontalLineWhite} />
{resultModal === 'WON' ? (
      <Text style={s.resultWonAmountText}>{resultAmount.toFixed(2)} SOL</Text>
    ) : null}
    {/* Center Stage Static Vector Hero Coin Token */}
    <View style={s.modalCoinContainer}>
      <Svg id="reference-one" width={220} height={220} viewBox="0 0 597.86 643.33">
      {/* Main Solana Coin Neon Fill Base Circle */}
      <Path 
        fill={resultCoinMainFill}
        d="M596.49,327.98c-11.95,118.61-94.41,225.51-94.41,225.51-99.74,71.17-203.12,88.36-203.12,88.36-5.45-1.53-10.78-3.06-16.06-4.68-114.05-34.59-184.85-84.9-202.52-98.44-2.89-2.19-4.37-3.41-4.37-3.41C3.84,407.74,1.37,314.75,1.37,314.75,25.38,191.6,92.46,91.86,92.46,91.86,182.33,26.42,268.96,5.79,286.53,2.1c2.13-.45,3.23-.62,3.23-.62,41.69,5.87,78.35,16.77,109.39,29.34,76.79,31.04,119.41,72.19,119.41,72.19,71.37,113.19,77.92,225,77.92,225v-.03Z"
      />
      {/* Secondary Bottom Shadow Lip Overlay */}
      <Path 
        fill={resultCoinDetailFill}
        d="M476.14,544.83c-71.76,60.04-162.74,85.21-193.24,92.34-114.05-34.59-184.85-84.9-202.52-98.44,56.07,38.73,203.69,83.48,203.69,83.48,84.36-16.32,182.18-86.41,182.18-86.41l9.9,9.05v-.03Z"
      />
      <G>
        <Path fill={resultCoinDetailFill} d="M445.72,128.83s-67.17-53.8-162.29-78.43c0,0-108.65,35.24-162.48,75.94,0,0-55.67,90.18-77.44,190.49,0,0,3.43,72.96,64.33,184.65,0,0-41.83-115.15-44.35-176.96,0,0,37.23-122.27,74.46-178.35,0,0,76.08-53.32,149.15-74.01,0,0,44.35-.65,158.57,56.67h.06Z" />
        <Path fill={resultCoinDetailFill} d="M508.55,299.34s-31.53,103.04-84.65,188c0,0-82.04,61.01-169.61,85.53l13.73,4.37s91.37-17.85,167.85-75.77c0,0,60.73-97.64,75.03-182.86l-2.33-19.27h-.03Z" />
        <Path fill={resultCoinDetailFill} d="M544.44,253.69c-36.8-125.74-70.06-161.01-70.06-161.01C384.14,27.18,309.26,7.04,286.5,2.1c2.13-.45,3.23-.62,3.23-.62,41.69,5.87,78.35,16.77,109.39,29.34,52.1,24.74,87.83,55.73,87.83,55.73,38.71,54.23,56.87,163.39,57.49,167.17v-.03Z" />
        <Path fill={resultCoinDetailFill} d="M476.14,544.83s77.64-115.61,74.43-212.23c0,0-17.51,106.27-84.36,203.18" />
        
        {/* Top Slanted Horizontal Bar Track */}
        <Path fill={resultCoinDetailFill} d="M415.19,197.53l-47.93,49.97c-2.3,2.38-5.45,3.75-8.77,3.75h-212.26c-5.39,0-8.17-6.47-4.43-10.36l47.93-49.97c2.3-2.38,5.45-3.75,8.77-3.75h212.26c5.39,0,8.17,6.47,4.43,10.36h0Z" />
        
        {/* Center Slanted Horizontal Bar Track */}
        <Path fill={resultCoinDetailFill} d="M141.84,291.57l47.93,49.97c2.3,2.38,5.45,3.75,8.77,3.75h212.26c5.39,0,8.17-6.47,4.43-10.36l-47.93-49.97c-2.3-2.38-5.45-3.75-8.77-3.75h-212.26c-5.39,0-8.17,6.47-4.43,10.36Z" />
        
        {/* Bottom Slanted Horizontal Bar Track */}
        <Path fill={resultCoinDetailFill} d="M415.19,385.58l-47.93,49.97c-2.3,2.38-5.45,3.75-8.77,3.75h-212.26c-5.39,0-8.17-6.47-4.43-10.36l47.93-49.97c2.3-2.38,5.45-3.75,8.77-3.75h212.26c5.39,0,8.17,6.47,4.43,10.36Z" />
      </G>
    </Svg>
    </View>

    {/* Bottom Dynamic Action Trigger with Brutalist Hard Shadow */}
    <View style={s.claimButtonContainer}>
      {/* Thick white offset block shadow underneath */}
      <View
        style={[
          s.claimButtonShadow,
          isLoseResult && { backgroundColor: '#8A8D90' },
        ]}
      />
      
      {/* Core action button changes color dynamically */}
      <TouchableOpacity
        activeOpacity={0.9}
        style={[
          s.btnClaimMain,
          isLoseResult && { backgroundColor: '#FFFFFF' }
        ]}
        onPress={() => { setResultModal(null); setPhase('idle'); void fetchGames(); }}
      >
        <Text style={s.btnClaimText}>
          {resultModal === 'WON' ? 'claim win' : 'return'}
        </Text>
      </TouchableOpacity>
    </View>

  </View>
      </SafeAreaView>
</Modal>

      {/* ── HISTORY DETAIL MODAL ─────────────────────────────────────────── */}
      <Modal visible={!!selectedHist} transparent animationType="slide" onRequestClose={() => setSelectedHist(null)}>
        <View style={s.overlay}>
          <View style={s.histModal}>
            <Text style={s.histModalTitle}>⚖ PROVABLY FAIR</Text>
            <View style={[s.histOutcome, {
              borderColor:       selectedHist?.winnerSide === 'HEADS' ? C.accent : C.purple,
              backgroundColor:   selectedHist?.winnerSide === 'HEADS' ? C.accent + '18' : C.purple + '18',
            }]}>
              <Text style={[s.histOutcomeText, { color: selectedHist?.winnerSide === 'HEADS' ? C.accent : C.purple }]}>
                {selectedHist?.winnerSide}
              </Text>
            </View>

            {selectedHist?.amount != null && (
              <View style={s.histModalRow}>
                <Text style={s.histModalLabel}>AMOUNT</Text>
                <Text style={s.histModalVal}>{selectedHist.amount} SOL</Text>
              </View>
            )}
            {selectedHist?.playerOne && (
              <View style={s.histModalRow}>
                <Text style={s.histModalLabel}>PLAYER 1</Text>
                <Text style={s.histModalVal}>{short(selectedHist.playerOne, 12, 6)}</Text>
              </View>
            )}
            {selectedHist?.playerTwo && (
              <View style={s.histModalRow}>
                <Text style={s.histModalLabel}>PLAYER 2</Text>
                <Text style={s.histModalVal}>{short(selectedHist.playerTwo, 12, 6)}</Text>
              </View>
            )}

            {[
              { label: 'SERVER HASH (COMMIT)', key: 'serverHash' as keyof HistoryItem },
              { label: 'SERVER SEED (REVEAL)', key: 'serverSeed' as keyof HistoryItem },
              { label: 'CLIENT SEED A',        key: 'seedA'      as keyof HistoryItem },
              { label: 'CLIENT SEED B',        key: 'seedB'      as keyof HistoryItem },
            ].map(({ label, key }) => (
              <TouchableOpacity
                key={key}
                style={s.copyBox}
                onPress={() => Clipboard.setString(String(selectedHist?.[key] ?? ''))}
              >
                <Text style={s.copyLabel}>{label}</Text>
                <Text style={s.copyVal} numberOfLines={1}>{String(selectedHist?.[key] ?? 'N/A')}</Text>
                <Text style={s.copyHint}>TAP TO COPY</Text>
              </TouchableOpacity>
            ))}

            <TouchableOpacity
              style={[s.btnCreate, { backgroundColor: C.purple, marginTop: 16, width: '100%' }]}
              onPress={() => setSelectedHist(null)}
            >
              <Text style={s.btnCreateText}>CLOSE</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>

    </SafeAreaView>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────
const s = StyleSheet.create({
  root:         { flex: 1, backgroundColor: C.bg },
  scroll:       { paddingHorizontal: 16, paddingTop: 20 },
  logo:         { fontFamily: 'Orbitron', fontSize: 22, color: C.text, letterSpacing: 2 },
  topRight:     { flexDirection: 'row', alignItems: 'center', gap: 8 },
  balText:      { fontFamily: 'Orbitron', fontSize: 13, color: C.accent },
  walletBtn:    { backgroundColor: C.glass, paddingHorizontal: 12, paddingVertical: 8, borderRadius: 8, borderWidth: 1, borderColor: C.border },
  walletBtnText:{ fontFamily: 'Orbitron', fontSize: 11, color: C.text, letterSpacing: 1 },
  copyBtn:      { backgroundColor: C.accent, paddingHorizontal: 10, paddingVertical: 8, borderRadius: 8 },
  copyBtnText:  {fontFamily: 'Orbitron', fontSize: 11, color: '#000', letterSpacing: 1 },
  coinText:     { fontFamily: 'Orbitron', fontSize: 42, color: '#1a0a00' },
  statusBar:    { flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: C.glass, borderRadius: 8, paddingHorizontal: 14, paddingVertical: 10, borderWidth: 1, borderColor: C.border, maxWidth: SW - 32 },
  statusDot:    { width: 8, height: 8, borderRadius: 4 },
  statusText:   {fontFamily: 'Orbitron', fontSize: 11, color: C.accent, letterSpacing: 0.5, flex: 1 },
  glassPanel:   { padding: 20, borderWidth: 1,  marginBottom: 24, borderColor: 'transparent' },
  buttonContainer: {
    position: 'relative',
    marginTop: 40,
    height: 74,        // ixed height to contain the absolute positioned button
    marginBottom: 16,  // Gives clear space for items rendered below it
  },
  buttonShadow: {
    position: 'absolute',
    top: 8,            // Shifts shadow downwards
    left: 8,           // Shifts shadow rightwards
    right: -8,         // Matches the offset width stretch
    bottom: -8,        // Matches the offset height stretch
    backgroundColor: '#FFFFFF',
    borderRadius: 0,   // Strict flat, sharp brutalist edges
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
    borderRadius: 0,            // Erases the old rounded corners
    borderWidth: 0,
  },
  btnCreateText: {
   fontFamily: 'Orbitron',
    fontSize: 30,
    color: '#000000',

    // --- The Super-Bold Hack ---
    textShadowColor: '#000000',
    textShadowRadius: 1,
    // Slightly compress letter spacing to handle the extra thickness
    letterSpacing: -0.5, 
  },
  btnDisabled: {
    opacity: 0.5,
  },
  btnDanger:    { borderRadius: 8, paddingVertical: 10, paddingHorizontal: 14, borderWidth: 1, borderColor: C.danger, alignItems: 'center' },
  btnDangerText:{ fontFamily: 'Orbitron', fontSize: 12, color: C.danger },
  btnJoin:      { flex: 1, borderRadius: 8, paddingVertical: 10, backgroundColor: C.purple, alignItems: 'center' },
  btnJoinText:  { fontFamily: 'Orbitron', fontSize: 12, color: '#fff', letterSpacing: 1 },
  section:      { marginBottom: 28 },
  sectionHead:  { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 },
  sectionTitle: { fontFamily: 'Orbitron', fontSize: 11, color: C.text, letterSpacing: 2 },
  badge:        { backgroundColor: C.glass, borderRadius: 6, paddingHorizontal: 10, paddingVertical: 4, borderWidth: 1, borderColor: C.border },
  badgeText:    { fontFamily: 'Orbitron', fontSize: 10, color: C.muted },
  refreshBtn:   { backgroundColor: C.accent + '22', paddingHorizontal: 10, paddingVertical: 6, borderRadius: 6, borderWidth: 1, borderColor: C.accent },
  refreshBtnText:{ fontFamily: 'Orbitron', fontSize: 10, color: C.accent },
  emptyText:    { fontFamily: 'Orbitron', color: C.muted, fontSize: 12, textAlign: 'center', paddingVertical: 24 },
  lobbyCard:    { width: 200, backgroundColor: C.glass, borderRadius: 14, padding: 16, borderWidth: 1, borderColor: C.border, gap: 8 },
  lobbyCardTop: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  lobbyAmount:  { fontFamily: 'Orbitron', fontSize: 16, color: C.text },
  chip:         { borderRadius: 6, paddingHorizontal: 8, paddingVertical: 3 },
  chipText:     { fontFamily: 'Orbitron', fontSize: 10 },
  lobbyMeta:    { fontFamily: 'Orbitron', fontSize: 10, color: C.muted },
  lobbyActions: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 4 },
  ownLabel:     { fontFamily: 'Orbitron', fontSize: 11, color: C.accent, flex: 1 },
  pillBar:      { flexDirection: 'row', gap: 6, paddingVertical: 8, paddingHorizontal: 2 },
  pill:         { width: 34, height: 34, borderRadius: 17, alignItems: 'center', justifyContent: 'center' },
  pillNew:      { shadowColor: C.accent, shadowOffset: { width: 0, height: 0 }, shadowOpacity: 0.8, shadowRadius: 8, elevation: 6 },
  pillText:     { fontFamily: 'Orbitron', fontSize: 12, color: '#000' },
  histRow:      { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 10, paddingHorizontal: 4, borderBottomWidth: 1, borderBottomColor: C.border },
  histDot:      { width: 8, height: 8, borderRadius: 4 },
  histGameId:   { fontFamily: 'Orbitron', fontSize: 12, color: C.text, flex: 1 },
  histAmt:      { fontFamily: 'Orbitron', fontSize: 12, color: C.muted },
  histArr:      { fontFamily: 'Orbitron', fontSize: 18, color: C.muted },
  overlay:      { flex: 1, backgroundColor: 'rgba(0,0,0,0.88)', alignItems: 'center', justifyContent: 'center', padding: 20 },
  resultCard:   { backgroundColor: C.surface, borderRadius: 20, padding: 28, width: '100%', maxWidth: 380, alignItems: 'center', borderWidth: 1, shadowOffset: { width: 0, height: 0 }, shadowOpacity: 0.5, shadowRadius: 24, elevation: 16 },
  resultCoin:   { width: 80, height: 80, borderRadius: 40, alignItems: 'center', justifyContent: 'center', marginBottom: 16 },
  resultCoinText:{ fontFamily: 'Orbitron', fontSize: 36, color: C.text },
  resultSideText:{ fontFamily: 'Orbitron', fontSize: 22, color: C.text, letterSpacing: 2 },
  resultVerdict: { fontFamily: 'Orbitron', fontSize: 26, marginTop: 10, letterSpacing: 1 },
  resultSub:    { fontFamily: 'Orbitron', fontSize: 12, color: C.muted, marginTop: 8, textAlign: 'center' },
  histModal:    { backgroundColor: C.surface, borderRadius: 20, padding: 24, width: '100%', maxWidth: 400, borderWidth: 1, borderColor: C.border, gap: 10 },
  histModalTitle:{ fontFamily: 'Orbitron', fontSize: 12, color: C.muted, letterSpacing: 1 },
  histOutcome:  { borderRadius: 8, borderWidth: 1, padding: 12, alignItems: 'center', marginBottom: 4 },
  histOutcomeText:{ fontFamily: 'Orbitron', fontSize: 18, letterSpacing: 3 },
  histModalRow: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 6, borderBottomWidth: 1, borderBottomColor: C.border },
  histModalLabel:{ fontFamily: 'Orbitron', fontSize: 10, color: C.muted, letterSpacing: 1.2 },
  histModalVal: { fontFamily: 'Orbitron', fontSize: 12, color: C.text },
  copyBox:      { backgroundColor: C.glass, borderRadius: 10, padding: 12, borderWidth: 1, borderColor: C.border },
  copyLabel:    { fontFamily: 'Orbitron', fontSize: 9, color: C.muted, letterSpacing: 1.5, marginBottom: 4 },
  copyVal:      { fontFamily: 'Orbitron', fontSize: 12, color: C.text },
  copyHint:     { fontFamily: 'Orbitron', fontSize: 9, color: C.accent, marginTop: 4, letterSpacing: 1 },
 settlingCoinInner: { width: 90, height: 90, borderRadius: 45, backgroundColor: '#f6d670', borderWidth: 2, borderColor: '#20140044' },

  toggleContainer: {
    position: 'relative',
    height: 94,        // Height adjusting to fit inner rows + outline padding
    marginBottom: 24,
  },
  toggleShadow: {
    position: 'absolute',
    top: 8,
    left: 8,
    right: -8,
    bottom: -8,
    backgroundColor: '#FFFFFF',
    borderRadius: 0,
  },
  toggleFrame: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: '#121314', // Core backdrop color
    borderWidth: 3,
    borderColor: '#FFFFFF',    // Thick outer white frame line
    borderRadius: 0,
    padding: 3,                // Creates the spacing for the inner double outline
  },
  sideToggle: {
    flex: 1,
    flexDirection: 'row',
    borderWidth: 2,
    borderColor: '#FFFFFF',    // Inner parallel border row lines
    backgroundColor: '#121314',
  },
 
  // Inactive state - dark box
  
  // Active HEADS state - brilliant lime color box with a solid inner line margin
  sideBtnActiveHeads: {
    backgroundColor: '#D1FF00', 
    borderWidth: 3,
    borderColor: '#121314',     // Creates the gap outline effect around the active green box
    margin: 3,
  },
  // Active TAILS state - stays dark but inherits active layout margins if needed
  sideBtnActiveTails: {
    backgroundColor: '#1C1D1F',  // Slightly lighter gray-black or same accent if needed
    borderWidth: 3,
    borderColor: '#121314',
    margin: 3,
  },





  
  // Quick Selector Pills Row Styles
  quickRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    gap: 10,
    marginBottom: 24,
  },
  quickBtn: {
    flex: 1,
    height: 38,
    borderWidth: 2,
    borderColor: '#FFFFFF',
    borderRadius: 0,
    justifyContent: 'center',
    alignItems: 'center',
  },
  quickBtnInactive: {
    backgroundColor: '#121314',
  },
  quickBtnActive: {
    backgroundColor: '#1C1D1F', // Slightly raised dark background for active state toggle
    borderColor: '#D1FF00',     // Neon lime boundary highlight
  },
  quickBtnText: {
    fontFamily: 'Orbitron',
    fontSize: 14,
    color: '#FFFFFF',
  },
  textActiveLime: {
    color: '#D1FF00',           // Glow font accent on selection match
  },
  topBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 24,
    paddingVertical: 5,
    
  },
  
  // Left Side Brand Styling
  brandWrapper: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  brandLogoText: {
   fontFamily: 'Orbitron',
    fontStyle: 'italic',
    fontSize: 44,
    fontWeight: '900',
    color: '#FFFFFF',
    letterSpacing: -2,
    // Emulate thick text stroke using shadow values
    textShadowColor: '#000000',
    textShadowOffset: { width: 2, height: 2 },
    textShadowRadius: 1,
  },
  brandCoinCircle: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: '#D1FF00', // Neon yellow-lime
    borderWidth: 2,
    borderColor: '#FFFFFF',
    justifyContent: 'center',
    alignItems: 'center',
    gap: 3,
    transform: [{ rotate: '-15deg' }],
  },
  coinEmblemLine: {
    width: 18,
    height: 3,
    backgroundColor: '#121314',
    borderRadius: 1,
  },


  heroSection: {
    alignItems: 'center',
    justifyContent: 'center',
    marginVertical: 0,
    
  },





  // Active Static Token Symbol Structure


  // Interactive Spin text layout
  coinSpinText: {
   fontFamily: 'Orbitron',
    fontSize: 72,
    color: '#121314',
  },
  // Full Screen Backdrop Canvas
  fullScreenOverlay: {
    flex: 1,
    backgroundColor: '#000000', 
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 10, 
    paddingHorizontal: 28,
  },
  winHeadlineText: {
     fontFamily: 'Orbitron',
    fontSize: 13,
    color: 'white',
    textAlign: 'center',
   
    letterSpacing: 1.5,
    marginBottom: 0,
    marginTop: 0
  },
  resultWonAmountText: {
    fontFamily: 'Orbitron',
    color:"white",
    fontSize: 28,
    
    textAlign: 'center',
    letterSpacing: 1,
    marginTop: 8,
    marginBottom: 0,
  },
  
  // Center Token Position Framework
  modalCoinContainer: {
    justifyContent: 'center',
    alignItems: 'center',
    flex: 1,
  },

  // Brutalist Action Complex Structures
  claimButtonContainer: {
    position: 'relative',
    width: '100%',
    height: 74,
    marginBottom: 20,
  },
  claimButtonShadow: {
    position: 'absolute',
    top: 8,
    left: 8,
    right: -8,
    bottom: -8,
    backgroundColor: '#FFFFFF',
    borderRadius: 0,
  },
  btnClaimMain: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: '#D1FF00', // Default neon lime green for WIN state
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 0,
    borderWidth: 0,
  },
  btnClaimText: {
    fontFamily: 'Orbitron',
    textAlign:'center',
    fontSize: 28,
    fontWeight: '600',
    color: '#121314', // Crisp dark contrast color matching screenshot graphics
    letterSpacing: 1,
   
  },
  
  
  // Reuse these classes from your main stylesheet to ensure absolute design matching:
  coinWhiteBorderLayer: {
    width: 216,
    height: 216,
    borderRadius: 108,
    backgroundColor: '#FFFFFF', 
    padding: 3,
  },
  coinComicOutlineFrame: {
    flex: 1,
    borderRadius: 105,
    backgroundColor: '#121314', 
    paddingTop: 2,
    paddingLeft: 4,
    paddingRight: 10,           
    paddingBottom: 12,          
  },
  coinCoreFill: {
    flex: 1,
    borderRadius: 100,
    backgroundColor: '#D1FF00', 
    justifyContent: 'center',
    alignItems: 'center',
  },
  solanaLogoWrapper: {
    width: 110,
    height: 76,
    justifyContent: 'space-between',
    alignItems: 'center',
    transform: [{ skewX: '-24deg' }], 
  },
  solanaParallelogram: {
    width: 90,
    height: 18,
    backgroundColor: '#121314', 
    borderRadius: 1,
  },
  solanaTopRow: {
    alignSelf: 'flex-start',
    marginLeft: 4,
  },
  solanaMidRow: {
    alignSelf: 'center',
  },
  solanaBotRow: {
    alignSelf: 'flex-end',
    marginRight: 4,
  },
 headerBalanceContainer: {
    position: 'relative',
    width: 130,                 
    height: 34,                 
  },
  headerBalanceShadow: {
    position: 'absolute',
    top: 4,                     
    left: 4,
    right: -4,
    bottom: -4,
    backgroundColor: '#d1d3d4', 
    borderRadius: 0,
  },
  headerBalanceMainFrame: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: '#FFFFFF', // Clean, borderless solid white canvas plate
    borderRadius: 0,
  },
  balanceTouchRegion: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between', 
    paddingHorizontal: 12,      
  },
  headerBalanceVal: {
    fontFamily: 'Orbitron',
    fontSize: 14,               
    color: '#151618',            
    letterSpacing: -0.5,
  },
  headerBalanceTicker: {
    fontFamily: 'Orbitron',
    fontSize: 14,               
    color: '#151618',            
    letterSpacing: 0.5,
  },
  coin :{

  },
 label: {
fontFamily: 'Orbitron',
    fontSize: 14,
    color: '#8a8d90',
    textAlign: 'center',
    marginBottom: 12,
    letterSpacing: 1,
  },
  sideToggleRow: {
    flexDirection: 'row',
    width: '100%',
    height: 42,                 // Decreased height from 54 for a much lower profile box
    justifyContent: 'space-between',
    gap: 16,                    
    paddingHorizontal: 4,
    marginBottom: 20,
    marginTop:30
  },
  sideBtn: {
    flex: 1,
    height: '100%',
    justifyContent: 'center',
    alignItems: 'center',
    borderRadius: 0,            
  },
  sideBtnActive: {
    backgroundColor: '#C3F306', 
    borderWidth: 0,
  },
  sideBtnInactive: {
    backgroundColor: '#151618', 
    borderWidth: 2,
    borderColor: '#FFFFFF',
  },
  sideBtnText: {
    fontFamily: 'Orbitron',
    fontSize: 20,               // Scaled down slightly from 24 to look perfectly centered in the shorter box
    letterSpacing: 0.5,
    ...Platform.select({
      ios: { lineBreakStrategyIOS: 'none' },
      android: { includeFontPadding: false } // Cleans up vertical alignment on Android
    }),
  },
  textActiveDark: {
    color: '#151618', 
     
  },
  textInactiveWhite: {
    color: '#FFFFFF',   
    
  },
wagerLabel: {
    fontFamily: 'Orbitron',       // Call your font here
    fontSize: 15,
    color: 'white',
    textAlign: 'center',
    marginBottom: 12,
    letterSpacing: 0.5,
    marginTop:30
  },
  inputWrapper: {
    position: 'relative',
    height: 52,                 // Lower compressed height profile matching your asset card
    width: '100%',
    marginBottom: 20,
  },
  inputShadow: {
    position: 'absolute',
    top: 5,
    left: 5,
    right: -5,
    bottom: -5,
    backgroundColor: '#d1d3d4', // Light brutalist gray shadow offset plate
    borderRadius: 0,
  },
  inputMainBox: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: '#FFFFFF', // Solid crisp white main container plate
    borderRadius: 0,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 24,
  },
  wagerInput: {
    flex: 1,
   fontFamily: 'Orbitron',
    fontSize: 26,
    color: '#151618',           // Sharp dark value text
    padding: 0,                 // Eliminates platform-default text paddings
  },
  
  // Center Column Arrow Toggle Blocks
  arrowToggleColumn: {
    justifyContent: 'center',
    alignItems: 'center',
    gap: 6,                     // Space separating the two opposing triangles
    paddingHorizontal: 16,
    height: '100%',
  },
  upTriangle: {
    width: 0,
    height: 0,
    backgroundColor: 'transparent',
    borderStyle: 'solid',
    borderLeftWidth: 5,
    borderRightWidth: 5,
    borderBottomWidth: 6,
    borderLeftColor: 'transparent',
    borderRightColor: 'transparent',
    borderBottomColor: '#151618', // Sharp charcoal arrow fill
  },
  downTriangle: {
    width: 0,
    height: 0,
    backgroundColor: 'transparent',
    borderStyle: 'solid',
    borderLeftWidth: 5,
    borderRightWidth: 5,
    borderTopWidth: 6,
    borderLeftColor: 'transparent',
    borderRightColor: 'transparent',
    borderTopColor: '#151618',   // Sharp charcoal arrow fill
  },

  inputTicker: {
    fontFamily: Platform.OS === 'android' ? 'Orbitron' : 'Orbitron',
    fontSize: 25,
    color: '#151618',           // Sharp dark label text
    letterSpacing: 0.5,
  },

  navToggleRow: {
    flexDirection: 'row',
    width: '100%',
    height: 42,                 // Kept the lower compressed profile height you like
    justifyContent: 'space-between',
    gap: 16,                    // Space between the two blocks
    paddingHorizontal: 4,
    marginBottom: 20,
  },
  navBtn: {
    flex: 1,
    height: '100%',
    backgroundColor: '#151618', // Sharp background matching your dark setup
    borderWidth: 2,
    borderColor: '#FFFFFF',     // Clean white bounding line around both items
    justifyContent: 'center',
    alignItems: 'center',
    borderRadius: 0,            // Hard blocky corners
  },
  navBtnText: {
    fontFamily: 'Orbitron',     // Calls your registered Orbitron font cleanly
    fontSize: 14,               // Sized optimally to make sure 'leaderboard' fits on one line
    color: '#FFFFFF',           // Crisp white text color output
    letterSpacing: 0.5,
  },
   horizontalLineWhite: {
    width: '100%',
    height: 0.5,                  // Controls the thickness of your line
    backgroundColor: '#C3F306', // Crisp white line color
    marginVertical: 16,         // Creates spacing above and below the line
  },
  horizontalLineMuted: {
    width: '100%',
    height: 0.5,                  
    backgroundColor: '#1c2530', // Muted dark border color matching your UI palette
    marginVertical: 16,         
  },
  settlingScreen: {
    flex: 1,
    backgroundColor: '#080b10',
    alignItems: 'center',
    justifyContent: 'center',
  },
  settlingCoin: {
    width: 200,
    height: 215,
    alignItems: 'center',
    justifyContent: 'center',
    // backfaceVisibility prevents flickering mid-flip on native platforms
    backfaceVisibility: 'visible', 
  },
});
