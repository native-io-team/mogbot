/**
 * A request in the chat, on the shared card (`surfaces.tsx`): what it asks,
 * the exact command, then ⋯ · Deny · Allow with the neutral Allow last, and
 * Always allow (when the desktop offers a scope) one tap away behind ⋯,
 * inert for a beat after it lands. Once answered, the outcome in a line.
 */

import type { Agent, AgentMessage, Approval, ImportProposal } from '@shipstudio/companion-protocol';
import {
  Children,
  createContext,
  useContext,
  useEffect,
  useState,
  type ComponentProps,
  type ReactNode,
} from 'react';
import {
  type LayoutChangeEvent,
  Pressable,
  ScrollView,
  StyleSheet,
  TextInput,
  View,
  useWindowDimensions,
} from 'react-native';
import Animated, { FadeIn, FadeOut, LinearTransition } from 'react-native-reanimated';
import {
  approvalFields,
  capFields,
  cardOutcome,
  describeScope,
  DETAIL_LINES,
  DETAIL_LINES_LARGE,
} from '../lib/agents';
import { haptic } from '../lib/haptics';
import { useInFlight } from '../lib/once';
import { answerApproval, call, describeError } from '../lib/session';
import { useApp } from '../lib/store';
import { fonts, iconSize, radius, space, type, PRESSED } from '../lib/theme';
import { makeStyles, useAppearance, useColors } from '../lib/appearance';
import { choose } from './menu';
import { SettingsChange } from './settingsChange';
import { PlanList } from './planList';
import { ShowAll } from './ShowAll';
import { Card, Line, OFFLINE_NOTE, useActionShare } from './surfaces';
import { Button, Icon, T } from './ui';

/**
 * How long a new card's answers stay inert: the desktop's anti-misclick
 * delay. A card can land under a thumb that was tapping Send or Stop, and
 * Allow is the one tap this app must never take by accident.
 */
export const ARM_MS = 400;

const UNARMED = Symbol('unarmed');

/**
 * Whether a pending card's answers are live yet: false for `ARM_MS` after it
 * lands, and again for `ARM_MS` whenever its `layout` changes (a rotation, a
 * banner, the pin coming or going): a reflow can put a different answer
 * under a thumb that was already moving.
 */
export function useArmed(pending: boolean, layout: string | number | boolean = '') {
  const [armedFor, setArmedFor] = useState<unknown>(UNARMED);
  useEffect(() => {
    if (!pending) return;
    const timer = setTimeout(() => setArmedFor(layout), ARM_MS);
    return () => clearTimeout(timer);
  }, [pending, layout]);
  // Derived in the render that changes the layout: there's no frame where the
  // new layout is live before its beat has passed.
  return pending && armedFor === layout;
}

/**
 * The chat pane a card sits in. A pending card caps its detail by its height,
 * so the question, what it's about and the answers are on screen together: in
 * a short pane (a phone in landscape, the split view) a 12-line diff would
 * otherwise push the question off the top and leave buttons with no context.
 */
export interface Pane {
  /** The list's height (0 when unknown). */
  height: number;
  /** The list's and the pinned question's together: the same whether the pin shows or not. */
  room: number;
  /** The card the chat would pin: the newest pending one. */
  candidate: string | null;
  /** The card whose question the pin is showing now. */
  pinnedId: string | null;
  /** That card says whether it needs the pin (it can't fit whole with its own question). */
  report: (id: string, needsPin: boolean) => void;
}

export const PaneContext = createContext<Pane>({
  height: 0,
  room: 0,
  candidate: null,
  pinnedId: null,
  report: () => {},
});

/**
 * Below this a pane is short (a phone in landscape, the split view): cards go
 * compact, Deny | Allow | ⋯ and nothing under them.
 */
export const SHORT_PANE = 480;

export function useShortPane() {
  const { height } = useContext(PaneContext);
  return height > 0 && height < SHORT_PANE;
}

/** Room kept clear around a fitted card: the list's and the row's padding. */
const FIT_MARGIN = 40;
/** Never squeeze the detail below a couple of lines; past that the pane scrolls as usual. */
const MIN_DETAIL = 48;

