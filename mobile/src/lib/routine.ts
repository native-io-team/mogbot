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
  MONTH_INTERVALS,
  MONTH_KINDS,
  monthKindOf,
  monthsLabel,
  monthWhichChoices,
  monthWhichOf,
  newPicker,
  onceDays,
  pickerOf,
  setMonthKind,
  setMonthWhich,
  toggleDay,
  WEEK,
  whenOf,
  type Cadence,
  type MonthKind,
  type PickerState,
} from '@shipstudio/companion-protocol';
