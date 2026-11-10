//! Blocks (`show`): the right UI at the right moment. An agent answers with
//! data, never markup: a chart from its numbers, a table, metric tiles, facts,
//! a checklist, steps, a comparison with "Pick this", quick replies, a short
//! form, links, a callout, code, or one of its own images. The desk and the
//! phone draw them (`packages/companion-protocol/src/blocks.ts`).
//!
//! Everything is checked here before anything is kept: a known kind, the
//! fields it needs, sizes inside the limits below, numbers that are numbers,
//! links that are http(s) with no credentials, no HTML anywhere (a block's
//! text is drawn as text; `code` is the only field that may hold markup, and
//! it is shown verbatim), and no form that asks for a secret (secrets keep
//! their masked card, `request_secret`).
//!
//! Each block carries a plain-text `summary`, the agent's or one made here,
//! and the message's `text` is the intro plus every summary: what an older
//! client shows, what search finds, what Copy copies.
//!
//! Answering one (a choice, Pick this, a form) is the user's own message,
//! sent through the ordinary path: independence and approvals are unchanged.
//! A set posted in a turn answering outside text is marked `fromOutside`, and
//! the clients then stage the words in the composer instead of sending them.

use serde::{Deserialize, Deserializer, Serialize};
use serde_json::{json, Value};

/// The format the clients draw. A client that knows an older one shows `text`.
pub const VERSION: u32 = 1;

pub const TOOL: &str = "show";

/// Limits. Generous for a chat, small enough that one message stays light.
const MAX_BLOCKS: usize = 8;
const MAX_IMAGES: usize = 4;
const MAX_INTRO: usize = 4_000;
const MAX_SHORT: usize = 120;
const MAX_TEXT: usize = 2_000;
const MAX_CODE: usize = 20_000;
const MAX_SUMMARY: usize = 1_500;
const MAX_POINTS: usize = 120;
const MAX_BAR_CATEGORIES: usize = 40;
const MAX_SERIES: usize = 8;
const MAX_COLUMNS: usize = 8;
const MAX_ROWS: usize = 200;
const MAX_LIST: usize = 40;
const MAX_URL: usize = 2_000;
/// The whole set, as stored.
const MAX_BYTES: usize = 96_000;

pub const DESCRIPTION: &str = "Answer with UI, not just prose: post a message with blocks (charts, tables, metric tiles, facts, a checklist, steps, a comparison, quick replies, a short form, links, a callout, code, an image of yours). Use it when a block says it better than sentences: numbers over time → chart (line/area; bar for categories; pie/donut only for parts of one whole, ≤ 6 slices; sparkline inside a sentence-sized trend); a few headline numbers → metrics; rows of records → table; label/value details → facts; progress → checklist or steps; 2-3 options to weigh → comparison (each gets \"Pick this\"); a quick decision → choices; several details you need from the user → form; sources → links; a caution or an all-clear → callout. Finished deliverables still end on share_result. Data only: plain text, numbers and http(s) links; never HTML, never markdown inside blocks (only `text`, above them, is markdown). Don't repeat in prose what a block shows. A choice, Pick this or a form sends the user's answer as their next message, so ask one of them per call, then end your turn with no more text (no \"tap one above\", no repeat of the question). Never ask for a password, key or token in a form: use request_secret or request_login. Every block may have `title` and `summary` (one plain-text line for apps that can't draw it; made for you if left out). Kinds and their fields:\n\
- chart: `chart` line|bar|area|pie|donut|sparkline; `labels` (x categories, or slice names); `series` [{name, values}] (values line up with labels; null for a gap; pie/donut/sparkline take one series); `stacked` (bar/area); `prefix` (\"$\") / `suffix` (\"%\", \" ms\"); `axis` (what the values measure). Up to 8 series, 120 points (40 bars).\n\
- table: `columns` (labels, or {label, prefix, suffix}); `rows` (arrays of strings/numbers/null, one per column). Up to 8 columns, 200 rows; numbers stay numbers so they sort and align.\n\
- metrics: `items` [{label, value, prefix, suffix, delta (number, or words like \"+12%\"), vs (\"vs last week\"), good (\"up\" or \"down\": which way is good), trend (a few numbers for a sparkline)}], up to 6.\n\
- facts: `items` [{label, value}].\n\
- checklist: `items` [{text, done, note}].\n\
- steps: `items` [{title, detail, status: done|current|todo|failed, when}].\n\
- comparison: `options` (2-3) [{name, summary, pros, cons, facts [{label, value}], recommended, reply (what Pick this sends; default \"Let's go with <name>.\")}].\n\
- choices: `question`; `options` (2-6): labels, or {label, reply}.\n\
- form: `fields` (up to 8) [{id, label, type: text|long_text|choice|date|number, options (choice), required, placeholder}]; `submit` (the button's words).\n\
- links: `items` [{url, label, note}] (the domain is shown; nothing is fetched).\n\
- callout: `tone` info|warning|success; `text`.\n\
- code: `code`; `language` (\"diff\" for a diff).\n\
- image: `path` (an image file in your own folder); `caption`.\n\
Example: {\"text\": \"Signups are up since the launch.\", \"blocks\": [{\"kind\": \"metrics\", \"items\": [{\"label\": \"Signups\", \"value\": 1284, \"delta\": 18, \"suffix\": \"\", \"vs\": \"vs last week\"}]}, {\"kind\": \"chart\", \"chart\": \"line\", \"title\": \"Signups per day\", \"labels\": [\"Mon\", \"Tue\", \"Wed\"], \"series\": [{\"name\": \"Signups\", \"values\": [160, 172, 210]}]}, {\"kind\": \"choices\", \"question\": \"Want the breakdown by channel?\", \"options\": [\"Yes, by channel\", \"Not now\"]}]}";

pub fn schema() -> Value {
    json!({
        "type": "object",
        "properties": {
            "text": { "type": "string", "description": "Optional: your words above the blocks (markdown)." },
            "blocks": {
                "type": "array",
                "description": "1 to 8 blocks, in order. Each is an object with `kind` and that kind's fields (see the tool description).",
                "items": {
                    "type": "object",
                    "properties": {
                        "kind": { "type": "string", "enum": ["chart", "table", "metrics", "facts", "checklist", "steps", "comparison", "choices", "form", "links", "callout", "code", "image"] },
                        "title": { "type": "string" },
                        "summary": { "type": "string", "description": "Optional: the block as one or two plain-text lines." }
                    },
                    "required": ["kind"]
                }
            }
        },
        "required": ["blocks"]
    })
}