/**
 * Measure the card, its head (eyebrow and title) and its detail; while
 * pending, the detail's max height is whatever the pane has left once the
 * rest of the card fits. When even that leaves less than `MIN_DETAIL`, the
 * chat pins the question above the list and the card drops its own head
 * (`pinned`): the pin owns the question, so it's never on screen twice.
 *
 * The decision is made against the card *with* its head and the room the
 * pin and the list share, neither of which the pin changes, so it settles
 * instead of flipping the pin on and off.
 */
export function useFitDetail(pending: boolean, id: string, hasAside = false) {
  const pane = useContext(PaneContext);
  const [card, setCard] = useState(0);
  const [detail, setDetail] = useState(0);
  const [head, setHead] = useState(0);
  const [aside, setAside] = useState(0);
  const candidate = pending && pane.candidate === id;
  const pinned = pending && pane.pinnedId === id;
  const measured = pending && pane.height > 0 && card > 0;
  // The rest of the card with everything it drops while pinned (its head, and
  // an aside such as "It paused here"), whether or not they're drawn now.
  const dropped = head + space.md + (hasAside ? aside + space.md : 0);
  const restFull = card - detail + (pinned ? dropped : 0);
  const needsPin = candidate && measured && pane.room - restFull - FIT_MARGIN < MIN_DETAIL;
  const { report } = pane;
  useEffect(() => report(id, needsPin), [needsPin, id, report]);
  useEffect(() => () => report(id, false), [id, report]);
  const rest = card - detail;
  const maxHeight = measured ? Math.max(MIN_DETAIL, pane.height - rest - FIT_MARGIN) : undefined;
  return {
    onCardLayout: (e: LayoutChangeEvent) => setCard(e.nativeEvent.layout.height),
    onDetailLayout: (e: LayoutChangeEvent) => setDetail(e.nativeEvent.layout.height),
    onHeadLayout: (e: LayoutChangeEvent) => setHead(e.nativeEvent.layout.height),
    onAsideLayout: (e: LayoutChangeEvent) => setAside(e.nativeEvent.layout.height),
    maxHeight,
    /** The chat is showing this card's question in the pin: the card leaves its head out. */
    pinned,
  };
}

/** A card's detail, scrolling inside itself when it has been fitted to the pane. */
export function FittedDetail({
  fit,
  children,
}: {
  fit: ReturnType<typeof useFitDetail>;
  children: ReactNode;
}) {
  const appearance = useAppearance();
  return (
    <ScrollView
      style={{ maxHeight: fit.maxHeight, flexGrow: 0 }}
      onLayout={fit.onDetailLayout}
      nestedScrollEnabled
      scrollEnabled={fit.maxHeight !== undefined}
      showsVerticalScrollIndicator
      indicatorStyle={appearance === 'light' ? 'black' : 'white'}
    >
      {children}
    </ScrollView>
  );
}

/** At this text size the explanation folds away, so the answers stay in reach. */
const LARGE_TEXT = 1.6;

