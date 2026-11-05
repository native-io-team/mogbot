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
};
const upstream = config.resolver.resolveRequest;
config.resolver.resolveRequest = (context, moduleName, platform) => {
  if (platform === 'web' && WEB_STANDINS[moduleName]) {
    return {
      type: 'sourceFile',
      filePath: path.join(__dirname, 'dev/web', WEB_STANDINS[moduleName]),
    };
  }
  return (upstream ?? context.resolveRequest)(context, moduleName, platform);
};

module.exports = config;
