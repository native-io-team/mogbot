/**
 * A login card (`request_login`, desktop `agents/logins.rs`): "Hiring needs
 * your Gmail", which account, what it will be able to do, and the ways in,
 * best first. Every way in runs on the Mac: Connect asks the Mac to start it
 * (`agents.loginStart`), the sign-in opens in the Mac's browser and its token
 * stays in the Mac's Keychain, so while it runs this card says "Finish
 * signing in on your Mac — it's open there" with the Mac's live line, and a
 * Cancel. The card's `login.flow` arrives with every change, from either
 * device.
 *
 * A password is never asked for. The only field is the key option's, for an
 * API key made for programs, under a secret card's rules: in a ref, wiped on
 * Save, when the app leaves the screen and when the card goes; only over
 * Tailscale to a Mac that proved its identity.
 */

import type { Agent, AgentMessage, Approval, LoginOption, LoginRequest } from '@shipstudio/companion-protocol';
import { type ComponentRef, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, AppState, TextInput, View } from 'react-native';
import { haptic } from '../lib/haptics';
import { useInFlight } from '../lib/once';
import {
  keyOption,
  loginCancel,
  loginDecline,
  loginOutcome,
  loginPhase,
  loginStart,
  loginTitle,
  onMacLine,
  otherOptions,
  primaryOption,
  saveLoginKey,
} from '../lib/logins';
import { currentTransport, describeError, secretRouteProblem } from '../lib/session';
import { useApp } from '../lib/store';
import { CARD_TITLE_SCALE, fonts, space } from '../lib/theme';
import { makeStyles, useAppearance, useColors } from '../lib/appearance';
import { Receipt, useArmed, useCardStyles } from './ApprovalCard';
import { ACTION, Card, CardActions, OFFLINE_NOTE } from './surfaces';
import { Button, T } from './ui';