export function ApprovalCard({
  message,
  approval,
  agent,
  onError,
  onAnswered,
  answers = true,
}: {
  message: AgentMessage;
  approval: Approval;
  agent: Agent;
  onError: (text: string) => void;
  /** The Mac took the answer (a card shown outside its own chat resolves here). */
  onAnswered?: (allow: boolean) => void;
  /**
   * False where the screen answers it with its own buttons (Catch up's
   * Allow · Deny under the thumb): the card shows what it asks, never a
   * second pair of answers.
   */
  answers?: boolean;
}) {
  const cardStyles = useCardStyles();
  const colors = useColors();
  const appearance = useAppearance();
  const [busy, setBusy] = useState<null | 'allow' | 'deny' | 'always'>(null);
  const [noting, setNoting] = useState(false);
  const [note, setNote] = useState('');
  const { fontScale } = useWindowDimensions();
  const large = fontScale >= LARGE_TEXT;
  const connected = useApp((s) => s.link.kind === 'connected');
  const pending = approval.status === 'pending';
  const paused = pending && agent.status.state === 'idle';
  const fit = useFitDetail(pending, message.id, paused);
  const compact = useShortPane();
  const armed = useArmed(pending, `${compact}:${fit.pinned}`);
  const once = useInFlight();

  // The haptic says what the Mac did, so it waits for the Mac. One answer at
  // a time: a second tap in the same frame would be refused by the Mac.
  const answer = (allow: boolean, always = false, why?: string) =>
    once(async () => {
      if (!armed) return;
      setBusy(always ? 'always' : allow ? 'allow' : 'deny');
      try {
        await answerApproval(message.agentId, approval.requestId, allow, always, why);
        onAnswered?.(allow);
        if (allow) haptic.success();
        else haptic.warning();
        setNoting(false);
      } catch (error) {
        haptic.error();
        onError(describeError(error));
      } finally {
        setBusy(null);
      }
    });

  const outcome = cardOutcome(approval);
  const scope = approval.always ? describeScope(approval.always, agent.name) : null;
  const off = !!busy || !connected;
  // Behind ⋯: the broader answer, and a denial with a note. One row of
  // answers under the thumb, never a second line of them.
  const more = [
    ...(approval.always
      ? [{ label: `Always allow ${approval.always.label}`, run: () => void answer(true, true) }]
      : []),
    { label: 'Deny with note…', run: () => setNoting(true) },
  ];

  // "<source> sent what it knows": Ignore / Save to memory, nothing else.
  const handoff = !!approval.handoff;
  const consentCard = approval.connector?.kind === 'consent' || !!approval.front || handoff;
  const [denyWord, allowWord] = approval.front
    ? ['Not now', 'Check again']
    : handoff
      ? ['Ignore', 'Save to memory']
      : ['Deny', 'Allow'];
  // Deny and Allow share the row beside ⋯ while both say their word whole.
  const share = useActionShare([denyWord, allowWord], consentCard ? 0 : 44);

  if (!pending) {
    return (
      <Receipt status={approval.status} title={approval.title} outcome={outcome}>
        {!!approval.detail &&
          (approval.connector?.kind === 'consent' ? (
            <T variant="small" color={colors.textSecondary}>
              {approval.detail}
            </T>
          ) : (
            <Summarized approval={approval} lines={12} />
          ))}
      </Receipt>
    );
  }

  const consent = consentCard;
  const actions = noting ? (
    <>
      <Button title="Cancel" variant="outline" onPress={() => setNoting(false)} style={share} />
      <Button
        title="Deny"
        variant="answer"
        busy={busy === 'deny'}
        disabled={!connected}
        onPress={() => void answer(false, false, note)}
        style={share}
      />
    </>
  ) : (
    <Animated.View
      // Inert, and fading in, until armed: a tap meant for something else lands on nothing.
      entering={FadeIn.duration(ARM_MS)}
      exiting={FadeOut.duration(120)}
      pointerEvents={armed ? 'auto' : 'none'}
      accessibilityElementsHidden={!armed}
      importantForAccessibility={armed ? 'auto' : 'no-hide-descendants'}
      style={cardStyles.answers}
    >
      {/*
        Never a second Allow under the thumb: anything broader is a
        deliberate second step, with what it covers spelled out. A consent
        request has nothing to say instead: just Deny.
      */}
      {!consent && (
        <MoreAnswers
          disabled={off || !armed}
          onPress={() => choose(approval.title, more, scope ?? undefined)}
        />
      )}
      <Button
        title={denyWord}
        variant="outline"
        busy={busy === 'deny'}
        disabled={off}
        focusable={armed}
        onPress={() => void answer(false)}
        style={share}
      />
      <Button
        title={allowWord}
        variant="answer"
        busy={busy === 'allow'}
        disabled={off}
        focusable={armed}
        onPress={() => void answer(true)}
        accessibilityHint={approval.detail || undefined}
        style={share}
      />
    </Animated.View>
  );

  return (
    <Card
      icon={
        consent
          ? 'square.and.arrow.down'
          : approval.settings
            ? 'slider.horizontal.3'
            : 'checkmark.shield'
      }
      title={approval.title}
      // Whose and where, as its sibling import card says it.
      source={
        consent && approval.connector
          ? `From ${approval.connector.source} · over Remote access`
          : undefined
      }
      // The pin above the chat shows the question while this can't fit whole.
      hideHead={fit.pinned}
      onLayout={fit.onCardLayout}
      onHeadLayout={fit.onHeadLayout}
      note={
        !connected
          ? OFFLINE_NOTE
          : paused && !fit.pinned && !consent && !approval.settings
            ? 'It paused here for you. Allow it and it picks up where it left off.'
            : undefined
      }
      actions={answers ? actions : undefined}
    >
      {!!approval.detail && (
        <FittedDetail fit={fit}>
          {consent ? (
            // Consent asks in sentences, not a command: prose that wraps.
            <T color={colors.textBody}>{approval.detail}</T>
          ) : (
            <Summarized approval={approval} lines={large ? DETAIL_LINES_LARGE : DETAIL_LINES} />
          )}
        </FittedDetail>
      )}
      {noting && (
        <Animated.View entering={FadeIn.duration(150)}>
          <TextInput
            autoFocus
            value={note}
            onChangeText={setNote}
            maxLength={500}
            placeholder={`Tell ${agent.name} what to do instead`}
            placeholderTextColor={colors.textMuted}
            style={cardStyles.input}
            returnKeyType="send"
            keyboardAppearance={appearance}
            // Return denies with the note, and only once there is one.
            onSubmitEditing={() => note.trim() && void answer(false, false, note)}
          />
        </Animated.View>
      )}
    </Card>
  );
}

