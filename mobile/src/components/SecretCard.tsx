/**
 * A secure input card (`request_secret`): what the agent wants and why, a
 * masked field per part, Save or Deny. The value goes from these fields to
 * the Mac's Keychain over Tailscale and nowhere else: it lives in a ref (not
 * state, so nothing re-renders holding it), is wiped on Save, when the app
 * leaves the foreground and when the card goes, and never reaches the store,
 * the cache, drafts, the outbox, a notification or a log. The agent is woken
 * with the variable's name, never the value.
 */

import type { Agent, AgentMessage, Approval, SecretRequest } from '@shipstudio/companion-protocol';
import { type ComponentRef, useEffect, useRef, useState } from 'react';
import { AppState, TextInput, View } from 'react-native';
import Animated, { FadeIn, FadeOut } from 'react-native-reanimated';
import { haptic } from '../lib/haptics';
import { useInFlight } from '../lib/once';
import {
  answerApproval,
  currentTransport,
  describeError,
  saveSecret,
  secretRouteProblem,
} from '../lib/session';
import { folderName } from '../lib/agents';
import { useApp } from '../lib/store';
import { CARD_TITLE_SCALE, fonts, space } from '../lib/theme';
import { makeStyles, useAppearance, useColors } from '../lib/appearance';
import { ARM_MS, Receipt, useCardStyles, useArmed } from './ApprovalCard';
import { ACTION, Card, CardActions, OFFLINE_NOTE } from './surfaces';
import { Button, T } from './ui';

/** `$STRIPE_KEY`, or `$BANK_USERNAME, $BANK_PASSWORD`: what the agent gets. */
export const secretVars = (s: Pick<SecretRequest, 'fields'>) =>
  s.fields.map((f) => `$${f.env}`).join(', ');

