//! Paths found by trying to break the runtime (child of runner.rs).
use super::*;

/// A chain of agents asking each other six deep: the sixth did the work,
/// and its answer back to the fifth travels one hop past the cap. Every
/// path that owes an asker word (a finished turn's result, "couldn't
/// finish", "stopped before it started") used to skip it then, so the agent
/// that asked never heard and nothing said why. Past the cap the answer is
/// now shown in the asker's chat, with a line, and still never starts a
/// turn (answers can start further answers, so a cycle of them must end).
#[test]
fn an_answer_past_the_hop_cap_is_shown_not_dropped() {
    assert_eq!(answer_way(0), AnswerWay::Turn(1));
    assert_eq!(answer_way(MAX_HOPS - 1), AnswerWay::Turn(MAX_HOPS));
    assert_eq!(answer_way(MAX_HOPS), AnswerWay::ShowOnly);
    assert_eq!(answer_way(u8::MAX), AnswerWay::ShowOnly);
    let line = chain_end_line("Research", "Writer");
    assert!(line.starts_with("Writer's answer came at the end of a long chain"));
    assert!(line.contains("Message Research to carry on"));
}
