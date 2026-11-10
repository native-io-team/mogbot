//! How full an agent's conversation is, as its engine reported it.
//!
//! Two numbers, both the engine's own: the tokens its latest model request
//! carried (the conversation as the model last saw it) and the context
//! window it reported for that model. Nothing is estimated. An engine that
//! doesn't report both (Codex through `codex exec`) gives no reading, and the
//! UI shows nothing rather than a guess.
//!
//! What each engine says (observed):
//!
//! - **Claude Code** (2.1.318, `claude -p --output-format stream-json`):
//!   every top-level `assistant` event carries `message.usage` for the API
//!   request it came from (`input_tokens`, `cache_read_input_tokens`,
//!   `cache_creation_input_tokens`, `output_tokens`) and `message.model`. The
//!   `result` event's `modelUsage` has a `contextWindow` per model
//!   (`"claude-haiku-5-5": {"contextWindow": 1000000, …}`). A turn with a
//!   tool call has one `assistant` usage per request; the last is the size.
//! - **Codex app-server** (0.166): `thread/tokenUsage/updated` carries
//!   `tokenUsage.last` (that request: `inputTokens` including cached, and
//!   `outputTokens`, of which `reasoningOutputTokens` are a part) and
//!   `tokenUsage.modelContextWindow`. The model is the one `thread/start` or
//!   `thread/resume` answered with (`result.model`).
//!
//!   Reasoning is left out of the size. The model's reasoning isn't carried
//!   into the next turn's request, so it doesn't fill the conversation, and
//!   Codex's own source (`TokenUsage::tokens_in_context_window`) counts the
//!   context as the total less reasoning. The 0.166 binary carries a
//!   `tokens_in_context` figure separate from its totals, but its app-server
//!   schema documents no formula, so this rests on the source, not on an
//!   observed run with reasoning. Codex's "% context left" also sets aside a
//!   fixed allowance for its system prompt, so its percentage can read a
//!   point or two lower than ours.
//! - **`codex exec --json`**: `turn.completed` has token counts but no
//!   window, so no reading.

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// One reading, stored on the agent until its next turn replaces it, or a
/// fresh start or engine switch clears it.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ContextFill {
    /// Tokens the latest request carried: input, cached input and output
    /// (less reasoning, which the next request doesn't carry).
    pub used: u64,
    /// The model's context window, as the engine reported it.
    pub window: u64,
    pub at: i64,
    /// The model the engine says made that request (its own id, such as
    /// `claude-opus-5-5`), when it says. The window is that model's.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
}

impl ContextFill {
    pub(super) fn new(used: u64, window: u64, at: i64, model: Option<String>) -> Option<Self> {
        (window > 0 && used > 0).then_some(Self {
            used,
            window,
            at,
            model,
        })
    }
}

/// Claude Code's reading needs two events: the last request's size comes
/// with each `assistant` event, the window only with `result`.
#[derive(Debug, Default)]
pub struct ClaudeContext {
    /// The model and size of the latest top-level request.
    last: Option<(String, u64)>,
}

impl ClaudeContext {
    /// Fold in one stream-json line; the reading arrives with `result`.
    pub fn observe(&mut self, value: &Value, now: i64) -> Option<ContextFill> {
        match value.get("type").and_then(Value::as_str) {
            Some("assistant") if super::stream::top_level(value) => {
                let message = value.get("message")?;
                let model = message.get("model").and_then(Value::as_str)?;
                let usage = message.get("usage")?;
                let n = |k: &str| usage.get(k).and_then(Value::as_u64).unwrap_or(0);
                let size = n("input_tokens")
                    .saturating_add(n("cache_read_input_tokens"))
                    .saturating_add(n("cache_creation_input_tokens"))
                    .saturating_add(n("output_tokens"));
                self.last = Some((model.to_string(), size));
                None
            }
            Some("result") => {
                let (model, used) = self.last.take()?;
                // The window of the model that made the request, never another's.
                let window = value
                    .pointer("/modelUsage")
                    .and_then(Value::as_object)?
                    .get(&model)?
                    .get("contextWindow")
                    .and_then(Value::as_u64)?;
                ContextFill::new(used, window, now, Some(model))
            }
            _ => None,
        }
    }
}

