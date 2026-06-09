import AsyncStorage from '@react-native-async-storage/async-storage';
import * as web3 from '@solana/web3.js';
import { router } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Platform,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import Svg, { G, Path, Polygon } from 'react-native-svg';
import WalletNavbarMenu from '../components/wallet-navbar-menu';

const resolveRuntimeEnv = (key: string) => {
  if (typeof process !== 'undefined' && process.env && process.env[key]) return process.env[key];
  if (typeof globalThis !== 'undefined') {
    const anyGlobal = globalThis as any;
    if (anyGlobal.__ENV__ && anyGlobal.__ENV__[key]) return anyGlobal.__ENV__[key];
    if (anyGlobal.env && anyGlobal.env[key]) return anyGlobal.env[key];
  }
  return '';
};

const SUPABASE_URL = resolveRuntimeEnv('EXPO_PUBLIC_SUPABASE_URL') || "https://zzgtvijdwxjugorgyobh.supabase.co";
const SUPABASE_ANON_KEY = resolveRuntimeEnv('EXPO_PUBLIC_SUPABASE_ANON_KEY') ||
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inp6Z3R2aWpkd3hqdWdvcmd5b2JoIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzM4NTIxMjMsImV4cCI6MjA4OTQyODEyM30.KRnjV8dPYua_rm4fE8HSot9iXL9tmZ_OnpJgztOSbZ4';
const HELIUS_RPC = resolveRuntimeEnv('EXPO_PUBLIC_HELIUS_RPC') || 'https://api.devnet.solana.com';
const LOCAL_WALLET_KEY = 'solflip_local_keypair';
const FALLBACK_RPC = 'https://api.devnet.solana.com';

const getRpcCandidates = () => {
  const candidates = [HELIUS_RPC, FALLBACK_RPC];
  return Array.from(new Set(candidates.filter(Boolean)));
};

const connection = new web3.Connection(HELIUS_RPC, {
  commitment: 'confirmed',
  fetch: (url, options) => fetch(url as string, options as RequestInit),
});

const createConnection = (rpcUrl: string) => new web3.Connection(rpcUrl, {
  commitment: 'confirmed',
  fetch: (url, options) => fetch(url as string, options as RequestInit),
});

type LeaderboardPlayer = {
  address: string;
  wins: number;
  earnedLamports: bigint;
  earned: string;
};

const formatShortAddress = (address: string) => {
  if (!address) return '0x0000...00';
  return `${address.slice(0, 10)}...${address.slice(-2)}`.toLowerCase();
};

const SOL = 1_000_000_000;

const parsePrizeToLamports = (prize: unknown) => {
  if (prize === null || prize === undefined) return 0n;
  if (typeof prize === 'bigint') return prize;
  if (typeof prize === 'number' && Number.isFinite(prize)) return BigInt(Math.trunc(prize));
  const cleaned = String(prize).replace(/[^0-9.-]/g, '');
  if (!cleaned) return 0n;
  try {
    if (cleaned.includes('.')) {
      return BigInt(Math.trunc(Number(cleaned)));
    }
    return BigInt(cleaned);
  } catch {
    return 0n;
  }
};

