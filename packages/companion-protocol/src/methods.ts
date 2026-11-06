/**
 * Every request the phone can make, with its params and result.
 *
 * Each `agents.*` method is the Tauri command of the same name
 * (`agents.answerApproval` → `agents_answer_approval`) and takes the same
 * arguments, so the server is a thin router onto `src-tauri/src/commands/agents.rs`.
 * Where a method differs from its command, the comment says how and why.
 */

import type { Cursor } from './frames';
import type { AgentPolicyView } from './policy';
import type {
  AgentMessage,
  AgentReach,
  LoginPhoneBegin,
  TeamLogins,
  AgentSecret,
  AgentsOverview,
  CheckIn,
  Device,
  FileDiff,
  ImportApplied,
  ImportSummary,
  PhoneImportStatus,
  KeptCopy,
  MacStatus,
  MemoryChange,
  MemoryView,
  PasteImportPreview,
  ProjectSummary,
  PushEnvironment,
  RoomView,
  AgentRef,
  PushStatus,
  SchedulePreview,
  SearchHit,
  SessionScreen,
  SharedFile,
  StoredAgent,
  TeamSetupStepId,
  TeamSetupStepState,
  TeamSetupView,
  NewAgentInput,
  NewAgentDefaults,
  AgentIndependence,
  NewAgentDefaultsChange,
  RoleTemplateSummary,
  UpdateAgentInput,
  UsageSummary,
  Quota,
  UsageAccount,
  UsageInventory,
} from './model';

/** A file uploaded with `PUT /v1/blobs`, referenced by id. Replaces a desktop path. */
export interface BlobRef {
  blobId: string;
  name: string;
  mime: string;
  size: number;
}

export interface Methods {
  // ---- The Mac and this device ------------------------------------------
  'system.status': { params: Record<string, never>; result: MacStatus };
  /** This device's own record. Other devices are managed on the Mac only. */
  'devices.self': { params: Record<string, never>; result: Device };
  /** "Forget this Mac" from the phone: revokes this device's token. */
  'devices.unpairSelf': { params: Record<string, never>; result: null };
  /**
   * Hand the Mac this phone's APNs (or FCM) token, or `null` to stop. The Mac
   * registers it with Ship Studio's content-free push relay when its owner
   * has push on, and says where that leaves this phone (docs/push-relay.md).
   * Call on every connect: an unchanged token costs nothing.
   */
  'devices.setPush': {
    params: { token: string | null; environment?: PushEnvironment };
    result: { status: PushStatus };
  };

