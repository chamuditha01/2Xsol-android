import AsyncStorage from '@react-native-async-storage/async-storage';
import * as web3 from '@solana/web3.js';
import * as borsh from 'borsh';
import bs58 from 'bs58';
import { router } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Animated,
  Easing,
  FlatList,
  Modal,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  TouchableOpacity,
  View
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import Svg, { G, Path, Polygon } from 'react-native-svg';
import WalletNavbarMenu from '../components/wallet-navbar-menu';

// ─── Configuration References (Synced with index.tsx) ──────────────────────
const PROGRAM_ID = new web3.PublicKey(
  process.env.EXPO_PUBLIC_PROGRAM_ID ?? 'YOUR_PROGRAM_ID'
);
const HELIUS_RPC =
  process.env.EXPO_PUBLIC_HELIUS_RPC ?? 'https://api.devnet.solana.com';
const LOCAL_WALLET_KEY = 'solflip_local_keypair';
const ACTIVE_GAME_KEY = 'solflip_active_game';

const GAME_SIZE = 200;
const OFFSET_PLAYER_ONE = 0;
const OFFSET_PLAYER_TWO = 32;
const OFFSET_AMOUNT     = 64;
const OFFSET_STATUS     = 73;
const OFFSET_GAME_ID    = 80;
const HISTORY_SIZE = 280;




const connection = new web3.Connection(HELIUS_RPC, { commitment: 'confirmed' });
const short = (k = '', h = 6, t = 4) => k ? `${k.slice(0, h)}…${k.slice(-t)}` : '?';
const deserializeKeypair = (s: string) => web3.Keypair.fromSecretKey(Uint8Array.from(JSON.parse(s)));

const parseHistoryRaw = (data: Buffer): HistoryItem | null => {
  try {
    const d = (borsh as any).deserializeUnchecked(historySchema, GameHistoryAccount, data) as GameHistoryAccount;
    return {
      gameId: String(d.game_id),
      playerOne: new web3.PublicKey(d.player_one).toBase58(),
      playerTwo: new web3.PublicKey(d.player_two).toBase58(),
      winner: new web3.PublicKey(d.winner).toBase58(),
      winnerSide: d.winner_side === 0 ? 'HEADS' : 'TAILS',
      amount: SOL(d.amount),
      slot: Number(d.timestamp_slot),
    };
  } catch {
    return null;
  }
};



// ─── Shared Struct State Parser ─────────────────────────────────────────────
function parseGameRaw(data: Buffer): OpenGame | null {
  try {
    if (!data || data.length < GAME_SIZE) return null;
    if (data.every(b => b === 0)) return null;

    const status  = data.readUInt8(OFFSET_STATUS);
    const gameId  = data.readBigUInt64LE(OFFSET_GAME_ID);
    const amount  = data.readBigUInt64LE(OFFSET_AMOUNT);
    const side    = data.readUInt8(OFFSET_STATUS - 1); // offset 72 player_one_side

    const playerOne = new web3.PublicKey(data.slice(OFFSET_PLAYER_ONE, OFFSET_PLAYER_ONE + 32));
    const playerTwo = new web3.PublicKey(data.slice(OFFSET_PLAYER_TWO, OFFSET_PLAYER_TWO + 32));

    return { pubkey: null as any, player_one: playerOne, player_two: playerTwo,
             amount, player_one_side: side, status, game_id: gameId };
  } catch { return null; }
}

interface OpenGame {
  pubkey:          web3.PublicKey;
  player_one:      web3.PublicKey;
  player_two:      web3.PublicKey;
  amount:          bigint;
  player_one_side: number;
  status:          number;
  game_id:         bigint;
}

