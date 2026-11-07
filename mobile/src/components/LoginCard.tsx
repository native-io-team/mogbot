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
 * One way in leads: the access chain's first (`primaryOption`; for Gmail,
 * Use my browser), beside Not now, with one short line saying what it does.
 * Every other way, why there's no connector, and Not needed wait behind
 * "Other ways", each with its full account, so the card is a question and
 * one answer rather than five buttons and three paragraphs.
 *
 * A password is never asked for. The only field is the key option's, for an
 * API key made for programs, under a secret card's rules: in a ref, wiped on
 * Save, when the app leaves the screen and when the card goes; only over
 * Tailscale to a Mac that proved its identity.
 */

import {
  MAC_FEATURES,
  secretTitle,
  type Agent,
  type AgentMessage,
  type Approval,
  type LoginOption,
  type LoginRequest,
} from '@shipstudio/companion-protocol';
import * as Clipboard from 'expo-clipboard';
import { useRouter } from 'expo-router';
import { type ComponentRef, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, AppState, TextInput, View } from 'react-native';
import { haptic } from '../lib/haptics';
import { alsoForLine } from '../lib/teamSetup';
import { useInFlight } from '../lib/once';
import {
  CLAUDE_AI_CONNECTORS,
  hasSignInSheet,
  keyOption,
  openHere,
  phoneDetail,
  phoneLine,
  phoneWay,
  signInWithSheet,
  loginCancel,
  loginDecline,
  loginNotNeeded,
  loginOutcome,
  loginPhase,
  loginStart,
  loginTitle,
  onMacLine,
  otherOptions,
  primaryOption,
  saveLoginKey,
} from '../lib/logins';
import { signinHereLine } from '../lib/signinView';
import { currentTransport, describeError, secretRouteProblem } from '../lib/session';
import { useApp, useServed } from '../lib/store';
import { CARD_TITLE_SCALE, fonts, space, type } from '../lib/theme';
import { makeStyles, useAppearance, useColors } from '../lib/appearance';
import { Receipt, useArmed, useCardStyles } from './ApprovalCard';
import { DeclineReceiptLine, useDeclineReceipt, useRecheckWhenBack } from './loginExtras';
import { ACTION, Card, CardActions, OFFLINE_NOTE, TextAction, useActionShare } from './surfaces';
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
  const [otherWays, setOtherWays] = useState(false);
  const [filled, setFilled] = useState(false);
  const value = useRef('');
  const input = useRef<ComponentRef<typeof TextInput> | null>(null);
  const title = loginTitle(approval, login, agent.name);
  const phoneSignIn = useServed('agents.loginPhoneBegin', MAC_FEATURES.loginsPhone);
  const canDecline = useServed('agents.loginNotNeeded');
  const [receipt, setReceipt] = useDeclineReceipt();
  useRecheckWhenBack(
    login.flow?.state === 'waiting' &&
      login.flow.onPhone === true &&
      login.flow.option === 'claude_ai'
  );
  // The Mac's browser, driven from here: the agents' own (the card's
  // `agent_browser` way in), or the user's Chrome for an older card.
  const signinServed = useServed('agents.signinBegin', MAC_FEATURES.signinPhone);
  const way = (o: LoginOption) => phoneWay(o, phoneSignIn, hasSignInSheet(), signinServed);
  const label = (o: LoginOption) => (way(o) === 'here' ? 'Sign in from here' : o.label);
  const router = useRouter();
  const signinHere = () =>
    router.push({
      pathname: '/signin',
      params: { agentId: message.agentId, requestId: approval.requestId },
    });

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
      case 'here':
        haptic.select();
        return signinHere();
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
    run(
      'decline',
      () => loginDecline(message.agentId, approval.requestId),
      () => {
        wipe();
        haptic.warning();
      }
    );
  const cancel = () => run('cancel', () => loginCancel(message.agentId, approval.requestId));
  const notNeeded = () =>
    run(
      'notNeeded',
      async () => setReceipt(await loginNotNeeded(message.agentId, approval.requestId)),
      () => {
        wipe();
        haptic.select();
      }
    );
  const saveKey = () =>
    run(
      'key',
      () => saveLoginKey(message.agentId, approval.requestId, value.current),
      () => {
        wipe();
        haptic.success();
      }
    );

  // The labels each row will carry, so they share it without cutting one ("Copy co…").
  const signingIn = login.flow;
  const signingInOption = signingIn
    ? login.options.find((o) => o.id === signingIn.option)
    : undefined;
  const onMacShare = useActionShare([
    ...(signingIn?.userCode ? ['Copy code'] : []),
    ...(signingIn?.onPhone && signingIn.verificationUri ? ['Open GitHub'] : []),
    ...(signingIn?.onPhone && signingInOption?.method === 'claude_ai'
      ? ['Open Claude’s connectors']
      : []),
    'Cancel',
  ]);
  const firstOption = primaryOption(login);
  const answerShare = useActionShare([
    'Not now',
    ...(firstOption && firstOption.method !== 'key'
      ? [
          phase === 'failed' && login.flow?.option === firstOption.id
            ? 'Try again'
            : label(firstOption),
        ]
      : []),
  ]);

  if (!pending) {
    return (
      <Receipt
        status={approval.status}
        title={title}
        outcome={loginOutcome(approval, login, agent.name)}
      >
        <T variant="small" color={colors.textSecondary}>
          {login.why}
        </T>
        {receipt && (
          <DeclineReceiptLine receipt={receipt} onDone={() => setReceipt(null)} onError={onError} />
        )}
      </Receipt>
    );
  }

  const source = login.askedAs ? `Asked for “${secretTitle(login.askedAs)}”` : undefined;
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
      {/* Others who asked for the same joined this card: answering it answers them. */}
      {!!alsoForLine(login.alsoFor) && (
        <T variant="caption" color={colors.textMuted} testID="login-also-for">
          {alsoForLine(login.alsoFor)}
        </T>
      )}
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
      <Card icon="lock.fill" title={title} source={source} testID="login-card">
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
            ? 'Your Mac keeps the sign-in; this phone keeps nothing.'
            : 'The sign-in and its token stay on your Mac.'}
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
              style={onMacShare}
            />
          )}
          {!!flow?.onPhone && !!flow.verificationUri && (
            <Button
              title="Open GitHub"
              variant="answer"
              onPress={() =>
                void openHere(flow.verificationUri!).catch((e) => setError(describeError(e)))
              }
              style={onMacShare}
            />
          )}
          {!!flow?.onPhone && flowOption?.method === 'claude_ai' && (
            <Button
              title="Open Claude’s connectors"
              variant="answer"
              onPress={() =>
                void openHere(CLAUDE_AI_CONNECTORS).catch((e) => setError(describeError(e)))
              }
              style={onMacShare}
            />
          )}
          <Button
            title="Cancel"
            variant="outline"
            busy={busy === 'cancel'}
            disabled={!connected || !!busy}
            onPress={() => void cancel()}
            style={onMacShare}
          />
        </CardActions>
      </Card>
    );
  }

  const first = primaryOption(login);
  const others = otherOptions(login);
  const key = keyOption(login);
  const route = connected ? (currentTransport()?.route ?? null) : null;
  const keyProblem = key
    ? secretRouteProblem(route, currentTransport()?.identityVerified ?? false)
    : null;
  const failed = phase === 'failed';
  const connects = !!first && ['oauth', 'claude_ai', 'gh', 'existing'].includes(first.method);
  const off = !connected || !!busy || !armed;
  // The one way in the card leads with; a key is never it (it opens a field).
  const lead = first && first.method !== 'key' ? first : undefined;
  const signinHereExtra =
    signinServed &&
    login.options.some((o) => o.method === 'browser') &&
    !login.options.some((o) => o.method === 'agent_browser');
  const hasOtherWays =
    others.length > 0 ||
    signinHereExtra ||
    (!!lead && !!key && !!login.key) ||
    canDecline ||
    (!!login.noConnector && !connects);
  // A way that failed is shown where its Try again is.
  const showOtherWays =
    otherWays || (failed && !!login.flow && login.flow.option !== lead?.id && hasOtherWays);
  const keyWay = key && login.key && (
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
  );

  return (
    <Card
      icon="lock.fill"
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
      {lead && (
        <T
          variant="small"
          color={colors.textMuted}
          maxFontSizeMultiplier={CARD_TITLE_SCALE}
          testID="login-lead-line"
        >
          {phoneLine(lead, way(lead), login.title)}
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
          style={answerShare}
        />
        {lead && (
          <Button
            title={failed && login.flow?.option === lead.id ? 'Try again' : label(lead)}
            // The affirmative answer is the neutral filled one, never the accent.
            variant="answer"
            busy={busy === lead.id}
            disabled={off}
            onPress={() => void start(lead)}
            style={answerShare}
          />
        )}
      </CardActions>
      {!lead && keyWay}
      {hasOtherWays && (
        <TextAction
          label={showOtherWays ? 'Hide other ways' : 'Other ways'}
          muted
          onPress={() => {
            haptic.select();
            setOtherWays(!showOtherWays);
          }}
        />
      )}
      {showOtherWays && (
        <View style={styles.otherWays} testID="login-other-ways">
          {/* Why there's no connector, only when the card can't lead with one. */}
          {!!login.noConnector && !connects && (
            <T variant="small" color={colors.textMuted} testID="login-no-connector">
              {login.noConnector}
            </T>
          )}
          {others.map((o) => (
            <View key={o.id} style={styles.other}>
              <Button
                title={failed && login.flow?.option === o.id ? `Try again: ${label(o)}` : label(o)}
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
          {signinHereExtra && (
            <View style={styles.other}>
              <Button
                title="Sign in from here"
                variant="outline"
                disabled={off}
                onPress={signinHere}
                testID="login-signin-here"
              />
              <T variant="caption" color={colors.textMuted}>
                {signinHereLine(login.title)}
              </T>
            </View>
          )}
          {lead && keyWay}
          {canDecline && (
            <View style={styles.other}>
              <Button
                title="Not needed"
                variant="outline"
                busy={busy === 'notNeeded'}
                disabled={off}
                onPress={() => void notNeeded()}
                testID="login-not-needed"
              />
              <T variant="caption" color={colors.textMuted}>
                Puts this away for {agent.name}. Nothing gets connected.
              </T>
            </View>
          )}
        </View>
      )}
    </Card>
  );
}

const useStyles = makeStyles(() => ({
  abilities: { gap: space.tight },
  // The spinner beside the first line, not the middle of four.
  onMac: { flexDirection: 'row', alignItems: 'flex-start', gap: space.md },
  other: { gap: space.tight },
  otherWays: { gap: space.md },
  secret: { fontFamily: fonts.mono },
  code: { gap: space.tight },
  codeValue: { fontFamily: fonts.mono, fontSize: type.title },
}));
