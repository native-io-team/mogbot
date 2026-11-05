/**
 * A login card (`request_login`, desktop `agents/logins.rs`): "Recruiter needs
 * your Gmail", which account, what it will be able to do, and the ways in,
 * best first. The token always ends up in the Mac's Keychain. With a Mac
 * that lets the phone sign in (`logins.phone`), the sign-in itself is done
 * here (`phoneWay`): the provider's page in the system sign-in sheet,
 * GitHub's one-time code, or claude.ai opened here. With an older Mac (or a
 * build without the sheet), Connect asks the Mac to start it and the card
 * says "Finish signing in on your Mac — it's open there". The card's
 * `login.flow` arrives with every change, from either device.
 *
 * A password is never asked for. The only field is the key option's, for an
 * API key made for programs, under a secret card's rules: in a ref, wiped on
 * Save, when the app leaves the screen and when the card goes; only over
 * Tailscale to a Mac that proved its identity.
 */

import {
  MAC_FEATURES,
  type Agent,
  type AgentMessage,
  type Approval,
  type LoginOption,
  type LoginRequest,
} from '@shipstudio/companion-protocol';
import * as Clipboard from 'expo-clipboard';
import { type ComponentRef, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, AppState, TextInput, View } from 'react-native';
import { haptic } from '../lib/haptics';
import { useInFlight } from '../lib/once';
import {
  CLAUDE_AI_CONNECTORS,
  hasSignInSheet,
  keyOption,
  openHere,
  phoneDetail,
  phoneWay,
  signInWithSheet,
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
import { useApp, useServed } from '../lib/store';
import { CARD_TITLE_SCALE, fonts, space, type } from '../lib/theme';
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
  const phoneSignIn = useServed('agents.loginPhoneBegin', MAC_FEATURES.loginsPhone);
  const way = (o: LoginOption) => phoneWay(o, phoneSignIn, hasSignInSheet());

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
  const start = (o: LoginOption) => {
    const ids = { agentId: message.agentId, requestId: approval.requestId };
    switch (way(o)) {
      case 'sheet':
        return run(o.id, () => signInWithSheet(ids, o.id), haptic.select);
      case 'web':
        return run(
          o.id,
          async () => {
            await loginStart(ids.agentId, ids.requestId, o.id, true);
            await openHere(CLAUDE_AI_CONNECTORS);
          },
          haptic.select
        );
      case 'device':
        return run(o.id, () => loginStart(ids.agentId, ids.requestId, o.id, true), haptic.select);
      default:
        return run(o.id, () => loginStart(ids.agentId, ids.requestId, o.id), haptic.select);
    }
  };
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

  // Signing in (on the Mac, or here with a code or claude.ai): wait, finish it, or stop it.
  const flow = login.flow;
  const flowOption = flow ? login.options.find((o) => o.id === flow.option) : undefined;
  if (phase === 'onMac') {
    return (
      <Card icon="puzzlepiece" title={title} source={source} testID="login-card">
        <View style={styles.onMac} testID="login-on-mac">
          <ActivityIndicator size="small" color={colors.textMuted} />
          <T variant="small" color={colors.textBody} style={{ flex: 1 }}>
            {onMacLine(login)}
          </T>
        </View>
        {!!flow?.userCode && (
          <View style={styles.code} testID="login-device-code">
            <T variant="caption" color={colors.textMuted}>
              Your code
            </T>
            <T selectable style={styles.codeValue} color={colors.textPrimary}>
              {flow.userCode}
            </T>
          </View>
        )}
        <T variant="small" color={colors.textMuted} maxFontSizeMultiplier={CARD_TITLE_SCALE}>
          {flow?.onPhone
            ? 'Your Mac keeps the sign-in; this phone keeps nothing. This card updates when it’s done.'
            : 'The sign-in and its token stay on your Mac. This card updates when it’s done.'}
        </T>
        {errorLine}
        <CardActions>
          {!!flow?.userCode && (
            <Button
              title="Copy code"
              variant="outline"
              onPress={() => {
                void Clipboard.setStringAsync(flow.userCode ?? '');
                haptic.select();
              }}
              style={ACTION}
            />
          )}
          {!!flow?.onPhone && !!flow.verificationUri && (
            <Button
              title="Open GitHub"
              variant="answer"
              onPress={() => void openHere(flow.verificationUri!).catch((e) => setError(describeError(e)))}
              style={ACTION}
            />
          )}
          {!!flow?.onPhone && flowOption?.method === 'claude_ai' && (
            <Button
              title="Open claude.ai"
              variant="answer"
              onPress={() => void openHere(CLAUDE_AI_CONNECTORS).catch((e) => setError(describeError(e)))}
              style={ACTION}
            />
          )}
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
          {phoneDetail(first, way(first), login.title)}
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
            {phoneDetail(o, way(o), login.title)}
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
  code: { gap: space.tight },
  codeValue: { fontFamily: fonts.mono, fontSize: type.title },
}));
