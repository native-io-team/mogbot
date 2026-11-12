/**
 * What the app calls the computer it runs on: one word, the same everywhere.
 *
 * The agents run on a computer, and that computer may be a Mac, a Windows PC
 * or a Linux machine. Copy names it the way its own system does: "this Mac",
 * "this PC" (Windows' own name for itself), "this computer" (Linux, or when
 * the kind isn't known). Never "Mac" on a PC.
 *
 * - The desk knows its own kind (`computerKindOf` on the platform).
 * - The phone learns it from `MacStatus.computer` once paired. Before that,
 *   and from a computer too old to say, it is "your computer".
 *
 * Words for things only a Mac has (the Keychain, macOS notifications, the
 * Calendar app) stay as they are: they name the thing, not the computer.
 */

export type ComputerKind = 'mac' | 'pc' | 'computer';

/** The noun alone: "Mac", "PC", "computer". Unknown → "computer". */
export const computerNoun = (kind?: ComputerKind | null): string =>
  kind === 'mac' ? 'Mac' : kind === 'pc' ? 'PC' : 'computer';

/** "your Mac" / "your PC" / "your computer". */
export const yourComputer = (kind?: ComputerKind | null): string => `your ${computerNoun(kind)}`;

/** "this Mac" / "this PC" / "this computer". */
export const thisComputer = (kind?: ComputerKind | null): string => `this ${computerNoun(kind)}`;

/** The same words at the start of a sentence: "Your Mac", "This PC". */
export const capFirst = (words: string): string =>
  words.length === 0 ? words : words[0].toUpperCase() + words.slice(1);

/**
 * The kind from an OS name, as Tauri's `platform()` (`macos`, `windows`,
 * `linux`), Rust's `std::env::consts::OS`, or a user agent guess gives it.
 */
export function computerKindOf(os: string | null | undefined): ComputerKind {
  const o = (os ?? '').toLowerCase();
  if (o === 'macos' || o === 'darwin' || o === 'mac' || o === 'ios-mac') return 'mac';
  if (o === 'windows' || o === 'win32' || o === 'pc') return 'pc';
  return 'computer';
}
