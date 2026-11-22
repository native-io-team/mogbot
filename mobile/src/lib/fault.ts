/**
 * Where something this phone couldn't handle is reported (the session sends
 * it to the crash log). A throw out of a socket callback or a timer is fatal
 * in a release build, so a frame or an event that trips the code is reported
 * and skipped, never let through.
 */

let report: (error: unknown) => void = () => {};

export function setFaultReporter(to: (error: unknown) => void) {
  report = to;
}

/** Best effort: never throws. */
export function reportFault(error: unknown) {
  try {
    report(error);
  } catch {
    // Reporting is best effort.
  }
}

/** Runs `fn`; what it throws is reported, and goes no further. */
export function guarded(fn: () => void) {
  try {
    fn();
  } catch (e) {
    reportFault(e);
  }
}
