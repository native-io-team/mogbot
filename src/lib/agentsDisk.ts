/**
 * Disk space for agents: mirrors `src-tauri/src/agents/disk.rs`. Free space
 * on this Mac, each large agent home, and "Free up space" (regenerable
 * dependency and build folders only).
 *
 * @module lib/agentsDisk
 */

import { invoke } from '@tauri-apps/api/core';

export type DiskLevel = 'fine' | 'low' | 'floor';

export interface AgentHomeSize {
  agentId: string;
  name: string;
  bytes: number;
  /** In `node_modules`, `.next`, `.turbo` and `target` folders beside what rebuilds them. */
  regenerableBytes: number;
}

export interface DiskOverview {
  /** Null when it couldn't be read. */
  freeBytes: number | null;
  level: DiskLevel;
  lowBytes: number;
  floorBytes: number;
  /** Homes of 1 GB or more, largest first. */
  homes: AgentHomeSize[];
}

export interface DiskFreed {
  bytes: number;
  removed: number;
  /** Kept because git tracks them or doesn't ignore them. */
  kept: number;
  /** The agent was working, so it was left alone. */
  busy: boolean;
}

export const diskOverview = () => invoke<DiskOverview>('agents_disk_overview');
export const freeUpAgentHome = (agentId: string) =>
  invoke<DiskFreed>('agents_disk_free_up', { agentId });

/** `39 GB`, `3.4 GB`, `20 MB`: decimal, as Finder counts (`disk::gb`). */
export function formatBytes(bytes: number): string {
  const gb = bytes / 1e9;
  if (gb >= 10) return `${Math.round(gb)} GB`;
  if (gb >= 0.1) return `${gb.toFixed(1)} GB`;
  return `${Math.floor(bytes / 1e6)} MB`;
}

/** One home's line in Settings. */
export function homeLine(h: AgentHomeSize): string {
  const total = `Its folder uses ${formatBytes(h.bytes)}`;
  if (h.regenerableBytes < 1e8) return `${total}.`;
  return `${total}, ${formatBytes(h.regenerableBytes)} of it in dependency and build folders.`;
}

/** What "Free up space" did, in one line. */
export function freedLine(f: DiskFreed): string {
  if (f.busy && f.removed === 0) return 'It’s working right now. Try again when it’s done.';
  const kept =
    f.kept > 0 ? ` Left ${f.kept} alone: git doesn’t ignore ${f.kept === 1 ? 'it' : 'them'}.` : '';
  if (f.removed === 0) return `Nothing to free up.${kept}`;
  return `Freed ${formatBytes(f.bytes)}.${kept}`;
}
