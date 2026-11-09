/**
 * Tauri wrappers for the pinned-projects backend commands.
 *
 * Pins are persisted on disk in `pins.json`
 * (`~/Library/Application Support/ShipStudio/pins.json` on macOS).
 * Backend invariants:
 *
 * - `pinProject` dedupes by path — repeated calls are idempotent.
 * - `reorderPins` requires the new order to contain exactly the same
 *   set of paths as the current pins (no adds, no removes, no dupes);
 *   otherwise it rejects with a `Validation` `CommandError`.
 *
 * @module lib/pins
 */

import { invoke } from '@tauri-apps/api/core';

/** Add a project to the pinned list. Returns the updated ordered list. */
export async function pinProject(projectPath: string): Promise<string[]> {
  return invoke<string[]>('pin_project', { projectPath });
}

/** Remove a project from the pinned list. Returns the updated ordered list. */
export async function unpinProject(projectPath: string): Promise<string[]> {
  return invoke<string[]>('unpin_project', { projectPath });
}

/** Return the current ordered list of pinned project paths. */
export async function listPinnedProjects(): Promise<string[]> {
  return invoke<string[]>('list_pinned_projects');
}

/**
 * Replace the pin order. The new order must contain exactly the same set of
 * paths as the current pins — backend rejects sets with adds/removes/dupes.
 */
export async function reorderPins(orderedPaths: string[]): Promise<string[]> {
  return invoke<string[]>('reorder_pins', { orderedPaths });
}