  // ---- Agents ------------------------------------------------------------
  'agents.overview': { params: Record<string, never>; result: AgentsOverview };
  /**
   * `agents_messages`, plus `before` for scrollback (a message id: the page
   * ending just before it). `asOf` is the event cursor at the moment of the
   * read; see "Events, cursors and resync" in docs/mobile.md for why the
   * merge needs it.
   */
  'agents.messages': {
    params: { agentId: string; limit?: number; before?: string };
    result: { messages: AgentMessage[]; asOf: Cursor; more: boolean };
  };
  /**
   * `agents_send`. Attachments are uploaded first and passed by blob id.
   * `clientId` is required: a send retried after a reconnect with the same
   * `clientId` returns the original message instead of sending twice.
   * Text gets Remote Access's refusal rules (no control characters, no
   * leading `!`, `/` commands from the allowlist only, 20k characters).
   * The message it returns, and its `agents.message` event, carry the same
   * `clientId`, so the phone swaps its optimistic bubble by id.
   */
  'agents.send': {
    params: {
      agentId: string;
      text: string;
      clientId: string;
      attachments?: { blobId: string }[];
      mentions?: string[];
      /**
       * "Ask for changes": the id of the result this message asks to revise.
       * Send only to a Mac whose `welcome.features` has `results.revise`.
       */
      revises?: string;
    };
    result: AgentMessage;
  };
  'agents.stop': { params: { agentId: string }; result: boolean };
  'agents.interrupt': { params: { agentId: string }; result: boolean };
  /** "Stop this step": ends the command the agent is running; its turn carries on. Says what it did. */
  'agents.stopStep': { params: { agentId: string }; result: string };
  /** "Check on it": what the Mac can see of the turn now, in one line. Never interrupts it. */
  'agents.checkOn': { params: { agentId: string }; result: string };
  /** `choice`: on a session's question (`approval.prompt`), the option picked, by index. */
  'agents.answerApproval': {
    params: {
      agentId: string;
      requestId: string;
      allow: boolean;
      always?: boolean;
      note?: string;
      choice?: number;
    };
    result: null;
  };
  /**
   * `agents_save_secret`: a secure input card's values, one per field, into
   * the Mac's Keychain. Only over the Tailscale route (TLS end to end); the
   * audit line names the secret, never a value, and a malformed request is
   * refused without echoing what it carried.
   */
  'agents.saveSecret': {
    params: { agentId: string; requestId: string; values: string[] };
    result: AgentSecret;
  };
  /**
   * Logins (Mac feature `logins`). The token is always made and kept on
   * the Mac; the card's `login.flow` follows the sign-in on both devices.
   * Without `onPhone`, Connect opens the sign-in in the Mac's browser. With
   * `onPhone` (Mac feature `logins.phone`), the sign-in is on the phone:
   * claude.ai there, or GitHub's device code shown in `login.flow`.
   */
  'agents.loginStart': {
    params: { agentId: string; requestId: string; optionId: string; onPhone?: boolean };
    result: null;
  };
  /**
   * Mac feature `logins.phone`: an `oauth` way in, signed in on the phone's
   * sign-in sheet. The Mac registers the companion app's redirect and keeps
   * the PKCE verifier and `state`; the phone gets only the URL to open. One
   * card, or a team row (`key`, `skip`) whose other cards get the same
   * connection.
   */
  'agents.loginPhoneBegin': {
    params:
      | { agentId: string; requestId: string; optionId: string }
      | { key: string; optionId: string; skip?: string[] };
    result: LoginPhoneBegin;
  };
  /**
   * The sheet's redirect, as it came back. Accepted once, within ten
   * minutes, only from the device that began it; exchanged on the Mac, the
   * token kept in its Keychain. Never logged.
   */
  'agents.loginPhoneFinish': {
    params: { flowId: string; callbackUrl: string };
    result: null;
  };
  'agents.loginCancel': { params: { agentId: string; requestId: string }; result: null };
  'agents.loginDecline': {
    params: { agentId: string; requestId: string; note?: string };
    result: null;
  };
  /** A login card's API key (its `key` option), into the Mac's Keychain. As saveSecret. */
  'agents.loginSaveKey': {
    params: { agentId: string; requestId: string; value: string };
    result: AgentSecret;
  };
  /** What an agent can reach: connections, browser, secrets. Read-only. */
  'agents.reach': { params: { agentId: string }; result: AgentReach };
  /** "What it can do" (`agents/policy.rs`): its settings in plain words. Read-only; changed in chat. */
  'agents.policy': { params: { agentId: string }; result: AgentPolicyView };
  /**
   * "What your team needs": every login card waiting, one row per service
   * (Gmail + Calendar as one Google row), with each agent on it; `since`
   * adds the ones answered since then, for "4 of 9 connected".
   */
  'agents.loginsTeam': { params: { since?: number }; result: TeamLogins };
  /** One row's way in, for every agent on it but those in `skip` (agent ids). */
  'agents.loginsConnect': {
    params: { key: string; optionId: string; skip?: string[]; onPhone?: boolean };
    result: null;
  };
  /** "Not needed": the card is put away and the agent isn't woken. */
  'agents.loginDismiss': { params: { agentId: string; requestId: string }; result: null };
  /** `agents_memory`: the agent's `## Memory` entries. */
  'agents.memory': { params: { agentId: string }; result: MemoryView };
  /** `agents_memory_change`: add, edit or delete one entry. */
  'agents.memoryChange': {
    params: { agentId: string; change: MemoryChange };
    result: MemoryView;
  };
  /** `agents_memory_suggest`: "Remember this", the message as one line to edit. */
  'agents.memorySuggest': { params: { text: string }; result: string };
  'agents.revokePermission': { params: { agentId: string; ruleId: string }; result: null };
  /**
   * `agents_focus`, scoped to this device instead of a window. Sent when a
   * chat is on screen with the app in the foreground, and `null` on leaving
   * it. The server also clears it when the connection drops.
   */
  'agents.focus': { params: { agentId: string | null }; result: null };
  'agents.markUnread': { params: { agentId: string }; result: null };
  /**
   * `agents_start_fresh`: its next message starts a new conversation, with
   * its instructions and memory and no recap; the chat stays, with a `fresh`
   * note as a divider. Refused (`expected`) while it's working. Newer Macs
   * only: check `welcome.methods`.
   */
  'agents.startFresh': { params: { agentId: string }; result: StoredAgent };
  /**
   * `agents_create`, from the phone: a name (at most 40 characters), what it
   * should do (one line, at most 500) and a colour; any other field is
   * refused with `bad_params`. It goes on the defaults for new agents
   * (`defaults` in the overview: the chosen engine when ready, else the first
   * engine that is) with the model chosen for that engine, and on the first free colour when none is given.
   * `clientId` makes a retry return the agent the first try made. Newer
   * Macs only: check `welcome.methods`.
   */
  'agents.create': {
    params: {
      input: Pick<NewAgentInput, 'name' | 'role' | 'color' | 'template' | 'avatar'>;
      clientId?: string;
    };
    result: StoredAgent;
  };
  /**
   * From the phone, only the row's toggles (`pinned`, `muted`, `hidden`)
   * and `instructions` (at most 20,000 characters), and from a Mac listing
   * `MAC_FEATURES.looks`, `avatar` and `color`; any other field is refused
   * with `bad_params`. The name, role, model and project stay the desk's.
   */
  'agents.update': { params: { agentId: string; input: UpdateAgentInput }; result: StoredAgent };
  /** The phone asks for confirmation first; the server asks nothing further. */
  'agents.delete': { params: { agentId: string }; result: null };
  'agents.instructions': { params: { agentId: string }; result: string };
  'agents.usage': { params: { agentId: string }; result: UsageSummary };
  /**
   * Each engine's plan as it last reported it (Claude Code's
   * `rate_limit_event`, Codex's `account/rateLimits`), windows already past
   * their reset left out. Empty when no engine has said. Newer Macs only.
   */
  'agents.quota': { params: Record<string, never>; result: Quota[] };
  /**
   * `agents_set_defaults`: what new agents start on (Settings → Agents),
   * read back from `agents.overview`'s `defaults`. Checked as the desk checks
   * it (an engine installed and signed in, a model its engine offers) and
   * audited. Existing agents don't change. Newer Macs only.
   */
  'agents.setDefaults': { params: NewAgentDefaultsChange; result: NewAgentDefaults };
  /**
   * `agents_set_independence`: how much agents do on their own (Settings →
   * Agents), read back from `agents.overview`'s `independence`. Audited.
   * Changes what agents are told on their next turn, never what asks for the
   * user's OK. Newer Macs only.
   */
  'agents.setIndependence': {
    params: { level: AgentIndependence };
    result: { level: AgentIndependence };
  };
  /**
   * `agents_set_admin`: the user's own "Admin — can manage and approve for
   * other agents" switch, per agent. No agent can set it. Audited. Newer
   * Macs only.
   */
  'agents.setAdmin': {
    params: { agentId: string; admin: boolean };
    result: { agentId: string; admin: boolean };
  };
  /**
   * Each engine's usage accounts, in the order turns try them when one
   * reaches its usage limit (`agents::wallet`). Read-only: they are added
   * and signed in on the Mac. Newer Macs only.
   */
  'agents.accounts': { params: Record<string, never>; result: UsageAccount[] };
  /**
   * The capacity inventory: the usage mode, every account with what its
   * engine last reported, other compute, spare windows, estimates from past
   * runs and the spare-capacity list (`agents::inventory`). Read-only on the
   * phone. Newer Macs only.
   */
  'agents.usagePlan': { params: Record<string, never>; result: UsageInventory };
  /**
   * The ready-made agents the phone's New agent sheet offers. `template` on
   * `agents.create` takes one's id, and the Mac fills in its briefing. A Mac
   * that lists this method accepts `template`. Newer Macs only.
   */
  'agents.templates': { params: Record<string, never>; result: RoleTemplateSummary[] };
  'agents.files': { params: { agentId: string }; result: SharedFile[] };
  'agents.changeDiff': {
    params: { agentId: string; messageId: string; path: string };
    result: FileDiff;
  };
  /**
   * "Keep changes" on a change card: the agent's copy merged into the
   * project's current branch. `copyId` is the card's `changes.copy.id`; a
   * copy already kept or discarded is refused.
   */
  'agents.keepCopy': {
    /** `into`: the project's current branch, confirmed after an `otherBranch` answer. */
    params: { agentId: string; copyId: string; into?: string };
    result: KeptCopy;
  };
  /** "Discard" on a change card: the copy and everything in it, gone. */
  'agents.discardCopy': { params: { agentId: string; copyId: string }; result: null };
  /**
   * The phone's stand-in for `agents_open_path` (which opens Finder on the
   * Mac): a path written in an agent's reply, made downloadable. Only paths
   * `files::shareable` accepts for that agent; folders and apps are refused.
   */
  'agents.fetchPath': { params: { agentId: string; path: string }; result: BlobRef };
  'agents.search': { params: { query: string }; result: SearchHit[] };

