/**
 * Talk: `/talk?id=<agent>`. A hands-free conversation with one agent, from
 * its chat's header (the Chief's too) or the Home Screen's "Talk to …".
 *
 * The loop is `lib/talk.ts` (a pure reducer); this screen only wires it to
 * what already exists: the mic's recognizer (`useDictation`, held, so its own
 * silence rule never ends a turn: the loop's countdown does), `send`, and
 * Listen's voice (`readAloud`). Approvals are never answered here by voice:
 * a card pauses the loop, says so aloud once, and the request opens with a tap.
 */

import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { AppState, Platform, ScrollView, View } from 'react-native';
import { useReducedMotion, useSharedValue } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { keyAccessibleName } from '@shipstudio/companion-protocol';
import { AgentKey } from '../components/AgentKey';
import { Waveform } from '../components/Waveform';
import { Button, IconButton, T } from '../components/ui';
import { AgentAccent, useAccent } from '../lib/accent';
import { announce } from '../lib/a11y';
import { agentKeyState, needsYou, pendingApproval } from '../lib/agents';
import { makeStyles, useColors } from '../lib/appearance';
import { VOICE_LEVEL, dictationHint, listeningNote, useDictation } from '../lib/dictation';
import { haptic } from '../lib/haptics';
import { canReadAloud, readAloud, stopReading, useReading } from '../lib/readAloud';
import { describeError, loadLatest, send, setOpenChat } from '../lib/session';
import { useApp } from '../lib/store';
import {
  approvalSpoken,
  countdownProgress,
  newReplies,
  pauseDetail,
  talkClock,
  talkLines,
  talkReducer,
  talkStart,
  talkStatus,
  type TalkState,
} from '../lib/talk';
import { keySize, radius, space } from '../lib/theme';

const NONE: never[] = [];
/** The clock's step while it listens or counts down. */
const CLOCK_MS = 100;
/** Right after a send the Mac may not yet say the turn began: this long, it counts as working. */
const TURN_GRACE_MS = 4000;

export default function Talk() {
  const params = useLocalSearchParams<{ id?: string }>();
  const id = typeof params.id === 'string' ? params.id : '';
  return (
    <AgentAccent agentId={id}>
      <TalkScreen id={id} />
    </AgentAccent>
  );
}