export function SecretCard({
  message,
  approval,
  request,
  agent,
  onError,
}: {
  message: AgentMessage;
  approval: Approval;
  request: SecretRequest;
  agent: Agent;
  onError: (text: string) => void;
}) {
  const cardStyles = useCardStyles();
  const colors = useColors();
  const styles = useStyles();
  const appearance = useAppearance();
  const pending = approval.status === 'pending';
  const armed = useArmed(pending);
  const link = useApp((s) => s.link);
  // Only that each field has something, never what.
  const [filled, setFilled] = useState<boolean[]>(() => request.fields.map(() => false));
  const [busy, setBusy] = useState<null | 'save' | 'deny'>(null);
  const [error, setError] = useState<string | null>(null);
  const values = useRef<string[]>(request.fields.map(() => ''));
  const inputs = useRef<(ComponentRef<typeof TextInput> | null)[]>([]);
  const route = link.kind === 'connected' ? (currentTransport()?.route ?? null) : null;
  const problem = secretRouteProblem(route, currentTransport()?.identityVerified ?? false);

  const wipe = () => {
    values.current = request.fields.map(() => '');
    inputs.current.forEach((i) => i?.clear());
    setFilled(request.fields.map(() => false));
  };
  // Gone from memory when the card goes, and when the app leaves the screen.
  useEffect(() => {
    const sub = AppState.addEventListener('change', (s) => s !== 'active' && wipe());
    return () => {
      sub.remove();
      values.current = [];
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- wipe only reads refs
  }, []);

  // Save and Deny share one guard: whichever is tapped first is the answer.
  const once = useInFlight();
  const save = () =>
    once(async () => {
      if (!armed || problem || !filled.every(Boolean)) return;
      setBusy('save');
      setError(null);
      try {
        await saveSecret(message.agentId, approval.requestId, [...values.current]);
        wipe();
        haptic.success();
      } catch (e) {
        haptic.error();
        setError(describeError(e));
      } finally {
        setBusy(null);
      }
    });
  const deny = () =>
    once(async () => {
      setBusy('deny');
      try {
        await answerApproval(message.agentId, approval.requestId, false);
        wipe();
        haptic.warning();
      } catch (e) {
        haptic.error();
        onError(describeError(e));
      } finally {
        setBusy(null);
      }
    });

  const outcome =
    approval.status === 'allowed'
      ? `Saved to your Mac’s Keychain · ${agent.name} uses ${secretVars(request)}`
      : approval.status === 'denied'
        ? approval.note
          ? `Declined · “${approval.note}”`
          : `Declined · ${agent.name} was told`
        : 'Not answered';

  if (!pending) {
    return (
      <Receipt
        status={approval.status}
        title={`${agent.name} asked for “${request.name}”`}
        outcome={
          approval.status === 'allowed'
            ? outcome.replace('Saved to your Mac’s Keychain', 'Saved')
            : outcome
        }
      >
        <T variant="small" color={colors.textSecondary}>
          {request.purpose}
        </T>
        {approval.status === 'allowed' && (
          <T variant="small" color={colors.textMuted}>
            In your Mac’s Keychain
          </T>
        )}
      </Receipt>
    );
  }

  const connected = link.kind === 'connected';
  const project = agent.project ? folderName(agent.project) : null;
  const purpose = (
    <T variant="small" color={colors.textBody} maxFontSizeMultiplier={2}>
      {request.purpose}
    </T>
  );

  if (problem) {
    // Nothing can be typed here: say why in the note, and leave Deny where an
    // answer goes (right, its own width). Offline it stays, disabled.
    return (
      <Card
        icon="lock.fill"
        title={`${agent.name} asks for “${request.name}”`}
        source={project ? `For ${agent.name} · in ${project}` : `For ${agent.name}`}
        note={connected ? problem : OFFLINE_NOTE}
        actions={
          <Button
            title="Deny"
            variant="outline"
            busy={busy === 'deny'}
            disabled={!connected || !!busy}
            onPress={() => void deny()}
          />
        }
      >
        {purpose}
      </Card>
    );
  }

  return (
    <Card
      icon="lock.fill"
      title={`${agent.name} asks for “${request.name}”`}
      source={project ? `For ${agent.name} · in ${project}` : `For ${agent.name}`}
    >
      {purpose}
      <Animated.View
        entering={FadeIn.duration(ARM_MS)}
        exiting={FadeOut.duration(120)}
        pointerEvents={armed ? 'auto' : 'none'}
        accessibilityElementsHidden={!armed}
        importantForAccessibility={armed ? 'auto' : 'no-hide-descendants'}
        style={{ gap: space.md }}
      >
        {request.fields.map((field, i) => (
          <View key={field.env} style={{ gap: space.tight }}>
            <T
              variant="small"
              color={colors.textSecondary}
              style={{ fontFamily: fonts.medium }}
              maxFontSizeMultiplier={CARD_TITLE_SCALE}
            >
              {field.label}
            </T>
            <TextInput
              ref={(r) => {
                inputs.current[i] = r;
              }}
              secureTextEntry
              // Not offered to the system's password manager: it would keep a copy.
              textContentType="none"
              autoComplete="off"
              importantForAutofill="no"
              autoCorrect={false}
              autoCapitalize="none"
              spellCheck={false}
              editable={!busy}
              keyboardAppearance={appearance}
              accessibilityLabel={field.label}
              onChangeText={(v) => {
                values.current[i] = v;
                const has = v.trim().length > 0;
                setFilled((f) => (f[i] === has ? f : f.map((x, j) => (j === i ? has : x))));
              }}
              returnKeyType={i === request.fields.length - 1 ? 'done' : 'next'}
              onSubmitEditing={() =>
                i < request.fields.length - 1 ? inputs.current[i + 1]?.focus() : void save()
              }
              placeholderTextColor={colors.textMuted}
              style={[cardStyles.input, styles.secret]}
            />
          </View>
        ))}
        {/* The card's note: what happens to it, before the answers. */}
        <T
          variant="small"
          color={colors.textMuted}
          maxFontSizeMultiplier={CARD_TITLE_SCALE}
          testID="card-note"
        >
          Kept in your Mac’s Keychain for {agent.name} only. It gets {secretVars(request)}, never
          the value, and this phone keeps nothing.
        </T>
        {error && (
          <T variant="small" color={colors.accentErrorLight}>
            {error}
          </T>
        )}
        <CardActions>
          <Button
            title="Deny"
            variant="outline"
            busy={busy === 'deny'}
            disabled={!!busy || link.kind !== 'connected'}
            onPress={() => void deny()}
            style={ACTION}
          />
          <Button
            title="Save"
            // The filled answer is the neutral one on every card, like Allow.
            variant="answer"
            busy={busy === 'save'}
            disabled={!!busy || !filled.every(Boolean)}
            focusable={armed}
            onPress={() => void save()}
            style={ACTION}
          />
        </CardActions>
      </Animated.View>
    </Card>
  );
}

const useStyles = makeStyles(() => ({
  secret: { fontFamily: fonts.mono },
}));
