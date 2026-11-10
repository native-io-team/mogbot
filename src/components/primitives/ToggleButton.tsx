import { forwardRef } from 'react';
import { Button, type ButtonProps } from './Button';

/** Props for a button-family control with an explicit boolean pressed state. */
export interface ToggleButtonProps extends Omit<ButtonProps, 'aria-pressed'> {
  pressed: boolean;
}

export const ToggleButton = forwardRef<HTMLButtonElement, ToggleButtonProps>(function ToggleButton(
  { pressed, ...props },
  ref
) {
  // As a radio (a choice in a radiogroup) its state is aria-checked, which
  // the caller sets; aria-pressed isn't allowed on that role, so the chosen
  // look comes from data-selected instead.
  const asRadio = props.role === 'radio' || props.role === 'menuitemradio';
  return asRadio ? (
    <Button ref={ref} data-selected={pressed || undefined} {...props} />
  ) : (
    <Button ref={ref} aria-pressed={pressed} {...props} />
  );
});