/// Codex app-server's `thread/tokenUsage/updated` params, for a thread on `model`.
pub fn from_codex_app(params: &Value, model: Option<&str>, now: i64) -> Option<ContextFill> {
    let usage = params.get("tokenUsage")?;
    let window = usage.get("modelContextWindow").and_then(Value::as_u64)?;
    let last = usage.get("last")?;
    let n = |k: &str| last.get(k).and_then(Value::as_u64).unwrap_or(0);
    // `inputTokens` already includes the cached part; `outputTokens` includes
    // the reasoning, which the next request leaves behind.
    let used = n("inputTokens")
        .saturating_add(n("outputTokens"))
        .saturating_sub(n("reasoningOutputTokens"));
    ContextFill::new(used, window, now, model.map(str::to_string))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn lines(text: &str) -> impl Iterator<Item = Value> + '_ {
        text.lines()
            .filter(|l| !l.trim().is_empty())
            .map(|l| serde_json::from_str(l).unwrap())
    }

    #[test]
    fn reads_claude_codes_last_request_against_its_models_window() {
        let mut ctx = ClaudeContext::default();
        let mut got = None;
        for value in lines(include_str!("testdata/stream-partial.jsonl")) {
            if let Some(fill) = ctx.observe(&value, 7) {
                got = Some(fill);
            }
        }
        // The fixture's second request: 2 + 29968 + 126 + 3, against Haiku's 1M.
        assert_eq!(
            got,
            Some(ContextFill {
                used: 30_099,
                window: 1_000_000,
                at: 7,
                model: Some("claude-haiku-5-5".into()),
            })
        );
    }

    #[test]
    fn no_window_for_that_model_is_no_reading() {
        let mut ctx = ClaudeContext::default();
        let assistant = serde_json::json!({"type": "assistant", "message": {"model": "claude-a",
            "usage": {"input_tokens": 10, "output_tokens": 5}}});
        assert!(ctx.observe(&assistant, 1).is_none());
        let result = serde_json::json!({"type": "result",
            "modelUsage": {"claude-b": {"contextWindow": 200000}}});
        assert!(ctx.observe(&result, 2).is_none());
        // An old Claude Code without `modelUsage` says nothing either.
        ctx.observe(&assistant, 3);
        assert!(ctx
            .observe(&serde_json::json!({"type": "result"}), 4)
            .is_none());
    }

    #[test]
    fn a_sub_agents_request_is_not_the_conversations_size() {
        let mut ctx = ClaudeContext::default();
        let own = serde_json::json!({"type": "assistant", "message": {"model": "m",
            "usage": {"input_tokens": 100, "output_tokens": 0}}});
        let sub = serde_json::json!({"type": "assistant", "parent_tool_use_id": "t1",
            "message": {"model": "m", "usage": {"input_tokens": 999_000}}});
        ctx.observe(&own, 1);
        ctx.observe(&sub, 2);
        let result =
            serde_json::json!({"type": "result", "modelUsage": {"m": {"contextWindow": 1000}}});
        assert_eq!(ctx.observe(&result, 3).map(|f| f.used), Some(100));
    }

    #[test]
    fn reads_codex_app_servers_token_usage() {
        let mut got = None;
        for value in lines(include_str!("testdata/codex-app-server.jsonl")) {
            if value.get("method").and_then(Value::as_str) == Some("thread/tokenUsage/updated") {
                got = from_codex_app(&value["params"], Some("scripted"), 9);
            }
        }
        assert_eq!(
            got,
            Some(ContextFill {
                used: 1_020,
                window: 258_400,
                at: 9,
                model: Some("scripted".into()),
            })
        );
        let no_window = serde_json::json!({"tokenUsage": {"last": {"inputTokens": 5}}});
        assert!(from_codex_app(&no_window, None, 1).is_none());
    }

    #[test]
    fn codex_reasoning_is_not_part_of_the_conversation() {
        let params = serde_json::json!({"tokenUsage": {"modelContextWindow": 100_000,
            "last": {"inputTokens": 40_000, "cachedInputTokens": 30_000,
                "outputTokens": 9_000, "reasoningOutputTokens": 8_000, "totalTokens": 49_000}}});
        assert_eq!(
            from_codex_app(&params, None, 1).map(|f| f.used),
            Some(41_000)
        );
    }
}
