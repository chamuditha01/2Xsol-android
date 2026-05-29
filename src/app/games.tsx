import AsyncStorage from '@react-native-async-storage/async-storage';
import * as web3 from '@solana/web3.js';
import { router } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
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

const connection = new web3.Connection(HELIUS_RPC, { commitment: 'confirmed' });
const short = (k = '', h = 6, t = 4) => k ? `${k.slice(0, h)}…${k.slice(-t)}` : '?';
const deserializeKeypair = (s: string) => web3.Keypair.fromSecretKey(Uint8Array.from(JSON.parse(s)));

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

export default function games() {
  const [walletKey, setWalletKey] = useState<web3.PublicKey | null>(null);
  const [balance, setBalance] = useState(0);
  const [walletLoading, setWalletLoading] = useState(true);
  const [openGames, setOpenGames] = useState<OpenGame[]>([]);
  const [refreshing, setRefreshing] = useState(false);
  const [joiningId, setJoiningId] = useState<string | null>(null);
  const localWallet = useRef<web3.Keypair | null>(null);

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

  useEffect(() => { if (walletKey) void fetchGames(); }, [walletKey, fetchGames]);

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

      Alert.alert('Match Joined!', 'Entering setup... navigate back to the main dash to witness result settlement.', [
        { text: 'OK', onPress: () => router.replace('/') }
      ]);
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
          balanceLabel={walletLoading ? '...' : balance.toFixed(1)}
          walletAddress={walletKey?.toBase58() ?? ''}
        />
      </View>

      {/* ─── LOBBY MATCH SCROLL SYSTEM ──────────────────────────────────────── */}
      <View style={s.mainBodyContainer}>
        <View style={s.horizontalLineWhite} />
        <Text style={s.screenHeadingTitle}>active games</Text>
        <View style={s.horizontalLineWhite} />
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
    fontFamily: 'Orbitron',
    fontSize: 14,
    color: 'white',
    textAlign: 'center',
   
    letterSpacing: 1.5,
    marginBottom: 0,
    marginTop: 0
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
    fontFamily: 'Orbitron',
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