import { useRouter } from 'expo-router';
import { useState } from 'react';
import { Modal, Pressable, StyleSheet, Text, View } from 'react-native';

type WalletNavbarMenuProps = {
  balanceLabel: string;
  walletAddress: string;
  onDisconnect?: () => void | Promise<void>;
};

export default function WalletNavbarMenu({ balanceLabel, walletAddress, onDisconnect }: WalletNavbarMenuProps) {
  const router = useRouter();
  const [open, setOpen] = useState(false);

  const goTo = (path: '/' | '/games' | '/leaderboard' | '/wallet') => {
    setOpen(false);
    router.push(path);
  };

  return (
    <>
      <View style={s.headerBalanceContainer}>
        <View style={s.headerBalanceShadow} />
        <View style={s.headerBalanceMainFrame}>
          <Pressable style={s.balanceTouchRegion} onPress={() => setOpen(v => !v)}>
            <Text style={s.headerBalanceVal}>{balanceLabel}</Text>
            <Text style={s.headerBalanceTicker}>SOL</Text>
          </Pressable>
        </View>
      </View>

      <Modal visible={open} transparent animationType="fade" onRequestClose={() => setOpen(false)}>
        <View style={s.overlayRoot}>
          <Pressable style={StyleSheet.absoluteFill} onPress={() => setOpen(false)} />
          <View style={s.menuCard}>
            <Text style={s.menuLabel}>wallet address</Text>
              <Text style={s.menuAddress} selectable>
                {walletAddress || 'wallet not ready'}
            </Text>

            <View style={s.menuDivider} />

            <Pressable style={s.menuLink} onPress={() => goTo('/games')}>
              <Text style={s.menuLinkText}>games</Text>
            </Pressable>
            <Pressable style={s.menuLink} onPress={() => goTo('/leaderboard')}>
              <Text style={s.menuLinkText}>leaderboard</Text>
            </Pressable>
            <Pressable style={s.menuLink} onPress={() => goTo('/wallet')}>
              <Text style={s.menuLinkText}>wallet</Text>
            </Pressable>
            {onDisconnect ? (
              <Pressable style={s.menuLink} onPress={() => void onDisconnect()}>
                <Text style={s.menuLinkText}>disconnect</Text>
              </Pressable>
            ) : null}
          </View>
        </View>
      </Modal>
    </>
  );
}

const s = StyleSheet.create({
  headerBalanceContainer: {
    position: 'relative',
    width: 130,
    height: 34,
    overflow: 'visible',
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
  overlayRoot: {
    flex: 1,
    backgroundColor: 'rgba(8, 11, 16, 0.35)',
  },
  menuCard: {
    position: 'absolute',
    top: 64,
    right: 24,
    width: 250,
    padding: 14,
    backgroundColor: '#111820',
    borderWidth: 2,
    borderColor: '#FFFFFF',
  },
  menuLabel: {
    fontFamily: 'Orbitron',
    fontSize: 11,
    color: '#C3F306',
    textTransform: 'uppercase',
    marginBottom: 8,
  },
  menuAddress: {
    fontFamily: 'Orbitron',
    fontSize: 11,
    color: '#FFFFFF',
    lineHeight: 16,
  },
  menuDivider: {
    height: 1,
    backgroundColor: '#2a3440',
    marginVertical: 12,
  },
  menuLink: {
    paddingVertical: 10,
  },
  menuLinkText: {
    fontFamily: 'Orbitron',
    fontSize: 13,
    color: '#C3F306',
    textTransform: 'lowercase',
  },
});