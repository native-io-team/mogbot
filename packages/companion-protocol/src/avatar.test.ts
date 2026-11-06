import { describe, expect, it } from 'vitest';
import {
  AVATAR_FACES,
  AVATAR_SHAPES,
  CHIEF_LOOK,
  FACE_NAMES,
  FACE_SPECS,
  SHAPE_NAMES,
  SHAPE_SPECS,
  defaultLook,
  describeLook,
  faceTransform,
  faceWeights,
  freeLook,
  lookFor,
} from './avatar';

describe('lookFor', () => {
  it('derives the same look from an id as the Mac does (avatar_tests.rs holds this table)', () => {
    const table: [string, string, string][] = [
      ['hiring', 'circle', 'focused'],
      ['finance', 'pill', 'quiet'],
      ['a1b2c3', 'drop', 'bright'],
      ['acme', 'cookie', 'cheerful'],
      ['leadgen', 'arch', 'determined'],
      ['social', 'rounded', 'content'],
      ['é-agent', 'circle', 'focused'],
    ];
    for (const [id, shape, face] of table) {
      expect(defaultLook(id)).toEqual({ shape, face });
    }
  });

  it('gives the Chief its own default, and nobody else a squircle by default', () => {
    expect(lookFor({ id: 'chief-id', isMain: true })).toEqual(CHIEF_LOOK);
    for (let i = 0; i < 200; i++) {
      const look = defaultLook(`agent-${i}`);
      expect(look.shape).not.toBe(CHIEF_LOOK.shape);
      // A wink or a sleepy face is chosen, never handed out.
      expect(['wink', 'sleepy']).not.toContain(look.face);
    }
  });

  it('keeps a saved choice field by field, and falls back on a key it does not draw', () => {
    expect(lookFor({ id: 'hiring', avatar: { shape: 'hexagon', face: 'curious' } })).toEqual({
      shape: 'hexagon',
      face: 'curious',
    });
    expect(
      lookFor({ id: 'hiring', avatar: { shape: 'hexagon', face: 'newer' as never } }).face
    ).toBe(defaultLook('hiring').face);
  });
});

describe('freeLook', () => {
  it('starts a new agent on a shape nobody wears, never the Chief’s', () => {
    const taken = AVATAR_SHAPES.filter((s) => s !== 'arch' && s !== 'squircle').map((shape) => ({
      shape,
      face: 'calm' as const,
    }));
    expect(freeLook(taken, 'x').shape).toBe('arch');
    expect(freeLook([], 'y').shape).not.toBe('squircle');
  });
});

describe('the drawing', () => {
  it('has a silhouette, a name and a face position for every shape, and strokes for every face', () => {
    for (const s of AVATAR_SHAPES) {
      expect(SHAPE_SPECS[s].d).toMatch(/^M[\d.]/);
      expect(SHAPE_SPECS[s].d).not.toMatch(/NaN/);
      expect(SHAPE_NAMES[s]).toBeTruthy();
    }
    for (const f of AVATAR_FACES) {
      expect(FACE_SPECS[f].length).toBeGreaterThanOrEqual(2);
      expect(FACE_SPECS[f].some((p) => p.role === 'eye' || p.blinks)).toBe(true);
      expect(FACE_NAMES[f]).toBeTruthy();
    }
    expect(faceTransform('circle')).toBe('');
    expect(faceTransform('arch')).toMatch(/^translate\(16 17\) scale\(0\.96\)/);
  });

  it('weighs strokes up as the avatar gets smaller', () => {
    expect(faceWeights(16).eye).toBeGreaterThan(faceWeights(96).eye);
    expect(faceWeights(16).line).toBeGreaterThan(faceWeights(40).line);
    expect(faceWeights(24).line).toBeGreaterThan(faceWeights(96).line);
  });
});

describe('describeLook', () => {
  it('says it the way the settings card does', () => {
    expect(describeLook({ shape: 'hexagon', face: 'curious' })).toBe(
      'a hexagon with a curious face'
    );
    expect(describeLook({ shape: 'arch' })).toBe('an arch');
    expect(describeLook({ shape: 'rounded' })).toBe('a rounded square');
    expect(describeLook({ face: 'sleepy' })).toBe('a sleepy face');
  });
});
