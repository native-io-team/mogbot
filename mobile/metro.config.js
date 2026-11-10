// The wire types live in ../packages/companion-protocol (linked, not published),
// so Metro has to watch that folder too.
const path = require('path');
const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);
config.watchFolders = [path.resolve(__dirname, '../packages/companion-protocol')];

// Web QA only (`pnpm qa:web`, docs/mobile.md "Phone screens without a
// simulator"): native-only modules with no web build are swapped for the
// stand-ins in dev/web. Gated on the web platform, so iOS, Android, Expo Go
// and jest resolve exactly as before.
const WEB_STANDINS = {
  'expo-notifications': 'expo-notifications.ts',
  'expo-secure-store': 'expo-secure-store.ts',
  'expo-symbols': 'expo-symbols.tsx',
  '@react-native-community/datetimepicker': 'datetimepicker.tsx',
  'react-native-keyboard-controller': 'keyboard-controller.tsx',
  'expo-file-system': 'expo-file-system.ts',
  'expo-file-system/legacy': 'expo-file-system-legacy.ts',
  'expo-speech-recognition': 'expo-speech-recognition.ts',
  'expo-speech': 'expo-speech.ts',
};
// Simulator QA only: `QA_SCRIPTED_DICTATION=1 expo start` gives a native
// build the same scripted recognizer, so dictation's states can be looked at
// with no microphone and no sound (the simulator's own recognizer doesn't
// start anyway, docs/mobile.md "Dictation"). Unset, nothing changes.
const SCRIPTED_DICTATION = process.env.QA_SCRIPTED_DICTATION === '1';
// The agent keys' icon pack (docs/internal/agent-keys.md, "The icon pack"):
// the desk loads it with import(), which Metro doesn't split into its own
// bundles, so here its loaders are plain requires of each drawings file,
// evaluated the first time one is needed. Every platform.
const PACK_SHARDS = path.resolve(
  __dirname,
  '../packages/companion-protocol/src/agentKeyPackShards.require.ts'
);
const upstream = config.resolver.resolveRequest;
config.resolver.resolveRequest = (context, moduleName, platform) => {
  if (
    moduleName === './agentKeyPackShards' &&
    context.originModulePath.includes('companion-protocol')
  ) {
    return { type: 'sourceFile', filePath: PACK_SHARDS };
  }
  if (
    (platform === 'web' || (SCRIPTED_DICTATION && moduleName === 'expo-speech-recognition')) &&
    WEB_STANDINS[moduleName]
  ) {
    return {
      type: 'sourceFile',
      filePath: path.join(__dirname, 'dev/web', WEB_STANDINS[moduleName]),
    };
  }
  return (upstream ?? context.resolveRequest)(context, moduleName, platform);
};

module.exports = config;