  'agents.schedule.preview': { params: { when: string }; result: SchedulePreview };
  'agents.schedule.create': {
    params: { agentId: string; when: string; note: string };
    result: CheckIn;
  };
  'agents.schedule.update': {
    /**
     * An empty `when` keeps the schedule and changes only the note, on a Mac
     * whose welcome has `timeZone`; an older one refuses it.
     */
    params: { agentId: string; id: string; when: string; note: string };
    result: CheckIn;
  };
  'agents.schedule.pause': {
    params: { agentId: string; id: string; paused: boolean };
    result: null;
  };
  'agents.schedule.cancel': { params: { agentId: string; id: string }; result: null };
  'agents.schedule.runNow': { params: { agentId: string; id: string }; result: null };

  /** The import over the connector, as the phone follows it. */
  'agents.import.status': { params: Record<string, never>; result: PhoneImportStatus };
  /** Start: one import may begin (it still asks on a card in the Chief's chat). */
  'agents.import.start': { params: Record<string, never>; result: PhoneImportStatus };
  'agents.import.stop': { params: Record<string, never>; result: PhoneImportStatus };
  /**
   * Import from a review card: the agents with these keys, each as a new agent
   * (a taken name comes in as a copy). Replace and the Chief's notes stay on the Mac.
   */
  'agents.import.review': {
    params: { agentId: string; requestId: string; keys: string[] };
    result: ImportApplied;
  };
  /**
   * "Setting up your team" (a Mac whose welcome lists these methods): the
   * checklist, or `null` when there's none to show. `any` brings back one
   * the user put away. Re-read on `agents.registry`: the Mac fires one
   * whenever the checklist may read differently.
   */
  'agents.teamSetup': { params: { any?: boolean }; result: TeamSetupView | null };
  /** Mark a step done or skipped, or open it again. */
  'agents.teamSetup.step': {
    params: { step: TeamSetupStepId; state: TeamSetupStepState };
    result: null;
  };
  /** Switch one of an imported agent's routines on or off. */
  'agents.teamSetup.routine': {
    params: { agentId: string; checkInId: string; on: boolean };
    result: null;
  };
  /**
   * "Say hi": the user's hello to one imported agent, which wakes it. Refused
   * (`expected`) while another is still replying to its hello.
   */
  'agents.teamSetup.hello': { params: { agentId: string }; result: AgentMessage };
  /** Everything the agents said they're missing, to the Chief in one message (the user's). */
  'agents.teamSetup.missing': { params: Record<string, never>; result: AgentMessage };
  /** Put it away; `agents.teamSetup` with `any` brings it back. */
  'agents.teamSetup.dismiss': { params: Record<string, never>; result: null };
  /**
   * A row nothing on the Mac reached: `connect` raises one sign-in card and
   * starts its best way in on the Mac; `not_needed` puts it away.
   */
  'agents.teamSetup.later': {
    params: { key: string; action: 'connect' | 'not_needed'; onPhone?: boolean };
    result: { agentId: string; requestId: string } | null;
  };
  /** Check again what the team can already reach (progress arrives on the checklist). */
  'agents.teamSetup.check': { params: Record<string, never>; result: number };
  'agents.import.pastePrompt': { params: Record<string, never>; result: string };
  'agents.import.pastePreview': { params: { text: string }; result: PasteImportPreview };
  'agents.import.paste': { params: { text: string }; result: ImportSummary };

