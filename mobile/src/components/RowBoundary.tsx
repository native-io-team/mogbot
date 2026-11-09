/**
 * One row of a conversation that fails to draw (a card from a Mac of another
 * version, in a shape this phone doesn't know) becomes one quiet Line saying
 * so; the rest of the chat, and the screen around it, stay as they were. The
 * error goes to this phone's crash log. A new copy of the row (the Mac
 * answering a card, a newer version) gets another try.
 */

import { Component, type ReactNode } from 'react';
import { recordCrash } from '../lib/crash';
import { Line } from './surfaces';

/**
 * A row's content: the message itself (a new copy is a new object), else the
 * row's kind and key, so a list redrawn around a failed row doesn't retry it
 * (and log it again) on every render.
 */
export function rowResetKey(item: { kind: string; key?: string; message?: unknown }): unknown {
  return item.kind === 'message' && item.message ? item.message : `${item.kind}:${item.key ?? ''}`;
}

export const ROW_ERROR = 'This message couldn’t be shown.';

interface Props {
  /** Changes when the row's content does: a new value draws it again. */
  resetKey?: unknown;
  children: ReactNode;
}

export class RowBoundary extends Component<Props, { failed: boolean; key: unknown }> {
  state = { failed: false, key: this.props.resetKey };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  static getDerivedStateFromProps(props: Props, state: { failed: boolean; key: unknown }) {
    if (props.resetKey !== state.key) return { failed: false, key: props.resetKey };
    return null;
  }

  componentDidCatch(error: unknown) {
    void recordCrash(error, 'render', false).catch(() => {});
  }

  render() {
    if (this.state.failed)
      return <Line text={ROW_ERROR} icon="exclamationmark.triangle" testID="row-error" />;
    return this.props.children;
  }
}