function TalkScreen({ id }: { id: string }) {
  const styles = useStyles();
  const colors = useColors();
  const accent = useAccent();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const still = useReducedMotion();
  const agent = useApp((s) => s.overview?.agents.find((a) => a.id === id));
  const messages = useApp((s) => s.chats[id]?.messages);
  const team = useApp((s) => s.overview?.agents ?? NONE);
  const macName = useApp((s) => s.mac?.name ?? 'your Mac');
  const name = agent?.name ?? 'The agent';
  const card = pendingApproval(messages);
  const waitingOnYou = Boolean(card) || (agent ? needsYou(agent) : false);
  const agentBusy = agent?.status.state === 'working';

  const [state, dispatch] = useReducer(talkReducer, undefined, () =>
    talkStart(agentBusy, waitingOnYou)
  );
  const stateRef = useRef<TalkState>(state);
  stateRef.current = state;

  // What was in the chat when Talk opened is not read: only what lands after.
  // A chat not loaded yet counts from its first load: its history isn't new.
  const loaded = useApp((s) => Boolean(s.chats[id]?.loaded));
  const seen = useRef<Set<string> | null>(null);
  if (!seen.current && loaded) seen.current = new Set((messages ?? []).map((m) => m.id));
  const connected = useApp((s) => s.link.kind === 'connected');
  useEffect(() => {
    if (id && !loaded && connected) void loadLatest(id).catch(() => {});
  }, [id, loaded, connected]);
  const [since] = useState(() => Date.now());
  const sentAt = useRef(0);
  const repliedSinceSend = useRef(false);

  // ---- Listening ------------------------------------------------------------------
  const level = useSharedValue(0);
  const lastVoiceAt = useRef(0);
  const onLevel = useCallback(
    (l: number) => {
      level.set(l);
      if (l >= VOICE_LEVEL) lastVoiceAt.current = Date.now();
    },
    [level]
  );
  const vocabulary = useMemo(() => team.map((a) => a.name), [team]);
  const getDraft = useCallback(() => '', []);
  const setDraft = useCallback((text: string) => {
    lastVoiceAt.current = Date.now();
    dispatch({ type: 'heard', text });
  }, []);
  const dictation = useDictation({ getDraft, setDraft, vocabulary, onLevel });
  const hint = dictationHint(dictation.support);
  const dictationRef = useRef(dictation);
  dictationRef.current = dictation;

  const hearing = state.phase === 'listening' || state.phase === 'countdown';

  // How a listening session ended, for the loop.
  const handled = useRef(dictation.state);
  useEffect(() => {
    const d = dictation.state;
    if (d === handled.current || d.phase !== 'idle') return;
    handled.current = d;
    if (d.outcome === 'error' && d.problem) dispatch({ type: 'micProblem', problem: d.problem });
    else if (d.outcome === 'done') {
      // The recognizer's own limit ended it while you talked: send what it heard.
      if (d.heard) dispatch({ type: 'sendNow' });
      else dispatch({ type: 'nothingHeard' });
    }
  }, [dictation.state]);

  // Listening: the mic is on whenever the loop is, and only then.
  useEffect(() => {
    if (hint) return;
    if (hearing) {
      if (dictation.phase !== 'idle') return;
      // After the last session's ending has been seen: it may pause the loop.
      const t = setTimeout(() => {
        const s = stateRef.current;
        const d = dictationRef.current;
        if ((s.phase === 'listening' || s.phase === 'countdown') && d.phase === 'idle') {
          lastVoiceAt.current = 0;
          void d.start({ held: true });
        }
      }, 250);
      return () => clearTimeout(t);
    }
    // Sending keeps the words on screen (`send` stops at once); anything else drops them.
    if (dictation.phase !== 'idle') {
      if (state.phase === 'sending') dictation.send();
      else dictation.cancel();
    }
    // `dictation` itself is new every render: its phase is what matters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hearing, state.phase, state.quietRounds, dictation.phase, hint]);

  // The clock: quiet starts the countdown, a voice cancels it, its end sends.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!hearing) return;
    let t: ReturnType<typeof setTimeout>;
    const step = () => {
      const at = Date.now();
      const e = talkClock(stateRef.current, { now: at, lastVoiceAt: lastVoiceAt.current });
      if (e) dispatch(e);
      if (stateRef.current.phase === 'countdown') setNow(at);
      t = setTimeout(step, CLOCK_MS);
    };
    t = setTimeout(step, CLOCK_MS);
    return () => clearTimeout(t);
  }, [hearing]);

  // ---- Sending --------------------------------------------------------------------
  useEffect(() => {
    if (state.phase !== 'sending') return;
    const text = stateRef.current.heard.trim();
    haptic.light();
    sentAt.current = Date.now();
    repliedSinceSend.current = false;
    send(id, text).then(
      () => dispatch({ type: 'sent' }),
      (e: unknown) => {
        haptic.error();
        dispatch({ type: 'sendFailed', message: describeError(e) });
      }
    );
    // Once per send.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.phase]);

  // ---- Replies, the turn and cards ------------------------------------------------
  useEffect(() => {
    const was = seen.current;
    if (!was) return;
    for (const m of newReplies(messages, was)) {
      was.add(m.id);
      repliedSinceSend.current = true;
      dispatch({ type: 'reply', id: m.id });
    }
  }, [messages]);

  const replied = repliedSinceSend.current;
  useEffect(() => {
    if (agentBusy === state.busy) return;
    if (agentBusy) return dispatch({ type: 'busy', busy: true });
    // The Mac says idle. Right after a send that can be before the turn began.
    const wait = replied ? 0 : Math.max(0, sentAt.current + TURN_GRACE_MS - Date.now());
    const t = setTimeout(() => dispatch({ type: 'busy', busy: false }), wait);
    return () => clearTimeout(t);
  }, [agentBusy, state.busy, replied, messages]);

  useEffect(() => {
    dispatch({ type: 'approval', waiting: waitingOnYou });
  }, [waitingOnYou]);

  // ---- Speaking -------------------------------------------------------------------
  const reading = useReading((s) => s.reading);
  const started = useRef<string | null>(null);
  useEffect(() => {
    if (state.phase !== 'speaking' || !state.speaking) return;
    const m = messages?.find((x) => x.id === state.speaking);
    if (started.current === state.speaking) return;
    started.current = state.speaking;
    // No voice in this build: the words are on screen, and the loop goes on.
    if (!m || !readAloud(id, m.id, m.text)) dispatch({ type: 'spoken', id: state.speaking });
  }, [state.phase, state.speaking, messages, id]);
  useEffect(() => {
    const mine = started.current;
    if (!mine) return;
    if (reading?.agentId === id && reading.messageId === mine) return;
    started.current = null;
    dispatch({ type: 'spoken', id: mine });
  }, [reading, id]);
  // Leaving speaking (a tap, a card, a pause, End): stop the voice.
  useEffect(() => {
    if (state.phase === 'speaking') return;
    const r = useReading.getState().reading;
    if (r?.agentId === id && !r.messageId.startsWith('talk-')) {
      started.current = null;
      stopReading();
    }
  }, [state.phase, id]);

  // A card: say it once, aloud, and never answer it by voice.
  const said = useRef(false);
  useEffect(() => {
    if (state.pause !== 'approval') {
      said.current = false;
      return;
    }
    if (said.current) return;
    said.current = true;
    haptic.warning();
    const line = approvalSpoken(name);
    if (!readAloud(id, `talk-approval-${Date.now()}`, line)) announce(line);
  }, [state.pause, id, name]);

  // ---- Interruptions --------------------------------------------------------------
  useEffect(() => {
    // Background only: a permission sheet or Control Center makes it "inactive".
    const sub = AppState.addEventListener('change', (s) => {
      if (s === 'background') {
        dispatch({ type: 'interrupt', reason: 'Talk paused when the app left the screen.' });
      }
    });
    return () => sub.remove();
  }, []);

  // On screen, the agent counts as read, as an open chat does.
  useFocusEffect(
    useCallback(() => {
      if (!id) return;
      setOpenChat(id);
      return () => setOpenChat(null);
    }, [id])
  );

  // Leaving stops everything: the mic (the hook aborts on unmount) and the voice.
  useEffect(
    () => () => {
      if (useReading.getState().reading?.agentId === id) stopReading();
    },
    [id]
  );

  const end = () => {
    haptic.select();
    dispatch({ type: 'end' });
    if (router.canGoBack()) router.back();
    else router.replace('/agents');
  };
  const openCard = () =>
    card && router.push({ pathname: '/request', params: { agent: id, id: card.id } });

  // ---- Drawing --------------------------------------------------------------------
  const status = hint ? 'Talk can’t listen here' : talkStatus(state, name, now);
  const detail = hint
    ? hint
    : (pauseDetail(state) ??
      (hearing ? listeningNote(dictation.via) : null) ??
      (state.phase === 'waiting' ? `Replies are read aloud as they land.` : null));
  const lines = talkLines(messages, since, state.heard);
  const progress = countdownProgress(state, now);
  const silentLine =
    Platform.OS === 'android'
      ? 'Replies play at media volume.'
      : 'On silent, replies show here but aren’t read aloud.';
  const offline = useApp((s) => s.link.kind !== 'connected');

  const action = (() => {
    if (hint) return null;
    switch (state.phase) {
      case 'listening':
        return state.heard.trim()
          ? { title: 'Send now', run: () => dispatch({ type: 'sendNow' }) }
          : null;
      case 'speaking':
        return {
          title: 'Talk now',
          run: () => {
            haptic.select();
            dispatch({ type: 'skip' });
          },
        };
      case 'paused':
        if (state.pause === 'approval') {
          // No card in this phone's copy yet: the chat shows it.
          return card
            ? { title: 'Open the request', run: openCard }
            : { title: 'Open the chat', run: end };
        }
        return {
          title: 'Carry on',
          run: () => {
            haptic.select();
            dispatch({ type: 'resume' });
          },
        };
      default:
        return null;
    }
  })();

  return (
    <View style={[styles.page, { paddingTop: insets.top, paddingBottom: insets.bottom }]}>
      <View style={styles.header}>
        <IconButton name="xmark" label="End Talk" onPress={end} />
        <T variant="headline" color={colors.textStrong} accessibilityRole="header">
          Talk
        </T>
        <View style={styles.headerEnd} />
      </View>

      <View style={styles.middle}>
        <View
          accessible
          accessibilityLabel={agent ? keyAccessibleName(agent.name, agentKeyState(agent)) : name}
          style={styles.who}
        >
          <AgentKey
            id={id}
            name={agent?.name}
            color={agent?.color}
            state={agent ? agentKeyState(agent) : 'idle'}
            size={keySize.xl}
          />
          <T variant="title" color={colors.textStrong} numberOfLines={1}>
            {name}
          </T>
        </View>
        <T
          variant="headline"
          color={state.pause === 'approval' ? colors.textStrong : colors.textSecondary}
          accessibilityLiveRegion="polite"
          style={styles.center}
          testID="talk-status"
        >
          {status}
        </T>
        {!!detail && (
          <T variant="small" color={colors.textSecondary} style={styles.center}>
            {detail}
          </T>
        )}
        <View style={styles.wave}>
          <Waveform
            level={level}
            height={space['2xl']}
            color={hearing ? accent.accent : colors.textMuted}
            fill
          />
        </View>
        {state.phase === 'countdown' && (
          <View style={styles.countdown}>
            {!still && (
              <View style={styles.track}>
                <View
                  style={[
                    styles.fill,
                    { width: `${Math.round(progress * 100)}%`, backgroundColor: accent.accent },
                  ]}
                />
              </View>
            )}
            <View style={styles.row}>
              <Button
                title="Cancel"
                variant="outline"
                onPress={() => {
                  haptic.select();
                  dispatch({ type: 'cancel' });
                  dictation.cancel();
                }}
                style={styles.grow}
              />
              <Button
                title="Send now"
                variant="primary"
                onPress={() => dispatch({ type: 'sendNow' })}
                style={styles.grow}
              />
            </View>
          </View>
        )}
      </View>

      <ScrollView style={styles.lines} contentContainerStyle={styles.linesBody}>
        {lines.map((l) => (
          <View key={l.key} style={styles.line}>
            <T variant="caption" color={colors.textMuted}>
              {l.who === 'you' ? 'You' : name}
            </T>
            <T
              variant="body"
              color={l.key === 'heard' ? colors.textSecondary : colors.textPrimary}
              numberOfLines={4}
            >
              {l.text}
            </T>
          </View>
        ))}
      </ScrollView>

      <View style={styles.foot}>
        {offline && (
          <T variant="caption" color={colors.textSecondary} style={styles.center}>
            {`${macName} is away. What you say waits and goes when it’s back.`}
          </T>
        )}
        {canReadAloud() && (
          <T variant="caption" color={colors.textMuted} style={styles.center}>
            {silentLine}
          </T>
        )}
        {action && state.phase !== 'countdown' && (
          <Button
            title={action.title}
            variant={state.pause === 'approval' ? 'answer' : 'primary'}
            size="large"
            onPress={action.run}
          />
        )}
        <Button title="End" variant="outline" size="large" onPress={end} />
      </View>
    </View>
  );
}

const useStyles = makeStyles((colors) => ({
  page: { flex: 1, backgroundColor: colors.surfaceApp },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: space.sm,
    paddingVertical: space.xs,
  },
  headerEnd: { width: keySize.lg },
  middle: { alignItems: 'center', gap: space.sm, paddingHorizontal: space.xl },
  who: { alignItems: 'center', gap: space.sm, marginTop: space.lg },
  center: { textAlign: 'center' },
  wave: { alignSelf: 'stretch', flexDirection: 'row', height: space['2xl'], marginTop: space.md },
  countdown: { alignSelf: 'stretch', gap: space.md, marginTop: space.sm },
  track: {
    height: space.xs,
    borderRadius: radius.pill,
    backgroundColor: colors.surfaceControl,
    overflow: 'hidden',
  },
  fill: { height: '100%', borderRadius: radius.pill },
  row: { flexDirection: 'row', gap: space.sm },
  grow: { flex: 1 },
  lines: { flex: 1, marginTop: space.lg },
  linesBody: {
    paddingHorizontal: space.xl,
    gap: space.md,
    justifyContent: 'flex-end',
    flexGrow: 1,
  },
  line: { gap: space['2xs'] },
  foot: { paddingHorizontal: space.lg, paddingTop: space.sm, gap: space.sm },
}));

/** A throw while drawing stays on this screen, with the way back. */
export { ScreenError as ErrorBoundary } from '../components/ScreenError';