/**
 * An admin's batch (desktop `agents/admin.rs`, `bring_to_user`): other
 * agents' requests only you can decide, each answered here for the agent
 * that asked. The card is read live from that agent's chat when the phone
 * has it, else as the Mac sent it, resolving once the Mac takes the answer.
 */
export function DecideCards({
  message,
  onError,
}: {
  message: AgentMessage;
  onError: (text: string) => void;
}) {
  const colors = useColors();
  const chats = useApp((s) => s.chats);
  const agents = useApp((s) => s.overview?.agents);
  const [answered, setAnswered] = useState<Record<string, Approval['status']>>({});
  const items = message.decide ?? [];
  if (items.length === 0) return null;
  return (
    <View style={{ gap: space.sm }}>
      {items.map((item) => {
        const id = item.approval.requestId;
        const live = chats[item.agentId]?.messages.find((m) => m.approval?.requestId === id);
        const base = live?.approval ?? item.approval;
        const approval =
          answered[id] && base.status === 'pending' ? { ...base, status: answered[id] } : base;
        const owner = agents?.find((a) => a.id === item.agentId);
        if (!owner) {
          return (
            <T key={id} variant="small" color={colors.textSecondary}>
              {item.agentName}: {approval.summary ?? approval.title}
            </T>
          );
        }
        const card: AgentMessage = live ?? {
          ...message,
          id: `${message.id}:${id}`,
          agentId: item.agentId,
          kind: 'approval',
          text: '',
          approval,
          decide: undefined,
        };
        return (
          <View key={id} style={{ gap: space['2xs'] }}>
            <T variant="caption" color={colors.textMuted}>
              {item.agentName}
            </T>
            <ApprovalCard
              message={card}
              approval={approval}
              agent={owner}
              onError={onError}
              onAnswered={(allow) =>
                setAnswered((a) => ({ ...a, [id]: allow ? 'allowed' : 'denied' }))
              }
            />
          </View>
        );
      })}
    </View>
  );
}

/**
 * An import's playback (desktop `agents/harvest.rs`): what each agent will do,
 * in plain words, and "Is there anything I'm missing?". Answerable here:
 * "That's everything" brings up the review (which only the Mac imports), and
 * what you add goes to the desk as the card's note, back into the interview.
 */
