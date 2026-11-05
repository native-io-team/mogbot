/* eslint-disable @typescript-eslint/require-await -- stand-ins keep the native modules' async signatures */
/**
 * Web QA stand-in for expo-file-system/legacy (see metro.config.js): files
 * are `localStorage` entries keyed by path, so the offline cache and drafts
 * survive a reload. Directories are implied by their files.
 */
import { local } from './storage';

const P = 'fs:';
export const cacheDirectory = 'file:///cache/';
export const documentDirectory = 'file:///documents/';
export enum FileSystemUploadType {
  BINARY_CONTENT = 0,
  MULTIPART = 1,
}

const under = (dir: string) => {
  const d = dir.endsWith('/') ? dir : `${dir}/`;
  return local.keys().filter((k) => k.startsWith(P + d));
};

export async function getInfoAsync(path: string) {
  const file = local.get(P + path);
  if (file !== null) return { exists: true, isDirectory: false, uri: path, size: file.length };
  return under(path).length
    ? { exists: true, isDirectory: true, uri: path }
    : { exists: false, isDirectory: false, uri: path };
}

export async function readAsStringAsync(path: string) {
  const v = local.get(P + path);
  if (v === null) throw new Error(`No file at ${path}`);
  return v;
}

export async function writeAsStringAsync(path: string, value: string) {
  local.set(P + path, value);
}

export async function deleteAsync(path: string, _opts?: { idempotent?: boolean }) {
  local.remove(P + path);
  for (const k of under(path)) local.remove(k);
}

export async function makeDirectoryAsync(_path: string, _opts?: { intermediates?: boolean }) {}

export async function readDirectoryAsync(dir: string) {
  const d = dir.endsWith('/') ? dir : `${dir}/`;
  const names = new Set(under(dir).map((k) => k.slice(P.length + d.length).split('/')[0]));
  return [...names];
}

export async function copyAsync({ from, to }: { from: string; to: string }) {
  const v = local.get(P + from);
  if (v !== null) local.set(P + to, v);
}

export async function moveAsync({ from, to }: { from: string; to: string }) {
  await copyAsync({ from, to });
  local.remove(P + from);
}

export async function downloadAsync(
  url: string,
  dest: string,
  opts?: { headers?: Record<string, string> }
) {
  const res = await fetch(url, { headers: opts?.headers });
  return { status: res.status, uri: dest, headers: {} };
}

export function createUploadTask(
  url: string,
  _file: string,
  opts?: { httpMethod?: string; headers?: Record<string, string> }
) {
  return {
    uploadAsync: async () => {
      const res = await fetch(url, {
        method: opts?.httpMethod ?? 'PUT',
        headers: opts?.headers,
        body: '',
      });
      return { status: res.status, body: await res.text(), headers: {} };
    },
    cancelAsync: async () => {},
  };
}