  // ---- Rooms (a Mac whose welcome.features has `rooms`) --------------------
  'rooms.list': { params: Record<string, never>; result: RoomView[] };
  /** A page of the room's thread, oldest first; `before` for scrollback. */
  'rooms.messages': {
    params: { roomId: string; limit?: number; before?: string };
    result: { messages: AgentMessage[]; asOf: Cursor; more: boolean };
  };
  /**
   * Say something in a room: to the members in `mentions` (agent ids), to
   * everyone, or else to the room's lead. With no mention and no lead it is
   * refused (`validation`, nothing recorded): ask who should answer first.
   * Same text rules and `clientId` retry as `agents.send`.
   */
  'rooms.send': {
    params: {
      roomId: string;
      text: string;
      clientId: string;
      mentions?: string[];
      everyone?: boolean;
    };
    result: { message: AgentMessage; asked: AgentRef[] };
  };
  /** The room on screen (or `null`), like `agents.focus`: its lines aren't unread meanwhile. */
  'rooms.focus': { params: { roomId: string | null }; result: null };

  // ---- Projects and their sessions (Remote Access's handlers) -------------
  'projects.list': { params: Record<string, never>; result: ProjectSummary[] };
  'sessions.read': { params: { sessionId: string }; result: SessionScreen };
  /**
   * Type into an agent tab: the same handler and refusals as Remote Access's
   * `message_agent` (agent tabs only, never shells). Returns once delivered;
   * progress arrives as `projects.changed` events.
   */
  'sessions.send': {
    params: { project: string; sessionId?: string; text: string; clientId: string };
    result: { sessionId: string };
  };
  /** Answer a menu: `press_key`'s rules (a digit only while a question shows). */
  'sessions.key': { params: { sessionId: string; key: string }; result: null };
  /** Remote Access's `start_agent`: a new agent tab that opens on `prompt`. Idempotent by `clientId`. */
  'sessions.start': {
    params: { project: string; prompt: string; clientId: string };
    result: { sessionId: string };
  };
  /** The project's live preview, captured for this phone alone as a private blob. */
  'preview.screenshot': {
    params: { project: string; device: 'desktop' | 'phone' };
    result: BlobRef;
  };
}

export type MethodName = keyof Methods;
export type Params<M extends MethodName> = Methods[M]['params'];
export type Result<M extends MethodName> = Methods[M]['result'];

/** Methods that only read. Not written to the audit log, as in Remote Access. */
export const READ_ONLY_METHODS = [
  'system.status',
  'devices.self',
  'agents.overview',
  'agents.messages',
  'agents.instructions',
  'agents.memory',
  'agents.reach',
  'agents.policy',
  'agents.loginsTeam',
  'agents.usage',
  'agents.quota',
  'agents.accounts',
  'agents.usagePlan',
  'agents.import.status',
  'agents.teamSetup',
  'agents.templates',
  'agents.files',
  'agents.changeDiff',
  'agents.search',
  'agents.schedule.preview',
  'rooms.list',
  'rooms.messages',
  'agents.import.pastePrompt',
  'agents.import.pastePreview',
  'projects.list',
  'sessions.read',
] as const satisfies readonly MethodName[];