/* ------------------------------------------------------------ the types */

/// A string, from a string, a number or a yes/no: agents write `"value": 42`.
fn de_text<'de, D: Deserializer<'de>>(d: D) -> Result<String, D::Error> {
    Ok(match Value::deserialize(d)? {
        Value::String(s) => s,
        Value::Number(n) => n.to_string(),
        Value::Bool(b) => if b { "Yes" } else { "No" }.to_string(),
        Value::Null => String::new(),
        other => {
            return Err(serde::de::Error::custom(format!(
                "expected text, found {}",
                kind_of(&other)
            )))
        }
    })
}

fn de_opt_text<'de, D: Deserializer<'de>>(d: D) -> Result<Option<String>, D::Error> {
    let s = de_text(d)?;
    Ok((!s.trim().is_empty()).then_some(s))
}

fn kind_of(v: &Value) -> &'static str {
    match v {
        Value::Null => "null",
        Value::Bool(_) => "true/false",
        Value::Number(_) => "a number",
        Value::String(_) => "text",
        Value::Array(_) => "a list",
        Value::Object(_) => "an object",
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Block {
    #[serde(default, deserialize_with = "de_text")]
    pub summary: String,
    #[serde(
        default,
        deserialize_with = "de_opt_text",
        skip_serializing_if = "Option::is_none"
    )]
    pub title: Option<String>,
    #[serde(flatten)]
    pub body: Body,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Body {
    Chart(Chart),
    Table(Table),
    Metrics(Items<Metric>),
    Facts(Items<Fact>),
    Checklist(Items<Check>),
    Steps(Items<Step>),
    Comparison(Comparison),
    Choices(Choices),
    Form(Form),
    Links(Items<Link>),
    Callout(Callout),
    Code(Code),
    Image(Image),
}

impl Body {
    fn kind(&self) -> &'static str {
        match self {
            Body::Chart(_) => "chart",
            Body::Table(_) => "table",
            Body::Metrics(_) => "metrics",
            Body::Facts(_) => "facts",
            Body::Checklist(_) => "checklist",
            Body::Steps(_) => "steps",
            Body::Comparison(_) => "comparison",
            Body::Choices(_) => "choices",
            Body::Form(_) => "form",
            Body::Links(_) => "links",
            Body::Callout(_) => "callout",
            Body::Code(_) => "code",
            Body::Image(_) => "image",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(bound(deserialize = "T: Deserialize<'de>"))]
pub struct Items<T> {
    #[serde(default)]
    pub items: Vec<T>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ChartType {
    Line,
    Bar,
    Area,
    Pie,
    Donut,
    Sparkline,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Series {
    #[serde(default, deserialize_with = "de_text")]
    pub name: String,
    #[serde(default)]
    pub values: Vec<Option<f64>>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Chart {
    pub chart: ChartType,
    #[serde(default)]
    pub labels: Vec<Label>,
    #[serde(default)]
    pub series: Vec<Series>,
    /// A shortcut for one series (a pie's slices): becomes `series`.
    #[serde(default, skip_serializing)]
    pub values: Option<Vec<Option<f64>>>,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub stacked: bool,
    #[serde(
        default,
        deserialize_with = "de_opt_text",
        skip_serializing_if = "Option::is_none"
    )]
    pub prefix: Option<String>,
    #[serde(
        default,
        deserialize_with = "de_opt_text",
        skip_serializing_if = "Option::is_none"
    )]
    pub suffix: Option<String>,
    #[serde(
        default,
        deserialize_with = "de_opt_text",
        skip_serializing_if = "Option::is_none"
    )]
    pub axis: Option<String>,
}

/// A label, from text or a number (`2024`).
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(transparent)]
pub struct Label(pub String);

impl<'de> Deserialize<'de> for Label {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        de_text(d).map(Label)
    }
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Column {
    pub label: String,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub numeric: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub prefix: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub suffix: Option<String>,
}

impl<'de> Deserialize<'de> for Column {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        #[derive(Deserialize)]
        struct Full {
            #[serde(default, deserialize_with = "de_text")]
            label: String,
            #[serde(default)]
            numeric: bool,
            #[serde(default, deserialize_with = "de_opt_text")]
            prefix: Option<String>,
            #[serde(default, deserialize_with = "de_opt_text")]
            suffix: Option<String>,
        }
        match Value::deserialize(d)? {
            Value::Object(map) => {
                let f: Full =
                    serde_json::from_value(Value::Object(map)).map_err(serde::de::Error::custom)?;
                Ok(Column {
                    label: f.label,
                    numeric: f.numeric,
                    prefix: f.prefix,
                    suffix: f.suffix,
                })
            }
            other => Ok(Column {
                label: de_text(other).map_err(serde::de::Error::custom)?,
                numeric: false,
                prefix: None,
                suffix: None,
            }),
        }
    }
}

/// A table cell: a number stays a number (it sorts and aligns), anything
/// else is text, and null is empty.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(untagged)]
pub enum Cell {
    Num(f64),
    Text(String),
}

impl<'de> Deserialize<'de> for Cell {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        match Value::deserialize(d)? {
            Value::Number(n) => n
                .as_f64()
                .map(Cell::Num)
                .ok_or_else(|| serde::de::Error::custom("a number too large")),
            other => de_text(other)
                .map(Cell::Text)
                .map_err(serde::de::Error::custom),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Table {
    #[serde(default)]
    pub columns: Vec<Column>,
    #[serde(default)]
    pub rows: Vec<Vec<Option<Cell>>>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Good {
    Up,
    Down,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Metric {
    #[serde(default, deserialize_with = "de_text")]
    pub label: String,
    pub value: Cell,
    #[serde(
        default,
        deserialize_with = "de_opt_text",
        skip_serializing_if = "Option::is_none"
    )]
    pub prefix: Option<String>,
    #[serde(
        default,
        deserialize_with = "de_opt_text",
        skip_serializing_if = "Option::is_none"
    )]
    pub suffix: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub delta: Option<Cell>,
    #[serde(
        default,
        deserialize_with = "de_opt_text",
        skip_serializing_if = "Option::is_none"
    )]
    pub vs: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub good: Option<Good>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub trend: Vec<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Fact {
    #[serde(default, deserialize_with = "de_text")]
    pub label: String,
    #[serde(default, deserialize_with = "de_text")]
    pub value: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Check {
    #[serde(default, deserialize_with = "de_text")]
    pub text: String,
    #[serde(default)]
    pub done: bool,
    #[serde(
        default,
        deserialize_with = "de_opt_text",
        skip_serializing_if = "Option::is_none"
    )]
    pub note: Option<String>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "lowercase")]
