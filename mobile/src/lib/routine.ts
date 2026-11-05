/**
 * The routine picker's state, and the schedule it means. The logic is shared
 * with the desk's schedule popover, so a phone-made routine and a desk-made
 * one are built by the same code: see
 * `packages/companion-protocol/src/routinePicker.ts`.
 */

export {
  CADENCES,
  INTERVALS,
  intervalLabel,
  newPicker,
  onceDays,
  pickerOf,
  toggleDay,
  WEEK,
  whenOf,
  type Cadence,
  type PickerState,
} from '@shipstudio/companion-protocol';