class GameHistoryAccount {
  game_id!: bigint;
  player_one!: Uint8Array;
  player_two!: Uint8Array;
  amount!: bigint;
  winner!: Uint8Array;
  winner_side!: number;
  player_one_side!: number;
  padding!: Uint8Array;
  server_seed!: Uint8Array;
  server_hash!: Uint8Array;
  client_seed_a!: Uint8Array;
  client_seed_b!: Uint8Array;
  flip_byte!: number;
  padding2!: Uint8Array;
  timestamp_slot!: bigint;
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

type HistoryItem = {
  gameId: string;
  playerOne: string;
  playerTwo: string;
  winner: string;
  winnerSide: 'HEADS' | 'TAILS';
  amount: number;
  slot: number;
};

const SOL = (lam: bigint | number) => Number(lam) / web3.LAMPORTS_PER_SOL;

export default function games() {
  const [walletKey, setWalletKey] = useState<web3.PublicKey | null>(null);
  const [balance, setBalance] = useState(0);
  const [walletLoading, setWalletLoading] = useState(true);
  const [openGames, setOpenGames] = useState<OpenGame[]>([]);
  const [refreshing, setRefreshing] = useState(false);
  const [joiningId, setJoiningId] = useState<string | null>(null);
  const [phase, setPhase] = useState<'idle' | 'joined' | 'settling' | 'done'>('idle');
  const [activeGameMessage, setActiveGameMessage] = useState('');
  const [resultModal, setResultModal] = useState<'WON' | 'LOST' | null>(null);
  const [resultAmount, setResultAmount] = useState(0);
  const [resultSide, setResultSide] = useState<number | null>(null);
  const localWallet = useRef<web3.Keypair | null>(null);
  const joinedGameSubRef = useRef<number | null>(null);
  const settleHistorySubRef = useRef<number | null>(null);
  const settlePollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const balanceBeforeRef = useRef(0);
  const joinedWagerLamportsRef = useRef<number>(0);
  const settledRef = useRef(false);
  const activeGameIdRef = useRef<number | null>(null);
  const lastFlipResultRef = useRef<{
    gameId: number;
    winner: string;
    winnerSide: number;
  } | null>(null);

  const coinAnim = useRef(new Animated.Value(0)).current;
  const flipLoop = useRef<Animated.CompositeAnimation | null>(null);
  const flipping = phase === 'joined' || phase === 'settling';
const walletKeyRef = useRef<web3.PublicKey | null>(null);


  useEffect(() => { walletKeyRef.current = walletKey; }, [walletKey]);

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
  }, [flipping, coinAnim]);

  const coinScaleY = coinAnim.interpolate({ inputRange: [0, 0.5, 1], outputRange: [1, 0.05, 1] });
  const settlingCoinTranslateY = coinAnim.interpolate({ inputRange: [0, 0.5, 1], outputRange: [120, 0, -120] });
  const settlingCoinRotateX = useRef(new Animated.Value(0)).current;

  // ─── Restore Wallet Credentials ───────────────────────────────────────────
  const loadWallet = useCallback(async () => {
    setWalletLoading(true);
    try {
      let stored: string | null = null;
      try {
        const mod = await import('expo-secure-store');
        stored = await mod.getItemAsync(LOCAL_WALLET_KEY);
      } catch {
        stored = await AsyncStorage.getItem(LOCAL_WALLET_KEY);
      }
      if (!stored) stored = await AsyncStorage.getItem(LOCAL_WALLET_KEY);

      if (stored) {
        const kp = deserializeKeypair(stored);
        localWallet.current = kp;
        setWalletKey(kp.publicKey);
        const rawBal = await connection.getBalance(kp.publicKey);
        setBalance(rawBal / web3.LAMPORTS_PER_SOL);
      }
    } catch (e: any) {
      console.error('Wallet restoration error:', e.message);
    } finally {
      setWalletLoading(false);
    }
  }, []);

  useEffect(() => { void loadWallet(); }, [loadWallet]);

  // ── Listen for Contract Logs ──────────────────────────────────────────────
  useEffect(() => {
    if (!PROGRAM_ID) return;
    console.log('Subscribing to program logs for program:', PROGRAM_ID.toBase58());
    
    let subId: number | null = null;
    try {
      subId = connection.onLogs(
        PROGRAM_ID,
        (logs) => {
          if (logs && logs.logs) {
            logs.logs.forEach((log) => {
              if (log.includes('FLIP_RESULT:')) {
                console.log('Solana Contract Emit Log - FLIP_RESULT:', log);
                try {
                  const gameIdMatch = log.match(/game_id=(\d+)/);
                  const winnerSideMatch = log.match(/winner_side=(\d+)/);
                  const winnerMatch = log.match(/winner=([a-zA-Z0-9]+)/);
                  if (gameIdMatch && winnerMatch && winnerSideMatch) {
                    lastFlipResultRef.current = {
                      gameId: parseInt(gameIdMatch[1], 10),
                      winner: winnerMatch[1],
                      winnerSide: parseInt(winnerSideMatch[1], 10),
                    };
                    console.log('Parsed last flip result:', lastFlipResultRef.current);
                  }
                } catch (err) {
                  console.error('Error parsing FLIP_RESULT log:', err);
                }
              }
            });
          }
        },
        'confirmed'
      );
    } catch (err) {
      console.error('Failed to subscribe to program logs:', err);
    }

    return () => {
      if (subId !== null) {
        try {
          connection.removeOnLogsListener(subId);
        } catch (err) {
          console.error('Failed to unsubscribe from program logs:', err);
        }
      }
    };
  }, []);

  // ─── Fetch On-Chain Game Accounts ──────────────────────────────────────────
  const fetchGames = useCallback(async () => {
    try {
      const accounts = await connection.getProgramAccounts(PROGRAM_ID, {
        filters: [{ dataSize: GAME_SIZE }],
        commitment: 'confirmed',
      });

      const games: OpenGame[] = [];
      for (const { pubkey, account } of accounts) {
        const buf = Buffer.isBuffer(account.data) ? account.data : Buffer.from(account.data as any);
        const game = parseGameRaw(buf);
        if (game && game.status === 1) {
          games.push({ ...game, pubkey });
        }
      }
      setOpenGames(games.sort((a, b) => Number(b.game_id) - Number(a.game_id)));
    } catch (e) {
      console.error('Fetch games failed:', e);
    }
  }, []);

  const getHistoryByGameId = useCallback(async (gameId: number) => {
    try {
      const accounts = await connection.getProgramAccounts(PROGRAM_ID, {
        filters: [{ dataSize: HISTORY_SIZE }],
        commitment: 'confirmed',
      });

      for (const { account } of accounts) {
        const buf = Buffer.isBuffer(account.data) ? account.data : Buffer.from(account.data as any);
        const item = parseHistoryRaw(buf);
        if (item && String(item.gameId) === String(gameId)) return item;
      }
    } catch (error) {
      console.warn('getHistoryByGameId failed:', error);
    }

    return null;
  }, []);

  const clearJoinedGameWatcher = useCallback(() => {
    if (joinedGameSubRef.current !== null) {
      try {
        connection.removeAccountChangeListener(joinedGameSubRef.current);
      } catch {
        // ignore stale listener cleanup errors
      }
      joinedGameSubRef.current = null;
    }
  }, []);

  const clearSettlingWatchers = useCallback(() => {
    if (settlePollRef.current !== null) {
      clearInterval(settlePollRef.current);
      settlePollRef.current = null;
    }

    if (settleHistorySubRef.current !== null) {
      try {
        connection.removeProgramAccountChangeListener(settleHistorySubRef.current);
      } catch {
        // ignore stale listener cleanup errors
      }
      settleHistorySubRef.current = null;
    }
  }, []);

  const clearSettlementPoll = useCallback(() => {
    clearSettlingWatchers();
  }, [clearSettlingWatchers]);