const formatSol = (lamports: bigint) =>
  `${(Number(lamports) / SOL).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const getRankSuffix = (rank: number) => {
  if (rank === 1) return 'st';
  if (rank === 2) return 'nd';
  if (rank === 3) return 'rd';
  return 'th';
};

export default function LeaderboardScreen() {
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [players, setPlayers] = useState<LeaderboardPlayer[]>([]);
  const [walletBalance, setWalletBalance] = useState(0);
  const [walletAddress, setWalletAddress] = useState('');
  const [walletLoading, setWalletLoading] = useState(true);
  const didLoadWalletOnce = useRef(false);

  const loadWalletBalance = useCallback(async () => {
    const isInitialWalletLoad = !didLoadWalletOnce.current;
    if (isInitialWalletLoad) {
      setWalletLoading(true);
    }
    try {
      let stored: string | null = null;
      try {
        const mod = await import('expo-secure-store');
        stored = await mod.getItemAsync(LOCAL_WALLET_KEY);
      } catch {
        stored = await AsyncStorage.getItem(LOCAL_WALLET_KEY);
      }

      if (!stored) {
        stored = await AsyncStorage.getItem(LOCAL_WALLET_KEY);
      }

      if (!stored) {
        setWalletBalance(0);
        return;
      }

      const kp = web3.Keypair.fromSecretKey(Uint8Array.from(JSON.parse(stored)));
      setWalletAddress(kp.publicKey.toBase58());
      let lastError: unknown = null;
      let balanceLoaded = false;
      for (const rpcUrl of getRpcCandidates()) {
        try {
          const activeConnection = rpcUrl === HELIUS_RPC ? connection : createConnection(rpcUrl);
          const rawBalance = await activeConnection.getBalance(kp.publicKey);
          setWalletBalance(rawBalance / web3.LAMPORTS_PER_SOL);
          balanceLoaded = true;
          break;
        } catch (rpcError) {
          lastError = rpcError;
          console.warn('wallet balance rpc failed', rpcUrl, rpcError);
        }
      }

      if (!balanceLoaded) {
        throw lastError || new Error('No RPC endpoint was reachable');
      }
    } catch (error) {
      console.error('Leaderboard wallet balance sync failed:', error);
      setWalletAddress('');
      setWalletBalance(0);
    } finally {
      didLoadWalletOnce.current = true;
      if (isInitialWalletLoad) {
        setWalletLoading(false);
      }
    }
  }, []);

  const loadLeaderboard = async () => {
    try {
      const response = await fetch(
        `${SUPABASE_URL}/rest/v1/leaderboard?select=winner,prize&order=created_at.desc`,
        {
          headers: {
            apikey: SUPABASE_ANON_KEY,
            Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
            Accept: 'application/json',
          },
        }
      );

      if (!response.ok) throw new Error(`${response.status}`);
      const rows = await response.json();
      const normalizedRows = Array.isArray(rows) ? rows : [];

      const winsMap = new Map<string, number>();
      const earningsMap = new Map<string, bigint>();
      for (const row of normalizedRows) {
        const winner = String(row.winner || '');
        if (!winner) continue;
        const prizeLamports = parsePrizeToLamports(row.prize);
        winsMap.set(winner, (winsMap.get(winner) || 0) + 1);
        earningsMap.set(winner, (earningsMap.get(winner) || 0n) + prizeLamports);
      }

      const aggregated = Array.from(winsMap.entries()).map(([address, wins]) => ({
        address,
        wins,
        earnedLamports: earningsMap.get(address) || 0n,
        earned: formatSol(earningsMap.get(address) || 0n),
      }));

      // Sort primarily by earned amount descending without coercing BigInt to number
      aggregated.sort((a, b) => {
        if (a.earnedLamports === b.earnedLamports) return b.wins - a.wins;
        return a.earnedLamports < b.earnedLamports ? 1 : -1;
      });
      setPlayers(aggregated.slice(0, 20));
    } catch (e) {
      console.error('Leaderboard data sync failed:', e);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  useEffect(() => {
    void loadLeaderboard();
    void loadWalletBalance();
  }, [loadLeaderboard, loadWalletBalance]);

  const onRefresh = async () => {
    setRefreshing(true);
    await Promise.all([loadLeaderboard(), loadWalletBalance()]);
  };

  return (
    <SafeAreaView style={s.rootViewContainer}>
      
      {/* ── TOP HEADER SYSTEM ── */}
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
          balanceLabel={walletLoading ? '...' : walletBalance.toFixed(2)}
          walletAddress={walletAddress}
        />
      </View>

      {/* ─── DYNAMIC RANKINGS VIEWER ─── */}
      <View style={s.mainBodyContainer}>
        
        {/* SUB HEADER TITLE WRAPPER */}
        <View style={s.leaderTitleFrame}>
          <View style={s.headerLineHorizontal} />
          <Text style={s.screenHeadingTitle}>leader board</Text>
          <View style={s.headerLineHorizontal} />
        </View>

        {loading ? (
          <View style={s.loadingWrapper}>
            <ActivityIndicator size="large" color="#C3F306" />
          </View>
        ) : (
          <ScrollView
            style={{ flex: 1 }}
            contentContainerStyle={s.listScrollContent}
            showsVerticalScrollIndicator={false}
            refreshControl={
              <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor="#C3F306" />
            }
          >
            {players.map((item, index) => {
              const displayRank = index + 1;
              const suffix = getRankSuffix(displayRank);
              
              // Alternating color assignments: odd ranks get white plates, even ranks get neon lime plates
              const isEven = displayRank % 2 === 0;
              const badgeBg = isEven ? '#C3F306' : '#FFFFFF';
              
              return (
                <View key={item.address} style={s.rankItemRow}>
                  <View style={s.cardLeftInfo}>
                    <Text style={s.rankDisplayTitle}>{displayRank}{suffix}</Text>
                    <Text style={s.addressLabelText}>{formatShortAddress(item.address)}</Text>
                  </View>

                  <View style={[s.scoreBadgePlate, { backgroundColor: badgeBg }]}>
                    <Text style={s.scoreBadgeText}>{item.wins}</Text>
                  </View>
                </View>
              );
            })}

            {players.length === 0 && (
              <Text style={s.fallbackNoDataText}>No records located in backend tables.</Text>
            )}
          </ScrollView>
        )}
      </View>

      {/* ─── FIXED BOTTOM SYSTEM PANEL ─── */}
 // ─── ADDED LIST FOOTER SYSTEM ──────────────────────────────────────────

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
  

      
      {/* Fixed create-new button positioned above the bottom */}
      <View style={s.fixedCreateWrapper} pointerEvents="box-none">
        <View style={s.buttonContainer}>
          <View style={s.buttonShadow} />
          <TouchableOpacity
            activeOpacity={0.9}
            style={s.btnCreate}
            onPress={() => router.replace('/')}
          >
            <Text style={s.btnCreateText}>play</Text>
          </TouchableOpacity>
        </View>
      </View>

    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  rootViewContainer: { 
    flex: 1, 
    backgroundColor: '#000000',
    position: 'relative',
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
    fontSize: 14,                
    fontWeight: '600',
    color: '#151618',            
    letterSpacing: -0.5,
  },
  headerBalanceTicker: {
    fontFamily: 'Orbitron',
    fontSize: 14,                
    fontWeight: '600',
    color: '#151618',            
    letterSpacing: 0.5,
  },
  mainBodyContainer: {
    flex: 1,
    paddingHorizontal: 32,
    paddingTop: 16,
  },
  leaderTitleFrame: {
    width: '100%',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 24,
  },
  headerLineHorizontal: {
    width: '100%',
    height: 1,
    backgroundColor: '#3b432a', // Dark forest tint matching line vectors in image
  },
  screenHeadingTitle: {
    fontFamily: 'Orbitron-SemiBold',
    fontSize: 16,
    color: '#FFFFFF',
    textAlign: 'center',
    textTransform: 'lowercase',
    letterSpacing: 0.5,
    marginVertical: 6,
  },
  loadingWrapper: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  listScrollContent: {
    paddingBottom: 90, // Room to scroll past absolute navigation area comfortably
    gap: 24,
  },
  
  // ─── LEADERBOARD DATA ROW SYSTEM ───
  rankItemRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    width: '100%',
  },
  cardLeftInfo: {
    flex: 1,
    justifyContent: 'center',
    gap: 1,
  },
  rankDisplayTitle: {
    fontFamily: 'Orbitron-SemiBold',
    fontSize: 16,
    color: '#FFFFFF',
    textTransform: 'lowercase',
  },
  addressLabelText: {
    fontFamily: 'Orbitron-SemiBold',
    fontSize: 15,
    color: '#C3F306',
  },
  scoreBadgePlate: {
    width: 68,
    height: 32,
    justifyContent: 'center',
    alignItems: 'center',
    borderRadius: 0,
  },
  scoreBadgeText: {
    fontFamily: 'Orbitron-SemiBold',
    fontSize: 16,
    color: '#151618',
    fontWeight: '600',
  },
  fallbackNoDataText: {
    fontFamily: 'Orbitron-SemiBold',
    fontSize: 12,
    color: '#5a6a7a',
    textAlign: 'center',
    paddingVertical: 64,
  },

  // ─── BOTTOM ROUTER ATTACHMENT PANEL ───
  fixedBottomActionContainer: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    backgroundColor: '#080b10',
    paddingHorizontal: 24,
    paddingTop: 12,
    paddingBottom: Platform.OS === 'ios' ? 24 : 12,
  },
  navToggleRow: {
    flexDirection: 'row',
    width: '100%',
    height: 42,                 
    justifyContent: 'space-between',
    gap: 16,                    
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
  navBtnText: {
    fontFamily: 'Orbitron',     
    fontSize: 14,               
    color: '#FFFFFF',           
    letterSpacing: 0.5,
  },
   footerWrapper: {
    alignItems: 'center',
    marginTop: 20,
    marginBottom: 40, // Generous padding to ensure everything clears the absolute footer bar
    width: '100%',
  },
  showMoreTouchable: {
    paddingVertical: 100,
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
  buttonContainer: {
    position: 'relative',

    marginTop: 40,
    height: 74,        // ixed height to contain the absolute positioned button
    marginBottom: 16,     width: '92%',
    alignSelf: 'center',
     // Proportional compressed height matching your custom dashboard button assets
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
    fontFamily: 'Orbitron-Bold',
    fontSize: 28, // Large bold low-profile typography sizing metric
    color: '#000000',
    fontWeight: '600',
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