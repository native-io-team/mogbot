//! One probe for everyone asking at once.
//!
//! Several surfaces ask the same slow question in the same instant: the
//! Agents overview, the usage inventory and setup status each wanted
//! `claude auth status` (a Node process, ~0.3 s of CPU), and one launch's log
//! showed seven of them started within 100 ms. [`Joined::run`] lets the
//! callers that arrive while a probe is running wait for that probe's answer
//! instead of starting their own. Nothing is cached beyond that: a caller that
//! arrives after the last probe finished runs a fresh one, so no answer is
//! older than it would have been had each caller probed for itself.

use std::future::Future;
use std::time::Instant;

pub struct Joined<T> {
    /// The last probe's answer and when it finished.
    last: tokio::sync::Mutex<Option<(Instant, T)>>,
}

impl<T: Clone> Joined<T> {
    pub const fn new() -> Self {
        Self {
            last: tokio::sync::Mutex::const_new(None),
        }
    }

    /// `probe`'s answer, or the answer of the probe that was already running
    /// when this was called.
    pub async fn run<F, Fut>(&self, probe: F) -> T
    where
        F: FnOnce() -> Fut,
        Fut: Future<Output = T>,
    {
        let asked = Instant::now();
        let mut last = self.last.lock().await;
        if let Some((finished, answer)) = last.as_ref() {
            // It finished after this caller asked: it was running while this
            // caller waited for the lock.
            if *finished >= asked {
                return answer.clone();
            }
        }
        let answer = probe().await;
        *last = Some((Instant::now(), answer.clone()));
        answer
    }
}

impl<T: Clone> Default for Joined<T> {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::time::Duration;

    #[tokio::test]
    async fn callers_arriving_during_a_probe_share_its_answer() {
        static JOINED: Joined<usize> = Joined::new();
        static PROBES: AtomicUsize = AtomicUsize::new(0);
        let probe = || async {
            let n = PROBES.fetch_add(1, Ordering::SeqCst) + 1;
            tokio::time::sleep(Duration::from_millis(50)).await;
            n
        };
        let (a, b, c, d) = tokio::join!(
            JOINED.run(probe),
            JOINED.run(probe),
            JOINED.run(probe),
            JOINED.run(probe)
        );
        assert_eq!(
            PROBES.load(Ordering::SeqCst),
            1,
            "one probe for four callers"
        );
        assert_eq!((a, b, c, d), (1, 1, 1, 1));
    }

    #[tokio::test]
    async fn a_caller_after_the_probe_finished_probes_again() {
        static JOINED: Joined<usize> = Joined::new();
        static PROBES: AtomicUsize = AtomicUsize::new(0);
        let probe = || async { PROBES.fetch_add(1, Ordering::SeqCst) + 1 };
        assert_eq!(JOINED.run(probe).await, 1);
        tokio::time::sleep(Duration::from_millis(2)).await;
        assert_eq!(JOINED.run(probe).await, 2, "nothing is kept past the probe");
    }

    #[tokio::test]
    async fn a_cancelled_caller_leaves_the_next_one_to_probe() {
        static JOINED: Joined<usize> = Joined::new();
        static PROBES: AtomicUsize = AtomicUsize::new(0);
        let slow = || async {
            PROBES.fetch_add(1, Ordering::SeqCst);
            tokio::time::sleep(Duration::from_secs(10)).await;
            0
        };
        let cancelled = tokio::time::timeout(Duration::from_millis(10), JOINED.run(slow)).await;
        assert!(cancelled.is_err());
        let answer = JOINED
            .run(|| async { PROBES.fetch_add(1, Ordering::SeqCst) + 1 })
            .await;
        assert_eq!(answer, 2);
    }
}
