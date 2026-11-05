import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { mockIPC, clearMocks } from '@tauri-apps/api/mocks';
import {
  buildMigrationPrompt,
  buildResumePrompt,
  fidelityBand,
  fidelityImageUrl,
  loadFidelityRun,
  runScore,
  type FidelityRun,
} from './migration';
import { normaliseUrl } from '../components/migration/SiteUrlPanel';
import { brandScoped } from './brand';

afterEach(() => {
  clearMocks();
  vi.unstubAllGlobals();
});

describe('normaliseUrl', () => {
  it('accepts what a person actually pastes', () => {
    // Nobody types the scheme when copying their own site's address.
    expect(normaliseUrl('example.com')).toBe('https://example.com/');
    expect(normaliseUrl('  https://example.com/pricing ')).toBe('https://example.com/pricing');
    expect(normaliseUrl('http://tempo-template.webflow.io/')).toBe(
      'http://tempo-template.webflow.io/'
    );
  });

  it('rejects things that are not addresses', () => {
    // A bare word would otherwise become https://rebuild/ and send the agent
    // off to survey a host that does not exist.
    expect(normaliseUrl('')).toBeNull();
    expect(normaliseUrl('   ')).toBeNull();
    expect(normaliseUrl('rebuild my site')).toBeNull();
    expect(normaliseUrl('localhost')).toBeNull();
  });
});

describe('buildMigrationPrompt', () => {
  const prompt = buildMigrationPrompt('https://example.com/');

  it('names the site and the skill that carries the method', () => {
    expect(prompt).toContain('https://example.com/');
    expect(prompt).toContain(brandScoped('site-to-code'));
  });

  it('points at the engine by the name it is actually written under', () => {
    // The Rust side writes `site-fidelity.mjs`. A prompt naming anything else
    // sends the agent to a file that is not there, and the failure reads as
    // the agent being unable to measure rather than as a wrong path.
    expect(prompt).toContain('.shipstudio/fidelity/site-fidelity.mjs');
  });

  it('asks for the status file to be kept current', () => {
    // The panel reads that file. An agent that works without updating it
    // looks, from the user's side, like an agent that has stalled.
    expect(prompt).toContain('.shipstudio/migration.json');
  });

  it('states the bar for done', () => {
    expect(prompt).toContain('99.5%');
  });

  it('carries the status file’s shape', () => {
    // A live run wrote `needsYou` as bare sentences and used "in-progress" for
    // a status, because the prompt named the concepts and never the schema.
    // The backend now tolerates both, but the prompt is where it stops
    // happening.
    expect(prompt).toContain('"needsYou"');
    expect(prompt).toContain('"not-started" | "active" | "blocked" | "done"');
    expect(prompt).toContain('objects, not');
  });

  it('asks for the site’s own breakpoints rather than the tool’s defaults', () => {
    expect(prompt).toContain('--breakpoints');
    expect(prompt).toContain('media queries');
  });

  it('names where the rebuild is actually served', () => {
    // The app knows the project's port; leaving the agent to discover it is
    // the difference between measuring and hunting.
    expect(buildMigrationPrompt('https://example.com/', 'http://localhost:4321/')).toContain(
      '--rebuild http://localhost:4321/'
    );
    expect(buildResumePrompt('https://example.com/', 'http://localhost:4321/')).toContain(
      'http://localhost:4321/'
    );
    // And falls back rather than emitting an empty URL when nobody said.
    expect(buildMigrationPrompt('https://example.com/')).toContain('http://localhost:3000/');
  });
});

describe('fidelityImageUrl', () => {
  it('leaves served paths alone outside Tauri', () => {
    // The UI harness serves the same captures over HTTP; running them through
    // the asset protocol there would produce a URL nothing can load.
    expect(fidelityImageUrl('/migration-demo/v1/home/1440', 'diff.png')).toBe(
      '/migration-demo/v1/home/1440/diff.png'
    );
  });
});

describe('loadFidelityRun', () => {
  beforeEach(() => {
    mockIPC((cmd) => {
      if (cmd !== 'read_fidelity_runs') throw new Error(`unexpected command ${cmd}`);
      return [
        {
          dir: '/p/.shipstudio/fidelity/pass-1',
          report: {
            label: 'home',
            reference: 'https://example.com/',
            rebuild: 'http://localhost:3000/',
            capturedAt: '2026-09-08T00:00:00.000Z',
            score: 89.25,
            rebuildCss: null,
            breakpoints: [
              {
                breakpoint: 1440,
                score: 89.25,
                differingPixels: 10,
                totalPixels: 100,
                referenceHeight: 1000,
                rebuildHeight: 900,
              },
            ],
          },
        },
        {
          dir: '/p/.shipstudio/fidelity/pass-2',
          report: {
            label: 'home',
            reference: 'https://example.com/',
            rebuild: 'http://localhost:3000/',
            capturedAt: '2026-09-08T01:00:00.000Z',
            score: 99.8,
            rebuildCss: null,
            breakpoints: [
              {
                breakpoint: 1440,
                score: 99.8,
                differingPixels: 1,
                totalPixels: 100,
                referenceHeight: 1000,
                rebuildHeight: 1000,
              },
            ],
          },
        },
      ];
    });
  });

  it('reports the latest pass, and every pass as history', async () => {
    const run = await loadFidelityRun('/p');
    // The panel opens on where the work *is*, not where it started.
    expect(run.templates[0].status).toBe('compared');
    expect(runScore(run)).toBe(99.8);
    expect(run.history.map((h) => h.score)).toEqual([89.25, 99.8]);
    // Passes are labelled with the name the agent gave them.
    expect(run.history.map((h) => h.note)).toEqual(['pass-1', 'pass-2']);
  });

  it('resolves image directories under the run that produced them', async () => {
    const run = await loadFidelityRun('/p');
    const template = run.templates[0];
    if (template.status !== 'compared') throw new Error('expected a compared template');
    expect(template.breakpoints[0].dir).toBe('/p/.shipstudio/fidelity/pass-2/home/1440');
  });

  it('carries whether the latest run finished', async () => {
    // A run is written after every width so an interruption is not lost, which
    // means a report can describe two widths when four were asked for. Without
    // this the panel would present half a run as a verdict on the whole page.
    const run = await loadFidelityRun('/p');
    expect(run.complete).toBe(true);
  });

  it('fails rather than inventing a run when there are none', async () => {
    clearMocks();
    mockIPC(() => []);
    await expect(loadFidelityRun('/p')).rejects.toThrow();
  });
});

describe('fidelityBand', () => {
  it('treats the measurement floor as a match', () => {
    // The engine's own noise on a page compared against itself is ~0.3%, so
    // anything above 99.5 is as close as this can tell. A stricter bar would
    // be unreachable and would keep every migration permanently unfinished.
    expect(fidelityBand(99.7)).toBe('match');
    expect(fidelityBand(99.4)).toBe('close');
    expect(fidelityBand(94)).toBe('off');
    expect(fidelityBand(60)).toBe('broken');
  });
});

describe('runScore', () => {
  it('is null when nothing has been compared', () => {
    // Not zero. Zero would say the rebuild is broken; null says nobody looked.
    const run: FidelityRun = {
      reference: 'https://example.com/',
      rebuild: 'http://localhost:3000/',
      complete: true,
      rebuildOverlay: null,
      history: [],
      templates: [
        { template: 'home', route: '/', status: 'not-compared', reason: 'Not rebuilt yet' },
      ],
    };
    expect(runScore(run)).toBeNull();
  });
});
