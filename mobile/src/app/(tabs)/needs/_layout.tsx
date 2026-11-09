import { Stack } from 'expo-router';
import { useStackOptions } from '../../../lib/navigation';

export default function TabStack() {
  return <Stack screenOptions={useStackOptions()} />;
}