const applySettlementResult = useCallback((history: HistoryItem) => {
    const won = (() => {
    try { return !!walletKeyRef.current && new web3.PublicKey(history.winner).equals(walletKeyRef.current); }
    catch { return history.winner === walletKeyRef.current?.toBase58(); }
  })();
    clearSettlingWatchers();
    setResultSide(history.winnerSide === 'HEADS' ? 0 : 1);
    setResultAmount(history.amount);
    setResultModal(won ? 'WON' : 'LOST');
    setActiveGameMessage(won ? 'SETTLED: YOU WON' : 'SETTLED: YOU LOST');
    setPhase('done');
    void AsyncStorage.removeItem(ACTIVE_GAME_KEY);
  }, [clearSettlingWatchers]);

  const startSettlementPoll = useCallback((gameId: number) => {
    clearSettlementPoll();
    settlePollRef.current = setInterval(() => {
      void (async () => {
        const history = await getHistoryByGameId(gameId);
        if (history) {
          applySettlementResult(history);
        }
      })();
    }, 3000);
  }, [applySettlementResult, clearSettlementPoll, getHistoryByGameId]);

  const subscribeToHistory = useCallback((gameId: number) => {
    if (settleHistorySubRef.current !== null) {
      try {
        connection.removeProgramAccountChangeListener(settleHistorySubRef.current);
      } catch {
        // ignore stale listener cleanup errors
      }
      settleHistorySubRef.current = null;
    }

    const gameIdBytes = Buffer.alloc(8);
    gameIdBytes.writeBigUInt64LE(BigInt(gameId));

    const id = connection.onProgramAccountChange(
      PROGRAM_ID,
      (accountInfo: any) => {
        try {
          const raw = accountInfo.account?.data ?? accountInfo.accountInfo?.data ?? accountInfo.value?.account?.data;
          if (!raw) return;
          const buf = Buffer.isBuffer(raw) ? raw : Buffer.from(raw as any);
          const history = parseHistoryRaw(buf);
          if (history && String(history.gameId) === String(gameId)) {
            applySettlementResult(history);
          }
        } catch (error) {
          console.warn('settle history watcher error:', error);
        }
      },
      'confirmed',
      [{ dataSize: HISTORY_SIZE }, { memcmp: { offset: 0, bytes: bs58.encode(gameIdBytes) } }]
    );

    settleHistorySubRef.current = id;
  }, [applySettlementResult]);

  const completeSettlement = useCallback(async (gameId: number) => {
    if (settledRef.current) return;
    settledRef.current = true;
    setPhase('settling');
    setActiveGameMessage('VERIFYING_OUTCOME...');

    await new Promise(resolve => setTimeout(resolve, 2500));

    // 1. Try history PDA lookup
    const history = await getHistoryByGameId(gameId);
    if (history) {
      applySettlementResult(history);
      return;
    }

    // 2. Try parsed log from realtime logs subscription
    if (lastFlipResultRef.current && lastFlipResultRef.current.gameId === gameId) {
      const logRes = lastFlipResultRef.current;
      const won = !!walletKeyRef.current && logRes.winner === walletKeyRef.current.toBase58();
      console.log('winner selected from parsed logs (games.tsx)', {
        gameId,
        winner: logRes.winner,
        myPubkey: walletKeyRef.current?.toBase58(),
        won,
      });

      clearSettlingWatchers();
      setResultSide(logRes.winnerSide);
      setResultAmount(won ? (joinedWagerLamportsRef.current / web3.LAMPORTS_PER_SOL) : 0);
      setResultModal(won ? 'WON' : 'LOST');
      setActiveGameMessage(won ? 'SETTLED: YOU WON' : 'SETTLED: YOU LOST');
      setPhase('done');
      void AsyncStorage.removeItem(ACTIVE_GAME_KEY);
      lastFlipResultRef.current = null; // Clear it
      return;
    }

    // Don't fall back to balance check — keep polling for history
    startSettlementPoll(gameId);
    return; // exit, let the poll call applySettlementResult when ready
  }, [applySettlementResult, clearSettlingWatchers, getHistoryByGameId, startSettlementPoll]);
  const subscribeToJoinedGame = useCallback((pda: web3.PublicKey, gameId: number) => {
    clearJoinedGameWatcher();

    const id = connection.onAccountChange(
      pda,
      info => {
        try {
          if (!info.data || info.data.length === 0 || Buffer.from(info.data).every(b => b === 0)) {
            void completeSettlement(gameId);
            return;
          }

          const buf = Buffer.from(info.data);
          const status = buf.readUInt8(OFFSET_STATUS);

          if (status === 2) {
            setActiveGameMessage('OPPONENT_JOINED!');
            setPhase('joined');
            void fetchGames();
          }
        } catch (error) {
          console.warn('joined game watcher error:', error);
        }
      },
      'confirmed'
    );

    joinedGameSubRef.current = id;
    activeGameIdRef.current = gameId;
  }, [clearJoinedGameWatcher, completeSettlement, fetchGames]);

  useEffect(() => { if (walletKey) void fetchGames(); }, [walletKey, fetchGames]);

  useEffect(() => {
    return () => {
      clearSettlingWatchers();
    };
  }, [clearSettlingWatchers]);

  useEffect(() => {
    if (!walletKey) return;

    let cancelled = false;

    const restoreJoinedGameWatcher = async () => {
      try {
        const stored = await AsyncStorage.getItem(ACTIVE_GAME_KEY);
        if (!stored || cancelled) return;

        const parsed = JSON.parse(stored) as { pda?: string; gameId?: string; playerOneSide?: number };
        if (!parsed?.pda) return;

        const pda = new web3.PublicKey(parsed.pda);
        const gameId = parsed.gameId ? Number(parsed.gameId) : null;
        setActiveGameMessage('MATCH_LIVE: AWAITING_SETTLER...');
        setPhase('joined');
        if (gameId != null) {
          subscribeToJoinedGame(pda, gameId);
          subscribeToHistory(gameId);
        }
      } catch {
        // ignore invalid persisted active game state
      }
    };

    void restoreJoinedGameWatcher();

    return () => {
      cancelled = true;
      clearJoinedGameWatcher();
      clearSettlingWatchers();
    };
  }, [walletKey, subscribeToJoinedGame, clearJoinedGameWatcher, clearSettlingWatchers, subscribeToHistory]);

  // ─── Poll for new games (realtime-ish) ───────────────────────────────────
  useEffect(() => {
    if (!walletKey) return;
    let mounted = true;
    const id = setInterval(() => {
      if (!mounted) return;
      void fetchGames();
    }, 3000);
    return () => { mounted = false; clearInterval(id); };
  }, [walletKey, fetchGames]);

  const onRefresh = async () => {
    setRefreshing(true);
    if (walletKey) {
      const rawBal = await connection.getBalance(walletKey);
      setBalance(rawBal / web3.LAMPORTS_PER_SOL);
    }
    await fetchGames();
    setRefreshing(false);
  };

  // ─── Execute Match Join Transaction ────────────────────────────────────────
  const joinGame = async (game: OpenGame) => {
    if (!walletKey || !localWallet.current || joiningId) return;
    if (game.player_one.equals(walletKey)) {
      Alert.alert('Lobby Error', 'You cannot enter your own lobby.');
      return;
    }

    const pubkeyStr = game.pubkey.toBase58();
    setJoiningId(pubkeyStr);

    try {
      const clientSeedB = Array.from(crypto.getRandomValues(new Uint8Array(32)));
      const ixData = new Uint8Array(33);
      ixData[0] = 1; // Variant 1 = JoinGame
      ixData.set(Uint8Array.from(clientSeedB), 1);

      const latest = await connection.getLatestBlockhash('finalized');
      const tx = new web3.Transaction().add(
        new web3.TransactionInstruction({
          keys: [
            { pubkey: game.pubkey,                  isSigner: false, isWritable: true  },
            { pubkey: walletKey,                    isSigner: true,  isWritable: true  },
            { pubkey: web3.SystemProgram.programId, isSigner: false, isWritable: false },
          ],
          programId: PROGRAM_ID,
          data: Buffer.from(ixData),
        })
      );

      tx.feePayer = walletKey;
      tx.recentBlockhash = latest.blockhash;
      tx.sign(localWallet.current);

      const sig = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: true });
      await connection.confirmTransaction({ signature: sig, ...latest }, 'confirmed');

      await AsyncStorage.setItem(ACTIVE_GAME_KEY, JSON.stringify({
        gameId: String(game.game_id),
        pda: pubkeyStr,
        playerOneSide: game.player_one_side,
      }));

      setActiveGameMessage('MATCH_LIVE: AWAITING_SETTLER...');
      setPhase('joined');
      settledRef.current = false;
      balanceBeforeRef.current = balance;
        joinedWagerLamportsRef.current = Number(game.amount);
      subscribeToJoinedGame(game.pubkey, Number(game.game_id));
      subscribeToHistory(Number(game.game_id));

    } catch (e: any) {
      Alert.alert('Transaction Failed', e.message ?? 'Unknown on-chain rejection.');
    } finally {
      setJoiningId(null);
      void fetchGames();
    }
  };

  // ─── Sub-Component List Item Render ────────────────────────────────────────
  const renderItem = ({ item }: { item: OpenGame }) => {
    const isOwnLobby = walletKey && item.player_one.equals(walletKey);
    const amountSol = (Number(item.amount) / web3.LAMPORTS_PER_SOL).toFixed(2);
    const pubkeyStr = item.pubkey.toBase58();

    return (
      <View style={s.lobbyItemCard}>
  <View style={s.cardBody}>
    
    {/* ZONE 1: Left Context Area */}
    <View style={s.cardLeftInfo}>
      
      {/* Top Header Track: Row that forces Title and Price onto the exact same baseline */}
      <View style={s.headerMetaRow}>
        <Text style={s.gameTitleText} numberOfLines={1}>
          game name {item.game_id.toString().slice(-1)}
        </Text>
        
        <Text style={s.wagerDisplayValue}>{amountSol} sol</Text>
      </View>
      
      {/* Bottom Subtext Track: Left-aligned green wallet address string and its node side tag */}
      <View style={s.addressRowWrapper}>
        <Text style={s.addressLabelText}>{short(item.player_one.toBase58(), 8, 2)}</Text>
        <Text style={s.inlineSideLabelText}>
          {item.player_one_side === 0 ? 'head' : 'tail'}
        </Text>
      </View>
      
    </View>
    
    {/* ZONE 2: Far-Right Fixed White Action Square Box */}
    <TouchableOpacity
      activeOpacity={0.8}
     disabled={!!(joiningId || isOwnLobby)}
      style={[
        s.actionSquareBtn,
        isOwnLobby && s.disabledSquareVariant,
        // If the shown letter is 'H' make the box green
        item.player_one_side !== 0 && { backgroundColor: '#C3F306' }
      ]}
      onPress={() => joinGame(item)}
    >
      {joiningId === pubkeyStr ? (
        <ActivityIndicator size="small" color="#151618" />
      ) : (
        <Text style={s.actionSquareText}>
          {item.player_one_side === 0 ? 'T' : 'H'}
        </Text>
      )}
    </TouchableOpacity>

  </View>
  
  
</View>
    );
  };

  const verticalTumbleX = settlingCoinRotateX.interpolate({
    inputRange: [0, 1],
    outputRange: ['0deg', '720deg'],
  });

  if (phase === 'settling') {
    return (
      <View style={s.settlingScreen}>
        <Animated.View
          style={[
            s.settlingCoin,
            {
              transform: [
                { perspective: 1000 },
                { translateY: settlingCoinTranslateY },
                { rotateX: verticalTumbleX },
                { scaleY: coinScaleY },
              ],
            },
          ]}
        >
          <Svg width={200} height={215} viewBox="0 0 597.86 643.33">
            <Path fill="#c3f306" d="M596.49,327.98c-11.95,118.61-94.41,225.51-94.41,225.51-99.74,71.17-203.12,88.36-203.12,88.36-5.45-1.53-10.78-3.06-16.06-4.68-114.05-34.59-184.85-84.9-202.52-98.44-2.89-2.19-4.37-3.41-4.37-3.41C3.84,407.74,1.37,314.75,1.37,314.75,25.38,191.6,92.46,91.86,92.46,91.86,182.33,26.42,268.96,5.79,286.53,2.1c2.13-.45,3.23-.62,3.23-.62,41.69,5.87,78.35,16.77,109.39,29.34,76.79,31.04,119.41,72.19,119.41,72.19,71.37,113.19,77.92,225,77.92,225v-.03Z" />
            <Path fill="#121314" d="M476.14,544.83c-71.76,60.04-162.74,85.21-193.24,92.34-114.05-34.59-184.85-84.9-202.52-98.44,56.07,38.73,203.69,83.48,203.69,83.48,84.36-16.32,182.18-86.41,182.18-86.41l9.9,9.05v-.03Z" />
            <G fill="#121314">
              <Path d="M445.72,128.83s-67.17-53.8-162.29-78.43c0,0-108.65,35.24-162.48,75.94,0,0-55.67,90.18-77.44,190.49,0,0,3.43,72.96,64.33,184.65,0,0-41.83-115.15-44.35-176.96,0,0,37.23-122.27,74.46-178.35,0,0,76.08-53.32,149.15-74.01,0,0,44.35-.65,158.57,56.67h.06Z" />
              <Path d="M508.55,299.34s-31.53,103.04-84.65,188c0,0-82.04,61.01-169.61,85.53l13.73,4.37s91.37-17.85,167.85-75.77c0,0,60.73-97.64,75.03-182.86l-2.33-19.27h-.03Z" />
              <Path d="M544.44,253.69c-36.8-125.74-70.06-161.01-70.06-161.01C384.14,27.18,309.26,7.04,286.5,2.1c2.13-.45,3.23-.62,3.23-.62,41.69,5.87,78.35,16.77,109.39,29.34,52.1,24.74,87.83,55.73,87.83,55.73,38.71,54.23,56.87,163.39,57.49,167.17v-.03Z" />
              <Path d="M476.14,544.83s77.64-115.61,74.43-212.23c0,0-17.51,106.27-84.36,203.18" />
              <Path d="M415.19,197.53l-47.93,49.97c-2.3,2.38-5.45,3.75-8.77,3.75h-212.26c-5.39,0-8.17-6.47-4.43-10.36l47.93-49.97c2.3-2.38,5.45-3.75,8.77-3.75h212.26c5.39,0,8.17,6.47,4.43,10.36h0Z" />
              <Path d="M141.84,291.57l47.93,49.97c2.3,2.38,5.45,3.75,8.77,3.75h212.26c5.39,0,8.17-6.47,4.43-10.36l-47.93-49.97c-2.3-2.38-5.45-3.75-8.77-3.75h-212.26c-5.39,0-8.17,6.47-4.43,10.36Z" />
              <Path d="M415.19,385.58l-47.93,49.97c-2.3,2.38-5.45,3.75-8.77,3.75h-212.26c-5.39,0-8.17-6.47-4.43-10.36l47.93-49.97c2.3,2.38,5.45,3.75,8.77,3.75h212.26c5.39,0,8.17,6.47,4.43,10.36Z" />
            </G>
          </Svg>
        </Animated.View>
      </View>
    );
  }

  return (
    <SafeAreaView style={s.rootViewContainer}>
      
      {/* ── TOP HEADER DASH NAVIGATION SYSTEM ────────────────────────────────── */}
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
          balanceLabel={walletLoading ? '...' : balance.toFixed(2)}
          walletAddress={walletKey?.toBase58() ?? ''}
        />
      </View>

      {/* ─── LOBBY MATCH SCROLL SYSTEM ──────────────────────────────────────── */}
      <View style={s.mainBodyContainer}>
        <View style={s.horizontalLineWhite} />
        <Text style={s.screenHeadingTitle}>active games</Text>
        <View style={s.horizontalLineWhite} />
        {activeGameMessage ? (
          <View style={s.activeGameBanner}>
            <Text style={s.activeGameBannerText}>{activeGameMessage}</Text>
          </View>
        ) : null}
        <FlatList
  data={openGames}
  keyExtractor={item => item.pubkey.toBase58()}
  renderItem={renderItem}
  showsVerticalScrollIndicator={false}
  contentContainerStyle={s.listContent}
  refreshControl={
    <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor="#C3F306" />
  }
  ListEmptyComponent={
    <Text style={s.fallbackNoDataText}>
      No on-chain lobbies deployed.{'\n'}Pull to sync or build one in home dashboard.
    </Text>
  }
  
  // ─── ADDED LIST FOOTER SYSTEM ──────────────────────────────────────────
  ListFooterComponent={
    <View style={s.footerWrapper}>
      
      {/* SHOW MORE TEXT BUTTON */}
      <TouchableOpacity 
        activeOpacity={0.7} 
        onPress={() => { /* Handle pagination / fetching more records here if needed */ }}
        style={s.showMoreTouchable}
      >
        <Text style={s.showMoreText}>show more</Text>
      </TouchableOpacity>

      {/* (create-new moved to fixed bottom wrapper) */}

    </View>
  }
/>
      
      {/* Fixed create-new button positioned above the bottom */}
      <View style={s.fixedCreateWrapper} pointerEvents="box-none">
        <View style={s.createNewContainer}>
          <View style={s.createNewShadow} />
          <TouchableOpacity
            activeOpacity={0.9}
            style={s.btnCreateNewMain}
            onPress={() => router.replace('/')}
          >
            <Text style={s.btnCreateNewText}>create new</Text>
          </TouchableOpacity>
        </View>
      </View>
      </View>

      <Modal visible={!!resultModal} transparent={false} animationType="fade" onRequestClose={() => {
        clearSettlingWatchers();
        setResultModal(null);
        setResultAmount(0);
        setResultSide(null);
        setPhase('idle');
        setActiveGameMessage('');
        settledRef.current = false;
        activeGameIdRef.current = null;
        clearJoinedGameWatcher();
        void fetchGames();
      }}>
        <SafeAreaView style={s.rootViewContainer}>
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
              balanceLabel={balance.toFixed(2)}
              walletAddress={walletKey?.toBase58() ?? ''}
            />
          </View>

          <View style={s.resultScreenBody}>
            <View style={s.resultTopBlock}>
              <View style={s.horizontalLineWhite} />
              <Text style={s.winHeadlineText}>{resultModal === 'WON' ? 'you won!' : 'you lost!'}</Text>
              <View style={s.horizontalLineWhite} />
            </View>

            <Text style={s.resultAmountText}>{resultAmount.toFixed(2)} SOL</Text>

            <View style={s.modalCoinContainer}>
              <Svg width={210} height={210} viewBox="0 0 597.86 643.33">
                <Path
                  fill={resultModal === 'WON' ? '#c3f306' : '#c7c9cc'}
                  d="M596.49,327.98c-11.95,118.61-94.41,225.51-94.41,225.51-99.74,71.17-203.12,88.36-203.12,88.36-5.45-1.53-10.78-3.06-16.06-4.68-114.05-34.59-184.85-84.9-202.52-98.44-2.89-2.19-4.37-3.41-4.37-3.41C3.84,407.74,1.37,314.75,1.37,314.75,25.38,191.6,92.46,91.86,92.46,91.86,182.33,26.42,268.96,5.79,286.53,2.1c2.13-.45,3.23-.62,3.23-.62,41.69,5.87,78.35,16.77,109.39,29.34,76.79,31.04,119.41,72.19,119.41,72.19,71.37,113.19,77.92,225,77.92,225v-.03Z"
                />
                <Path
                  fill={resultModal === 'WON' ? '#121314' : '#121314'}
                  d="M476.14,544.83c-71.76,60.04-162.74,85.21-193.24,92.34-114.05-34.59-184.85-84.9-202.52-98.44,56.07,38.73,203.69,83.48,203.69,83.48,84.36-16.32,182.18-86.41,182.18-86.41l9.9,9.05v-.03Z"
                />
                <G fill="#121314">
                  <Path d="M445.72,128.83s-67.17-53.8-162.29-78.43c0,0-108.65,35.24-162.48,75.94,0,0-55.67,90.18-77.44,190.49,0,0,3.43,72.96,64.33,184.65,0,0-41.83-115.15-44.35-176.96,0,0,37.23-122.27,74.46-178.35,0,0,76.08-53.32,149.15-74.01,0,0,44.35-.65,158.57,56.67h.06Z" />
                  <Path d="M508.55,299.34s-31.53,103.04-84.65,188c0,0-82.04,61.01-169.61,85.53l13.73,4.37s91.37-17.85,167.85-75.77c0,0,60.73-97.64,75.03-182.86l-2.33-19.27h-.03Z" />
                  <Path d="M544.44,253.69c-36.8-125.74-70.06-161.01-70.06-161.01C384.14,27.18,309.26,7.04,286.5,2.1c2.13-.45,3.23-.62,3.23-.62,41.69,5.87,78.35,16.77,109.39,29.34,52.1,24.74,87.83,55.73,87.83,55.73,38.71,54.23,56.87,163.39,57.49,167.17v-.03Z" />
                  <Path d="M476.14,544.83s77.64-115.61,74.43-212.23c0,0-17.51,106.27-84.36,203.18" />
                  <Path d="M415.19,197.53l-47.93,49.97c-2.3,2.38-5.45,3.75-8.77,3.75h-212.26c-5.39,0-8.17-6.47-4.43-10.36l47.93-49.97c2.3-2.38,5.45-3.75,8.77-3.75h212.26c5.39,0,8.17,6.47,4.43,10.36h0Z" />
                  <Path d="M141.84,291.57l47.93,49.97c2.3,2.38,5.45,3.75,8.77,3.75h212.26c5.39,0,8.17-6.47,4.43-10.36l-47.93-49.97c-2.3-2.38-5.45-3.75-8.77-3.75h-212.26c-5.39,0-8.17,6.47-4.43,10.36Z" />
                  <Path d="M415.19,385.58l-47.93,49.97c-2.3,2.38-5.45,3.75-8.77,3.75h-212.26c-5.39,0-8.17-6.47-4.43-10.36l47.93-49.97c2.3,2.38,5.45,3.75,8.77,3.75h212.26c5.39,0,8.17,6.47,4.43,10.36Z" />
                </G>
              </Svg>
            </View>

            <View style={s.resultBottomBlock}>
              <View style={s.resultActionShadow} />
              <TouchableOpacity
                activeOpacity={0.9}
                style={[s.resultActionBtn, resultModal === 'LOST' && s.resultActionBtnLost]}
                onPress={() => {
                  setResultModal(null);
                  setResultAmount(0);
                  setResultSide(null);
                  setPhase('idle');
                  setActiveGameMessage('');
                  settledRef.current = false;
                  activeGameIdRef.current = null;
                  clearJoinedGameWatcher();
                  clearSettlingWatchers();
                  void fetchGames();
                }}
              >
                <Text style={s.resultActionText}>{resultModal === 'WON' ? 'claim win' : 'return'}</Text>
              </TouchableOpacity>
            </View>
          </View>
        </SafeAreaView>
      </Modal>

    </SafeAreaView>
  );
}

