/**
 * The legend on an agent's key, from every icon there is
 * (docs/internal/agent-keys.md, "The icon pack"): the featured legends first,
 * then the pack's two thousand, found by typing what the agent is for
 * ("money", "invoice", "house"). The search is instant and forgiving
 * (`searchIcons`: names, tags, synonyms, one typo); categories narrow it;
 * the icons picked lately sit in their own row.
 *
 * The pack loads when this opens (a code-split chunk: the index and the
 * drawings), never at startup. Until it arrives the featured legends are
 * here and searchable.
 *
 * Keyboard: the search is focused when the look opens by hand; ↓ goes into
 * the grid and Enter takes the first match. In the grid the arrows move the
 * pick (the key above changes with it, as radios do), ↑ from the top row
 * goes back to the search.
 *
 * @module components/agents/AgentKeyIconPicker
 */

import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import {
  FEATURED_CATEGORY,
  featuredEntries,
  loadIconCatalog,
  searchIcons,
  type IconCatalog,
} from '../../../packages/companion-protocol/src/agentKeySearch';
import { iconName, loadAllPackDrawings } from '../../../packages/companion-protocol/src/agentKeys';
import { useAsyncState } from '../../hooks/useAsyncState';
import { SearchField } from '../primitives/SearchField';
import { TextButton } from '../primitives/TextButton';
import { Dropdown, DropdownItem } from '../primitives/Dropdown';
import { MenuButton } from '../primitives/MenuButton';
import { ToggleButton } from '../primitives/ToggleButton';
import { AgentKey } from './AgentKey';

/** How many tiles are drawn at first, and how many more each time the end comes into view. */
const FIRST = 120;
const MORE = 240;
/** The icons picked lately, on this Mac (a convenience: nothing breaks without it). */
const RECENT_KEY = 'agents.keyIcons.recent';
const RECENT_MAX = 10;

function readRecent(): string[] {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]');
    return Array.isArray(raw) ? raw.filter((v): v is string => typeof v === 'string') : [];
  } catch {
    return [];
  }
}

function writeRecent(list: string[]) {
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(list));
  } catch {
    // Storage off: the row just doesn't remember.
  }
}

/** What's searchable before the pack arrives: the featured legends alone. */
const FEATURED_ONLY: IconCatalog = {
  entries: featuredEntries(),
  categories: [{ id: FEATURED_CATEGORY, title: 'Featured' }],
};

/**
 * The categories people pick an agent's icon by lead the row, in this order;
 * the rest (Lucide's, alphabetical: Accessibility, Arrows…) wait in More, so
 * the row fits the dialog instead of running off its edge (round 4, #11).
 */
const LEADING_CATEGORIES = [FEATURED_CATEGORY, 'people', 'finance', 'mail', 'time'];

/** The row's chips, then what's in More: the leading ones first, in their order. */
export function splitCategories(categories: IconCatalog['categories']) {
  const lead = LEADING_CATEGORIES.flatMap((id) => categories.filter((c) => c.id === id));
  const more = categories.filter((c) => !LEADING_CATEGORIES.includes(c.id));
  return { lead, more };
}

async function loadEverything(): Promise<IconCatalog> {
  const [catalog] = await Promise.all([loadIconCatalog(), loadAllPackDrawings()]);
  return catalog;
}

interface AgentKeyIconPickerProps {
  name: string;
  colorway: string;
  icon: string;
  onChange: (icon: string) => void;
  /** Focus the search on open (the look opened by hand, not a new agent's name field). */
  autoFocus?: boolean;
}