export function PlaybackCard({
  message,
  approval,
  onError,
}: {
  message: AgentMessage;
  approval: Approval;
  onError: (text: string) => void;
}) {
  const colors = useColors();
  const appearance = useAppearance();
  const cardStyles = useCardStyles();
  const [busy, setBusy] = useState<null | 'done' | 'add'>(null);
  const [adding, setAdding] = useState(false);
  const [addition, setAddition] = useState('');
  const connected = useApp((s) => s.link.kind === 'connected');
  const pending = approval.status === 'pending';
  const armed = useArmed(pending, adding);
  const once = useInFlight();
  const plan = approval.connector?.playback ?? [];
  const source = approval.connector?.source;

  const answer = (done: boolean) =>
    once(async () => {
      if (!armed) return;
      setBusy(done ? 'done' : 'add');
      try {
        await answerApproval(
          message.agentId,
          approval.requestId,
          done,
          false,
          done ? undefined : addition
        );
        haptic.success();
        setAdding(false);
        setAddition('');
      } catch (error) {
        haptic.error();
        onError(describeError(error));
      } finally {
        setBusy(null);
      }
    });

  const lines = plan.map((a) => (
    <View key={a.key} style={{ gap: space['2xs'] }}>
      <T variant="small" color={colors.textPrimary}>
        {a.name}
      </T>
      {a.lines.map((l, i) => (
        <T
          key={i}
          variant="small"
          color={l.kind === 'gap' ? colors.textMuted : colors.textSecondary}
        >
          {`· ${l.text}`}
        </T>
      ))}
    </View>
  ));

  const share = useActionShare(['Add something', 'That’s all']);
  if (!pending) {
    return (
      <Receipt status={approval.status} title={approval.title} outcome={cardOutcome(approval)}>
        {lines}
      </Receipt>
    );
  }
  const off = !!busy || !connected;
  return (
    <Card
      icon="square.and.arrow.down"
      title={approval.title}
      source={source ? `From ${source} · nothing is created yet` : undefined}
      note={!connected ? OFFLINE_NOTE : 'Is there anything I’m missing?'}
      actions={
        <Animated.View
          entering={FadeIn.duration(ARM_MS)}
          pointerEvents={armed ? 'auto' : 'none'}
          style={cardStyles.answers}
        >
          {adding ? (
            <>
              <Button
                title="Cancel"
                variant="outline"
                onPress={() => setAdding(false)}
                style={share}
              />
              <Button
                title="Add this"
                variant="answer"
                busy={busy === 'add'}
                disabled={off || !addition.trim()}
                onPress={() => void answer(false)}
                style={share}
              />
            </>
          ) : (
            <>
              <Button
                title="Add something"
                variant="outline"
                disabled={off}
                onPress={() => setAdding(true)}
                style={share}
              />
              <Button
                title="That’s all"
                variant="answer"
                busy={busy === 'done'}
                disabled={off}
                onPress={() => void answer(true)}
                style={share}
              />
            </>
          )}
        </Animated.View>
      }
    >
      <View style={{ gap: space.sm }}>{lines}</View>
      {adding && (
        <Animated.View entering={FadeIn.duration(150)}>
          <TextInput
            autoFocus
            value={addition}
            onChangeText={setAddition}
            maxLength={500}
            placeholder="Something it does that isn’t here"
            placeholderTextColor={colors.textMuted}
            style={cardStyles.input}
            returnKeyType="send"
            keyboardAppearance={appearance}
            onSubmitEditing={() => addition.trim() && void answer(false)}
          />
        </Animated.View>
      )}
    </Card>
  );
}

/**
 * An import's review card on a Mac that serves `agents.import.review`: each
 * agent with its role and its instructions in view, then Import. From the
 * phone every kept agent comes in new (a name already here arrives as
 * "<Name> (from Grok)"); replacing one of yours, where the diff and every
 * consequence have to be read first, stays on the Mac's card.
 */
