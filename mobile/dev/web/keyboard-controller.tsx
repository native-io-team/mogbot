/** Web QA stand-in for react-native-keyboard-controller: plain views (see metro.config.js). */
import { forwardRef, type ComponentRef, type ReactNode } from 'react';
import { ScrollView, View, type ScrollViewProps, type ViewProps } from 'react-native';

export function KeyboardProvider({ children }: { children: ReactNode }) {
  return <>{children}</>;
}

export function KeyboardStickyView({
  offset: _offset,
  ...props
}: ViewProps & { offset?: unknown }) {
  return <View {...props} />;
}

type ScrollProps = ScrollViewProps & {
  offset?: unknown;
  bottomOffset?: number;
  inverted?: boolean;
};

export const KeyboardAwareScrollView = forwardRef<ComponentRef<typeof ScrollView>, ScrollProps>(
  function Aware({ offset: _offset, bottomOffset: _bottom, inverted: _inverted, ...props }, ref) {
    return <ScrollView ref={ref} {...props} />;
  }
);

export const KeyboardChatScrollView = KeyboardAwareScrollView;

export const useKeyboardHandler = () => {};
export const useReanimatedKeyboardAnimation = () => ({
  height: { value: 0 },
  progress: { value: 0 },
});
export const KeyboardController = { dismiss: async () => {}, setFocusTo: () => {} };