pub enum StepStatus {
    Done,
    Current,
    #[default]
    Todo,
    Failed,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Step {
    #[serde(default, deserialize_with = "de_text")]
    pub title: String,
    #[serde(
        default,
        deserialize_with = "de_opt_text",
        skip_serializing_if = "Option::is_none"
    )]
    pub detail: Option<String>,
    #[serde(default)]
    pub status: StepStatus,
    #[serde(
        default,
        deserialize_with = "de_opt_text",
        skip_serializing_if = "Option::is_none"
    )]
    pub when: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Pick {
    #[serde(default, deserialize_with = "de_text")]
    pub name: String,
    #[serde(
        default,
        deserialize_with = "de_opt_text",
        skip_serializing_if = "Option::is_none"
    )]
    pub summary: Option<String>,
    #[serde(default)]
    pub pros: Vec<Label>,
    #[serde(default)]
    pub cons: Vec<Label>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub facts: Vec<Fact>,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub recommended: bool,
    #[serde(default, deserialize_with = "de_text")]
    pub reply: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Comparison {
    #[serde(default)]
    pub options: Vec<Pick>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct Choice {
    pub label: String,
    pub reply: String,
}

impl<'de> Deserialize<'de> for Choice {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        #[derive(Deserialize)]
        struct Full {
            #[serde(default, deserialize_with = "de_text")]
            label: String,
            #[serde(default, deserialize_with = "de_text")]
            reply: String,
        }
        match Value::deserialize(d)? {
            Value::Object(map) => {
                let f: Full =
                    serde_json::from_value(Value::Object(map)).map_err(serde::de::Error::custom)?;
                Ok(Choice {
                    label: f.label,
                    reply: f.reply,
                })
            }
            other => Ok(Choice {
                label: de_text(other).map_err(serde::de::Error::custom)?,
                reply: String::new(),
            }),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Choices {
    #[serde(
        default,
        deserialize_with = "de_opt_text",
        skip_serializing_if = "Option::is_none"
    )]
    pub question: Option<String>,
    #[serde(default)]
    pub options: Vec<Choice>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "snake_case")]
pub enum FieldType {
    #[default]
    Text,
    LongText,
    Choice,
    Date,
    Number,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Field {
    #[serde(default, deserialize_with = "de_text")]
    pub id: String,
    #[serde(default, deserialize_with = "de_text")]
    pub label: String,
    #[serde(default, rename = "type")]
    pub kind: FieldType,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub options: Vec<Label>,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub required: bool,
    #[serde(
        default,
        deserialize_with = "de_opt_text",
        skip_serializing_if = "Option::is_none"
    )]
    pub placeholder: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Form {
    #[serde(default)]
    pub fields: Vec<Field>,
    #[serde(default, deserialize_with = "de_text")]
    pub submit: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Link {
    #[serde(default, deserialize_with = "de_text")]
    pub url: String,
    #[serde(default, deserialize_with = "de_text")]
    pub label: String,
    #[serde(default, deserialize_with = "de_text")]
    pub domain: String,
    #[serde(
        default,
        deserialize_with = "de_opt_text",
        skip_serializing_if = "Option::is_none"
    )]
    pub note: Option<String>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "lowercase")]
pub enum Tone {
    #[default]
    Info,
    Warning,
    Success,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Callout {
    #[serde(default)]
    pub tone: Tone,
    #[serde(default, deserialize_with = "de_text")]
    pub text: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Code {
    #[serde(
        default,
        deserialize_with = "de_opt_text",
        skip_serializing_if = "Option::is_none"
    )]
    pub language: Option<String>,
    #[serde(default, deserialize_with = "de_text")]
    pub code: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Image {
    /// The agent's file, as it asked: copied into the chat as `file`.
    #[serde(default, skip_serializing)]
    pub path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub file: Option<super::attachments::Attachment>,
    #[serde(
        default,
        deserialize_with = "de_opt_text",
        skip_serializing_if = "Option::is_none"
    )]
    pub caption: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BlockSet {
    pub v: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub intro: Option<String>,
    pub items: Vec<Block>,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub from_outside: bool,
}

/* ------------------------------------------------------------- parsing */

