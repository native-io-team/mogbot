/**
 * GitHub contribution calendar component.
 *
 * Displays a user's GitHub contribution graph using react-github-calendar.
 * Shows contribution activity to encourage daily engagement.
 * Shows skeleton until auth check confirms status, then real data or hides.
 *
 * @module components/GitHubCalendar
 */

import { useState, useEffect, useCallback, useMemo, memo } from 'react';
import { GitHubCalendar as GitHubCalendarLib } from 'react-github-calendar';
import { EyeOffIcon } from '@/components/icons';
import { Tooltip } from '../primitives/Tooltip';
import { mixHex, useAppAccentHex } from '../../lib/accent';
import { useResolvedTheme, type ResolvedTheme } from '../../lib/theme';

interface Activity {
  date: string;
  count: number;
  level: number;
}

/** The activity shape react-github-calendar hands to — and expects back from — `transformData`. */
type CalendarActivity = { date: string; count: number; level: 0 | 1 | 2 | 3 | 4 };

/**
 * A full year of zero-count days, used when the contributions fetch comes
 * back empty.
 *
 * react-activity-calendar throws `Activity data must not be empty.` from
 * inside its render when handed a zero-length array — a transient API
 * failure, a rate limit, or an account with no activity for the requested
 * year would therefore crash the whole app to the error boundary rather than
 * degrade (issue #721). Handing it a valid all-zero year keeps it renderable
 * while the caller keeps the skeleton on top of it.
 *
 * Mirrors react-activity-calendar's own internal `generateEmptyData()`.
 */
export function placeholderYearActivity(year: number): CalendarActivity[] {
  const pad = (n: number) => String(n).padStart(2, '0');
  const days: CalendarActivity[] = [];
  const cursor = new Date(year, 0, 1);
  while (cursor.getFullYear() === year) {
    days.push({
      date: `${year}-${pad(cursor.getMonth() + 1)}-${pad(cursor.getDate())}`,
      count: 0,
      level: 0,
    });
    cursor.setDate(cursor.getDate() + 1);
  }
  return days;
}

interface GitHubCalendarProps {
  /** GitHub username to display contributions for */
  username: string | null | undefined;
  /** Whether GitHub is authenticated */
  isAuthenticated?: boolean;
  /** Whether the auth check has completed */
  isAuthCheckDone?: boolean;
  /** Called when the user clicks the hide button */
  onHide?: () => void;
}

// Theme: the empty cell plus four steps toward the app accent.
//
// BOTH `light` and `dark` MUST be provided as explicit 5-color hex scales, even
// though we only ever render one `colorScheme` at a time (the app's theme). react-activity-calendar fills
// any missing scale from its own default, and that default is generated with
// `color-mix(in oklab, …)`. It mutates the passed-in theme object to cache that
// scale, then re-validates it on a later render via `CSS.supports('color', …)`.
// macOS 12 ships Safari 15, which predates `color-mix()` — so the check returns
// false and the library throws "Invalid color …", white-screening the whole app
// a few seconds after launch (once the calendar data loads and it re-renders).
// Supplying both scales as plain hex keeps the library off every color-mix path,
// which is why the accent steps are mixed in JS (mixHex) rather than in CSS.
// The empty cell is a step off each theme's dashboard surface; the steps then
// climb toward the accent (near-black for the white accent on light).
const CALENDAR_EMPTY: Record<ResolvedTheme, string> = { dark: '#2d2d2d', light: '#e8e8e8' };
const CALENDAR_STEPS = [0.25, 0.5, 0.75, 1];

export function calendarTheme(accent: string) {
  const scale = (empty: string) => [empty, ...CALENDAR_STEPS.map((t) => mixHex(empty, accent, t))];
  return { light: scale(CALENDAR_EMPTY.light), dark: scale(CALENDAR_EMPTY.dark) };
}

function formatTooltip(activity: Activity): string {
  const date = new Date(activity.date);
  const formatted = date.toLocaleDateString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });

  if (activity.count === 0) {
    return `No contributions on ${formatted}`;
  }

  const s = activity.count === 1 ? '' : 's';
  return `${activity.count} contribution${s} on ${formatted}`;
}

function CalendarSkeleton() {
  return (
    <div className="github-calendar-skeleton">
      <div className="github-calendar-skeleton-grid">
        {Array.from({ length: 371 }).map((_, i) => (
          <div key={i} className="github-calendar-skeleton-block" />
        ))}
      </div>
    </div>
  );
}

// Stable renderBlock callback — avoids creating a new function reference every render,
// which would cause react-github-calendar to re-render all 365+ SVG blocks.
const renderBlock = (block: React.ReactElement, activity: Activity) => (
  <Tooltip content={formatTooltip(activity)} delayMs={50}>
    <g>{block}</g>
  </Tooltip>
);

export const GitHubCalendar = memo(function GitHubCalendar({
  username,
  isAuthenticated,
  isAuthCheckDone,
  onHide,
}: GitHubCalendarProps) {
  const accent = useAppAccentHex();
  const scheme = useResolvedTheme();
  // A new object only when the accent changes: the library caches on it.
  const theme = useMemo(() => calendarTheme(accent), [accent]);
  const currentYear = new Date().getFullYear();
  const [dataLoaded, setDataLoaded] = useState(false);

  // Reset data loaded state when username changes
  useEffect(() => {
    setDataLoaded(false); // eslint-disable-line react-hooks/set-state-in-effect -- intentional: reset loading state when username prop changes
  }, [username]);

  // Stable transformData callback — prevents the library from re-fetching/re-processing
  // data on every parent re-render (unstable function refs trigger library effects).
  const handleTransformData = useCallback(
    (data: CalendarActivity[]) => {
      if (data.length === 0) {
        // No contributions came back (transient API failure, rate limit, or
        // an account with nothing in this year). Stay in the loading state —
        // the calendar keeps rendering, but off a placeholder year, because
        // an empty array makes the library throw during render (issue #721).
        return placeholderYearActivity(currentYear);
      }
      // Called when data is loaded
      setDataLoaded(true);
      return data;
    },
    [currentYear]
  );

  // Only hide after auth check is DONE and confirmed NOT authenticated
  if (isAuthCheckDone && !isAuthenticated) {
    return null;
  }

  // Show skeleton while waiting for auth check OR waiting for data
  const showSkeleton = !isAuthCheckDone || !username || !dataLoaded;

  return (
    <div className="github-calendar-wrapper" data-education-id="github-calendar">
      {onHide && (
        <button
          className="github-calendar-hide-btn"
          onClick={onHide}
          title="Hide activity calendar"
          aria-label="Hide activity calendar"
        >
          <EyeOffIcon size={14} />
        </button>
      )}
      {showSkeleton && <CalendarSkeleton />}
      {username && (
        <div style={{ display: dataLoaded ? 'block' : 'none' }}>
          <GitHubCalendarLib
            username={username}
            colorScheme={scheme}
            theme={theme}
            blockSize={12}
            blockMargin={2}
            blockRadius={4}
            fontSize={10}
            showColorLegend={false}
            showTotalCount={false}
            year={currentYear}
            renderBlock={renderBlock}
            transformData={handleTransformData}
          />
        </div>
      )}
    </div>
  );
});
