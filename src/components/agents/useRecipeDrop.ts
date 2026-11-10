/**
 * A recipe file dropped anywhere on the Agents window puts its review card
 * up in the Chief's chat, through the same sealed path as Import
 * (`agents_import_file_review`): read by plain code on the Mac, nothing
 * made until Import is pressed there. Other files are left to whatever
 * they land on (a chat attaches them; recipe files it skips).
 *
 * In the app the drop arrives as Tauri's window-wide `tauri://drag-drop`
 * with paths; in a plain browser (the UI harness) as a DOM drop with the
 * file's text, which goes the paste way (`agents_import_text_review`).
 *
 * @module components/agents/useRecipeDrop
 */

import { useEffect, useLayoutEffect, useRef } from 'react';
import { listen } from '@tauri-apps/api/event';
import { useOptionalToast } from '../../contexts/ToastContext';
import { asCommandError, formatCommandError } from '../../lib/errors';
import { reviewFileImport, reviewTextImport, type ExportImportPosted } from '../../lib/agents';
import { isRecipeFile } from '../../lib/agentRecipe';

export function useRecipeDrop(enabled: boolean, onPosted: (chiefId: string) => void) {
  const { showToast } = useOptionalToast();
  const latest = useRef({ enabled, onPosted, showToast });
  useLayoutEffect(() => {
    latest.current = { enabled, onPosted, showToast };
  }, [enabled, onPosted, showToast]);

  useEffect(() => {
    const post = async (go: () => Promise<ExportImportPosted>) => {
      try {
        const posted = await go();
        latest.current.onPosted(posted.chiefId);
      } catch (e) {
        const err = asCommandError(e);
        latest.current.showToast(
          err.type === 'Validation' ? err.reason : formatCommandError(err),
          'error'
        );
      }
    };
    const fromPaths = (paths: string[]) => {
      for (const path of paths.filter(isRecipeFile)) void post(() => reviewFileImport(path));
    };
    const tauri = listen<{ paths?: string[] }>('tauri://drag-drop', (e) => {
      if (latest.current.enabled) fromPaths(e.payload.paths ?? []);
    });
    const recipes = (e: DragEvent) =>
      Array.from(e.dataTransfer?.files ?? []).filter((f) => isRecipeFile(f.name));
    const over = (e: DragEvent) => {
      if (latest.current.enabled && e.dataTransfer?.types.includes('Files')) e.preventDefault();
    };
    const drop = (e: DragEvent) => {
      if (!latest.current.enabled) return;
      const files = recipes(e);
      if (files.length === 0) return;
      e.preventDefault();
      for (const f of files) void post(async () => reviewTextImport(await f.text()));
    };
    window.addEventListener('dragover', over);
    window.addEventListener('drop', drop);
    return () => {
      window.removeEventListener('dragover', over);
      window.removeEventListener('drop', drop);
      void tauri.then((off) => off()).catch(() => {});
    };
  }, []);
}
