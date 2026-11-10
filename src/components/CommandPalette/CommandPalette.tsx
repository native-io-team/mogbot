import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ModalFrame } from '../primitives/ModalFrame';
import { Tabs, TabsList, TabsPanel, TabsTab } from '../primitives/Tabs';
import { TextButton } from '../primitives/TextButton';
import { CommandPlaceholderIcon, SearchIcon } from '@/components/icons';
import { useConsumePendingTab, type PaletteContextKind } from './paletteContext';
import { useRankedCommands } from '../../commands/useRankedCommands';
import { recordRun } from '../../commands/frecency';
import { layoutPalette, tabsFor, type PaletteRow, type TabId } from './paletteLayout';
import { logger } from '../../lib/logger';
import { asCommandError, formatCommandError } from '../../lib/errors';
import { useOptionalToast } from '../../contexts/ToastContext';
import { trackEvent } from '../../lib/analytics';

interface CommandPaletteProps {
  isOpen: boolean;
  onClose: () => void;
  context: PaletteContextKind;
  currentProjectName: string | null;
}

/**
 * Rows drawn in the frame the palette opens in; the rest follow one frame
 * later. Measured with ~170 commands (22 agents) at 4× CPU throttle: opening
 * took ~115 ms with every row drawn at once and ~60 ms with ten, so the first
 * paint draws what fits on screen and nothing a person could reach yet.
 */
const FIRST_PAINT_ROWS = 24;

function placeholderFor(ctx: PaletteContextKind, projectName: string | null) {
  if (ctx === 'project') {
    return projectName ? `Search actions in ${projectName}…` : 'Search actions…';
  }
  return 'Search agents, projects, settings…';
}

const optionId = (index: number) => `command-palette-option-${index}`;

