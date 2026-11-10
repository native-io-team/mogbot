/**
 * "Save what it learns" and "What it knows how to do", in the agent editor
 * (`agents/skills_learn.rs`). The setting is three choices, saved at once
 * like the Admin switch; each skill can be edited (cleaned on the Mac as a
 * new one is) or removed, also at once.
 *
 * @module components/agents/AgentSkills
 */

import { listen } from '@tauri-apps/api/event';
import { useCallback, useEffect, useState } from 'react';
import { ErrorIcon } from '@/components/icons';
import { Button } from '../primitives/Button';
import { SegmentedControl } from '../primitives/SegmentedControl';
import { TextArea, TextField } from '../primitives/TextField';
import { TextButton } from '../primitives/TextButton';
import { updateAgent, type Agent } from '../../lib/agents';
import {
  agentSkills,
  editAgentSkill,
  LEARN_SKILLS_CHOICES,
  LEARN_SKILLS_LABEL,
  learnSkillsDetail,
  learnSkillsOf,
  noSkillsLine,
  removeAgentSkill,
  SKILLS_CHANGED_EVENT,
  SKILLS_TITLE,
  skillCardNote,
  type SkillCard,
  type LearnSkills,
  type Skill,
} from '../../lib/agentSkills';
import { refreshAgents, useAgentsSelector } from '../../lib/agentsStore';
import { asCommandError, formatCommandError } from '../../lib/errors';

function SkillEditor({
  skill,
  onSave,
  onCancel,
}: {
  skill: Skill;
  onSave: (edit: { name: string; when: string; steps: string }) => Promise<void>;
  onCancel: () => void;
}) {
  const [name, setName] = useState(skill.name);
  const [when, setWhen] = useState(skill.when);
  const [steps, setSteps] = useState(skill.steps);
  const [busy, setBusy] = useState(false);
  return (
    <div className="agent-skills__editor">
      <TextField
        aria-label="Skill name"
        value={name}
        maxLength={60}
        onChange={(e) => setName(e.target.value)}
      />
      <TextField
        aria-label="When to use it"
        value={when}
        maxLength={300}
        onChange={(e) => setWhen(e.target.value)}
      />
      <TextArea
        aria-label="Steps"
        value={steps}
        rows={6}
        onChange={(e) => setSteps(e.target.value)}
      />
      <div className="agent-skills__editor-actions">
        <Button variant="secondary" size="compact" disabled={busy} onClick={onCancel}>
          Cancel
        </Button>
        <Button
          variant="strong"
          size="compact"
          disabled={busy || !name.trim() || !steps.trim()}
          onClick={() => {
            setBusy(true);
            void onSave({ name, when, steps }).finally(() => setBusy(false));
          }}
        >
          Save skill
        </Button>
      </div>
    </div>
  );
}

/** The card's body: when to use it, the steps as they'd be saved, the small print. */
export function AgentSkillCardBody({ card }: { card: SkillCard }) {
  const note = skillCardNote(card);
  return (
    <>
      {card.when && <p className="agent-skill-card__when">{card.when}</p>}
      <p className="agent-skill-card__steps">{card.steps}</p>
      {note && <p className="agent-skill-card__note">{note}</p>}
    </>
  );
}

/** The editor's section: the setting, then the skills. */
export function AgentSkills({ agent }: { agent: Agent }) {
  const live = useAgentsSelector((s) => s.agents?.find((a) => a.id === agent.id)) ?? agent;
  const setting = learnSkillsOf(live);
  const [skills, setSkills] = useState<Skill[] | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    agentSkills(agent.id)
      .then((v) => setSkills(v.skills))
      // A Mac that can't read them shows no list rather than an error.
      .catch(() => undefined);
  }, [agent.id]);

  useEffect(() => {
    load();
    let off: (() => void) | undefined;
    let gone = false;
    void listen<string>(SKILLS_CHANGED_EVENT, (e) => {
      if (e.payload === agent.id) load();
    }).then((u) => {
      if (gone) u();
      else off = u;
    });
    return () => {
      gone = true;
      off?.();
    };
  }, [agent.id, load]);

  const act = async (run: () => Promise<unknown>) => {
    setError(null);
    try {
      await run();
    } catch (e) {
      setError(formatCommandError(asCommandError(e)));
      throw e;
    }
  };

  const choose = (value: LearnSkills) =>
    void act(async () => {
      await updateAgent(agent.id, { learnSkills: value });
      await refreshAgents();
    }).catch(() => undefined);

  return (
    <div className="agent-editor__label agent-skills" role="group" aria-label={SKILLS_TITLE}>
      {LEARN_SKILLS_LABEL}
      <SegmentedControl
        value={setting}
        options={LEARN_SKILLS_CHOICES.map((c) => ({ value: c.value, label: c.label }))}
        onValueChange={(v) => choose(v)}
        aria-label={LEARN_SKILLS_LABEL}
      />
      <p className="agent-editor__hint">{learnSkillsDetail(setting)}</p>
      <span className="agent-skills__title">{SKILLS_TITLE}</span>
      {skills !== null && skills.length === 0 && (
        <p className="agent-editor__hint">{noSkillsLine(live.name, setting)}</p>
      )}
      {!!skills?.length && (
        <ul className="agent-permissions agent-skills__list">
          {skills.map((skill) =>
            editing === skill.slug ? (
              <li key={skill.slug} className="agent-skills__skill">
                <SkillEditor
                  skill={skill}
                  onCancel={() => setEditing(null)}
                  onSave={(edit) =>
                    act(async () => {
                      await editAgentSkill(agent.id, skill.slug, edit);
                      setEditing(null);
                      load();
                    }).catch(() => undefined)
                  }
                />
              </li>
            ) : (
              <li key={skill.slug} className="agent-permissions__rule agent-skills__skill">
                <span className="agent-skills__what">
                  <span className="agent-skills__name">{skill.name}</span>
                  {skill.when && <span className="agent-skills__when">{skill.when}</span>}
                </span>
                <span className="agent-skills__actions">
                  <TextButton
                    tabIndex={0}
                    className="agent-permissions__revoke"
                    onClick={() => setEditing(skill.slug)}
                  >
                    Edit
                  </TextButton>
                  <TextButton
                    tabIndex={0}
                    className="agent-permissions__revoke"
                    onClick={() =>
                      void act(async () => {
                        await removeAgentSkill(agent.id, skill.slug);
                        load();
                      }).catch(() => undefined)
                    }
                  >
                    Remove
                  </TextButton>
                </span>
              </li>
            )
          )}
        </ul>
      )}
      {error && (
        <p className="agent-editor__error" role="alert">
          <ErrorIcon size={12} className="inline-error-icon" />
          {error}
        </p>
      )}
    </div>
  );
}
