/**
 * What the phone calls the computer it's paired with: "your Mac", "your PC"
 * or "your computer", one set of words everywhere (`computer.ts` in the
 * protocol package).
 *
 * The kind is what the computer reported (`MacStatus.computer`). Before
 * pairing, and from a computer too old to say, it is "your computer": the
 * phone never guesses Mac.
 */

import {
  capFirst,
  computerNoun,
  thisComputer,
  yourComputer,
  type ComputerKind,
} from '@shipstudio/companion-protocol';
import { useMemo } from 'react';
import { useApp } from './store';

export interface ComputerWords {
  /** As reported; `undefined` when it hasn't said. */
  kind: ComputerKind | undefined;
  /** "Mac", "PC", "computer". */
  noun: string;
  /** "your Mac". */
  your: string;
  /** "this Mac". */
  this: string;
  /** "Your Mac", at the start of a sentence. */
  yourCap: string;
  /** "This Mac", at the start of a sentence. */
  thisCap: string;
  /** "your Mac’s". */
  yours: string;
  /** "the Mac". */
  the: string;
  /** "The Mac", at the start of a sentence. */
  theCap: string;
}

/** The words for a kind, for code outside React. */
export function computerWords(kind?: ComputerKind | null): ComputerWords {
  const your = yourComputer(kind);
  const thisOne = thisComputer(kind);
  return {
    kind: kind ?? undefined,
    noun: computerNoun(kind),
    your,
    this: thisOne,
    yourCap: capFirst(your),
    thisCap: capFirst(thisOne),
    yours: `${your}’s`,
    the: `the ${computerNoun(kind)}`,
    theCap: `The ${computerNoun(kind)}`,
  };
}

/** The kind the paired computer reported, for code outside React. */
export const pairedKind = (): ComputerKind | undefined => useApp.getState().mac?.computer;

/** The words for the paired computer, for code outside React (read when called). */
export const pairedComputer = (): ComputerWords => computerWords(pairedKind());

/** The words for the paired computer, kept current as it reports. */
export function useComputer(): ComputerWords {
  const kind = useApp((s) => s.mac?.computer);
  return useMemo(() => computerWords(kind), [kind]);
}