/// What an agent's `show` call asked for, checked and filled in. Images
/// still need their files copied (`image_paths`, then `attach`).
pub fn parse(args: &Value) -> Result<BlockSet, String> {
    let intro = args
        .get("text")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string);
    if let Some(intro) = &intro {
        if intro.chars().count() > MAX_INTRO {
            return Err(format!("`text` is over {MAX_INTRO} characters: say it in fewer words, or put the detail in blocks."));
        }
    }
    let raw = match args.get("blocks") {
        Some(Value::Array(list)) => list,
        // Some engines send a nested array as a JSON string.
        Some(Value::String(s)) => {
            return parse(
                &json!({ "text": intro, "blocks": serde_json::from_str::<Value>(s).map_err(|_| "`blocks` must be a list of objects.".to_string())? }),
            )
        }
        _ => {
            return Err(
                "`blocks` is required: a list of 1 to 8 objects, each with a `kind`.".into(),
            )
        }
    };
    if raw.is_empty() {
        return Err("`blocks` is empty: give at least one block, or just reply in prose.".into());
    }
    if raw.len() > MAX_BLOCKS {
        return Err(format!(
            "{} blocks is too many for one message: at most {MAX_BLOCKS}. Split it, or keep the ones that matter.",
            raw.len()
        ));
    }
    let mut items = Vec::with_capacity(raw.len());
    for (i, value) in raw.iter().enumerate() {
        let at = |kind: &str| format!("blocks[{i}] ({kind})");
        let kind = value.get("kind").and_then(Value::as_str).unwrap_or("");
        if kind.is_empty() {
            return Err(format!(
                "blocks[{i}] has no `kind`. Kinds: {}.",
                KINDS.join(", ")
            ));
        }
        if !KINDS.contains(&kind) {
            return Err(format!(
                "blocks[{i}]: there's no \"{kind}\" block. Kinds: {}.",
                KINDS.join(", ")
            ));
        }
        let mut block: Block = serde_json::from_value(value.clone())
            .map_err(|e| format!("{}: {}", at(kind), plain_serde(&e.to_string())))?;
        check(&mut block).map_err(|e| format!("{}: {e}", at(kind)))?;
        items.push(block);
    }
    // One question a message: the user's next message answers it, and two
    // asks in one message would both read as answered by the first reply.
    let asks = items
        .iter()
        .filter(|b| {
            matches!(
                b.body,
                Body::Choices(_) | Body::Comparison(_) | Body::Form(_)
            )
        })
        .count();
    if asks > 1 {
        return Err("One question per message: a choices, comparison or form block, not several (the user's next message answers it). Ask the first, wait for the answer, then ask the next.".into());
    }
    let images = items
        .iter()
        .filter(|b| matches!(b.body, Body::Image(_)))
        .count();
    if images > MAX_IMAGES {
        return Err(format!(
            "{images} images in one message: at most {MAX_IMAGES}. For a set of screenshots, use share_result."
        ));
    }
    let set = BlockSet {
        v: VERSION,
        intro,
        items,
        from_outside: false,
    };
    let size = serde_json::to_string(&set).map(|s| s.len()).unwrap_or(0);
    if size > MAX_BYTES {
        return Err(format!(
            "These blocks are {} KB: at most {} KB in one message. Show fewer rows or points (summarise, or share the full data as a file with share_file).",
            size / 1000,
            MAX_BYTES / 1000
        ));
    }
    Ok(set)
}

pub const KINDS: &[&str] = &[
    "chart",
    "table",
    "metrics",
    "facts",
    "checklist",
    "steps",
    "comparison",
    "choices",
    "form",
    "links",
    "callout",
    "code",
    "image",
];

/// serde's words, for the agent: "unknown variant `pyramid`, expected one of …".
fn plain_serde(e: &str) -> String {
    e.replace(" at line 1 column", " (column")
        .replace("  ", " ")
}

/// The image files a set asks for, by block index.
pub fn image_paths(set: &BlockSet) -> Vec<(usize, String)> {
    set.items
        .iter()
        .enumerate()
        .filter_map(|(i, b)| match &b.body {
            Body::Image(img) => Some((i, img.path.clone())),
            _ => None,
        })
        .collect()
}

/// Put a copied file on its image block, and finish its summary.
pub fn attach(set: &mut BlockSet, index: usize, file: super::attachments::Attachment) {
    if let Some(block) = set.items.get_mut(index) {
        if let Body::Image(img) = &mut block.body {
            img.file = Some(file);
            if block.summary.trim().is_empty() {
                block.summary = summary_of(block);
            }
        }
    }
}

fn too_long(s: &str, max: usize, what: &str) -> Result<(), String> {
    if s.chars().count() > max {
        return Err(format!("{what} is over {max} characters."));
    }
    Ok(())
}

fn required(s: &str, what: &str) -> Result<(), String> {
    if s.trim().is_empty() {
        return Err(format!("{what} is empty."));
    }
    Ok(())
}

fn short(s: &str, what: &str) -> Result<(), String> {
    required(s, what)?;
    too_long(s, MAX_SHORT, what)
}

fn opt_short(s: &Option<String>, what: &str) -> Result<(), String> {
    match s {
        Some(s) => too_long(s, MAX_SHORT, what),
        None => Ok(()),
    }
}

fn list_size<T>(list: &[T], min: usize, max: usize, what: &str) -> Result<(), String> {
    if list.len() < min {
        return Err(if min == 1 {
            format!("{what} is empty.")
        } else {
            format!("{what} needs at least {min}.")
        });
    }
    if list.len() > max {
        return Err(format!("{what} has {}: at most {max}.", list.len()));
    }
    Ok(())
}

/// Text that would be markup: `<b>`, `</div>`, `<!--`, `<script`. A lone
/// "<" (a comparison, "<3") is fine.
pub fn looks_like_html(s: &str) -> bool {
    let b = s.as_bytes();
    b.windows(2).any(|w| {
        w[0] == b'<' && (w[1].is_ascii_alphabetic() || w[1] == b'/' || w[1] == b'!' || w[1] == b'?')
    })
}

/// Every string in a block but its code, its copied file and its links.
fn strings(v: &Value, key: &str, out: &mut Vec<String>) {
    match v {
        Value::String(s) if !matches!(key, "code" | "url" | "file") => out.push(s.clone()),
        Value::Array(list) => list.iter().for_each(|x| strings(x, key, out)),
        Value::Object(map) => {
            for (k, x) in map {
                if k != "file" {
                    strings(x, k, out)
                }
            }
        }
        _ => {}
    }
}

/// Words that mean a secret: a form never asks for one.
fn asks_for_secret(s: &str) -> bool {
    let s = s.to_ascii_lowercase();
    let words: Vec<&str> = s
        .split(|c: char| !c.is_ascii_alphanumeric())
        .filter(|w| !w.is_empty())
        .collect();
    let has = |w: &str| words.contains(&w);
    let pair = |a: &str, b: &str| words.windows(2).any(|p| p[0] == a && p[1] == b);
    has("password")
        || has("passcode")
        || has("passphrase")
        || has("secret")
        || has("token")
        || has("apikey")
        || has("pin")
        || has("cvv")
        || has("cvc")
        || has("ssn")
        || has("otp")
        || has("2fa")
        || has("mfa")
        || pair("api", "key")
        || pair("private", "key")
        || pair("secret", "key")
        || pair("access", "key")
        || pair("card", "number")
        || pair("credit", "card")
        || pair("social", "security")
        || pair("security", "code")
        || pair("recovery", "code")
        || pair("seed", "phrase")
}

