//! The agent browser (prototype, behind the `agent-browser` cargo feature,
//! not wired into agent turns): the user's installed Google Chrome, started
//! by the app with a profile folder of its own and controlled over a CDP
//! pipe, so agents get a real browser the user can watch and drive from the
//! phone.
//!
//! - [`chrome`]: finding Chrome and the exact command line (held by tests).
//! - [`cdp`]: CDP over `--remote-debugging-pipe`, pages, clicks and typing.
//! - [`viewer`]: a loopback stand-in for the phone live view (frames out,
//!   taps and keys in).
//!
//! Run the end-to-end proof (launches Chrome with a throwaway profile):
//! `cargo run --features agent-browser --example agent_browser_demo -- <dir>`.
//! Findings, design and the "not getting blocked" rules:
//! docs/internal/agent-browser.md.

pub mod cdp;
pub mod chrome;
pub mod viewer;
