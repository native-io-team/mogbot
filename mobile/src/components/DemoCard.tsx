/**
 * At the top of the Agents and Projects lists while the demo runs: what this
 * is, and the way out to pairing a real Mac. Nothing while paired.
 */

import { useRouter } from 'expo-router';
import { StyleSheet, type StyleProp, type ViewStyle } from 'react-native';
import { isDemo } from '../lib/demo';
import { unpair } from '../lib/session';
import { useApp } from '../lib/store';
import { space } from '../lib/theme';
import { Card } from './surfaces';
import { Button } from './ui';

/** `style` replaces its margins, for a screen that already pads its content. */
export function DemoCard({ style }: { style?: StyleProp<ViewStyle> } = {}) {
  const router = useRouter();
  const demo = useApp((s) => isDemo(s.credentials));
  if (!demo) return null;
  return (
    <Card
      icon="info.circle"
      title="This is the demo"
      testID="demo-card"
      note="Sample agents with made-up work, so you can look around. Nothing here reaches a Mac or anyone else, and nothing is kept."
      style={style ?? styles.card}
      actions={
        <Button
          title="Pair your Mac"
          variant="outline"
          onPress={() => void unpair().then(() => router.replace('/pair'))}
        />
      }
    />
  );
}

const styles = StyleSheet.create({
  card: { marginHorizontal: space.lg, marginBottom: space.md },
});