export function PhoneReviewCard({
  message,
  approval,
  onError,
}: {
  message: AgentMessage;
  approval: Approval;
  onError: (text: string) => void;
}) {
  const colors = useColors();
  const cardStyles = useCardStyles();
  const [busy, setBusy] = useState<null | 'import' | 'no'>(null);
  const connected = useApp((s) => s.link.kind === 'connected');
  const pending = approval.status === 'pending';
  const armed = useArmed(pending);
  const once = useInFlight();
  const proposals = approval.connector?.review?.proposals ?? [];
  const source = approval.connector?.source;
  // A thorough import: what the other assistant told the Chief, by area,
  // comes in with the agents (as on the Mac's card, ticked there by default).
  const coverage = approval.connector?.review?.coverage;
  const notes = !!coverage && !!approval.connector?.review?.chiefNotes;

  const run = (importing: boolean) =>
    once(async () => {
      if (!armed) return;
      setBusy(importing ? 'import' : 'no');
      try {
        if (importing) {
          await call('agents.import.review', {
            agentId: message.agentId,
            requestId: approval.requestId,
            keys: proposals.map((p) => p.key),
            ...(notes ? { notes: true } : {}),
          });
        } else {
          await answerApproval(message.agentId, approval.requestId, false, false);
        }
        haptic.success();
      } catch (error) {
        haptic.error();
        onError(describeError(error));
      } finally {
        setBusy(null);
      }
    });

  const agents = proposals.map((p) => (
    <View key={p.key} style={{ gap: space['2xs'] }}>
      <T variant="small" color={colors.textPrimary}>
        {p.role ? `${p.name} · ${p.role}` : p.name}
        {p.clash ? ` · comes in as a copy (${p.name} is taken)` : ''}
      </T>
      {!!p.instructions && (
        <T variant="small" color={colors.textSecondary} numberOfLines={8}>
          {p.instructions}
        </T>
      )}
    </View>
  ));

  const importWord =
    proposals.length === 0
      ? 'Save'
      : proposals.length === 1
        ? 'Import 1 agent'
        : `Import ${proposals.length} agents`;
  const share = useActionShare(['Don’t import', importWord]);
  const gathered = (coverage?.areas ?? []).map((a) => (
    <T key={a.area} variant="small" color={a.gap ? colors.textSecondary : colors.textBody}>
      {a.label}:{' '}
      {a.none ? 'none' : a.gap ? (a.facts > 0 ? `${a.facts} · ${a.gap}` : a.gap) : `${a.facts}`}
    </T>
  ));
  if (!pending) {
    return (
      <Receipt status={approval.status} title={approval.title} outcome={cardOutcome(approval)}>
        {/* Not reviewLines: from here a taken name came in as a copy, never a replacement. */}
        {proposals.map((p) => (
          <T key={p.key} variant="small" color={colors.textSecondary}>
            {p.role ? `${p.name} · ${p.role}` : p.name}
          </T>
        ))}
      </Receipt>
    );
  }
  const off = !!busy || !connected;
  return (
    <Card
      icon="square.and.arrow.down"
      title={approval.title}
      source={source ? `From ${source} · nothing is created until you import` : undefined}
      note={
        !connected
          ? OFFLINE_NOTE
          : 'Routines arrive paused and logins are asked for securely. Replacing one of your agents is done on your Mac.'
      }
      actions={
        <Animated.View
          entering={FadeIn.duration(ARM_MS)}
          pointerEvents={armed ? 'auto' : 'none'}
          style={cardStyles.answers}
        >
          <Button
            title="Don’t import"
            variant="outline"
            busy={busy === 'no'}
            disabled={off}
            onPress={() => void run(false)}
            style={share}
          />
          <Button
            title={importWord}
            variant="answer"
            busy={busy === 'import'}
            disabled={off || (proposals.length === 0 && !notes)}
            onPress={() => void run(true)}
            style={share}
          />
        </Animated.View>
      }
    >
      <View style={{ gap: space.sm }}>{agents}</View>
      {gathered.length > 0 && (
        <View style={{ gap: space['2xs'] }}>
          <T variant="small" color={colors.textPrimary}>
            {`What ${source ?? 'it'} told your Chief${notes ? ' (saved when you import)' : ''}`}
          </T>
          {gathered}
          {coverage?.capped && (
            <T variant="small" color={colors.textSecondary}>
              Stopped at the message limit before everything was covered.
            </T>
          )}
        </View>
      )}
    </Card>
  );
}

/**
 * An import's review card (desktop `agents/review.rs`): the agents another
 * assistant proposed. It can't be answered here. Importing means reading
 * each agent's instructions first, and those are on the Mac's card, so this
 * one only says who they are and to go there. No Allow: the Mac refuses one.
 */
export function ReviewOnMacCard({ approval }: { approval: Approval }) {
  const colors = useColors();
  const proposals = approval.connector?.review?.proposals ?? [];
  const agents = reviewLines(proposals);
  if (approval.status !== 'pending') {
    return (
      <Receipt status={approval.status} title={approval.title} outcome={cardOutcome(approval)}>
        {agents.map((line, i) => (
          <T key={i} variant="small" color={colors.textSecondary}>
            {line}
          </T>
        ))}
      </Receipt>
    );
  }
  const source = approval.connector?.source;
  return (
    <Card
      icon="square.and.arrow.down"
      title={approval.title}
      // Not "Needs your OK" here: there's nothing to do on this phone.
      source={source ? `From ${source} · on your Mac` : 'On your Mac'}
      note="Each agent’s instructions are shown on your Mac before anything is created."
    >
      {agents.length > 0 && (
        <View style={{ gap: space['2xs'] }}>
          {agents.map((line, i) => (
            <T key={i} variant="small" color={colors.textSecondary}>
              {line}
            </T>
          ))}
        </View>
      )}
    </Card>
  );
}

