import { render, screen } from '@testing-library/react-native';
import { Switch } from 'react-native';
import { Row } from '../src/components/ui';

/**
 * Found on the iOS Simulator (XCUITest's accessibility tree): every Row
 * without an onPress was a disabled Pressable, so a plain fact read as
 * "dimmed", and Settings → Haptics was one element, "Haptics, Haptics,
 * dimmed", with the switch inside it out of VoiceOver's reach.
 */

/** The row's own host view: the label's nearest touchable ancestor. */
function hostRow(label: string) {
  let node = screen.getByText(label).parent;
  while (node && !node.props.onResponderGrant) node = node.parent;
  if (!node) throw new Error(`No row around ${label}`);
  return node;
}

/** What VoiceOver is told about it being dimmed. */
function dimmed(node: { props: { accessibilityState?: unknown } }): boolean | undefined {
  return (node.props.accessibilityState as { disabled?: boolean } | undefined)?.disabled;
}

describe('Row, to VoiceOver', () => {
  it('a fact is not dimmed and not a button', async () => {
    await render(<Row label="Paired" value="Nov 9" />);
    const row = hostRow('Paired');
    expect(dimmed(row)).not.toBe(true);
    expect(row.props.accessibilityRole).toBeUndefined();
  });

  it('a row holding a switch lets the switch be its own element', async () => {
    await render(
      <Row
        label="Haptics"
        trailing={<Switch value onValueChange={() => {}} accessibilityLabel="Haptics" />}
      />
    );
    expect(screen.getByRole('switch', { name: 'Haptics' })).toBeTruthy();
    const row = hostRow('Haptics');
    expect(row.props.accessible).toBe(false);
    expect(dimmed(row)).not.toBe(true);
  });

  it('an action stays one button; a disabled one is still announced, dimmed', async () => {
    await render(<Row label="Connection details" onPress={() => {}} />);
    expect(screen.getByRole('button', { name: 'Connection details' })).toBeTruthy();
    await render(<Row label="Use now" onPress={() => {}} disabled />);
    const off = screen.getByRole('button', { name: 'Use now' });
    expect(dimmed(off)).toBe(true);
  });
});