export function CommandPalette({
  isOpen,
  onClose,
  context,
  currentProjectName,
}: CommandPaletteProps) {
  const { showToast } = useOptionalToast();
  const [query, setQuery] = useState('');
  const [activeTab, setActiveTab] = useState<TabId>('all');
  const [selectedIdx, setSelectedIdx] = useState(0);
  const [rowLimit, setRowLimit] = useState(FIRST_PAINT_ROWS);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const consumePendingTab = useConsumePendingTab();

  // A fresh object every render would re-rank every command on every arrow
  // key and every hover.
  const ctx = useMemo(() => ({ kind: context, currentProjectName }), [context, currentProjectName]);
  const { ranked, fallbacks } = useRankedCommands(ctx, query);
  const tabs = tabsFor(context);

  const layout = useMemo(
    () => layoutPalette({ ranked, fallbacks, tab: activeTab, context, query }),
    [ranked, fallbacks, activeTab, context, query]
  );
  const { rows } = layout;

  useEffect(() => {
    if (isOpen) {
      const pending = consumePendingTab();
      setActiveTab(pending ?? 'all');
      inputRef.current?.focus();
      void trackEvent('palette_opened', {
        context,
        initial_tab: pending ?? 'all',
      });
      // The rest of the rows, once the first frame is on screen.
      const raf = requestAnimationFrame(() => setRowLimit(Infinity));
      return () => cancelAnimationFrame(raf);
    }
    setQuery('');
    setActiveTab('all');
    setSelectedIdx(0);
    setRowLimit(FIRST_PAINT_ROWS);
    return undefined;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- consumePendingTab is stable, context is captured in handlers
  }, [isOpen]);

  // A tab this context doesn't have (asked for elsewhere) falls back to All.
  useEffect(() => {
    if (!tabs.some((t) => t.id === activeTab)) setActiveTab('all');
  }, [tabs, activeTab]);

  useEffect(() => {
    setSelectedIdx(0);
  }, [query, activeTab, context]);

  // Clamp selection when the list changes length.
  useEffect(() => {
    setSelectedIdx((i) => Math.min(i, Math.max(0, rows.length - 1)));
  }, [rows.length]);

  useEffect(() => {
    listRef.current
      ?.querySelector<HTMLElement>(`#${optionId(selectedIdx)}`)
      ?.scrollIntoView({ block: 'nearest' });
  }, [selectedIdx]);

  // Read through a ref so the row callbacks stay stable and the rows memoize.
  const latest = useRef({ rows, query, activeTab, context });
  useLayoutEffect(() => {
    latest.current = { rows, query, activeTab, context };
  });

  const runRow = useCallback(
    (index: number) => {
      const { rows: current, query: typed, activeTab: tab, context: where } = latest.current;
      const row = current[index];
      if (!row) return;
      const { cmd } = row;
      const trimmedQuery = typed.trim();
      void trackEvent('palette_command_run', {
        command_id: cmd.id,
        category: cmd.category,
        // `position` is the index in the list as shown; pair it with
        // `total_results` so the metric is interpretable across queries.
        position: index,
        total_results: current.length,
        query_length: trimmedQuery.length,
        had_query: trimmedQuery.length > 0,
        tab,
        context: where,
      });
      // Close first so the UI doesn't block on long-running handlers.
      onClose();
      if (!cmd.fallback) recordRun(cmd.id);
      // A silently failing palette command kills trust in the palette: the
      // toast names the command and carries the real error.
      const reportFailure = (kind: 'failed' | 'threw', err: unknown) => {
        const detail = formatCommandError(asCommandError(err));
        logger.error(`[CommandPalette] command ${kind}`, { id: cmd.id, error: detail });
        showToast(`“${cmd.title}” didn’t work: ${detail}`, 'error');
      };
      try {
        const result = cmd.run(row.query);
        if (result && typeof (result as Promise<unknown>).then === 'function') {
          (result as Promise<unknown>).catch((err) => reportFailure('failed', err));
        }
      } catch (err) {
        reportFailure('threw', err);
      }
    },
    [onClose, showToast]
  );

  // Only a moving pointer selects: a list scrolled by the arrow keys under a
  // still pointer must not hand the selection to whatever row arrives there.
  const pointAt = useCallback((index: number) => {
    setSelectedIdx((i) => (i === index ? i : index));
  }, []);

  const cycleTab = (direction: 1 | -1) => {
    const currentIdx = tabs.findIndex((t) => t.id === activeTab);
    const nextIdx = (currentIdx + direction + tabs.length) % tabs.length;
    setActiveTab(tabs[nextIdx].id);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    const count = rows.length;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (count === 0) return;
      const step = e.key === 'ArrowDown' ? 1 : -1;
      // Wraps, so the last command is one ↑ away from the first.
      setSelectedIdx((i) => (i + step + count) % count);
    } else if (e.key === 'Tab') {
      e.preventDefault();
      cycleTab(e.shiftKey ? -1 : 1);
    } else if ((e.key === 'ArrowRight' || e.key === 'ArrowLeft') && query === '') {
      // With text in the field these move the caret, as in any text field.
      e.preventDefault();
      cycleTab(e.key === 'ArrowRight' ? 1 : -1);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      runRow(selectedIdx);
    }
  };

  const activeLabel = tabs.find((t) => t.id === activeTab)?.label ?? '';

  return (
    <ModalFrame
      isOpen={isOpen}
      onClose={onClose}
      className="command-palette"
      ariaLabel="Command palette"
    >
      <div className="command-palette-search">
        <span className="command-palette-search-icon" aria-hidden="true">
          <SearchIcon size={16} />
        </span>
        <input
          ref={inputRef}
          type="text"
          className="command-palette-input"
          placeholder={placeholderFor(context, currentProjectName)}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={handleKeyDown}
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          spellCheck={false}
          role="combobox"
          aria-expanded="true"
          aria-controls="command-palette-list"
          aria-activedescendant={rows.length ? optionId(selectedIdx) : undefined}
          aria-label="Search commands"
        />
      </div>

      {context === 'project' && currentProjectName && (
        <div className="command-palette-scope">
          <span className="command-palette-scope-label">In project</span>
          <span className="command-palette-scope-value">{currentProjectName}</span>
        </div>
      )}

      <Tabs value={activeTab} onValueChange={(next) => setActiveTab(next as TabId)}>
        <TabsList
          variant="stretch"
          appearance="underline"
          className="command-palette-tabs"
          aria-label="Command categories"
        >
          {tabs.map((tab) => (
            <TabsTab key={tab.id} value={tab.id} width="fill" className="command-palette-tab">
              {tab.label}
            </TabsTab>
          ))}
        </TabsList>
        <TabsPanel value={activeTab} className="command-palette-list-panel">
          <div
            className="command-palette-list"
            id="command-palette-list"
            role="listbox"
            aria-label="Commands"
            ref={listRef}
          >
            {layout.empty && (
              // A group, not a status: a listbox may hold only options and
              // groups (axe aria-required-children). It still announces itself.
              <div className="command-palette-empty" role="group" aria-live="polite">
                {layout.empty.kind === 'nothing' ? (
                  'Nothing to run here yet.'
                ) : layout.empty.elsewhere > 0 ? (
                  <>
                    <span>
                      Nothing in {activeLabel} matches “{layout.empty.query}”.
                    </span>
                    <TextButton variant="strong" onClick={() => setActiveTab('all')}>
                      Show {layout.empty.elsewhere}{' '}
                      {layout.empty.elsewhere === 1 ? 'result' : 'results'} in All
                    </TextButton>
                  </>
                ) : (
                  <span>Nothing here matches “{layout.empty.query}”.</span>
                )}
              </div>
            )}
            {layout.sections.map((section) => (
              <div
                key={section.group}
                className="command-palette-group"
                role="group"
                aria-label={section.label ?? undefined}
              >
                {section.label && (
                  <div className="command-palette-group-header" aria-hidden="true">
                    {section.label}
                  </div>
                )}
                {section.rows.map((row) =>
                  row.index < rowLimit ? (
                    <CommandRow
                      key={row.cmd.id}
                      row={row}
                      selected={row.index === selectedIdx}
                      onPoint={pointAt}
                      onRun={runRow}
                    />
                  ) : null
                )}
              </div>
            ))}
          </div>
        </TabsPanel>
      </Tabs>

      <div className="command-palette-footer" aria-hidden="true">
        <span className="command-palette-hint">
          <kbd className="command-palette-kbd">↑</kbd>
          <kbd className="command-palette-kbd">↓</kbd>
          <span>move</span>
        </span>
        <span className="command-palette-hint">
          <kbd className="command-palette-kbd">tab</kbd>
          <span>switch tab</span>
        </span>
        <span className="command-palette-hint">
          <kbd className="command-palette-kbd">↵</kbd>
          <span>run</span>
        </span>
        <span className="command-palette-hint">
          <kbd className="command-palette-kbd">esc</kbd>
          <span>close</span>
        </span>
      </div>
    </ModalFrame>
  );
}