/**
 * The agents an import proposes, from the card's own data: "Scout · Research",
 * and "replaces your Scout" where one would take an existing agent's place.
 */
export function reviewLines(proposals: ImportProposal[]): string[] {
  return proposals.map((p) => {
    const who = p.role ? `${p.name} · ${p.role}` : p.name;
    return p.clash ? `${who} · replaces your ${p.clash.name ?? p.name}` : who;
  });
}

type IconName = ComponentProps<typeof Icon>['name'];

/** A receipt's glyph is always its outcome, on every kind of card. */
export const OUTCOME_GLYPH: Record<Exclude<Approval['status'], 'pending'>, IconName> = {
  allowed: 'checkmark',
  denied: 'xmark',
  expired: 'clock',
};

/**
 * A card once it's answered: its outcome as a Line, "✓ Allowed · what it
 * asked", so a finished request doesn't keep the footprint of a live one
 * (three answered secret cards used to take a screen). With something more
 * to show, a tap unfolds what it was about under the line.
 */
export function Receipt({
  status,
  title,
  outcome,
  children,
}: {
  status: Approval['status'];
  title: string;
  /** `cardOutcome`: its first part leads the line, the whole of it shows when open. */
  outcome: string;
  children?: ReactNode;
}) {
  const colors = useColors();
  const cut = outcome.indexOf(' · ');
  const word = cut < 0 ? outcome : outcome.slice(0, cut);
  const rest = cut < 0 ? '' : outcome.slice(cut + 3);
  const glyph = OUTCOME_GLYPH[status === 'pending' ? 'expired' : status];
  const hasDetail = Children.toArray(children).length > 0 || !!rest;
  return (
    <Animated.View entering={FadeIn.duration(200)} layout={LinearTransition.duration(200)}>
      <Line
        icon={glyph}
        tone={status === 'allowed' ? 'success' : undefined}
        lead={word}
        text={title}
        testID="receipt"
        detail={
          hasDetail ? (
            <>
              {children}
              {!!rest && (
                <T variant="small" color={colors.textMuted}>
                  {rest}
                </T>
              )}
            </>
          ) : undefined
        }
      />
    </Animated.View>
  );
}

/** The "⋯" beside Deny | Allow on a compact card: the other answers, in a sheet. */
export function MoreAnswers({ disabled, onPress }: { disabled: boolean; onPress: () => void }) {
  const cardStyles = useCardStyles();
  const colors = useColors();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel="More answers"
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        cardStyles.more,
        pressed && { backgroundColor: colors.surfaceControlHover },
        disabled && { opacity: 0.4 },
      ]}
    >
      <Icon name="ellipsis" size={iconSize.body} color={colors.textStrong} fallback={<T>…</T>} />
    </Pressable>
  );
}

/**
 * What's being approved. A connector tool's input (an email, a record) as
 * labelled fields that wrap, as the desk shows it; anything else is the
 * exact command.
 */
/**
 * The card's plain line first, what and why (the Mac's `summary`), with the
 * exact command folded under Details; a card without one shows its detail.
 */
function Summarized({ approval, lines }: { approval: Approval; lines: number }) {
  const colors = useColors();
  const cardStyles = useCardStyles();
  const [open, setOpen] = useState(false);
  const summary = approval.summary?.trim();
  if (approval.plan) return <PlanList plan={approval.plan} />;
  if (!summary || approvalFields(approval.tool, approval.input)) {
    return <Detail approval={approval} lines={lines} />;
  }
  return (
    <View style={{ gap: space.xs }}>
      <T color={colors.textBody}>{summary}</T>
      {!!approval.detail && (
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ expanded: open }}
          onPress={() => setOpen((v) => !v)}
          hitSlop={{ top: 12, bottom: 12 }}
          // On the summary's own edge: showAll's inset is for a toggle inside a
          // field box, and here it left "Details" hanging off the text.
          style={({ pressed }) => [cardStyles.detailsToggle, pressed && PRESSED]}
        >
          <T variant="caption" color={colors.textSecondary} style={{ fontFamily: fonts.medium }}>
            {open ? 'Hide details' : 'Details'}
          </T>
        </Pressable>
      )}
      {open && <Detail approval={approval} lines={lines} />}
    </View>
  );
}

