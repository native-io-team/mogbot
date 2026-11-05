/** Web QA stand-in for @react-native-community/datetimepicker: a plain block (see metro.config.js). */
import { View } from 'react-native';

export type DateTimePickerEvent = { type: string; nativeEvent: { timestamp: number } };

export default function DateTimePicker() {
  return (
    <View style={{ height: 180, borderRadius: 12, backgroundColor: 'rgba(128,128,128,0.15)' }} />
  );
}

export const DateTimePickerAndroid = { open: () => {}, dismiss: () => {} };