fn finite(v: f64, what: &str) -> Result<(), String> {
    if !v.is_finite() {
        return Err(format!("{what} isn't a number."));
    }
    Ok(())
}

/// A link the chat may show: http(s), no credentials in it, a real host.
pub fn link_ok(url: &str) -> Result<String, String> {
    let url = url.trim();
    if url.chars().count() > MAX_URL {
        return Err("a link is over 2,000 characters.".into());
    }
    let lower = url.to_ascii_lowercase();
    let rest = lower
        .strip_prefix("https://")
        .or_else(|| lower.strip_prefix("http://"))
        .ok_or_else(|| format!("\"{url}\" isn't an http(s) link."))?;
    let authority = rest.split(['/', '?', '#']).next().unwrap_or("");
    if authority.contains('@') {
        return Err("a link can't carry a user name or password.".into());
    }
    let host = authority.split(':').next().unwrap_or("");
    if host.is_empty() || url.chars().any(char::is_whitespace) {
        return Err(format!("\"{url}\" isn't a link."));
    }
    Ok(host.trim_start_matches("www.").to_string())
}

/// Check one block, fill in what it may leave out, and write its summary.
fn check(block: &mut Block) -> Result<(), String> {
    opt_short(&block.title, "`title`")?;
    too_long(&block.summary, MAX_SUMMARY, "`summary`")?;
    match &mut block.body {
        Body::Chart(c) => check_chart(c)?,
        Body::Table(t) => check_table(t)?,
        Body::Metrics(m) => {
            list_size(&m.items, 1, 6, "`items`")?;
            for (i, it) in m.items.iter().enumerate() {
                short(&it.label, &format!("items[{i}].label"))?;
                match &it.value {
                    Cell::Num(v) => finite(*v, &format!("items[{i}].value"))?,
                    Cell::Text(s) => short(s, &format!("items[{i}].value"))?,
                }
                if let Some(Cell::Text(d)) = &it.delta {
                    too_long(d, 24, &format!("items[{i}].delta"))?;
                }
                opt_short(&it.prefix, "`prefix`")?;
                opt_short(&it.suffix, "`suffix`")?;
                opt_short(&it.vs, "`vs`")?;
                if it.trend.len() > MAX_POINTS {
                    return Err(format!("items[{i}].trend has over {MAX_POINTS} points."));
                }
                for v in &it.trend {
                    finite(*v, "a trend value")?;
                }
            }
        }
        Body::Facts(f) => {
            list_size(&f.items, 1, MAX_LIST, "`items`")?;
            for (i, it) in f.items.iter().enumerate() {
                short(&it.label, &format!("items[{i}].label"))?;
                too_long(&it.value, MAX_TEXT, &format!("items[{i}].value"))?;
            }
        }
        Body::Checklist(c) => {
            list_size(&c.items, 1, MAX_LIST, "`items`")?;
            for (i, it) in c.items.iter().enumerate() {
                required(&it.text, &format!("items[{i}].text"))?;
                too_long(&it.text, 300, &format!("items[{i}].text"))?;
                if let Some(n) = &it.note {
                    too_long(n, 300, &format!("items[{i}].note"))?;
                }
            }
        }
        Body::Steps(s) => {
            list_size(&s.items, 1, 16, "`items`")?;
            for (i, it) in s.items.iter().enumerate() {
                short(&it.title, &format!("items[{i}].title"))?;
                if let Some(d) = &it.detail {
                    too_long(d, 400, &format!("items[{i}].detail"))?;
                }
                opt_short(&it.when, "`when`")?;
            }
        }
        Body::Comparison(c) => {
            list_size(&c.options, 2, 3, "`options`")?;
            for (i, o) in c.options.iter_mut().enumerate() {
                short(&o.name, &format!("options[{i}].name"))?;
                if let Some(s) = &o.summary {
                    too_long(s, 400, &format!("options[{i}].summary"))?;
                }
                list_size(&o.pros, 0, 6, &format!("options[{i}].pros"))?;
                list_size(&o.cons, 0, 6, &format!("options[{i}].cons"))?;
                list_size(&o.facts, 0, 6, &format!("options[{i}].facts"))?;
                for p in o.pros.iter().chain(o.cons.iter()) {
                    too_long(&p.0, 200, "a pro or con")?;
                }
                for f in &o.facts {
                    short(&f.label, "a fact's label")?;
                    too_long(&f.value, MAX_SHORT, "a fact's value")?;
                }
                if o.reply.trim().is_empty() {
                    o.reply = format!("Let's go with {}.", o.name.trim());
                }
                too_long(&o.reply, 500, &format!("options[{i}].reply"))?;
            }
            if c.options.iter().filter(|o| o.recommended).count() > 1 {
                return Err("only one option can be `recommended`.".into());
            }
        }
        Body::Choices(c) => {
            list_size(&c.options, 2, 6, "`options`")?;
            if let Some(q) = &c.question {
                too_long(q, 300, "`question`")?;
            }
            for (i, o) in c.options.iter_mut().enumerate() {
                short(&o.label, &format!("options[{i}].label"))?;
                if o.reply.trim().is_empty() {
                    o.reply = o.label.clone();
                }
                too_long(&o.reply, 500, &format!("options[{i}].reply"))?;
            }
        }
        Body::Form(f) => check_form(f)?,
        Body::Links(l) => {
            list_size(&l.items, 1, 12, "`items`")?;
            for (i, it) in l.items.iter_mut().enumerate() {
                it.domain = link_ok(&it.url).map_err(|e| format!("items[{i}]: {e}"))?;
                it.url = it.url.trim().to_string();
                if it.label.trim().is_empty() {
                    it.label = it.domain.clone();
                }
                too_long(&it.label, 200, &format!("items[{i}].label"))?;
                if let Some(n) = &it.note {
                    too_long(n, 300, &format!("items[{i}].note"))?;
                }
            }
        }
        Body::Callout(c) => {
            required(&c.text, "`text`")?;
            too_long(&c.text, MAX_TEXT, "`text`")?;
        }
        Body::Code(c) => {
            required(&c.code, "`code`")?;
            too_long(&c.code, MAX_CODE, "`code`")?;
            opt_short(&c.language, "`language`")?;
        }
        Body::Image(img) => {
            required(&img.path, "`path`")?;
            img.file = None;
            if let Some(c) = &img.caption {
                too_long(c, 300, "`caption`")?;
            }
        }
    }
    // No markup anywhere a block shows text.
    let value = serde_json::to_value(&*block).map_err(|e| e.to_string())?;
    let mut all = Vec::new();
    strings(&value, "", &mut all);
    if all.iter().any(|s| looks_like_html(s)) {
        return Err(
            "blocks are plain text: no HTML tags. Put markup in a `code` block if it is the point."
                .into(),
        );
    }
    if block.summary.trim().is_empty() && !matches!(block.body, Body::Image(_)) {
        block.summary = summary_of(block);
    }
    Ok(())
}

