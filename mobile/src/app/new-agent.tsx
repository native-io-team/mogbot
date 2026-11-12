/**
 * A new agent, from the phone. One question first, "What should it do?";
 * a name and a colour if you want them (the name otherwise comes from what
 * you wrote, and Create says it before you tap). The Mac makes it with the
 * desk's own create path and engine rule, then its chat opens.
 *
 * On a Mac that serves `agents.templates`, "Start from" offers its
 * ready-made agents: one fills in what it does, its name and colour, and the
 * Mac gives it that template's briefing.
 *
 * On a Mac that drafts (`MAC_FEATURES.draft`) it opens as the desk's New
 * agent does: "Describe the agent you want", one big box and **Draft it**
 * alone (`DescribeFirst`), with the other ways in as quiet links under it:
 * fill it in yourself, start from a ready-made agent, or ask your Chief of
 * Staff. Draft it asks the Mac for the whole agent: name, colour, briefing,
 * routines (each as the Mac's grammar read it) and the apps it will need.
 * The draft fills the form's fields, and one review below them
 * (`DraftReview`) shows the briefing to edit and each routine to keep or
 * leave; Create makes it with what's kept. "Start over" goes back to the
 * box with your words in it. The words are the desk's (`AgentDescribe`).
 *
 * Or hand it to the Chief of Staff: your request goes into the Chief's
 * composer, for you to read and send. That's also all an older Mac offers,
 * since it can't create agents for a phone.
 */

import * as Crypto from 'expo-crypto';
import { useRouter } from 'expo-router';
import {
  boundKeyFor,
  colorwayForColor,
  DESCRIBE_PLACEHOLDER,
  freshColorway,
  iconFor,
  keptRoutines,
  keyLookFor,
  legacyColorFor,
  openingOf,
  MAC_FEATURES,
  type AgentDraft,
  type NewAgentDefaults,
  type RoleTemplateSummary,
} from '@shipstudio/companion-protocol';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { AgentKey } from '../components/AgentKey';
import { DraftReview } from '../components/draftReview';
import { Chip, ChipRow, ColorSwatches, KeyChoices } from '../components/pickers';
import { Button, SheetPage, T } from '../components/ui';
import { SheetTitle } from '../components/SheetTitle';
import { AccentProvider, useAccent } from '../lib/accent';
import { makeStyles, useAppearance, useColors } from '../lib/appearance';
import { setComposer } from '../lib/drafts';
import { haptic } from '../lib/haptics';
import { notChosenBecause } from '../lib/newAgentDefaults';
import {
  chiefOf,
  chiefRequest,
  freeColor,
  MAX_NAME,
  MAX_ROLE,
  suggestAgentName,
  templateColor,
} from '../lib/newAgent';
import { call, canCall, createAgent, describeError } from '../lib/session';
import { useApp, useServed } from '../lib/store';
import { keySize, fonts, lineHeight, radius, space, type } from '../lib/theme';
import { useComputer } from '../lib/computer';

