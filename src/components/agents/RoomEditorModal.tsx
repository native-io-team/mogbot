/**
 * New room, and a room's members and name: pick two to six agents, name it
 * if you like (it's called after its members until you do), and choose who
 * answers when nobody is mentioned. Removing an agent from a room never
 * touches the agent.
 *
 * @module components/agents/RoomEditorModal
 */

import { useMemo, useState } from 'react';
import { ModalFrame } from '../primitives/ModalFrame';
import { Button } from '../primitives/Button';
import { Checkbox } from '../primitives/Checkbox';
import { TextField } from '../primitives/TextField';
import { SegmentedControl } from '../primitives/SegmentedControl';
import { AgentAvatar } from './AgentAvatar';
import { sortAgents, type Agent } from '../../lib/agents';
import {
  createRoom,
  defaultRoomName,
  MAX_ROOM_MEMBERS,
  MIN_ROOM_MEMBERS,
  updateRoom,
  type Room,
} from '../../lib/agentRooms';
import { asCommandError, formatCommandError } from '../../lib/errors';

interface RoomEditorModalProps {
  isOpen: boolean;
  /** Absent: a new room. */
  room: Room | null;
  agents: Agent[];
  onClose: () => void;
  onSaved: (room: Room) => void;
}

const NOBODY = '';

export function RoomEditorModal({ isOpen, room, agents, onClose, onSaved }: RoomEditorModalProps) {
  const team = useMemo(
    () => sortAgents(agents).filter((a) => !a.hidden || room?.members.includes(a.id)),
    [agents, room]
  );
  const [picked, setPicked] = useState<string[]>(() => room?.members ?? []);
  const [name, setName] = useState(room?.name ?? '');
  const [lead, setLead] = useState<string>(() => room?.lead ?? NOBODY);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const chosen = team.filter((a) => picked.includes(a.id));
  const full = picked.length >= MAX_ROOM_MEMBERS;
  const enough = picked.length >= MIN_ROOM_MEMBERS;
  // A new room's lead is the Chief when it's in, as the backend does.
  const leadNow = picked.includes(lead)
    ? lead
    : room
      ? NOBODY
      : (chosen.find((a) => a.isMain)?.id ?? NOBODY);
  const placeholder = defaultRoomName(chosen.map((a) => a.name));

  const toggle = (id: string, on: boolean) =>
    setPicked((list) => (on ? [...list, id] : list.filter((x) => x !== id)));

  const save = async () => {
    if (!enough) return;
    setSaving(true);
    setError(null);
    try {
      const saved = room
        ? await updateRoom(room.id, {
            name: name.trim() || placeholder,
            members: picked,
            lead: leadNow || null,
          })
        : await createRoom(picked, name).then((created) =>
            leadNow !== (created.lead ?? NOBODY)
              ? updateRoom(created.id, { lead: leadNow || null })
              : created
          );
      onSaved(saved);
    } catch (err) {
      setError(formatCommandError(asCommandError(err)));
    } finally {
      setSaving(false);
    }
  };

  return (
    <ModalFrame
      isOpen={isOpen}
      onClose={onClose}
      title={room ? 'Members and name' : 'New room'}
      className="agent-room-editor"
    >
      <form
        className="agent-room-editor__body"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <p className="agent-room-editor__lead">
          A group conversation with two to six agents. Each keeps its own memory; you @ who should
          answer, or @everyone.
        </p>
        <label className="agent-room-editor__label" htmlFor="room-name">
          Name
        </label>
        <TextField
          id="room-name"
          value={name}
          maxLength={60}
          placeholder={placeholder || 'Named after its members'}
          onChange={(e) => setName(e.target.value)}
        />
        <div className="agent-room-editor__label" id="room-members">
          Members{' '}
          <span className="agent-room-editor__count">
            {picked.length} of {MAX_ROOM_MEMBERS}
          </span>
        </div>
        <ul className="agent-room-editor__members" aria-labelledby="room-members">
          {team.map((agent) => {
            const on = picked.includes(agent.id);
            return (
              <li key={agent.id}>
                <label className="agent-room-editor__member" data-on={on || undefined}>
                  <Checkbox
                    checked={on}
                    disabled={!on && full}
                    label={`${agent.name} in this room`}
                    onChange={(checked) => toggle(agent.id, checked)}
                  />
                  <AgentAvatar name={agent.name} color={agent.color} size="mini" />
                  <span className="agent-room-editor__member-name">{agent.name}</span>
                  {agent.role && (
                    <span className="agent-room-editor__member-role">{agent.role}</span>
                  )}
                </label>
              </li>
            );
          })}
        </ul>
        {chosen.length >= MIN_ROOM_MEMBERS && (
          <>
            <div className="agent-room-editor__label" id="room-lead">
              When nobody is mentioned
            </div>
            <SegmentedControl
              aria-label="Who answers when nobody is mentioned"
              size="compact"
              className="agent-room-editor__leads"
              value={leadNow}
              onValueChange={setLead}
              options={[
                { value: NOBODY, label: 'Ask me' },
                ...chosen.map((a) => ({ value: a.id, label: a.name })),
              ]}
            />
          </>
        )}
        {error && (
          <p className="agent-room-editor__error" role="alert">
            {error}
          </p>
        )}
        <div className="agent-editor__actions">
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" type="submit" disabled={!enough || saving}>
            {room ? 'Save' : 'Create room'}
          </Button>
        </div>
      </form>
    </ModalFrame>
  );
}
