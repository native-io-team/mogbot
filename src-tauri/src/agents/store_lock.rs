//! The registry lock: one writer at a time over `agents.json`.
//!
//! ## The rules (a phone that couldn't reach its Mac is why they're written down)
//!
//! - **Readers never take it.** `list`/`get`/`find` read the cached registry
//!   or the file, which every write replaces by an atomic rename, so a read
//!   sees one whole version or the next. Only a damaged file (recovery
//!   rewrites it) sends a read through the lock.
//! - **It is the innermost lock.** Held, it covers reading `agents.json`,
//!   the caller's change and writing the file back: nothing else. Never a
//!   keychain call, a child process, an event emit, a network call, another
//!   module's lock or a `store` call. `update`'s closure is a pure edit of
//!   the agent it is handed; work that follows from the change (forgetting
//!   a deleted agent's rooms, secrets and policy) runs after it is released.
//!   Other locks may be held while taking it (`runner::RUNTIMES` in
//!   `update_settings`), which is safe only because it takes nothing itself.
//! - **No re-entry.** A `std::sync::Mutex` taken twice on one thread waits
//!   on itself forever. A second take on the same thread is refused with an
//!   error instead, and logged with both places.
//! - **Nobody waits forever.** A writer that can't have it within
//!   [`wait`] gets a "busy" error naming nothing internal, and the log names
//!   where it is held and for how long.

use std::cell::Cell;
use std::panic::Location;
use std::sync::{Mutex, MutexGuard, TryLockError};
use std::time::{Duration, Instant};

use crate::errors::CommandError;

static LOCK: Mutex<()> = Mutex::new(());

/// Where the lock is held from, and since when: what the log says when a
/// writer gives up on it.
static HOLDER: Mutex<Option<(&'static Location<'static>, Instant)>> = Mutex::new(None);

thread_local! {
    /// Where this thread holds the lock, if it does.
    static HELD_AT: Cell<Option<&'static Location<'static>>> = const { Cell::new(None) };
}

/// How long a writer waits before it gives up and says the agents list is busy.
const WAIT: Duration = Duration::from_secs(10);

#[cfg(test)]
static WAIT_OVERRIDE: Mutex<Option<Duration>> = Mutex::new(None);

#[cfg(test)]
pub fn set_wait_for_tests(wait: Option<Duration>) {
    *WAIT_OVERRIDE.lock().unwrap_or_else(|e| e.into_inner()) = wait;
}

fn wait() -> Duration {
    #[cfg(test)]
    if let Some(w) = *WAIT_OVERRIDE.lock().unwrap_or_else(|e| e.into_inner()) {
        return w;
    }
    WAIT
}

/// What the user is told when the list couldn't be had in time.
pub const BUSY: &str = "Your agents list is busy right now. Try again in a moment.";

/// The lock, held. Dropping it releases it.
pub struct Held {
    _guard: MutexGuard<'static, ()>,
}

impl Drop for Held {
    fn drop(&mut self) {
        HELD_AT.with(|h| h.set(None));
        *HOLDER.lock().unwrap_or_else(|e| e.into_inner()) = None;
    }
}

/// Whether this thread holds the registry lock now.
pub fn held_here() -> bool {
    HELD_AT.with(|h| h.get().is_some())
}

/// Take the registry lock: refused on re-entry, and given up on after [`wait`].
#[track_caller]
pub fn take() -> Result<Held, CommandError> {
    let here = Location::caller();
    if let Some(outer) = HELD_AT.with(|h| h.get()) {
        tracing::error!(
            "[Agents] the agents list was asked for again at {here} while this thread holds it (from {outer}); refused rather than waiting on itself"
        );
        return Err(CommandError::expected(BUSY));
    }
    let deadline = Instant::now() + wait();
    let mut pause = Duration::from_millis(1);
    let guard = loop {
        match LOCK.try_lock() {
            Ok(guard) => break guard,
            Err(TryLockError::Poisoned(e)) => break e.into_inner(),
            Err(TryLockError::WouldBlock) => {
                if Instant::now() >= deadline {
                    let holder = *HOLDER.lock().unwrap_or_else(|e| e.into_inner());
                    match holder {
                        Some((at, since)) => tracing::error!(
                            "[Agents] gave up waiting for the agents list at {here}: held from {at} for {:?}",
                            since.elapsed()
                        ),
                        None => tracing::error!(
                            "[Agents] gave up waiting for the agents list at {here}"
                        ),
                    }
                    return Err(CommandError::expected(BUSY));
                }
                std::thread::sleep(pause);
                pause = (pause * 2).min(Duration::from_millis(10));
            }
        }
    };
    HELD_AT.with(|h| h.set(Some(here)));
    *HOLDER.lock().unwrap_or_else(|e| e.into_inner()) = Some((here, Instant::now()));
    Ok(Held { _guard: guard })
}