function Detail({ approval, lines }: { approval: Approval; lines: number }) {
  if (approval.settings) return <SettingsChange proposal={approval.settings} />;
  const fields = approvalFields(approval.tool, approval.input);
  if (!fields) return <Command text={approval.detail} lines={lines} />;
  return <Fields fields={fields} lines={lines} />;
}

/**
 * A connector's input as labelled fields, capped at `lines` with "Show all"
 * (an email body can be pages): Deny · Allow stay under the thumb, and the
 * whole of what you're agreeing to is one tap away.
 */
export function Fields({ fields, lines }: { fields: [string, string][]; lines: number }) {
  const cardStyles = useCardStyles();
  const colors = useColors();
  const [all, setAll] = useState(false);
  const capped = capFields(fields, lines);
  const shown: [string, string, number | undefined][] = all
    ? fields.map(([l, v]) => [l, v, undefined])
    : capped.shown;
  return (
    <View style={cardStyles.cardDetail}>
      <View style={[cardStyles.cardDetailInner, cardStyles.fields]}>
        {shown.map(([label, value, max], i) => (
          <View key={i} style={cardStyles.field}>
            <T variant="caption" color={colors.textSecondary} style={{ fontFamily: fonts.medium }}>
              {label}
            </T>
            <T color={colors.textPrimary} selectable numberOfLines={max}>
              {value}
            </T>
          </View>
        ))}
      </View>
      {capped.clipped && <ShowAll open={all} onPress={() => setAll((v) => !v)} />}
    </View>
  );
}

/**
 * The exact command, never re-wrapped: a line break inside `acme-site`
 * reads as a different path. Long lines scroll sideways instead, and what
 * is selected and copied is the command itself, character for character.
 */
export function Command({ text, lines }: { text: string; lines: number }) {
  const cardStyles = useCardStyles();
  const colors = useColors();
  const [all, setAll] = useState(false);
  // Long commands are never cut silently: past `lines` they say how many
  // more there are, and a tap shows the rest.
  const rows = text.split('\n');
  const long = rows.length > lines;
  const over = long && !all;
  return (
    <View style={cardStyles.cardDetail}>
      <ScrollView
        horizontal
        // Visible, so a line that runs off the edge reads as one to scroll.
        showsHorizontalScrollIndicator
        contentContainerStyle={cardStyles.cardDetailInner}
      >
        <T variant="mono" color={colors.textPrimary} selectable maxFontSizeMultiplier={1.5}>
          {over ? rows.slice(0, lines).join('\n') : text}
        </T>
      </ScrollView>
      {long && (
        <ShowAll
          open={all}
          onPress={() => setAll((v) => !v)}
          label={`Show all ${rows.length} lines`}
        />
      )}
    </View>
  );
}

/** The parts of a request card the shared card doesn't draw: wells, fields, receipts, ⋯. */
export const useCardStyles = makeStyles((colors) => ({
  cardDetail: {
    backgroundColor: colors.surfaceApp,
    borderRadius: radius.inner,
    overflow: 'hidden',
  },
  cardDetailInner: { padding: space.md },
  fields: { gap: space.sm },
  field: { gap: space.xs },
  showAll: { paddingHorizontal: space.md, paddingBottom: space.sm },
  /** "Details" under a summary: on the text's edge, not a field's inset. */
  detailsToggle: { alignSelf: 'flex-start' as const },
  /** ⋯ · Deny · Allow: one row, the affirmative last. */
  answers: { flexDirection: 'row', flexWrap: 'wrap', flexGrow: 1, gap: space.sm },
  /** A task's own menu: each option a full row, then the pair. */
  choices: { flexGrow: 1, flexBasis: '100%', gap: space.sm },
  more: {
    width: 44,
    minHeight: 44,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.control,
    borderWidth: StyleSheet.hairlineWidth * 2,
    borderColor: colors.borderStrong,
  },
  /** Every text field in a card or a sheet: clearly a field, on a panel, in either appearance. */
  input: {
    minHeight: 44,
    fontFamily: fonts.regular,
    fontSize: type.body,
    color: colors.textBody,
    backgroundColor: colors.inputFill,
    borderRadius: radius.inner,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.inputBorder,
    paddingHorizontal: space.md,
    paddingVertical: 0,
    textAlignVertical: 'center',
  },
}));
