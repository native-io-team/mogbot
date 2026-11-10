/**
 * A chart block, drawn as plain SVG from the shared model (`chartModel` in
 * companion-protocol's blocks.ts), so the phone draws the same paths. Thin
 * marks, a recessive grid, a legend only for two or more series, a crosshair
 * and tooltip on hover (arrow keys move it, for the keyboard), and the
 * numbers as a table one click away.
 *
 * @module components/agents/blocks/BlockChart
 */

import { useLayoutEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { TextButton } from '../../primitives/TextButton';
import {
  chartHasData,
  chartLabel,
  chartModel,
  formatValue,
  indexAt,
  legendEntries,
  tooltipAt,
  type CartesianModel,
  type ChartBlock,
  type PieModel,
} from '../../../../packages/companion-protocol/src/blocks';
import { TableView } from './BlockTable';

const HEIGHT = { cartesian: 200, pie: 168, sparkline: 44 } as const;
/** Before the first measure, and in tests (no ResizeObserver). */
const FALLBACK_WIDTH = 560;

/** The element's width, kept current. */
export function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(FALLBACK_WIDTH);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const read = () => {
      const w = el.getBoundingClientRect().width;
      if (w > 0) setWidth(Math.round(w));
    };
    read();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(read);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, width] as const;
}

const series = (slot: number) => `var(--chart-series-${slot})`;

