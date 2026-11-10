/**
 * A table block: sortable by any column (click its header, again to turn it
 * round), numbers right-aligned in tabular figures, the first rows shown and
 * the rest behind "Show all". Wide tables scroll inside the card, never the
 * chat.
 *
 * @module components/agents/blocks/BlockTable
 */

import { useMemo, useState } from 'react';
import { SortVerticalDownIcon, SortVerticalUpIcon } from '@/components/icons';
import { TextButton } from '../../primitives/TextButton';
import {
  TABLE_ROWS_SHOWN,
  formatCell,
  shortColumns,
  sortRows,
  type SortDir,
  type TableBlock,
} from '../../../../packages/companion-protocol/src/blocks';

type TableData = Pick<TableBlock, 'columns' | 'rows'>;

export function BlockTable({ block }: { block: TableBlock }) {
  return <TableView table={block} />;
}

export function TableView({ table }: { table: TableData }) {
  const [sort, setSort] = useState<{ col: number; dir: SortDir } | null>(null);
  const [all, setAll] = useState(false);
  const rows = useMemo(
    () => (sort ? sortRows(table.rows, sort.col, sort.dir) : table.rows),
    [table.rows, sort]
  );
  const short = useMemo(() => shortColumns(table), [table]);
  const shown = all ? rows : rows.slice(0, TABLE_ROWS_SHOWN);
  const more = rows.length - shown.length;
  const toggle = (col: number) =>
    setSort((s) =>
      s?.col === col
        ? { col, dir: s.dir === 'asc' ? 'desc' : 'asc' }
        : // Numbers start biggest first: that's what people sort them for.
          { col, dir: table.columns[col]?.numeric ? 'desc' : 'asc' }
    );
  return (
    <div className="agent-block-table">
      <div className="agent-block-table__scroll" tabIndex={0} role="region" aria-label="Table">
        <table>
          <thead>
            <tr>
              {table.columns.map((c, i) => {
                const on = sort?.col === i;
                return (
                  <th
                    key={i}
                    scope="col"
                    data-numeric={c.numeric || undefined}
                    aria-sort={on ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}
                  >
                    {c.label ? (
                      <button
                        type="button"
                        className="agent-block-table__sort"
                        onClick={() => toggle(i)}
                      >
                        {c.label}
                        <span
                          className="agent-block-table__arrow"
                          data-on={on || undefined}
                          aria-hidden
                        >
                          {on && sort.dir === 'asc' ? (
                            <SortVerticalUpIcon size={12} />
                          ) : (
                            <SortVerticalDownIcon size={12} />
                          )}
                        </span>
                      </button>
                    ) : null}
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {shown.map((row, r) => (
              <tr key={r}>
                {table.columns.map((c, i) =>
                  i === 0 ? (
                    <th
                      key={i}
                      scope="row"
                      data-numeric={c.numeric || undefined}
                      data-short={short[i] || undefined}
                    >
                      {formatCell(row[i] ?? null, c)}
                    </th>
                  ) : (
                    <td
                      key={i}
                      data-numeric={c.numeric || undefined}
                      data-short={short[i] || undefined}
                      data-empty={row[i] == null || undefined}
                    >
                      {formatCell(row[i] ?? null, c) || '–'}
                    </td>
                  )
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {(more > 0 || all) && rows.length > TABLE_ROWS_SHOWN && (
        <div className="agent-block-table__more">
          <TextButton onClick={() => setAll((v) => !v)} aria-expanded={all}>
            {all ? 'Show fewer' : `Show all ${rows.length} rows`}
          </TextButton>
        </div>
      )}
    </div>
  );
}
