/**
 * The Library tab's list: what the remote registry offers, with an honest
 * state for each way it can come back empty.
 *
 * @module components/plugins/PluginLibraryList
 */

import { Button } from '../primitives/Button';
import { ExtensionListRow, ExtensionState } from './extension';
import type { PluginRegistryEntry } from '../../lib/plugins';

/** Why the library fetch failed, so an empty list isn't read as "the library
 *  is empty" (#713). `unreachable` is the user's network or GitHub's rate
 *  limiter; `malformed` is a registry body we couldn't parse — a different
 *  problem, with a different fix, so it gets its own copy. */
export type RegistryFailure = 'unreachable' | 'malformed' | null;

interface PluginLibraryListProps {
  registry: PluginRegistryEntry[];
  /** The registry after the search filter. */
  entries: PluginRegistryEntry[];
  isLoading: boolean;
  failure: RegistryFailure;
  installingId: string | null;
  isInstalled: (entry: PluginRegistryEntry) => boolean;
  onInstall: (entry: PluginRegistryEntry) => void;
}

export function PluginLibraryList({
  registry,
  entries,
  isLoading,
  failure,
  installingId,
  isInstalled,
  onInstall,
}: PluginLibraryListProps) {
  return (
    <>
      {isLoading && registry.length === 0 && (
        <ExtensionState kind="loading" loadingLabel="Loading plugin library">
          Loading plugin library…
        </ExtensionState>
      )}

      {!isLoading && registry.length === 0 && (
        <ExtensionState kind="empty">
          {failure === 'unreachable' && (
            <>
              Couldn&apos;t reach the plugin library. Check your connection, or try again in a
              minute — GitHub sometimes rate-limits this request. You can still install from a URL
              below.
            </>
          )}
          {failure === 'malformed' && (
            <>
              The plugin library loaded but we couldn&apos;t read it — that&apos;s a problem on our
              side, not your connection. You can still install from a URL below.
            </>
          )}
          {failure === null &&
            'The plugin library is empty right now. You can still install from a URL below.'}
        </ExtensionState>
      )}

      {!isLoading && registry.length > 0 && entries.length === 0 && (
        <ExtensionState kind="empty">No matching plugins</ExtensionState>
      )}

      <div className="plugins-list">
        {entries.map((entry) => {
          const installing = installingId === entry.id;
          return (
            <ExtensionListRow
              key={entry.id}
              className="plugin-row"
              action={
                isInstalled(entry) ? (
                  <span className="plugin-installed-badge">Installed</span>
                ) : (
                  <Button
                    variant="primary"
                    onClick={() => onInstall(entry)}
                    disabled={installing || installingId !== null}
                  >
                    {installing ? 'Installing…' : 'Install'}
                  </Button>
                )
              }
            >
              <div className="plugin-info">
                <div className="plugin-header">
                  <div>
                    <span className="plugin-name">{entry.name}</span>
                    <span className="plugin-meta">{entry.author}</span>
                  </div>
                </div>
                <div className="plugin-desc">{entry.description}</div>
                {entry.category && <div className="plugin-category-badge">{entry.category}</div>}
              </div>
            </ExtensionListRow>
          );
        })}
      </div>
    </>
  );
}