interface RowProps {
  row: PaletteRow;
  selected: boolean;
  onPoint: (index: number) => void;
  onRun: (index: number) => void;
}

/**
 * Memoized, with stable callbacks: moving the selection re-renders the two
 * rows that changed, not all of them.
 */
const CommandRow = memo(function CommandRow({ row, selected, onPoint, onRun }: RowProps) {
  const { cmd, index, query } = row;
  // A fallback says what it will be handed: the text typed.
  const subtitle = query !== undefined ? `“${query}”` : cmd.subtitle;
  return (
    <button
      type="button"
      role="option"
      id={optionId(index)}
      tabIndex={-1}
      aria-selected={selected}
      data-selected={selected}
      className={`command-palette-row${selected ? ' is-selected' : ''}`}
      onMouseMove={() => onPoint(index)}
      onClick={() => onRun(index)}
    >
      <span className="command-palette-row-icon" aria-hidden="true">
        {cmd.icon ?? <CommandPlaceholderIcon />}
      </span>
      <span className="command-palette-row-text">
        <span className="command-palette-row-title">{cmd.title}</span>
        {subtitle && <span className="command-palette-row-subtitle">{subtitle}</span>}
      </span>
      {cmd.shortcut && (
        <span className="command-palette-row-meta">
          <kbd className="command-palette-kbd">{cmd.shortcut}</kbd>
        </span>
      )}
    </button>
  );
});
