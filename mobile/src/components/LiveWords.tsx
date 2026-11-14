/**
 * The dictated words in the field, moving smoothly (lib/wordMorph.ts): new
 * live words settle in, a soft light passes over them while the computer
 * tidies, and when the better words come only the changed ones swap, with a
 * faint highlight that fades. Nested in the field's own Text, so the words
 * keep the field's type and wrap exactly as the typed text will.
 *
 * A clock re-draws them only while something moves (about 30 a second);
 * with Reduce Motion on, nothing moves and the words simply change.
 */
import { useEffect, useRef, useState } from 'react';
import { Text } from 'react-native';
import { useReducedMotion } from 'react-native-reanimated';
import { useColors } from '../lib/appearance';
import { alpha } from '../lib/theme';
import {
  MORPH_MS,
  SETTLE_MS,
  morphParts,
  settleOpacity,
  shimmerOpacity,
  stagger,
  swapLook,
  tokens,
} from '../lib/wordMorph';

/** A swap that started at `at` (Date.now()), from the live words to the better ones. */
export interface WordMorph {
  from: string;
  to: string;
  at: number;
}

const FRAME_MS = 33;

interface Clock {
  now: number;
  /** When each live word arrived, by its place in the text. */
  born: number[];
}

/**
 * The time and each word's arrival, re-read about 30 times a second only
 * while something moves: words settling in, tidying, or a swap.
 */
function useWordClock(
  count: number,
  tidying: boolean,
  morph: WordMorph | null | undefined,
  still: boolean
): Clock {
  const [clock, setClock] = useState<Clock>({ now: 0, born: [] });
  const born = useRef<number[]>([]);
  useEffect(() => {
    if (still) return;
    let frame = 0;
    let last = -FRAME_MS;
    const tick = (t: number) => {
      if (t - last >= FRAME_MS) {
        last = t;
        const at = Date.now();
        born.current = stagger(born.current, count, at);
        setClock({ now: at, born: born.current });
        const youngest = born.current.length ? born.current[born.current.length - 1] : 0;
        const moving =
          tidying || (!!morph && at - morph.at < MORPH_MS) || at - youngest < SETTLE_MS;
        if (!moving) return;
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [count, tidying, morph, still]);
  return clock;
}

export function LiveWords({
  settled,
  deciding,
  tidying,
  morph,
}: {
  settled: string;
  deciding: string;
  tidying?: boolean;
  morph?: WordMorph | null;
}) {
  const colors = useColors();
  const still = useReducedMotion();
  const said = tokens(settled);
  const words = [...said, ...tokens(deciding)];
  const { now, born } = useWordClock(words.length, !!tidying, morph, still);
  // A word the clock hasn't timed yet has only just arrived.
  const age = (i: number) => (i < born.length ? now - born[i] : 0);
  const listening = !still && !tidying && !morph;
  const settling = listening && words.some((_, i) => age(i) < SETTLE_MS);
  const morphing = !still && !!morph && now - morph.at < MORPH_MS;
  const ink = (o: number) => alpha(colors.textBody, o);

  if (morph && morphing) {
    const look = swapLook(now - morph.at);
    return (
      <>
        {morphParts(morph.from, morph.to).map((part, i) =>
          part.kind === 'same' ? (
            <Text key={i}>{part.text}</Text>
          ) : (
            <Text
              key={i}
              style={{
                color: ink(look.opacity),
                backgroundColor: alpha(colors.textStrong, 0.14 * look.glow),
              }}
            >
              {look.show === 'from' ? part.from : part.to}
            </Text>
          )
        )}
      </>
    );
  }
  if (morph) return <Text>{morph.to}</Text>;
  if (tidying && !still) {
    const n = said.length;
    const t = now - (born[n - 1] ?? now);
    return (
      <>
        {said.map((w, i) => (
          <Text key={i} style={{ color: ink(shimmerOpacity(i, n, t)) }}>
            {w}
          </Text>
        ))}
        <Text style={{ color: colors.textSecondary }}>{deciding}</Text>
      </>
    );
  }
  if (!settling) {
    return (
      <>
        {settled}
        <Text style={{ color: colors.textSecondary }}>{deciding}</Text>
      </>
    );
  }
  // Words come out one after another: a word whose turn hasn't come stays
  // out, and so does everything after it.
  const shown = words.findIndex((_, i) => age(i) < 0);
  const upTo = shown === -1 ? words.length : shown;
  return (
    <>
      {words.slice(0, upTo).map((w, i) => {
        const a = age(i);
        const later = i >= said.length;
        if (a >= SETTLE_MS) {
          return later ? (
            <Text key={i} style={{ color: colors.textSecondary }}>
              {w}
            </Text>
          ) : (
            <Text key={i}>{w}</Text>
          );
        }
        const o = settleOpacity(a);
        return (
          <Text
            key={i}
            style={{ color: later ? alpha(colors.textSecondary, o) : ink(o) }}
          >
            {w}
          </Text>
        );
      })}
    </>
  );
}
