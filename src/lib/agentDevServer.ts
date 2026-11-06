/**
 * An agent's requests about a project's dev server (`agents/project_tools.rs`).
 *
 * The dev server belongs to the window (`useDevServer`), so `preview_start`,
 * `preview_stop` and `preview_logs` ask the window over `agents://dev-server`
 * and wait for `agents_dev_server_done`. Everything runs in the background:
 * the same `startServerForProject` the Agents preview pane uses (install
 * gate and consent included; the backend asked for consent first), then the
 * preview proxy the workspace would start, which is how screenshots, the
 * desk's Preview and the phone's Watch live find the server
 * (`proxy::dev_server_port_for`). The window never changes what it shows.
 *
 * @module lib/agentDevServer
 */
import { invoke } from '@tauri-apps/api/core';
import { devServerConsentStore } from './devServerConsent';
import { preferredPortForProject } from './ports';
import { isMobileProjectType, type ProjectType } from './static-server';

export const AGENT_DEV_SERVER_EVENT = 'agents://dev-server';

export interface DevServerRequest {
  requestId: string;
  projectPath: string;
  name: string;
  action: 'start' | 'stop' | 'status';
  /** The port saved for the folder, if any. */
  port?: number | null;
}

/** `project_tools::Report`. */
export interface DevServerReport {
  status: 'not-running' | 'starting' | 'ready' | 'stopped';
  port: number | null;
  projectType: ProjectType | null;
  mobile: boolean;
  needsInstall: boolean;
  consentPending: boolean;
  output: string;
  error?: string | null;
}

/** What it needs from the window's dev servers (App's `useDevServer`). */
export interface DevServerOwner {
  status: (path: string) => {
    status: DevServerReport['status'];
    address: string | null;
  };
  start: (path: string, name: string, port: number) => Promise<ProjectType>;
  stop: (path: string) => Promise<void>;
  needsInstall: (path: string) => { packageManager: string } | null;
  projectType: (path: string) => ProjectType;
  output: (path: string) => string;
  reservePort: (path: string, preferred: number) => Promise<number>;
  startProxy: (path: string, port: number) => Promise<unknown>;
}

function portOf(address: string | null): number | null {
  const m = address?.match(/:(\d{1,5})$/);
  const port = m ? Number(m[1]) : NaN;
  return Number.isInteger(port) && port > 0 && port <= 65535 ? port : null;
}

function report(owner: DevServerOwner, path: string, type?: ProjectType): DevServerReport {
  const snap = owner.status(path);
  const projectType = type ?? owner.projectType(path);
  return {
    status: snap.status,
    port: portOf(snap.address),
    projectType: projectType ?? null,
    mobile: projectType ? isMobileProjectType(projectType) : false,
    needsInstall: owner.needsInstall(path) !== null,
    consentPending: devServerConsentStore.get(path) !== null,
    output: owner.output(path),
  };
}

/** Do what was asked and say how it stands. Never throws. */
export async function handleDevServerRequest(
  owner: DevServerOwner,
  req: DevServerRequest
): Promise<DevServerReport> {
  const path = req.projectPath;
  try {
    if (req.action === 'stop') {
      await owner.stop(path);
      return report(owner, path);
    }
    if (req.action === 'status') return report(owner, path);
    const snap = owner.status(path);
    let type: ProjectType | undefined;
    if (snap.status !== 'ready' && snap.status !== 'starting') {
      const preferred = req.port ?? preferredPortForProject(path);
      const reserved = await owner.reservePort(path, preferred).catch(() => preferred);
      type = await owner.start(path, req.name, reserved);
    }
    const now = report(owner, path, type);
    // The proxy the workspace's preview would start once it sees the
    // server: it's what says "this folder's server is up" to the Mac.
    if (now.port && (now.status === 'ready' || now.status === 'starting')) {
      await owner.startProxy(path, now.port).catch(() => undefined);
    }
    return now;
  } catch (e) {
    return {
      ...report(owner, path),
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

/** The preview proxy `usePreviewConnection` starts, for a folder no preview shows. */
export function startPreviewProxyFor(
  windowLabel: string,
  projectPath: string,
  targetPort: number
): Promise<number> {
  return invoke<number>('start_preview_proxy', { windowLabel, projectPath, targetPort });
}

export function answerDevServerRequest(
  requestId: string,
  result: DevServerReport
): Promise<boolean> {
  return invoke<boolean>('agents_dev_server_done', { requestId, report: result });
}