export function AgentKeyIconPicker({
  name,
  colorway,
  icon,
  onChange,
  autoFocus = false,
}: AgentKeyIconPickerProps) {
  const { data, error } = useAsyncState(loadEverything, { immediate: true });
  const catalog = data ?? FEATURED_ONLY;
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState<string | null>(null);
  const [limit, setLimit] = useState(FIRST);
  const [recent, setRecent] = useState(readRecent);
  const searchRef = useRef<HTMLInputElement>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  const endRef = useRef<HTMLDivElement>(null);

  const results = useMemo(() => searchIcons(catalog, query, category), [catalog, query, category]);
  const shown = results.slice(0, limit);
  const browsing = !query.trim() && !category;
  const recentShown = browsing ? recent : [];

  useEffect(() => {
    if (autoFocus) searchRef.current?.focus();
  }, [autoFocus]);

  // A new search starts at the top with the first page.
  const restart = () => {
    setLimit(FIRST);
    if (gridRef.current) gridRef.current.scrollTop = 0;
  };
  const changeQuery = (q: string) => {
    setQuery(q);
    restart();
  };
  const changeCategory = (c: string | null) => {
    setCategory(c);
    restart();
  };

  // More tiles as the end of the grid comes into view.
  useEffect(() => {
    const end = endRef.current;
    if (!end || typeof IntersectionObserver === 'undefined') return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) setLimit((l) => l + MORE);
      },
      { root: gridRef.current, rootMargin: '120px' }
    );
    io.observe(end);
    return () => io.disconnect();
  }, [shown.length, results.length]);

  /** A deliberate pick (click, Enter): it joins the recent row. */
  const pick = useCallback(
    (id: string) => {
      onChange(id);
      setRecent((list) => {
        const next = [id, ...list.filter((v) => v !== id)].slice(0, RECENT_MAX);
        writeRecent(next);
        return next;
      });
    },
    [onChange]
  );

  const tiles = () => [...(gridRef.current?.querySelectorAll<HTMLElement>('[data-value]') ?? [])];

  const focusTile = (el: HTMLElement | undefined) => {
    if (!el) return;
    el.focus();
    const v = el.dataset.value;
    if (v) onChange(v);
  };

  const onSearchKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      focusTile(tiles()[0]);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (shown[0]) pick(shown[0].id);
    }
  };

  const onGridKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const all = tiles();
    const at = all.indexOf(document.activeElement as HTMLElement);
    if (at < 0) return;
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      pick(all[at].dataset.value as string);
      return;
    }
    // Columns: the tiles on the first one's row.
    const top = all[0].offsetTop;
    const cols = Math.max(
      1,
      all.findIndex((t) => t.offsetTop !== top)
    );
    const step =
      {
        ArrowRight: 1,
        ArrowLeft: -1,
        ArrowDown: all.length > cols ? cols : 0,
        ArrowUp: -cols,
      }[e.key] ?? null;
    if (e.key === 'Home' || e.key === 'End') {
      e.preventDefault();
      focusTile(e.key === 'Home' ? all[0] : all[all.length - 1]);
      return;
    }
    if (step === null) return;
    e.preventDefault();
    const next = at + step;
    if (next < 0) {
      searchRef.current?.focus();
      return;
    }
    focusTile(all[Math.min(next, all.length - 1)]);
  };

  // One Tab stop in the grid: the pick if it's shown, else the first tile.
  const stop = shown.some((e) => e.id === icon) ? icon : shown[0]?.id;
  const count = results.length.toLocaleString('en');
  const { lead, more } = splitCategories(catalog.categories);
  const inMore = more.find((c) => c.id === category) ?? null;

  return (
    <div className="agent-look__row agent-icons">
      <span className="agent-look__label" id="agent-icons-label">
        Icon
      </span>
      <SearchField
        ref={searchRef}
        value={query}
        onChange={changeQuery}
        onKeyDown={onSearchKeyDown}
        density="compact"
        aria-label="Search icons"
        aria-describedby="agent-icons-count"
        placeholder={data ? `Search ${count} icons: money, mail, house…` : 'Search icons'}
      />
      {data && (
        <div className="agent-icons__filters" role="group" aria-label="Categories">
          <ToggleButton
            size="compact"
            variant="ghost"
            pressed={category === null}
            onClick={() => changeCategory(null)}
          >
            All
          </ToggleButton>
          {lead.map((c) => (
            <ToggleButton
              key={c.id}
              size="compact"
              variant="ghost"
              pressed={category === c.id}
              onClick={() => changeCategory(category === c.id ? null : c.id)}
            >
              {c.title}
            </ToggleButton>
          ))}
          {more.length > 0 && (
            <Dropdown
              portal
              menuClassName="agent-icons__more-menu"
              trigger={(p) => (
                <MenuButton
                  {...p}
                  tabIndex={0}
                  size="compact"
                  variant="ghost"
                  expanded={p['aria-expanded']}
                  className="agent-icons__more-trigger"
                  data-pressed={inMore ? true : undefined}
                >
                  {inMore?.title ?? 'More'}
                </MenuButton>
              )}
            >
              {more.map((c) => (
                <DropdownItem
                  key={c.id}
                  active={category === c.id}
                  onSelect={() => changeCategory(category === c.id ? null : c.id)}
                >
                  {c.title}
                </DropdownItem>
              ))}
            </Dropdown>
          )}
        </div>
      )}
      <span className="agent-icons__count" id="agent-icons-count" role="status">
        {!data && !error
          ? 'Loading every icon…'
          : error
            ? 'Only the featured icons are here: the rest didn’t load.'
            : results.length === 0
              ? `Nothing matches “${query.trim()}”. Try a plainer word for what it’s for.`
              : query.trim()
                ? `${count} for “${query.trim()}”`
                : `${count} icons`}
      </span>
      <div
        ref={gridRef}
        className="agent-icons__scroll"
        role="radiogroup"
        aria-labelledby="agent-icons-label"
        onKeyDown={onGridKeyDown}
      >
        {recentShown.length > 0 && (
          <>
            <span className="agent-icons__section">Recently used</span>
            <div className="agent-icons__grid">
              {recentShown.map((id) => (
                <Tile
                  key={`recent-${id}`}
                  id={id}
                  name={name}
                  colorway={colorway}
                  selected={false}
                  tabbable={false}
                  recent
                  onPick={pick}
                />
              ))}
            </div>
            <span className="agent-icons__section">All icons</span>
          </>
        )}
        <div className="agent-icons__grid">
          {shown.map((e) => (
            <Tile
              key={e.id}
              id={e.id}
              name={name}
              colorway={colorway}
              selected={e.id === icon}
              tabbable={e.id === stop}
              onPick={pick}
            />
          ))}
        </div>
        {shown.length < results.length && (
          <div ref={endRef} className="agent-icons__more">
            <TextButton onClick={() => setLimit((l) => l + MORE)}>
              Show more ({(results.length - shown.length).toLocaleString('en')})
            </TextButton>
          </div>
        )}
      </div>
    </div>
  );
}

function Tile({
  id,
  name,
  colorway,
  selected,
  tabbable,
  recent = false,
  onPick,
}: {
  id: string;
  name: string;
  colorway: string;
  selected: boolean;
  tabbable: boolean;
  recent?: boolean;
  onPick: (id: string) => void;
}) {
  const label = iconName(id);
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      aria-label={recent ? `${label} (recently used)` : label}
      title={label}
      tabIndex={tabbable ? 0 : -1}
      className="agent-look__choice"
      data-value={recent ? undefined : id}
      data-recent={recent ? id : undefined}
      data-selected={selected || undefined}
      onClick={() => onPick(id)}
    >
      <AgentKey name={name} colorway={colorway} icon={id} size="md" />
    </button>
  );
}
