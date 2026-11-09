const STORAGE_KEY = 'workspace.active-project-order';

type Listener = () => void;

const listeners = new Set<Listener>();

function readStored(): string[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]');
    return Array.isArray(parsed)
      ? parsed.filter((path): path is string => typeof path === 'string')
      : [];
  } catch {
    return [];
  }
}

let cachedOrder: string[] | null = null;
let cachedRaw: string | null = null;

function readOrder(): string[] {
  let raw = '[]';
  try {
    raw = localStorage.getItem(STORAGE_KEY) ?? '[]';
  } catch {
    // Keep the in-memory snapshot when storage is unavailable.
  }
  if (cachedOrder === null || cachedRaw !== raw) {
    cachedRaw = raw;
    cachedOrder = readStored();
  }
  return cachedOrder;
}

export function getActiveProjectOrder(): string[] {
  return readOrder();
}

export function setActiveProjectOrder(order: readonly string[]): void {
  const next = [...new Set(order)];
  cachedOrder = next;
  cachedRaw = JSON.stringify(next);
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Best-effort persistence; the in-memory order remains useful this session.
  }
  for (const listener of listeners) listener();
}

export function subscribeActiveProjectOrder(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