fn check_chart(c: &mut Chart) -> Result<(), String> {
    if c.series.is_empty() {
        if let Some(values) = c.values.take() {
            c.series.push(Series {
                name: String::new(),
                values,
            });
        }
    }
    c.values = None;
    list_size(&c.series, 1, MAX_SERIES, "`series`")?;
    let one = matches!(
        c.chart,
        ChartType::Pie | ChartType::Donut | ChartType::Sparkline
    );
    if one && c.series.len() > 1 {
        return Err("a pie, donut or sparkline takes one series.".into());
    }
    let n = c.series.iter().map(|s| s.values.len()).max().unwrap_or(0);
    if n == 0 {
        return Err("`series` has no values.".into());
    }
    let max = match c.chart {
        ChartType::Bar => MAX_BAR_CATEGORIES,
        ChartType::Pie | ChartType::Donut => 8,
        _ => MAX_POINTS,
    };
    if n > max {
        return Err(format!(
            "{n} points is too many for this chart: at most {max}. Summarise them (by week, top {}), or use a table.",
            max.min(8)
        ));
    }
    if c.chart != ChartType::Sparkline && c.labels.len() != n {
        return Err(format!(
            "`labels` has {} but the series have {n} values: one label per value.",
            c.labels.len()
        ));
    }
    let several = c.series.len() > 1;
    for (i, s) in c.series.iter_mut().enumerate() {
        if s.values.len() != n {
            return Err(format!(
                "series[{i}] has {} values but the others have {n}: use null for a gap.",
                s.values.len()
            ));
        }
        for v in s.values.iter().flatten() {
            finite(*v, "a value")?;
        }
        if several && s.name.trim().is_empty() {
            return Err(format!("series[{i}] needs a `name`: the legend shows it."));
        }
        too_long(&s.name, MAX_SHORT, "a series name")?;
    }
    if matches!(c.chart, ChartType::Pie | ChartType::Donut)
        && c.series[0].values.iter().flatten().any(|v| *v < 0.0)
    {
        return Err("a pie can't show negative values: use a bar chart.".into());
    }
    for l in &c.labels {
        too_long(&l.0, 60, "a label")?;
    }
    if c.stacked && !matches!(c.chart, ChartType::Bar | ChartType::Area) {
        c.stacked = false;
    }
    opt_short(&c.prefix, "`prefix`")?;
    opt_short(&c.suffix, "`suffix`")?;
    opt_short(&c.axis, "`axis`")?;
    Ok(())
}

fn check_table(t: &mut Table) -> Result<(), String> {
    list_size(&t.columns, 1, MAX_COLUMNS, "`columns`")?;
    list_size(&t.rows, 1, MAX_ROWS, "`rows`")?;
    for (i, c) in t.columns.iter().enumerate() {
        short(&c.label, &format!("columns[{i}] label"))?;
        opt_short(&c.prefix, "`prefix`")?;
        opt_short(&c.suffix, "`suffix`")?;
    }
    let width = t.columns.len();
    for (i, row) in t.rows.iter_mut().enumerate() {
        if row.len() > width {
            return Err(format!(
                "rows[{i}] has {} cells but there are {width} columns.",
                row.len()
            ));
        }
        row.resize(width, None);
        for cell in row.iter_mut() {
            match cell {
                Some(Cell::Num(v)) => finite(*v, "a cell")?,
                Some(Cell::Text(s)) => {
                    too_long(s, 300, &format!("a cell in rows[{i}]"))?;
                    if s.is_empty() {
                        *cell = None;
                    }
                }
                None => {}
            }
        }
    }
    // A column whose every cell is a number is numeric: right-aligned, sorted as numbers.
    for (j, col) in t.columns.iter_mut().enumerate() {
        let cells: Vec<&Cell> = t.rows.iter().filter_map(|r| r[j].as_ref()).collect();
        col.numeric = !cells.is_empty() && cells.iter().all(|c| matches!(c, Cell::Num(_)));
    }
    Ok(())
}

fn check_form(f: &mut Form) -> Result<(), String> {
    list_size(&f.fields, 1, 8, "`fields`")?;
    let mut seen = std::collections::HashSet::new();
    for (i, field) in f.fields.iter_mut().enumerate() {
        short(&field.label, &format!("fields[{i}].label"))?;
        let hint = format!(
            "{} {} {}",
            field.label,
            field.id,
            field.placeholder.as_deref().unwrap_or("")
        );
        if asks_for_secret(&hint) {
            return Err(format!(
                "fields[{i}] (\"{}\") asks for a secret. Never in a form: an API key or token is request_secret (a masked card, into the Keychain); an account is request_login.",
                field.label.trim()
            ));
        }
        if field.id.trim().is_empty() {
            field.id = slug(&field.label, i);
        }
        if !seen.insert(field.id.clone()) {
            return Err(format!("two fields have the id \"{}\".", field.id));
        }
        opt_short(&field.placeholder, "`placeholder`")?;
        match field.kind {
            FieldType::Choice => {
                list_size(&field.options, 2, 12, &format!("fields[{i}].options"))?;
                for o in &field.options {
                    short(&o.0, "an option")?;
                }
            }
            _ => field.options.clear(),
        }
    }
    if f.submit.trim().is_empty() {
        f.submit = "Send".into();
    }
    too_long(&f.submit, 40, "`submit`")?;
    Ok(())
}

fn slug(label: &str, i: usize) -> String {
    let s: String = label
        .to_ascii_lowercase()
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '_' })
        .collect();
    let s = s.trim_matches('_').to_string();
    if s.is_empty() {
        format!("field_{i}")
    } else {
        s
    }
}