// ─── Stylesheet Definition ──────────────────────────────────────────────────
const s = StyleSheet.create({
  rootViewContainer: { 
    flex: 1, 
    backgroundColor: '#080b10' 
  },
  topBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 24,
    paddingVertical: 5,
  },
  brandWrapper: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
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
  },
  headerBalanceMainFrame: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: '#FFFFFF', 
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
    fontSize: 15,                
    fontWeight: '600',
    color: '#151618',            
    letterSpacing: -0.5,
  },
  headerBalanceTicker: {
    fontFamily: 'Orbitron',
    fontSize: 15,                
    fontWeight: '600',
    color: '#151618',            
    letterSpacing: 0.5,
  },
  mainBodyContainer: {
    flex: 1,
    paddingHorizontal: 20,
    paddingTop: 12,
  },
  screenHeadingTitle: {
    fontFamily: 'Orbitron-SemiBold',
    fontSize: 14,
    color: 'white',
    textAlign: 'center',
   
    letterSpacing: 1.5,
    marginBottom: 0,
    marginTop: 0
  },
  activeGameBanner: {
    width: '100%',
    borderWidth: 1,
    borderColor: '#C3F306',
    backgroundColor: '#111820',
    paddingHorizontal: 14,
    paddingVertical: 10,
    marginBottom: 14,
  },
  activeGameBannerText: {
    fontFamily: 'Orbitron',
    fontSize: 12,
    color: '#C3F306',
    textAlign: 'center',
    letterSpacing: 0.5,
  },
  listContent: {
    paddingBottom: 140,
    gap: 16
  },




  cardRightSideBlock: {
    alignItems: 'flex-end',
    gap: 10,
  },
  sideBadgePlate: {
    paddingHorizontal: 12,
    paddingVertical: 4,
    borderRadius: 0,
  },
  sideBadgeText: {
    fontFamily: 'Orbitron',
    fontSize: 12,
    fontWeight: '900',
    textTransform: 'lowercase',
  },
  actionExecuteBtn: {
    backgroundColor: '#FFFFFF',
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: 0,
    minWidth: 100,
    alignItems: 'center',
    justifyContent: 'center',
  },
  actionExecuteBtnText: {
    fontFamily: 'Orbitron',
    fontSize: 12,
    color: '#151618',
    fontWeight: '900',
  },
  disabledBtnVariant: {
    opacity: 0.3,
    backgroundColor: '#5a6a7a'
  },
  activeLoadingBtnVariant: {
    backgroundColor: '#9945FF'
  },
  fallbackNoDataText: {
    fontFamily: 'Orbitron',
    fontSize: 12,
    color: '#5a6a7a',
    textAlign: 'center',
    lineHeight: 20,
    paddingVertical: 64,
  },
  navToggleRow: {
    flexDirection: 'row',
    width: '100%',
    height: 42,                 
    justifyContent: 'space-between',
    gap: 16,                    
    marginTop: 12,
    marginBottom: 12,
  },
  navBtn: {
    flex: 1,
    height: '100%',
    backgroundColor: '#151618', 
    borderWidth: 2,
    borderColor: '#FFFFFF',     
    justifyContent: 'center',
    alignItems: 'center',
    borderRadius: 0,            
  },
  activeNavTab: {
    borderColor: '#C3F306', // Green active track outline marker
  },
  navBtnText: {
    fontFamily: 'Orbitron',     
    fontSize: 15,               
    color: '#FFFFFF',           
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
    backfaceVisibility: 'visible',
  },
  resultModalBackdrop: {
    flex: 1,
    backgroundColor: '#080b10',
  },
  resultScreenBody: {
    flex: 1,
    paddingHorizontal: 24,
    paddingBottom: 24,
    paddingTop: 8,
  },
  resultTopBlock: {
    marginTop: 18,
  },
  winHeadlineText: {
    fontFamily: 'Orbitron-SemiBold',
    fontSize: 18,
    color: '#FFFFFF',
    textAlign: 'center',
    textTransform: 'lowercase',
    letterSpacing: 0.5,
    marginVertical: 6,
  },
  resultAmountText: {
    fontFamily: 'Orbitron-ExtraBold',
    fontSize: 30,
    color: '#FFFFFF',
    textAlign: 'center',
    marginTop: 42,
    marginBottom: 28,
    letterSpacing: 0.5,
  },
  modalCoinContainer: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 8,
  },
  resultBottomBlock: {
    marginTop: 'auto',
    marginBottom: 6,
    position: 'relative',
    height: 72,
  },
  resultActionShadow: {
    position: 'absolute',
    left: 10,
    right: -10,
    top: 8,
    bottom: -8,
    backgroundColor: '#FFFFFF',
  },
  resultActionBtn: {
    position: 'absolute',
    left: 0,
    right: 0,
    top: 0,
    bottom: 0,
    backgroundColor: '#C3F306',
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 0,
  },
  resultActionBtnLost: {
    backgroundColor: '#FFFFFF',
  },
  resultCoin: {
    width: 88,
    height: 88,
    borderRadius: 44,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 16,
    borderWidth: 1,
    borderColor: '#00000033',
  },
  resultCoinText: {
    fontFamily: 'Orbitron',
    fontSize: 34,
    color: '#121314',
  },
  resultSideText: {
    fontFamily: 'Orbitron',
    fontSize: 22,
    color: '#FFFFFF',
    letterSpacing: 1.5,
    textTransform: 'uppercase',
    marginTop: 4,
  },
  resultWonAmountText: {
    fontFamily: 'Orbitron',
    color: '#FFFFFF',
    fontSize: 28,
    textAlign: 'center',
    letterSpacing: 1,
    marginTop: 8,
    marginBottom: 0,
  },
  resultSub: {
    fontFamily: 'Orbitron',
    fontSize: 12,
    color: '#5a6a7a',
    textAlign: 'center',
    marginTop: 10,
    lineHeight: 18,
  },
  resultActionText: {
    fontFamily: 'Orbitron-ExtraBold',
    fontSize: 20,
    color: '#000000',
    textTransform: 'lowercase',
    letterSpacing: 0.2,
  },
  lobbyItemCard: {
    width: '100%',
    backgroundColor: 'transparent', 
    paddingTop: 14,
    paddingBottom: 14,
    paddingHorizontal: 4,
    position: 'relative',
  },
  cardBody: {
    flexDirection: 'row',
    alignItems: 'center',          // Vertically aligns the left details and the right box button cleanly
    justifyContent: 'space-between',
    width: '100%',
  },
  cardLeftInfo: {
    flex: 1,                       // Dynamically fills all remaining left space
    justifyContent: 'center',
    gap: 2,                        // Tiny tight vertical spacing between top header row and bottom address row
    paddingRight: 24,              // Hard safety margin buffer so text never overlaps the right white block
  },
  headerMetaRow: {
    flexDirection: 'row',
    alignItems: 'baseline',        // Forces 'game name' and '0.1 sol' text components onto the same horizontal line
    justifyContent: 'space-between', // Pushes the game title to the left and sol price text to the right
    width: '100%',
  },
  gameTitleText: {
    fontFamily: 'Orbitron',
    fontSize: 16,
    color: '#FFFFFF',
    textTransform: 'lowercase',
  },
  wagerDisplayValue: {
    fontFamily: 'Orbitron',
    fontSize: 18,
    color: '#FFFFFF',
    textTransform: 'lowercase',
    textAlign: 'right',
  },
  addressRowWrapper: {
    flexDirection: 'row',
    alignItems: 'center',          
    gap: 8,                        // Horizontal space between green address hash and HEAD/TAIL text
    marginTop: 2,                  // Clean breathing room separating it from the top headline row
  },
  addressLabelText: {
    fontFamily: 'Orbitron',
    fontSize: 15,
    color: '#C3F306', 
  },
  inlineSideLabelText: {
    fontFamily: 'Orbitron',
    fontSize: 11,
    color: '#C3F306',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  actionSquareBtn: {
    width: 56,                     
    height: 36,                    
    backgroundColor: '#FFFFFF', 
    justifyContent: 'center',
    alignItems: 'center',
    borderRadius: 0,
  },
  actionSquareText: {
    fontFamily: 'Orbitron',
    fontSize: 18,
    color: '#151618', 
    fontWeight: '900',
    textTransform: 'uppercase',
    
  },
  disabledSquareVariant: {
    opacity: 0.25,
  },
  cardSeparatorLine: {
    width: '100%',
    height: 1,
    backgroundColor: '#1c2530',    
    position: 'absolute',
    bottom: 0,
    left: 4,
  },
  // ─── FOOTER & ACTION ELEMENT STYLES ──────────────────────────────────────
  footerWrapper: {
    alignItems: 'center',
    marginTop: 20,
    marginBottom: 40, // Generous padding to ensure everything clears the absolute footer bar
    width: '100%',
  },
  showMoreTouchable: {
    paddingVertical: 12,
    paddingHorizontal: 24,
    marginBottom: 40, // Explicit layout gap separating text link and the bottom action card
  },
  showMoreText: {
    fontFamily: 'Orbitron',
    fontSize: 14,
    color: '#FFFFFF',
    textTransform: 'lowercase',
    letterSpacing: 0.5,
  },
  createNewContainer: {
    position: 'relative',

    marginTop: 40,
    height: 74,        // ixed height to contain the absolute positioned button
    marginBottom: 16,     width: '92%',
    alignSelf: 'center',
     // Proportional compressed height matching your custom dashboard button assets
  },
  createNewShadow: {
    position: 'absolute',
    top: 8,            // Shifts shadow downwards
    left: 8,           // Shifts shadow rightwards
    right: -8,         // Matches the offset width stretch
    bottom: -8,        // Matches the offset height stretch
    backgroundColor: '#FFFFFF',
    borderRadius: 0,   // Strict flat, sharp brutalist edges
  },
  btnCreateNewMain: {
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
  btnCreateNewText: {
    fontFamily: 'Orbitron-SemiBold',
    fontSize: 28, // Large bold low-profile typography sizing metric
    color: '#000000',

    letterSpacing: -0.5,
    textTransform: 'lowercase', // Keeps font text looking uniform across layout panels
  },
  fixedCreateWrapper: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 50,
    alignItems: 'center',
    justifyContent: 'center',
    height: 80,
  },
  
});