/**
 * Settings → Appearance → Chat width: Narrow / Medium / Wide.
 *
 * The choice applies at once (every open window follows, see lib/chatWidth.ts)
 * and is then saved to the app settings.
 *
 * @module components/dashboard/ChatWidthSetting
 */

import { SegmentedControl } from '../primitives/SegmentedControl';
import { useOptionalToast } from '../../contexts/ToastContext';
import { CHAT_WIDTHS, CHAT_WIDTH_LABELS, setChatWidth, useChatWidth } from '../../lib/chatWidth';

const OPTIONS = CHAT_WIDTHS.map((value) => ({ value, label: CHAT_WIDTH_LABELS[value] }));

export function ChatWidthSetting() {
  const { showToast } = useOptionalToast();
  const width = useChatWidth();

  return (
    <div className="settings-row">
      <div className="settings-row-info">
        <span className="settings-row-label">Chat width</span>
        <span className="settings-row-description">
          How wide conversations run in the window. Medium and Wide show replies without a bubble.
        </span>
      </div>
      <SegmentedControl
        aria-label="Chat width"
        value={width}
        options={OPTIONS}
        onValueChange={(next) => {
          setChatWidth(next).catch(() => {
            showToast("Couldn't save the chat width", 'error');
          });
        }}
      />
    </div>
  );
}
