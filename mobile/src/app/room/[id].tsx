/** One room, full screen (see components/rooms.tsx), in the neutral accent. */

import { useLocalSearchParams } from 'expo-router';
import { RoomScreen } from '../../components/rooms';

export default function Room() {
  const { id } = useLocalSearchParams<{ id: string }>();
  return <RoomScreen id={id} />;
}
