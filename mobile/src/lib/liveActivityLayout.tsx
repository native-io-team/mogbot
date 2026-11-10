/**
 * The Live Activity's look (lib/liveActivity.ts says what goes in it and
 * when). SwiftUI through @expo/ui: the function below is turned into a string
 * by the `'widget'` directive at build time and run in the widget extension,
 * so it can use only its props, its environment and @expo/ui's views and
 * modifiers, never anything else in this file. Colours come in as props, from
 * the app's own palette.
 *
 * Loaded only on iOS in a build with the extension (`liveActivityBuilt`).
 */

import { HStack, Image, Spacer, Text, VStack } from '@expo/ui/swift-ui';
import {
  font,
  foregroundStyle,
  lineLimit,
  monospacedDigit,
  padding,
} from '@expo/ui/swift-ui/modifiers';
import { createLiveActivity, type LiveActivityEnvironment } from 'expo-widgets';
import type { WorkActivityProps } from './liveActivity';

const WorkActivity = (props: WorkActivityProps, env: LiveActivityEnvironment) => {
  'widget';
  const light = env.colorScheme === 'light';
  const key = light ? props.colorLight : props.color;
  const warn = light ? props.warnLight : props.warn;
  const state = env.isStale
    ? 'Open the app for the latest'
    : props.needsYou
      ? 'Needs your OK'
      : 'Working…';
  const stateColor = props.needsYou && !env.isStale ? warn : null;
  const clock = props.since
    ? { lower: new Date(props.since), upper: new Date(props.since + 43200000) }
    : null;
  const dot = (
    <Image
      systemName={props.needsYou ? 'exclamationmark.circle.fill' : 'circle.fill'}
      color={props.needsYou ? warn : key}
    />
  );
  const timer = clock ? (
    <Text
      timerInterval={clock}
      countsDown={false}
      modifiers={[monospacedDigit(), foregroundStyle({ type: 'hierarchical', style: 'secondary' })]}
    />
  ) : null;
  const more = props.more > 0 ? `+${props.more} more` : null;
  return {
    banner: (
      <HStack spacing={12} modifiers={[padding({ all: 16 })]}>
        {dot}
        <VStack alignment="leading" spacing={2}>
          <Text modifiers={[font({ weight: 'semibold' }), lineLimit(1)]}>{props.name}</Text>
          <Text
            modifiers={[
              foregroundStyle(stateColor ?? { type: 'hierarchical', style: 'secondary' }),
              lineLimit(1),
            ]}
          >
            {more ? `${state} · ${more}` : state}
          </Text>
        </VStack>
        <Spacer />
        {timer}
      </HStack>
    ),
    compactLeading: dot,
    compactTrailing: props.needsYou ? (
      <Text modifiers={[foregroundStyle(warn)]}>OK?</Text>
    ) : (
      (timer ?? <Text>…</Text>)
    ),
    minimal: dot,
    expandedLeading: (
      <HStack spacing={6}>
        {dot}
        <Text modifiers={[font({ weight: 'semibold' }), lineLimit(1)]}>{props.name}</Text>
      </HStack>
    ),
    expandedTrailing: timer ?? <Text> </Text>,
    expandedBottom: (
      <Text
        modifiers={[
          foregroundStyle(stateColor ?? { type: 'hierarchical', style: 'secondary' }),
          lineLimit(1),
        ]}
      >
        {more ? `${state} · ${more}` : state}
      </Text>
    ),
  };
};

export default createLiveActivity<WorkActivityProps>('WorkActivity', WorkActivity);
