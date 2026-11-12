/**
 * What the desk calls the computer it runs on: "Mac", "PC" or "computer",
 * from its own platform (the rule is `computer.ts` in companion-protocol).
 * Copy writes `THIS_COMPUTER` / `YOUR_COMPUTER`, never a literal "this Mac",
 * unless it names something only a Mac has (Keychain, macOS notifications).
 *
 * @module lib/computer
 */

import {
  capFirst,
  computerKindOf,
  computerNoun,
  thisComputer,
  yourComputer,
  type ComputerKind,
} from '../../packages/companion-protocol/src/computer';
import { isMac, isWindows } from './setup';

/** This desk's kind, fixed for the life of the window. */
export const HOST_COMPUTER: ComputerKind = computerKindOf(
  isMac() ? 'macos' : isWindows() ? 'windows' : 'other'
);

/** "Mac" / "PC" / "computer". */
export const COMPUTER = computerNoun(HOST_COMPUTER);
/** "this Mac" / "this PC" / "this computer". */
export const THIS_COMPUTER = thisComputer(HOST_COMPUTER);
/** "your Mac" / "your PC" / "your computer". */
export const YOUR_COMPUTER = yourComputer(HOST_COMPUTER);
/** Sentence-initial: "This Mac", "Your PC". */
export const THIS_COMPUTER_CAP = capFirst(THIS_COMPUTER);
export const YOUR_COMPUTER_CAP = capFirst(YOUR_COMPUTER);