export function LoginCard({
  message,
  approval,
  login,
  agent,
  onError,
}: {
  message: AgentMessage;
  approval: Approval;
  login: LoginRequest;
  agent: Agent;
  onError: (text: string) => void;
}) {
  const colors = useColors();
  const styles = useStyles();
  const cardStyles = useCardStyles();
  const appearance = useAppearance();
  const pending = approval.status === 'pending';
  const phase = loginPhase(approval, login);
  const armed = useArmed(pending, phase);
  const connected = useApp((s) => s.link.kind === 'connected');
  const once = useInFlight();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [typing, setTyping] = useState(false);
  const [filled, setFilled] = useState(false);
  const value = useRef('');
  const input = useRef<ComponentRef<typeof TextInput> | null>(null);
  const title = loginTitle(approval, login, agent.name);

  const wipe = () => {
    value.current = '';
    input.current?.clear();
    setFilled(false);
  };
  useEffect(() => {
    const sub = AppState.addEventListener('change', (s) => s !== 'active' && wipe());
    return () => {
      sub.remove();
      value.current = '';
    };
  }, []);

  const run = (tag: string, act: () => Promise<unknown>, done?: () => void) =>
    once(async () => {
      if (!armed && tag !== 'cancel') return;
      setBusy(tag);
      setError(null);
      try {
        await act();
        done?.();
      } catch (e) {
        haptic.error();
        // A failed "Not now" goes where the chat says what failed; the rest stay on the card.
        if (tag === 'decline') onError(describeError(e));
        else setError(describeError(e));
      } finally {
        setBusy(null);
      }
    });
  const start = (o: LoginOption) =>
    run(o.id, () => loginStart(message.agentId, approval.requestId, o.id), haptic.select);
  const decline = () =>
    run('decline', () => loginDecline(message.agentId, approval.requestId), () => {
      wipe();
      haptic.warning();
    });
  const cancel = () => run('cancel', () => loginCancel(message.agentId, approval.requestId));
  const saveKey = () =>
    run(
      'key',
      () => saveLoginKey(message.agentId, approval.requestId, value.current),
      () => {
        wipe();
        haptic.success();
      }
    );

  if (!pending) {
    return (
      <Receipt status={approval.status} title={title} outcome={loginOutcome(approval, login, agent.name)}>
        <T variant="small" color={colors.textSecondary}>
          {login.why}
        </T>
      </Receipt>
    );
  }

  const source = login.askedAs ? `Asked for “${login.askedAs}”` : undefined;
  const why = (
    <T variant="small" color={colors.textBody} maxFontSizeMultiplier={2}>
      {login.why}
    </T>
  );
  const abilities = (
    <View style={styles.abilities} testID="login-abilities">
      {login.abilities.map((a) => (
        <T key={a.id} variant="small" color={colors.textSecondary}>
          {a.id === 'read' ? 'Can: ' : 'And: '}
          {a.label}
        </T>
      ))}
    </View>
  );
  const errorLine = error ? (
    <T variant="small" color={colors.accentErrorLight}>
      {error}
    </T>
  ) : null;

  // Signing in on the Mac: nothing to do here but wait, or stop it.
  if (phase === 'onMac') {
    return (
      <Card icon="puzzlepiece" title={title} source={source} testID="login-card">
        <View style={styles.onMac} testID="login-on-mac">
          <ActivityIndicator size="small" color={colors.textMuted} />
          <T variant="small" color={colors.textBody} style={{ flex: 1 }}>
            {onMacLine(login)}
          </T>
        </View>
        <T variant="small" color={colors.textMuted} maxFontSizeMultiplier={CARD_TITLE_SCALE}>
          The sign-in and its token stay on your Mac. This card updates when it’s done.
        </T>
        {errorLine}
        <CardActions>
          <Button
            title="Cancel"
            variant="outline"
            busy={busy === 'cancel'}
            disabled={!connected || !!busy}
            onPress={() => void cancel()}
            style={ACTION}
          />
        </CardActions>
      </Card>
    );
  }

  const first = primaryOption(login);
  const others = otherOptions(login);
  const key = keyOption(login);
  const route = connected ? (currentTransport()?.route ?? null) : null;
  const keyProblem = key ? secretRouteProblem(route, currentTransport()?.identityVerified ?? false) : null;
  const failed = phase === 'failed';
  const connects = !!first && ['oauth', 'claude_ai', 'gh', 'existing'].includes(first.method);
  const off = !connected || !!busy || !armed;

  return (
    <Card
      icon="puzzlepiece"
      title={title}
      source={source}
      testID="login-card"
      note={!connected ? OFFLINE_NOTE : undefined}
    >
      {why}
      {abilities}
      {failed && (
        <T variant="small" color={colors.accentErrorLight} testID="login-failed">
          {login.flow?.message || 'That didn’t finish on your Mac.'}
        </T>
      )}
      {/* Why there's no connector, only when the card can't lead with one. */}
      {!!login.noConnector && !connects && (
        <T variant="small" color={colors.textMuted} testID="login-no-connector">
          {login.noConnector}
        </T>
      )}
      {first && first.method !== 'key' && (
        <T variant="small" color={colors.textMuted} maxFontSizeMultiplier={CARD_TITLE_SCALE}>
          {first.detail}
        </T>
      )}
      {errorLine}
      <CardActions>
        <Button
          title="Not now"
          variant="outline"
          busy={busy === 'decline'}
          disabled={off}
          onPress={() => void decline()}
          style={ACTION}
        />
        {first && first.method !== 'key' && (
          <Button
            title={failed && login.flow?.option === first.id ? 'Try again' : first.label}
            // The affirmative answer is the neutral filled one, never the accent.
            variant="answer"
            busy={busy === first.id}
            disabled={off}
            onPress={() => void start(first)}
            style={ACTION}
          />
        )}
      </CardActions>
      {others.map((o) => (
        <View key={o.id} style={styles.other}>
          <Button
            title={failed && login.flow?.option === o.id ? `Try again: ${o.label}` : o.label}
            variant="outline"
            busy={busy === o.id}
            disabled={off}
            onPress={() => void start(o)}
          />
          <T variant="caption" color={colors.textMuted}>
            {o.detail}
          </T>
        </View>
      ))}
      {key && login.key && (
        <View style={styles.other}>
          {!typing ? (
            <>
              <Button
                title={key.label}
                variant="ghost"
                disabled={off}
                onPress={() => setTyping(true)}
              />
              <T variant="caption" color={colors.textMuted}>
                {key.detail}
              </T>
            </>
          ) : keyProblem ? (
            <T variant="small" color={colors.textMuted}>
              {keyProblem}
            </T>
          ) : (
            <>
              <T
                variant="small"
                color={colors.textSecondary}
                style={{ fontFamily: fonts.medium }}
                maxFontSizeMultiplier={CARD_TITLE_SCALE}
              >
                {login.key.fields[0]?.label ?? 'API key'}
              </T>
              <TextInput
                ref={input}
                secureTextEntry
                textContentType="none"
                autoComplete="off"
                importantForAutofill="no"
                autoCorrect={false}
                autoCapitalize="none"
                spellCheck={false}
                editable={!busy}
                keyboardAppearance={appearance}
                accessibilityLabel={login.key.fields[0]?.label ?? 'API key'}
                onChangeText={(v) => {
                  value.current = v;
                  setFilled(v.trim().length > 0);
                }}
                onSubmitEditing={() => void saveKey()}
                placeholderTextColor={colors.textMuted}
                style={[cardStyles.input, styles.secret]}
              />
              <T variant="caption" color={colors.textMuted}>
                {key.detail} This phone keeps nothing.
              </T>
              <CardActions>
                <Button
                  title="Cancel"
                  variant="outline"
                  disabled={!!busy}
                  onPress={() => {
                    wipe();
                    setTyping(false);
                  }}
                  style={ACTION}
                />
                <Button
                  title="Save"
                  variant="answer"
                  busy={busy === 'key'}
                  disabled={off || !filled}
                  onPress={() => void saveKey()}
                  style={ACTION}
                />
              </CardActions>
            </>
          )}
        </View>
      )}
    </Card>
  );
}

const useStyles = makeStyles(() => ({
  abilities: { gap: space.tight },
  onMac: { flexDirection: 'row', alignItems: 'center', gap: space.md },
  other: { gap: space.tight },
  secret: { fontFamily: fonts.mono },
}));
