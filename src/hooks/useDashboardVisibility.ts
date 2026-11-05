import { useCallback, useEffect, useState } from 'react';

import {
  DASHBOARD_VISIBILITY_CHANGED_EVENT,
  type DashboardVisibilityChangedDetail,
  getSlackCtaHidden,
  setSlackCtaHidden as persistSlackCtaHidden,
} from '../lib/settings';

export interface DashboardVisibility {
  slackCtaHidden: boolean;
  hideSlackCta: () => void;
  /** Raw setter for surfaces that persist the flag themselves (SettingsModal). */
  setSlackCtaHidden: (hidden: boolean) => void;
}

/**
 * Dismissal state for the dashboard's community banner.
 *
 * The settings modal can toggle the same flag, so the persisted value is
 * loaded once and then kept in sync through DASHBOARD_VISIBILITY_CHANGED_EVENT
 * rather than re-read on every render.
 */
export function useDashboardVisibility(): DashboardVisibility {
  const [slackCtaHidden, setSlackCtaHidden] = useState(false);

  useEffect(() => {
    void getSlackCtaHidden().then(setSlackCtaHidden);
  }, []);

  useEffect(() => {
    const handleVisibilityChanged = (event: Event) => {
      const detail = (event as CustomEvent<DashboardVisibilityChangedDetail>).detail;
      if (!detail) return;
      if (detail.key === 'slackCta') setSlackCtaHidden(detail.hidden);
    };

    window.addEventListener(DASHBOARD_VISIBILITY_CHANGED_EVENT, handleVisibilityChanged);
    return () =>
      window.removeEventListener(DASHBOARD_VISIBILITY_CHANGED_EVENT, handleVisibilityChanged);
  }, []);

  const hideSlackCta = useCallback(() => {
    setSlackCtaHidden(true);
    void persistSlackCtaHidden(true);
  }, []);

  return { slackCtaHidden, hideSlackCta, setSlackCtaHidden };
}
