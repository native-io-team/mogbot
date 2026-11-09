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
 * On a Mac that drafts (`MAC_FEATURES.draft`), "What should it do?" takes a
 * sentence or two and **Draft the rest** asks the Mac for the whole agent:
 * name, colour, briefing, routines (each as the Mac's grammar read it) and
 * the apps it will need. The draft fills the same fields, and one review
 * below them (`DraftReview`) shows the briefing to edit and each routine to
 * keep or leave; Create makes it with what's kept. "Start over" puts your
 * words back.
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
import { ScrollView, StyleSheet, TextInput, View } from 'react-native';
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

export default function NewAgent() {
  const colors = useColors();
  const styles = useStyles();
  const appearance = useAppearance();
  const accent = useAccent();
  const router = useRouter();
  const agents = useApp((s) => s.overview?.agents);
  const engines = useApp((s) => s.overview?.engines);
  const defaults = useApp((s) => s.overview?.defaults ?? null);
  const connected = useApp((s) => s.link.kind === 'connected');
  const macName = useApp((s) => s.credentials?.name ?? 'your Mac');
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

  const draftIt = () => {
    const words = role.trim();
    if (!words || drafting || !connected) return;
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
      })
      .catch((e: unknown) => {
        haptic.error();
        setError(describeError(e));
      })
      .finally(() => setDrafting(false));
  };

  const startOver = () => {
    setRole(described);
    setName('');
    setDraft(null);
    setInstructions('');
    setKept([]);
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
    setComposer(chief.id, { text: chiefRequest(role, name) });
    haptic.select();
    router.replace({ pathname: '/chat/[id]', params: { id: chief.id, compose: '1' } });
  };

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
        <View style={styles.field}>
          <T variant="subhead" color={colors.textPrimary} nativeID="role-label">
            What should it do?
          </T>
          <TextInput
            autoFocus
            multiline
            value={role}
            onChangeText={(t) => setRole(t.replace(/\n/g, ' '))}
            maxLength={MAX_ROLE}
            placeholder={
              canDraft && canCreate
                ? 'Describe it: what it does, when, and where its work goes'
                : 'Keeps my inbox down to what matters'
            }
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
            <View style={styles.draftRow}>
              <Button
                title={drafting ? 'Drafting…' : 'Draft the rest'}
                variant="outline"
                size="compact"
                busy={drafting}
                disabled={!role.trim() || !connected || drafting}
                onPress={draftIt}
                accessibilityHint={`${macName} drafts its name, briefing and routines for you to check`}
              />
              <T variant="caption" color={colors.textMuted} style={styles.draftHint}>
                Name, briefing and routines, for you to check.
              </T>
            </View>
          )}
          {draft && (
            <View style={styles.draftRow}>
              <T variant="caption" color={colors.textMuted} style={styles.draftHint}>
                Drafted from what you wrote. Check it, then create.
              </T>
              <Button title="Start over" variant="ghost" size="compact" onPress={startOver} />
            </View>
          )}
        </View>

        {canCreate && (
          <>
            <View style={styles.identity}>
              <AccentProvider color={color}>
                <AgentKey
                  name={finalName}
                  role={role}
                  color={color}
                  {...(keys ? { colorway, icon } : {})}
                  size={keySize.lg}
                />
              </AccentProvider>
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
            {keys ? (
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
                its agent sheet here; its model and project are set on the Mac.
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
          {chief && (
            <Button
              title={`Ask ${chief.name} instead`}
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
  nameInput: { flex: 1, minHeight: 48 },
  identity: { flexDirection: 'row', alignItems: 'center', gap: space.md },
  actions: { gap: space.sm },
  draftRow: { flexDirection: 'row', alignItems: 'center', gap: space.md },
  draftHint: { flex: 1 },
}));

/** A throw while drawing stays on this screen, with the way back. */
export { ScreenError as ErrorBoundary } from '../components/ScreenError';
