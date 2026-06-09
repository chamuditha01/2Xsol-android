import CryptoJS from 'crypto-js';
import { useRouter } from 'expo-router';
import { useMemo, useState } from 'react';
import {
    Alert,
    Clipboard,
    Platform,
    SafeAreaView,
    ScrollView,
    StatusBar,
    StyleSheet,
    Text,
    TextInput,
    TouchableOpacity,
    View,
} from 'react-native';

type CodeTab = 'index.html' | 'verify.js' | 'style.css';

type VerificationResult = {
  isHashValid: boolean;
  outcome: 'HEADS' | 'TAILS';
  calculatedHash: string;
  finalHash: string;
};

const C = {
  bg: '#080b10',
  surface: '#0d1318',
  glass: '#111820',
  border: '#1c2530',
  accent: '#14F195',
  purple: '#9945FF',
  text: '#e8edf2',
  muted: '#5a6a7a',
  danger: '#FF4545',
};

const normalizeHex = (value: string) => value.trim().toLowerCase().replace(/^0x/, '');

const isHex = (value: string) => /^[0-9a-f]+$/i.test(value);

export default function VerifyGameScreen() {
  const router = useRouter();
  const [activeTab, setActiveTab] = useState<CodeTab>('verify.js');

  const [serverHash, setServerHash] = useState('');
  const [serverSeed, setServerSeed] = useState('');
  const [clientSeedA, setClientSeedA] = useState('');
  const [clientSeedB, setClientSeedB] = useState('');

  const [copySuccess, setCopySuccess] = useState('');
  const [verificationResult, setVerificationResult] = useState<VerificationResult | null>(null);

  const codeFiles: Record<CodeTab, string> = useMemo(
    () => ({
      'index.html': `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <title>Provably Fair Verifier</title>
    <script src="https://cdnjs.cloudflare.com/ajax/libs/crypto-js/4.1.1/crypto-js.min.js"></script>
    <link rel="stylesheet" href="style.css">
</head>
<body>
  <div class="glass-card">...</div>
  <script src="verify.js"></script>
</body>
</html>`,
      'verify.js': `function verify(sHash, sSeed, cA, cB) {
  const calculatedHash = CryptoJS.SHA256(CryptoJS.enc.Hex.parse(sSeed)).toString();
  const isHashValid = calculatedHash.toLowerCase() === sHash.toLowerCase();

  const combinedHex = sSeed + cA + cB;
  const finalHash = CryptoJS.SHA256(CryptoJS.enc.Hex.parse(combinedHex)).toString();
  const firstByte = parseInt(finalHash.substring(0, 2), 16);
  const outcome = firstByte % 2 === 0 ? 'HEADS' : 'TAILS';

  return { isHashValid, outcome, calculatedHash, finalHash };
}`,
      'style.css': `:root {
  --neon: #14F195;
  --bg: #0c0f14;
  --card: #141a21;
  --border: #242d38;
  --text: #8a939f;
}

.glass-card {
  background: var(--card);
  border: 1px solid var(--border);
  border-radius: 12px;
}`,
    }),
    []
  );

  const handleCopy = () => {
    try {
      Clipboard.setString(codeFiles[activeTab]);
      setCopySuccess('COPIED!');
      setTimeout(() => setCopySuccess(''), 2000);
    } catch {
      setCopySuccess('FAILED');
    }
  };

  const handleVerify = () => {
    const sHash = normalizeHex(serverHash);
    const sSeed = normalizeHex(serverSeed);
    const cA = normalizeHex(clientSeedA);
    const cB = normalizeHex(clientSeedB);

    if (!sHash || !sSeed || !cA || !cB) {
      Alert.alert('Missing fields', 'All 4 fields are required for verification.');
      return;
    }

    if (![sHash, sSeed, cA, cB].every(isHex)) {
      Alert.alert('Invalid input', 'All fields must be valid hex strings.');
      return;
    }

    try {
      const calculatedHash = CryptoJS.SHA256(CryptoJS.enc.Hex.parse(sSeed)).toString();
      const isHashValid = calculatedHash.toLowerCase() === sHash.toLowerCase();

      const combinedHex = sSeed + cA + cB;
      const finalHash = CryptoJS.SHA256(CryptoJS.enc.Hex.parse(combinedHex)).toString();
      const firstByte = parseInt(finalHash.slice(0, 2), 16);
      const outcome = firstByte % 2 === 0 ? 'HEADS' : 'TAILS';

      setVerificationResult({
        isHashValid,
        outcome,
        calculatedHash,
        finalHash,
      });
    } catch {
      Alert.alert('Verification error', 'Check if your hex values are valid.');
    }
  };

  return (
    <SafeAreaView style={s.root}>
      <View style={s.topBar}>
        <TouchableOpacity onPress={() => router.push('/')} style={s.backBtn}>
          <Text style={s.backBtnText}>BACK</Text>
        </TouchableOpacity>
        <Text style={s.logo}>VERIFY_GAME</Text>
      </View>

      <ScrollView contentContainerStyle={s.scroll} showsVerticalScrollIndicator={false}>
        <View style={s.editorCard}>
          <View style={s.editorHeader}>
            <View style={s.tabRow}>
              {(['index.html', 'verify.js', 'style.css'] as CodeTab[]).map(tab => (
                <TouchableOpacity
                  key={tab}
                  style={[s.tabBtn, activeTab === tab && s.tabBtnActive]}
                  onPress={() => setActiveTab(tab)}>
                  <Text style={[s.tabBtnText, activeTab === tab && s.tabBtnTextActive]}>
                    {tab}
                  </Text>
                </TouchableOpacity>
              ))}
            </View>
            <TouchableOpacity onPress={handleCopy} style={s.copyBtn}>
              <Text style={s.copyBtnText}>{copySuccess || 'COPY CODE'}</Text>
            </TouchableOpacity>
          </View>

          <View style={s.codeBody}>
            <Text style={s.codeText}>{codeFiles[activeTab]}</Text>
          </View>
        </View>

        <View style={s.previewCard}>
          <View style={s.cardHeader}>
            <View style={s.statusDot} />
            <Text style={s.cardHeaderText}>PROVABLY_FAIR_REVEAL_v2</Text>
          </View>

          <View style={s.inputBox}>
            <Text style={s.inputLabel}>COMMIT_HASH</Text>
            <TextInput
              value={serverHash}
              onChangeText={setServerHash}
              placeholder="0x..."
              placeholderTextColor={C.muted}
              style={s.input}
              autoCapitalize="none"
            />
          </View>

          <View style={s.inputBox}>
            <Text style={s.inputLabel}>REVEAL_SEED</Text>
            <TextInput
              value={serverSeed}
              onChangeText={setServerSeed}
              placeholder="hex_value"
              placeholderTextColor={C.muted}
              style={s.input}
              autoCapitalize="none"
            />
          </View>

          <View style={s.grid2}>
            <View style={s.inputBoxHalf}>
              <Text style={s.inputLabel}>CLIENT_A</Text>
              <TextInput
                value={clientSeedA}
                onChangeText={setClientSeedA}
                placeholder="seed_a"
                placeholderTextColor={C.muted}
                style={s.input}
                autoCapitalize="none"
              />
            </View>

            <View style={s.inputBoxHalf}>
              <Text style={s.inputLabel}>CLIENT_B</Text>
              <TextInput
                value={clientSeedB}
                onChangeText={setClientSeedB}
                placeholder="seed_b"
                placeholderTextColor={C.muted}
                style={s.input}
                autoCapitalize="none"
              />
            </View>
          </View>

          <View style={s.buttonContainer}>
            <View style={s.buttonShadow} />
            <TouchableOpacity
              activeOpacity={0.9}
              style={s.btnCreate}
              onPress={handleVerify}
            >
              <Text style={s.btnCreateText}>execute validation</Text>
            </TouchableOpacity>
          </View>

          {verificationResult && (
            <View
              style={[
                s.resultBox,
                {
                  borderLeftColor: verificationResult.isHashValid ? C.accent : C.danger,
                },
              ]}>
              <Text style={s.resultStatus}>
                STATUS:{' '}
                <Text
                  style={{
                    color: verificationResult.isHashValid ? C.accent : C.danger,
                    fontWeight: '800',
                  }}>
                  {verificationResult.isHashValid ? 'VERIFIED' : 'HASH MISMATCH'}
                </Text>
              </Text>

              <Text style={s.resultOutcome}>
                OUTCOME: <Text style={{ color: C.accent, fontWeight: '900' }}>{verificationResult.outcome}</Text>
              </Text>

              <Text style={s.resultMeta} numberOfLines={1}>
                HASH: {verificationResult.calculatedHash}
              </Text>
              <Text style={s.resultMeta} numberOfLines={1}>
                FINAL: {verificationResult.finalHash}
              </Text>
            </View>
          )}
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
    marginTop: Platform.OS === 'android' ? (StatusBar.currentHeight ?? 0) : 0,
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderBottomWidth: 1,
    borderBottomColor: C.border,
  },
  backBtn: {
    borderWidth: 1,
    borderColor: C.border,
    backgroundColor: C.glass,
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderRadius: 8,
  },
  backBtnText: {
    color: C.text,
    fontFamily: Platform.OS === 'ios' ? 'Courier New' : 'monospace',
    fontWeight: '700',
    letterSpacing: 1,
    fontSize: 11,
  },
  logo: {
    color: C.accent,
    fontFamily: Platform.OS === 'ios' ? 'Courier New' : 'monospace',
    fontWeight: '800',
    letterSpacing: 1.5,
    fontSize: 14,
  },
  scroll: {
    padding: 16,
    gap: 16,
  },
  editorCard: {
    backgroundColor: C.glass,
    borderWidth: 1,
    borderColor: C.border,
    borderRadius: 14,
    overflow: 'hidden',
  },
  editorHeader: {
    borderBottomWidth: 1,
    borderBottomColor: C.border,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: 10,
    gap: 8,
  },
  tabRow: {
    flexDirection: 'row',
    gap: 6,
    flex: 1,
  },
  tabBtn: {
    borderWidth: 1,
    borderColor: C.border,
    borderRadius: 6,
    paddingHorizontal: 8,
    paddingVertical: 6,
    backgroundColor: C.surface,
  },
  tabBtnActive: {
    borderColor: C.accent,
    backgroundColor: C.accent + '22',
  },
  tabBtnText: {
    color: C.muted,
    fontFamily: Platform.OS === 'ios' ? 'Courier New' : 'monospace',
    fontSize: 10,
  },
  tabBtnTextActive: {
    color: C.accent,
    fontWeight: '700',
  },
  copyBtn: {
    borderWidth: 1,
    borderColor: C.accent,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 6,
    backgroundColor: C.accent + '18',
  },
  copyBtnText: {
    color: C.accent,
    fontFamily: Platform.OS === 'ios' ? 'Courier New' : 'monospace',
    fontSize: 10,
    fontWeight: '700',
  },
  codeBody: {
    padding: 12,
    backgroundColor: '#070a0f',
  },
  codeText: {
    color: '#b7c2cf',
    fontSize: 11,
    lineHeight: 17,
    fontFamily: Platform.OS === 'ios' ? 'Courier New' : 'monospace',
  },
  previewCard: {
    backgroundColor: C.glass,
    borderWidth: 1,
    borderColor: C.border,
    borderRadius: 14,
    padding: 16,
  },
  cardHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginBottom: 18,
  },
  statusDot: {
    width: 8,
    height: 8,
    borderRadius: 999,
    backgroundColor: C.accent,
  },
  cardHeaderText: {
    color: C.muted,
    fontSize: 10,
    letterSpacing: 1.2,
    fontFamily: Platform.OS === 'ios' ? 'Courier New' : 'monospace',
  },
  inputBox: {
    marginBottom: 14,
  },
  inputBoxHalf: {
    flex: 1,
  },
  inputLabel: {
    color: C.muted,
    fontSize: 10,
    letterSpacing: 1,
    marginBottom: 6,
    fontFamily: Platform.OS === 'ios' ? 'Courier New' : 'monospace',
  },
  input: {
    borderWidth: 1,
    borderColor: C.border,
    backgroundColor: C.surface,
    color: C.text,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontFamily: Platform.OS === 'ios' ? 'Courier New' : 'monospace',
    fontSize: 12,
  },
  grid2: {
    flexDirection: 'row',
    gap: 10,
    marginBottom: 14,
  },
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
    fontFamily: Platform.OS === 'ios' ? 'Courier New' : 'monospace',
    fontSize: 16,
    color: '#000000',
    fontWeight: '900',
    letterSpacing: -0.5,
    textTransform: 'lowercase',
  },
  resultBox: {
    marginTop: 16,
    borderWidth: 1,
    borderColor: C.border,
    borderLeftWidth: 4,
    backgroundColor: C.surface,
    borderRadius: 10,
    padding: 12,
    gap: 6,
  },
  resultStatus: {
    color: C.text,
    fontFamily: Platform.OS === 'ios' ? 'Courier New' : 'monospace',
    fontSize: 12,
  },
  resultOutcome: {
    color: C.text,
    fontFamily: Platform.OS === 'ios' ? 'Courier New' : 'monospace',
    fontSize: 12,
  },
  resultMeta: {
    color: C.muted,
    fontFamily: Platform.OS === 'ios' ? 'Courier New' : 'monospace',
    fontSize: 10,
  },
});
