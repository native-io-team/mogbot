/** The in-app QR scanner. A pairing link goes to the pairing screen, which asks before pairing. */

import { parseLink } from '../lib/pairing';
import { CameraView, useCameraPermissions } from 'expo-camera';
import { useRouter } from 'expo-router';
import { useRef, useState } from 'react';
import { Linking, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Button, IconButton, T } from '../components/ui';
import { haptic } from '../lib/haptics';
import { radius, space } from '../lib/theme';
import { StatusBar } from 'expo-status-bar';
import { makeStyles, useColors } from '../lib/appearance';

export default function Scan() {
  const colors = useColors();
  const styles = useStyles();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const [permission, request] = useCameraPermissions();
  const [wrong, setWrong] = useState(false);
  const done = useRef(false);

  const onScan = ({ data }: { data: string }) => {
    if (done.current) return;
    if (!parseLink(data)) {
      setWrong(true);
      return;
    }
    done.current = true;
    haptic.success();
    router.dismissTo({ pathname: '/pair', params: { link: data } });
  };

  return (
    // Black once the camera is up, as the viewer is: the frame, caption and ×
    // are drawn in media white, and a white page under a camera that hasn't
    // produced a frame yet would hide every one of them.
    <View style={[styles.page, permission?.granted && { backgroundColor: colors.black }]}>
      {permission?.granted ? (
        <>
          <CameraView
            style={StyleSheet.absoluteFill}
            facing="back"
            barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
            onBarcodeScanned={onScan}
          />
          {/* Over the camera, in either appearance: white words, a white clock. */}
          <StatusBar style="light" />
        </>
      ) : (
        <View style={styles.ask}>
          <T variant="title" color={colors.textStrong} accessibilityRole="header">
            Scan the code on your Mac
          </T>
          <T color={colors.textSecondary}>
            The camera is only used to read the pairing code. Nothing is recorded.
          </T>
          {permission && !permission.canAskAgain ? (
            <Button
              title="Open Settings"
              variant="primary"
              onPress={() => void Linking.openSettings()}
            />
          ) : (
            <Button title="Allow camera" variant="primary" onPress={() => void request()} />
          )}
        </View>
      )}
      {permission?.granted && (
        <View pointerEvents="none" style={styles.frameWrap}>
          <View style={styles.frame} />
          <T color={colors.onMedia} style={styles.caption}>
            {wrong
              ? 'That isn’t a pairing code'
              : 'Point at the code in Settings → Phone on your Mac'}
          </T>
        </View>
      )}
      <View style={[styles.close, { top: insets.top + space.sm }]}>
        <IconButton
          name="xmark"
          label="Close"
          color={permission?.granted ? colors.onMedia : colors.textStrong}
          fallback="✕"
          onPress={() => router.back()}
        />
      </View>
    </View>
  );
}

const useStyles = makeStyles((colors) => ({
  page: { flex: 1, backgroundColor: colors.surfaceApp },
  ask: { flex: 1, justifyContent: 'center', padding: space.xl, gap: space.md },
  frameWrap: {
    ...StyleSheet.absoluteFill,
    alignItems: 'center',
    justifyContent: 'center',
    gap: space.xl,
  },
  frame: {
    width: 240,
    height: 240,
    borderRadius: radius.sheet,
    borderWidth: 2,
    borderColor: colors.overlayFrame,
  },
  caption: { textAlign: 'center', paddingHorizontal: space.xl },
  close: { position: 'absolute', right: space.lg },
}));