/* ----------------------------------------------------------- the text */

/// A number as a person would write it: 1,284 / 12.9K / 3.5.
pub fn number(v: f64) -> String {
    if !v.is_finite() {
        return "–".into();
    }
    let a = v.abs();
    let sign = if v < 0.0 { "-" } else { "" };
    if a >= 10_000.0 {
        let (div, unit) = if a >= 1e12 {
            (1e12, "T")
        } else if a >= 1e9 {
            (1e9, "B")
        } else if a >= 1e6 {
            (1e6, "M")
        } else {
            (1e3, "K")
        };
        let x = a / div;
        let body = if x >= 100.0 {
            format!("{x:.0}")
        } else {
            trim_zeros(format!("{x:.1}"))
        };
        return format!("{sign}{body}{unit}");
    }
    let body = if a >= 100.0 {
        format!("{a:.0}")
    } else if a >= 1.0 {
        trim_zeros(format!("{a:.2}"))
    } else {
        trim_zeros(format!("{a:.3}"))
    };
    let (int, frac) = body.split_once('.').unwrap_or((&body, ""));
    let mut grouped = String::new();
    for (k, ch) in int.chars().enumerate() {
        if k > 0 && (int.len() - k) % 3 == 0 {
            grouped.push(',');
        }
        grouped.push(ch);
    }
    if frac.is_empty() {
        format!("{sign}{grouped}")
    } else {
        format!("{sign}{grouped}.{frac}")
    }
}

fn trim_zeros(s: String) -> String {
    if s.contains('.') {
        s.trim_end_matches('0').trim_end_matches('.').to_string()
    } else {
        s
    }
}

fn with_units(v: f64, prefix: &Option<String>, suffix: &Option<String>) -> String {
    format!(
        "{}{}{}",
        prefix.as_deref().unwrap_or(""),
        number(v),
        suffix.as_deref().unwrap_or("")
    )
}

fn cell_text(c: &Option<Cell>) -> String {
    match c {
        Some(Cell::Num(v)) => number(*v),
        Some(Cell::Text(s)) => s.clone(),
        None => "–".into(),
    }
}