export default function NewAgent() {
  const comp = useComputer();
  const colors = useColors();
  const styles = useStyles();
  const appearance = useAppearance();
  const accent = useAccent();
  const router = useRouter();
  const agents = useApp((s) => s.overview?.agents);
  const engines = useApp((s) => s.overview?.engines);
  const defaults = useApp((s) => s.overview?.defaults ?? null);
  const connected = useApp((s) => s.link.kind === 'connected');
  const macName = useApp((s) => s.credentials?.name) ?? comp.your;
  const canCreate = useApp((s) => canCall('agents.create', s.welcome));
  // The Mac's last answer while it's away; they're fetched once it's back.
  const servesTemplates = useServed('agents.templates');
  const [templates, setTemplates] = useState<RoleTemplateSummary[]>([]);
  const [template, setTemplate] = useState<RoleTemplateSummary | null>(null);
  useEffect(() => {
    if (!servesTemplates || !connected) return;
    let live = true;
    call('agents.templates', {})
      .then((list) => live && setTemplates(list))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [servesTemplates, connected]);
  const chief = chiefOf(agents);
  const taken = useMemo(() => (agents ?? []).map((a) => a.name), [agents]);
  const [role, setRole] = useState('');
  const [name, setName] = useState('');
  const takenColors = useMemo(() => (agents ?? []).map((a) => a.color), [agents]);
  const [plainColor, setPlainColor] = useState(() => freeColor(takenColors));
  // A Mac that keeps keys: a colourway nobody wears yet, a legend read from
  // what it's for and the first free letter of its name, until you pick.
  const keys = useApp((s) => !!s.welcome?.features?.includes(MAC_FEATURES.agentKeys));
  const [colorway, setColorway] = useState(() =>
    freshColorway((agents ?? []).map((a) => keyLookFor(a).colorway))
  );
  const [pickedIcon, setIcon] = useState<string | null>(null);
  const [pickedKey, setBoundKey] = useState<string | null>(null);
  const takenKeys = useMemo(
    () => (agents ?? []).map((a) => keyLookFor(a).boundKey).filter((k): k is string => !!k),
    [agents]
  );
  // The colour old clients and the chat's accent read: the colourway's nearest, on a Mac that keeps keys.
  const color = keys ? legacyColorFor(colorway) : plainColor;
  const setColor = (c: string) => {
    setPlainColor(c);
    setColorway(colorwayForColor(c));
  };
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const clientId = useRef(Crypto.randomUUID());
  // "Describe the agent you want": the Mac drafts the rest, for review here.
  const canDraft = useApp((s) => !!s.welcome?.features?.includes(MAC_FEATURES.draft));
  const [draft, setDraft] = useState<AgentDraft | null>(null);
  const [described, setDescribed] = useState('');
  const [instructions, setInstructions] = useState('');
  const [kept, setKept] = useState<boolean[]>([]);
  const [drafting, setDrafting] = useState(false);
  // It opens on the one box; the form shows once there's a draft, a
  // ready-made agent picked, or "fill it in yourself" (as on the desk).
  const [description, setDescription] = useState('');
  const [manual, setManual] = useState(false);
  // How it looks (colour, icon, key): open while filling it in by hand,
  // folded into the key beside the name once there's a draft to review.
  const [showLook, setShowLook] = useState(true);
  const describing = canDraft && canCreate && !draft && !manual;

  const draftIt = () => {
    const words = description.trim();
    if (words.length < DRAFT_MIN || drafting || !connected) return;
    setDrafting(true);
    setError(null);
    haptic.light();
    call('agents.draft', { description: words })
      .then((d) => {
        haptic.success();
        setDescribed(words);
        setDraft(d);
        setRole(d.role);
        setName(d.name);
        setColor(d.color);
        setInstructions(d.instructions);
        setKept(d.routines.map((r) => !r.problem));
        setTemplate(null);
        setShowLook(false);
      })
      .catch((e: unknown) => {
        haptic.error();
        setError(describeError(e));
      })
      .finally(() => setDrafting(false));
  };

  /** Back to the one box, with what was written in it. */
  const startOver = () => {
    setDescription(described);
    setRole('');
    setName('');
    setDraft(null);
    setInstructions('');
    setKept([]);
    setManual(false);
    setShowLook(true);
    haptic.select();
  };

  /** Another starting point: fields still showing the last one's words (or nothing) take its. */
  const startFrom = (next: RoleTemplateSummary | null) => {
    const untouched = (field: string, from: (t: RoleTemplateSummary) => string) =>
      field.trim() === '' || (template !== null && field === from(template));
    if (untouched(role, (t) => t.role)) setRole(next?.role ?? '');
    if (untouched(name, (t) => t.name)) setName(next?.name ?? '');
    // Its own colour only when nobody wears it, as on the desk.
    if (next) setColor(templateColor(next.color, takenColors) ?? color);
    setTemplate(next);
  };

  const suggested = suggestAgentName(role, taken);
  const finalName = name.trim() || suggested || '';
  const icon = pickedIcon ?? iconFor(finalName, role);
  const boundKey = pickedKey ?? boundKeyFor(finalName, takenKeys);
  const engine = defaultEngineLabel(engines, defaults);
  // On a fallback, why it isn't the engine chosen in Settings.
  const why = defaults && notChosenBecause(defaults);
  const ready = canCreate && connected && !!role.trim() && !!finalName && !busy;

  const create = () => {
    if (!ready) return;
    setBusy(true);
    setError(null);
    haptic.light();
    createAgent(
      {
        name: finalName,
        role: role.trim(),
        color,
        ...(template ? { template: template.id } : {}),
        ...(keys ? { colorway, icon, ...(boundKey ? { boundKey } : {}) } : {}),
        ...(draft
          ? {
              instructions: instructions.trim(),
              routines: keptRoutines(draft, kept),
              ...openingOf(draft),
            }
          : {}),
      },
      clientId.current
    )
      .then((stored) => {
        haptic.success();
        router.replace({ pathname: '/chat/[id]', params: { id: stored.id, compose: '1' } });
      })
      .catch((e: unknown) => {
        haptic.error();
        setError(describeError(e));
        setBusy(false);
      });
  };

  const askChief = () => {
    if (!chief) return;
    setComposer(chief.id, { text: chiefRequest(describing ? description : role, name) });
    haptic.select();
    router.replace({ pathname: '/chat/[id]', params: { id: chief.id, compose: '1' } });
  };

  if (describing) {
    return (
      <DescribeFirst
        text={description}
        onText={setDescription}
        drafting={drafting}
        connected={connected}
        macName={macName}
        error={error}
        onDraft={draftIt}
        onFillIn={() => {
          haptic.select();
          setManual(true);
        }}
        templates={templates}
        onTemplate={(t) => {
          haptic.select();
          startFrom(t);
          setManual(true);
        }}
        onAskChief={chief ? askChief : undefined}
        chiefName={chief?.name}
      />
    );
  }

  return (
    <SheetPage>
      <ScrollView
        contentContainerStyle={styles.root}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="interactive"
      >
        <SheetTitle>New agent</SheetTitle>
        {!canCreate && (
          <T variant="small" color={colors.textSecondary}>
            The app on {macName} needs updating to create agents from this phone. Your Chief of
            Staff can set one up for you.
          </T>
        )}
        {canCreate && templates.length > 0 && !draft && (
          <View style={styles.field}>
            <T variant="subhead" color={colors.textPrimary}>
              Start from
            </T>
            <ChipRow label="Start from">
              <Chip label="Blank" selected={!template} onPress={() => startFrom(null)} />
              {templates.map((t) => (
                <Chip
                  key={t.id}
                  label={t.name}
                  accessibilityLabel={t.title}
                  selected={template?.id === t.id}
                  onPress={() => startFrom(t)}
                />
              ))}
            </ChipRow>
            {template && (
              <T variant="caption" color={colors.textMuted}>
                {template.needs === 'mail'
                  ? `It reads your email through an app connected on ${macName}, such as Gmail. Apps are set up there.`
                  : `It starts with ${macName}’s ready-made briefing for a ${template.title.toLowerCase()}.`}
              </T>
            )}
          </View>
        )}
        {draft && (
          // Where it came from and the way back, first, as on the desk.
          <View style={styles.draftRow}>
            <T variant="caption" color={colors.textMuted} style={styles.draftHint}>
              Drafted from your description. Check it, then Create.
            </T>
            <Button title="Start over" variant="ghost" size="compact" onPress={startOver} />
          </View>
        )}
        <View style={styles.field}>
          <T variant="subhead" color={colors.textPrimary} nativeID="role-label">
            What should it do?
          </T>
          <TextInput
            // A draft is for reading first: no keyboard over the review.
            autoFocus={!draft}
            multiline
            value={role}
            onChangeText={(t) => setRole(t.replace(/\n/g, ' '))}
            maxLength={MAX_ROLE}
            placeholder="Keeps my inbox down to what matters"
            placeholderTextColor={colors.textMuted}
            style={[styles.input, styles.roleInput]}
            selectionColor={accent.accent}
            keyboardAppearance={appearance}
            returnKeyType="next"
            submitBehavior="blurAndSubmit"
            accessibilityLabelledBy="role-label"
            accessibilityLabel="What should it do?"
          />
          {canDraft && canCreate && !draft && (
            // The way back to the one box (what's typed here stays).
            <View style={styles.draftRow}>
              <Button
                title="Or describe it instead"
                variant="ghost"
                size="compact"
                onPress={() => {
                  haptic.select();
                  setManual(false);
                }}
              />
            </View>
          )}
        </View>

        {canCreate && (
          <>
            <View style={styles.identity}>
              {/* The key opens how it looks (colour, icon, key), as the desk's avatar does. */}
              <Pressable
                onPress={() => {
                  haptic.select();
                  setShowLook((open) => !open);
                }}
                accessibilityRole="button"
                accessibilityLabel={showLook ? 'Done changing how it looks' : 'Change how it looks'}
                accessibilityState={{ expanded: showLook }}
                hitSlop={space.xs}
              >
                <AccentProvider color={color}>
                  <AgentKey
                    name={finalName}
                    role={role}
                    color={color}
                    {...(keys ? { colorway, icon } : {})}
                    size={keySize.lg}
                  />
                </AccentProvider>
              </Pressable>
              <TextInput
                value={name}
                onChangeText={setName}
                maxLength={MAX_NAME}
                placeholder={suggested ?? 'Name'}
                placeholderTextColor={colors.textMuted}
                style={[styles.input, styles.nameInput]}
                selectionColor={accent.accent}
                keyboardAppearance={appearance}
                autoCapitalize="words"
                returnKeyType="done"
                onSubmitEditing={create}
                accessibilityLabel="Name"
                accessibilityHint={suggested ? `Leave empty to call it ${suggested}` : undefined}
              />
            </View>
            {!showLook ? null : keys ? (
              <KeyChoices
                name={finalName}
                colorway={colorway}
                icon={icon}
                boundKey={boundKey}
                taken={takenKeys}
                onColorway={setColorway}
                onIcon={setIcon}
                onBoundKey={setBoundKey}
              />
            ) : (
              <ColorSwatches value={color} onChange={setColor} />
            )}
            {draft && (
              <DraftReview
                draft={draft}
                instructions={instructions}
                onInstructions={setInstructions}
                kept={kept}
                onKept={(i, on) => setKept((k) => k.map((v, j) => (j === i ? on : v)))}
              />
            )}
            {engine && (
              <T variant="caption" color={colors.textMuted}>
                Runs on {engine} on {macName}
                {why ? ` (${why})` : ''}, like one made there. You can edit its instructions from
                its agent sheet here; its model and project are set on {comp.the}.
              </T>
            )}
          </>
        )}

        {error && (
          <T variant="small" color={colors.accentErrorLight} accessibilityLiveRegion="polite">
            {error}
          </T>
        )}
        <View style={styles.actions}>
          {canCreate && (
            <AccentProvider color={color}>
              <Button
                title={finalName ? `Create ${finalName}` : 'Create'}
                variant="primary"
                size="large"
                busy={busy}
                disabled={!ready}
                onPress={create}
              />
            </AccentProvider>
          )}
          {chief && !draft && (
            <Button
              title="Ask your Chief of Staff to set it up"
              variant={canCreate ? 'ghost' : 'primary'}
              size={canCreate ? 'default' : 'large'}
              onPress={askChief}
              accessibilityHint={`Writes your request in ${chief.name}’s chat for you to send`}
            />
          )}
        </View>
        {!connected && canCreate && (
          <T variant="caption" color={colors.textSecondary}>
            Creating an agent needs {macName}.
          </T>
        )}
      </ScrollView>
    </SheetPage>
  );
}

/** Shorter than this isn't enough to draft from (the desk's rule). */
const DRAFT_MIN = 8;

/**
 * "Describe the agent you want": the page New agent opens on when the Mac
 * drafts. The box and Draft it alone; the other ways in quiet under it, in
 * the desk's words ("Or fill it in yourself, start from Research, …, or ask
 * your Chief of Staff.").
 */
function DescribeFirst({
  text,
  onText,
  drafting,
  connected,
  macName,
  error,
  onDraft,
  onFillIn,
  templates,
  onTemplate,
  onAskChief,
  chiefName,
}: {
  text: string;
  onText: (t: string) => void;
  drafting: boolean;
  connected: boolean;
  macName: string;
  error: string | null;
  onDraft: () => void;
  onFillIn: () => void;
  templates: RoleTemplateSummary[];
  onTemplate: (t: RoleTemplateSummary) => void;
  onAskChief?: () => void;
  chiefName?: string;
}) {
  const colors = useColors();
  const styles = useStyles();
  const appearance = useAppearance();
  const accent = useAccent();
  const ready = text.trim().length >= DRAFT_MIN && connected && !drafting;
  const link = (label: string, onPress: () => void, hint?: string) => (
    <Text
      onPress={onPress}
      accessibilityRole="link"
      accessibilityHint={hint}
      style={styles.link}
      suppressHighlighting={false}
    >
      {label}
    </Text>
  );
  return (
    <SheetPage>
      <ScrollView
        contentContainerStyle={styles.root}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="interactive"
      >
        <SheetTitle>New agent</SheetTitle>
        <View style={styles.field}>
          <T variant="subhead" color={colors.textPrimary} nativeID="describe-label">
            Describe the agent you want
          </T>
          <TextInput
            autoFocus
            multiline
            value={text}
            onChangeText={onText}
            maxLength={DESCRIBE_MAX}
            placeholder={DESCRIBE_PLACEHOLDER}
            placeholderTextColor={colors.textMuted}
            style={[styles.input, styles.describeInput]}
            selectionColor={accent.accent}
            keyboardAppearance={appearance}
            editable={!drafting}
            accessibilityLabelledBy="describe-label"
            accessibilityLabel="Describe the agent you want"
          />
        </View>
        <View style={styles.actions}>
          {/* The page's one strong button: neutral, never the agent's colour. */}
          <Button
            title={drafting ? 'Drafting…' : 'Draft it'}
            variant="answer"
            size="large"
            busy={drafting}
            disabled={!ready}
            onPress={onDraft}
            accessibilityHint={`${macName} drafts its name, what it does and when it runs, for you to check`}
          />
          <T variant="caption" color={colors.textMuted}>
            {drafting
              ? 'Writing its name, what it does and when it runs. This takes a little while.'
              : 'Its name, what it does and when it runs, for you to check before anything is made.'}
          </T>
        </View>
        {error && (
          <T variant="small" color={colors.accentErrorLight} accessibilityLiveRegion="polite">
            {error}
          </T>
        )}
        {!connected && (
          <T variant="caption" color={colors.textSecondary}>
            Drafting an agent needs {macName}.
          </T>
        )}
        {/* The other ways in, quiet: describing is the one this page leads with. */}
        <T variant="small" color={colors.textSecondary} testID="other-ways">
          Or {link('fill it in yourself', onFillIn)}
          {templates.length > 0 && ', start from '}
          {templates.map((t, i) => (
            <Text key={t.id}>
              {i > 0 && (i === templates.length - 1 ? ' or ' : ', ')}
              {link(t.name, () => onTemplate(t), t.title)}
            </Text>
          ))}
          {onAskChief && (
            <>
              {', or '}
              {link(
                'ask your Chief of Staff',
                onAskChief,
                chiefName ? `Writes your request in ${chiefName}’s chat for you to send` : undefined
              )}
            </>
          )}
          .
        </T>
      </ScrollView>
    </SheetPage>
  );
}

/** As long as the desk's box takes. */
const DESCRIBE_MAX = 4000;

/**
 * The engine a new agent goes on, as the Mac picks it: its defaults for new
 * agents (`startsOn`) when it says, else the rule (`engine::default_for`),
 * Claude Code when ready, else the first that is. Null while unknown, so
 * nothing is claimed about a Mac that hasn't said.
 */
function defaultEngineLabel(
  engines: { id: string; label: string; installed: boolean; signedIn: boolean }[] | undefined,
  defaults: NewAgentDefaults | null
): string | null {
  if (!engines?.length) return null;
  if (defaults) return engines.find((e) => e.id === defaults.startsOn)?.label ?? null;
  const ready = engines.filter((e) => e.installed && e.signedIn);
  return (ready.find((e) => e.id === 'claude') ?? ready[0])?.label ?? null;
}

const useStyles = makeStyles((colors) => ({
  root: { padding: space.lg, paddingTop: space.xl, gap: space.lg, paddingBottom: space['2xl'] },
  field: { gap: space.sm },
  input: {
    fontFamily: fonts.regular,
    fontSize: type.body,
    lineHeight: lineHeight(type.body, 1.35),
    color: colors.textBody,
    backgroundColor: colors.inputFill,
    borderRadius: radius.inner,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.inputBorder,
    paddingHorizontal: space.md,
    paddingVertical: space.md,
  },
  roleInput: { minHeight: 88, textAlignVertical: 'top' },
  describeInput: { minHeight: 160, textAlignVertical: 'top' },
  link: { color: colors.textStrong, textDecorationLine: 'underline' },
  nameInput: { flex: 1, minHeight: 48 },
  identity: { flexDirection: 'row', alignItems: 'center', gap: space.md },
  actions: { gap: space.sm },
  draftRow: { flexDirection: 'row', alignItems: 'center', gap: space.md },
  draftHint: { flex: 1 },
}));

/** A throw while drawing stays on this screen, with the way back. */
export { ScreenError as ErrorBoundary } from '../components/ScreenError';