export function BlockChart({ block }: { block: ChartBlock }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [asTable, setAsTable] = useState(false);
  const pie = block.chart === 'pie' || block.chart === 'donut';
  const spark = block.chart === 'sparkline';
  const legend = legendEntries(block);
  if (!chartHasData(block)) {
    return <p className="agent-block-chart__empty">No numbers to show yet.</p>;
  }
  const height = pie ? HEIGHT.pie : spark ? HEIGHT.sparkline : HEIGHT.cartesian;
  const model = chartModel(block, pie ? Math.min(width, height) : width, height);
  return (
    <div className="agent-block-chart" data-chart={block.chart}>
      {block.axis && !pie && !spark && (
        <span className="agent-block-chart__axis">{block.axis}</span>
      )}
      <div className="agent-block-chart__frame" data-pie={pie || undefined}>
        <div ref={ref} className="agent-block-chart__plot" data-pie={pie || undefined}>
          {model.type === 'pie' ? (
            <PieChart block={block} model={model} />
          ) : (
            <Cartesian block={block} model={model} width={width} height={height} />
          )}
        </div>
        {legend.length > 0 && (
          <ul className="agent-block-chart__legend" aria-label="Legend">
            {legend.map((entry, i) => (
              <li key={i}>
                <span
                  className="agent-block-chart__key"
                  data-shape={block.chart === 'line' ? 'line' : 'box'}
                  style={{ background: series(entry.slot) }}
                  aria-hidden
                />
                {entry.name}
                {pie && model.type === 'pie' && (
                  <span className="agent-block-chart__share">
                    {sharePct(model.slices.find((s) => s.index === i)?.share)}
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
      {!spark && (
        <div className="agent-block-chart__foot">
          <TextButton onClick={() => setAsTable((v) => !v)} aria-expanded={asTable}>
            {asTable ? 'Hide the numbers' : 'Show the numbers'}
          </TextButton>
        </div>
      )}
      {asTable && <TableView table={chartAsTable(block)} />}
    </div>
  );
}

const sharePct = (share: number | undefined) =>
  share == null ? '' : `${share >= 0.1 ? Math.round(share * 100) : Math.round(share * 1000) / 10}%`;

/** The chart's numbers as a table block, for the table view. */
function chartAsTable(block: ChartBlock) {
  return {
    kind: 'table' as const,
    summary: '',
    columns: [
      { label: '' },
      ...block.series.map((s) => ({
        label: s.name || block.title || 'Value',
        numeric: true,
        prefix: block.prefix,
        suffix: block.suffix,
      })),
    ],
    rows: block.labels.map((label, i) => [label, ...block.series.map((s) => s.values[i] ?? null)]),
  };
}

function Cartesian({
  block,
  model,
  width,
  height,
}: {
  block: ChartBlock;
  model: CartesianModel;
  width: number;
  height: number;
}) {
  const [at, setAt] = useState<number | null>(null);
  const spark = block.chart === 'sparkline';
  const n = model.xs.length;
  const move = (e: PointerEvent<SVGSVGElement>) => {
    const box = e.currentTarget.getBoundingClientRect();
    setAt(indexAt(model, e.clientX - box.left));
  };
  const key = (e: KeyboardEvent<SVGSVGElement>) => {
    if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
      e.preventDefault();
      const step = e.key === 'ArrowRight' ? 1 : -1;
      setAt((i) => Math.max(0, Math.min(n - 1, (i ?? (step > 0 ? -1 : n)) + step)));
    } else if (e.key === 'Escape') setAt(null);
  };
  const tip = at == null || spark ? null : tooltipAt(block, at);
  const tipX = at == null ? 0 : model.xs[at];
  const flip = tipX > width * 0.6;
  // The end of a single line carries its value: the one direct label.
  const endLabel =
    !spark && block.series.length === 1 && block.chart !== 'bar'
      ? lastPoint(model.lines[0]?.points ?? [])
      : null;
  return (
    <div className="agent-block-chart__canvas">
      <svg
        width={width}
        height={height}
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        aria-label={chartLabel(block)}
        tabIndex={spark ? undefined : 0}
        onPointerMove={spark ? undefined : move}
        onPointerLeave={() => setAt(null)}
        onKeyDown={spark ? undefined : key}
        onBlur={() => setAt(null)}
      >
        {model.ticks.map((t) => (
          <g key={t.value}>
            <line
              className={
                t.y === model.baseline ? 'agent-block-chart__baseline' : 'agent-block-chart__grid'
              }
              x1={model.plot.x}
              x2={model.plot.x + model.plot.w}
              y1={t.y}
              y2={t.y}
            />
            <text
              className="agent-block-chart__tick"
              x={model.plot.x - 8}
              y={t.y}
              textAnchor="end"
              dy="0.32em"
            >
              {t.label}
            </text>
          </g>
        ))}
        {model.xLabels.map((l) => (
          <text
            key={l.index}
            className="agent-block-chart__tick"
            x={l.x}
            y={model.plot.y + model.plot.h + 15}
            textAnchor={
              block.chart === 'bar'
                ? 'middle'
                : l.index === 0
                  ? 'start'
                  : l.index === n - 1
                    ? 'end'
                    : 'middle'
            }
          >
            {l.label}
          </text>
        ))}
        {at != null && !spark && (
          <rect
            className="agent-block-chart__column"
            x={model.xs[at] - Math.max(model.band, 8) / 2}
            y={model.plot.y}
            width={Math.max(model.band, 8)}
            height={model.plot.h}
          />
        )}
        {model.lines.map(
          (s) =>
            s.area && (
              <path
                key={`a${s.slot}`}
                d={s.area}
                className="agent-block-chart__area"
                data-stacked={block.stacked || undefined}
                style={{ fill: series(s.slot) }}
              />
            )
        )}
        {model.bars.map((b) => (
          <path
            key={`${b.series}:${b.index}`}
            d={b.path}
            style={{ fill: series(b.slot) }}
            className="agent-block-chart__bar"
            data-dim={at != null && at !== b.index ? true : undefined}
          />
        ))}
        {model.lines.map((s) => (
          <path
            key={`l${s.slot}`}
            d={s.line}
            className="agent-block-chart__line"
            data-spark={spark || undefined}
            style={{ stroke: series(s.slot) }}
          />
        ))}
        {spark && model.lines[0] && <EndDot points={model.lines[0].points} slot={1} />}
        {endLabel && at == null && (
          <>
            <circle
              className="agent-block-chart__dot"
              cx={endLabel.x}
              cy={endLabel.y}
              r={4}
              style={{ fill: series(1) }}
            />
            <text
              className="agent-block-chart__value"
              x={endLabel.x - 6}
              y={endLabel.y - 10}
              textAnchor="end"
            >
              {formatValue(endLabel.value, block)}
            </text>
          </>
        )}
        {at != null &&
          !spark &&
          model.lines.map((s) => {
            const p = s.points[at];
            return (
              p && (
                <circle
                  key={`d${s.slot}`}
                  className="agent-block-chart__dot"
                  cx={p.x}
                  cy={p.y}
                  r={4}
                  style={{ fill: series(s.slot) }}
                />
              )
            );
          })}
        {at != null && block.chart !== 'bar' && !spark && (
          <line
            className="agent-block-chart__crosshair"
            x1={tipX}
            x2={tipX}
            y1={model.plot.y}
            y2={model.plot.y + model.plot.h}
          />
        )}
      </svg>
      {tip && (
        <div
          className="agent-block-chart__tooltip"
          role="status"
          style={{
            left: flip ? undefined : tipX + 12,
            right: flip ? width - tipX + 12 : undefined,
            top: model.plot.y,
          }}
        >
          <span className="agent-block-chart__tooltip-title">{tip.title}</span>
          {tip.rows.map((r) => (
            <span key={r.slot} className="agent-block-chart__tooltip-row">
              <span
                className="agent-block-chart__key"
                data-shape="box"
                style={{ background: series(r.slot) }}
                aria-hidden
              />
              {block.series.length > 1 && (
                <span className="agent-block-chart__tooltip-name">{r.name}</span>
              )}
              <span className="agent-block-chart__tooltip-value">{r.value}</span>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

function lastPoint(points: CartesianModel['lines'][number]['points']) {
  for (let i = points.length - 1; i >= 0; i--) if (points[i]) return points[i]!;
  return null;
}

function EndDot({
  points,
  slot,
}: {
  points: CartesianModel['lines'][number]['points'];
  slot: number;
}) {
  const p = lastPoint(points);
  return p ? (
    <circle
      className="agent-block-chart__dot"
      cx={p.x}
      cy={p.y}
      r={3}
      style={{ fill: series(slot) }}
    />
  ) : null;
}

function PieChart({ block, model }: { block: ChartBlock; model: PieModel }) {
  const [at, setAt] = useState<number | null>(null);
  const size = model.cx * 2;
  const hovered = at == null ? null : model.slices.find((s) => s.index === at);
  const units = { prefix: block.prefix, suffix: block.suffix };
  return (
    <div className="agent-block-chart__canvas" data-pie>
      <svg
        width={size}
        height={model.cy * 2}
        viewBox={`0 0 ${size} ${model.cy * 2}`}
        role="img"
        aria-label={chartLabel(block)}
        onPointerLeave={() => setAt(null)}
      >
        {model.slices.map((s) => (
          <path
            key={s.index}
            d={s.path}
            className="agent-block-chart__slice"
            style={{ fill: series(s.slot) }}
            data-dim={at != null && at !== s.index ? true : undefined}
            onPointerEnter={() => setAt(s.index)}
            fillRule="evenodd"
          />
        ))}
        {block.chart === 'donut' && (
          <text
            className="agent-block-chart__centre"
            x={model.cx}
            y={model.cy}
            textAnchor="middle"
            dy="0.32em"
          >
            {hovered ? sharePct(hovered.share) : formatValue(model.total, units)}
          </text>
        )}
      </svg>
      {hovered && block.chart === 'pie' && (
        <div className="agent-block-chart__tooltip" role="status" style={{ left: size + 8 }}>
          <span className="agent-block-chart__tooltip-title">{hovered.label}</span>
          <span className="agent-block-chart__tooltip-row">
            <span className="agent-block-chart__tooltip-value">
              {formatValue(hovered.value, units, true)} · {sharePct(hovered.share)}
            </span>
          </span>
        </div>
      )}
    </div>
  );
}