/// The block in a few plain-text lines.
pub fn summary_of(block: &Block) -> String {
    let title = block
        .title
        .as_deref()
        .map(str::trim)
        .filter(|t| !t.is_empty());
    let head = |fallback: &str| title.unwrap_or(fallback).to_string();
    match &block.body {
        Body::Chart(c) => {
            let first = c.labels.first().map(|l| l.0.as_str()).unwrap_or("");
            let last = c.labels.last().map(|l| l.0.as_str()).unwrap_or("");
            let span = if !first.is_empty() && first != last {
                format!(", {first} to {last}")
            } else {
                String::new()
            };
            let kind = match c.chart {
                ChartType::Line => "line chart",
                ChartType::Bar => "bar chart",
                ChartType::Area => "area chart",
                ChartType::Pie => "pie chart",
                ChartType::Donut => "donut chart",
                ChartType::Sparkline => "trend",
            };
            let mut lines = vec![format!("{} ({kind}{span})", head("Chart"))];
            if matches!(c.chart, ChartType::Pie | ChartType::Donut) {
                for (label, v) in c.labels.iter().zip(&c.series[0].values) {
                    if let Some(v) = v {
                        lines.push(format!(
                            "- {}: {}",
                            label.0,
                            with_units(*v, &c.prefix, &c.suffix)
                        ));
                    }
                }
            } else {
                for s in &c.series {
                    let vals: Vec<f64> = s.values.iter().flatten().copied().collect();
                    let (Some(a), Some(b)) = (vals.first(), vals.last()) else {
                        continue;
                    };
                    let name = if s.name.trim().is_empty() {
                        "Values"
                    } else {
                        s.name.trim()
                    };
                    let hi = vals.iter().copied().fold(f64::MIN, f64::max);
                    let lo = vals.iter().copied().fold(f64::MAX, f64::min);
                    lines.push(format!(
                        "- {name}: {} → {} (low {}, high {})",
                        with_units(*a, &c.prefix, &c.suffix),
                        with_units(*b, &c.prefix, &c.suffix),
                        with_units(lo, &c.prefix, &c.suffix),
                        with_units(hi, &c.prefix, &c.suffix)
                    ));
                }
            }
            lines.truncate(10);
            lines.join("\n")
        }
        Body::Table(t) => {
            let mut lines = vec![format!(
                "{} ({} row{})",
                head("Table"),
                t.rows.len(),
                if t.rows.len() == 1 { "" } else { "s" }
            )];
            lines.push(
                t.columns
                    .iter()
                    .map(|c| c.label.as_str())
                    .collect::<Vec<_>>()
                    .join(" | "),
            );
            for row in t.rows.iter().take(8) {
                // A number in its column's units ("$2.75"), as the table draws it.
                let cells = row.iter().zip(&t.columns).map(|(cell, col)| match cell {
                    Some(Cell::Num(v)) => with_units(*v, &col.prefix, &col.suffix),
                    other => cell_text(other),
                });
                lines.push(cells.collect::<Vec<_>>().join(" | "));
            }
            if t.rows.len() > 8 {
                lines.push(format!("… {} more", t.rows.len() - 8));
            }
            lines.join("\n")
        }
        Body::Metrics(m) => {
            let mut lines: Vec<String> = title.map(str::to_string).into_iter().collect();
            for it in &m.items {
                let value = match &it.value {
                    Cell::Num(v) => with_units(*v, &it.prefix, &it.suffix),
                    Cell::Text(s) => format!(
                        "{}{s}{}",
                        it.prefix.as_deref().unwrap_or(""),
                        it.suffix.as_deref().unwrap_or("")
                    ),
                };
                let delta = match &it.delta {
                    Some(Cell::Num(d)) => format!(
                        " ({}{}",
                        if *d > 0.0 { "+" } else { "" },
                        with_units(*d, &it.prefix, &it.suffix)
                    ),
                    Some(Cell::Text(d)) => format!(" ({d}"),
                    None => String::new(),
                };
                let delta = if delta.is_empty() {
                    delta
                } else {
                    format!(
                        "{delta}{})",
                        it.vs
                            .as_deref()
                            .map(|v| format!(" {v}"))
                            .unwrap_or_default()
                    )
                };
                lines.push(format!("- {}: {value}{delta}", it.label));
            }
            lines.join("\n")
        }
        Body::Facts(f) => {
            let mut lines: Vec<String> = title.map(str::to_string).into_iter().collect();
            lines.extend(
                f.items
                    .iter()
                    .map(|it| format!("- {}: {}", it.label, it.value)),
            );
            lines.join("\n")
        }
        Body::Checklist(c) => {
            let mut lines: Vec<String> = title.map(str::to_string).into_iter().collect();
            lines.extend(c.items.iter().map(|it| {
                format!(
                    "- [{}] {}{}",
                    if it.done { "x" } else { " " },
                    it.text,
                    it.note
                        .as_deref()
                        .map(|n| format!(" ({n})"))
                        .unwrap_or_default()
                )
            }));
            lines.join("\n")
        }
        Body::Steps(s) => {
            let mut lines: Vec<String> = title.map(str::to_string).into_iter().collect();
            lines.extend(s.items.iter().enumerate().map(|(i, it)| {
                let status = match it.status {
                    StepStatus::Done => "done",
                    StepStatus::Current => "in progress",
                    StepStatus::Todo => "to do",
                    StepStatus::Failed => "failed",
                };
                format!("{}. {} ({status})", i + 1, it.title)
            }));
            lines.join("\n")
        }
        Body::Comparison(c) => {
            let mut lines: Vec<String> = title.map(str::to_string).into_iter().collect();
            for o in &c.options {
                let mut line = format!(
                    "- {}{}",
                    o.name,
                    if o.recommended { " (recommended)" } else { "" }
                );
                if let Some(s) = &o.summary {
                    line.push_str(&format!(": {s}"));
                }
                if !o.pros.is_empty() {
                    line.push_str(&format!(
                        " Pros: {}.",
                        o.pros
                            .iter()
                            .map(|p| p.0.as_str())
                            .collect::<Vec<_>>()
                            .join("; ")
                    ));
                }
                if !o.cons.is_empty() {
                    line.push_str(&format!(
                        " Cons: {}.",
                        o.cons
                            .iter()
                            .map(|p| p.0.as_str())
                            .collect::<Vec<_>>()
                            .join("; ")
                    ));
                }
                lines.push(line);
            }
            lines.push("Reply with the one you pick.".into());
            lines.join("\n")
        }
        Body::Choices(c) => {
            let mut lines: Vec<String> = c
                .question
                .clone()
                .or(title.map(str::to_string))
                .into_iter()
                .collect();
            lines.push(
                c.options
                    .iter()
                    .map(|o| format!("“{}”", o.label))
                    .collect::<Vec<_>>()
                    .join(" / "),
            );
            lines.join("\n")
        }
        Body::Form(f) => {
            let mut lines = vec![format!("{} — please reply with:", head("A few details"))];
            lines.extend(f.fields.iter().map(|fl| {
                let opts = if fl.options.is_empty() {
                    String::new()
                } else {
                    format!(
                        " ({})",
                        fl.options
                            .iter()
                            .map(|o| o.0.as_str())
                            .collect::<Vec<_>>()
                            .join(" / ")
                    )
                };
                format!(
                    "- {}{opts}{}",
                    fl.label,
                    if fl.required { "" } else { " (optional)" }
                )
            }));
            lines.join("\n")
        }
        Body::Links(l) => {
            let mut lines: Vec<String> = title.map(str::to_string).into_iter().collect();
            lines.extend(l.items.iter().map(|it| {
                if it.label == it.domain {
                    format!("- {}", it.url)
                } else {
                    format!("- {}: {}", it.label, it.url)
                }
            }));
            lines.join("\n")
        }
        Body::Callout(c) => {
            let word = match c.tone {
                Tone::Info => "Note",
                Tone::Warning => "Warning",
                Tone::Success => "Done",
            };
            match title {
                Some(t) => format!("{word}: {t}. {}", c.text),
                None => format!("{word}: {}", c.text),
            }
        }
        Body::Code(c) => {
            let fence = if c.code.contains("```") {
                "~~~~"
            } else {
                "```"
            };
            let mut s = String::new();
            if let Some(t) = title {
                s.push_str(t);
                s.push('\n');
            }
            s.push_str(&format!(
                "{fence}{}\n{}\n{fence}",
                c.language.as_deref().unwrap_or(""),
                c.code.trim_end()
            ));
            s
        }
        Body::Image(img) => {
            let name = img
                .file
                .as_ref()
                .map(|f| f.name.as_str())
                .unwrap_or("an image");
            match img.caption.as_deref().or(title) {
                Some(c) => format!("Image: {c} ({name})"),
                None => format!("Image: {name}"),
            }
        }
    }
}

/// The message's text: the intro, then every block's summary.
pub fn message_text(set: &BlockSet) -> String {
    let mut parts: Vec<String> = set.intro.iter().cloned().collect();
    parts.extend(
        set.items
            .iter()
            .map(|b| b.summary.trim().to_string())
            .filter(|s| !s.is_empty()),
    );
    parts.join("\n\n")
}

/// The set asks the user something (a choice, a comparison or a form).
pub fn asks(set: &BlockSet) -> bool {
    set.items.iter().any(|b| {
        matches!(
            b.body,
            Body::Choices(_) | Body::Comparison(_) | Body::Form(_)
        )
    })
}

/// What the agent is told once the blocks are in the chat.
pub fn receipt(set: &BlockSet) -> String {
    let kinds: Vec<&str> = set.items.iter().map(|b| b.body.kind()).collect();
    let asks = asks(set);
    let mut s = format!(
        "Shown in the chat: {}. Don't repeat in prose what they show.",
        kinds.join(", ")
    );
    if asks {
        s.push_str(
            " The user's answer comes back as their next message: stop here and wait for it. End your turn now with no more text: the question is already in the chat, and any words after it are a second bubble repeating it.",
        );
    }
    if set.from_outside {
        s.push_str(" You're answering outside text, so a tap only puts the words in the user's composer for them to send.");
    }
    s
}

#[cfg(test)]
#[path = "blocks_tests.rs"]
mod tests;
