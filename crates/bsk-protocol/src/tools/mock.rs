//! Request-mocking tool (`tool.mock`).
//!
//! Frontend integration without a backend: an agent — or the user, through
//! the extension's rules page — registers rules that match outgoing requests
//! by URL pattern and HTTP method, and replaces the response the page
//! receives. Nothing leaves the machine: the matched request is fulfilled
//! locally, so the origin server never sees it.
//!
//! Rules are stored in the extension's `chrome.storage.local`, not in a
//! session. They are browser-profile-scoped and outlive any single session,
//! which is what makes them useful for a human editing the rules page while
//! an agent works elsewhere. The RPC still carries a `session_id` because
//! that is how the daemon routes, queues and audits `tool.*` calls; the
//! session does not scope the rule.
//!
//! A single method carries a CRUD `action` discriminator rather than one
//! method per verb. Rule management is one resource with four operations, and
//! every operation answers the same question — "what is in effect now?" — so
//! every result echoes the full rule set.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

/// Upper bound on a URL glob. Long enough for real query strings, short
/// enough that a runaway agent cannot wedge the matcher.
pub const MAX_URL_PATTERN_LEN: usize = 2048;

/// Upper bound on a response body. Mirrors the extension's own limit so a
/// rule that passes CLI validation is never rejected at execution time.
pub const MAX_BODY_LEN: usize = 8 * 1024 * 1024;

/// Upper bound on artificial latency.
pub const MAX_DELAY_MS: u64 = 600_000;

/// Upper bound on the stored rule set.
pub const MAX_RULES: usize = 200;

/// Upper bound on a header name / value.
pub const MAX_HEADER_LEN: usize = 8192;

/// Upper bound on a free-form note.
pub const MAX_NOTE_LEN: usize = 512;

/// Which CRUD operation a `tool.mock` call performs.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum MockAction {
    /// Create one rule. The extension mints the id.
    Add,
    /// Read the current rule set.
    List,
    /// Delete one rule by id.
    Remove,
    /// Delete every rule.
    Clear,
    /// Atomically replace the whole rule set. Used by `import` so a partial
    /// failure cannot leave a half-applied rule table.
    ReplaceAll,
}

impl MockAction {
    /// Stable lowercase identifier, used in error messages and rendering.
    pub fn as_str(self) -> &'static str {
        match self {
            MockAction::Add => "add",
            MockAction::List => "list",
            MockAction::Remove => "remove",
            MockAction::Clear => "clear",
            MockAction::ReplaceAll => "replace_all",
        }
    }
}

/// How the extension decodes `MockRule::body`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum MockBodyEncoding {
    /// `body` is UTF-8 text.
    #[default]
    Text,
    /// `body` is standard base64; used for binary payloads (images, fonts).
    Base64,
}

/// One response header a mock returns.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct MockHeader {
    pub name: String,
    pub value: String,
}

/// A single mock rule.
///
/// Every field beyond `url_pattern` has a default, so the smallest useful
/// rule is `{ "url_pattern": "https://api.example.com/user/*" }` — it
/// matches any method and answers `200` with an empty body.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct MockRule {
    /// Stable id. Absent on `add`; the extension mints one. Always present
    /// on rules echoed back in a result.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    /// Disabled rules stay stored but never match, so a user can keep a
    /// scenario around without deleting it.
    #[serde(default = "default_enabled")]
    pub enabled: bool,
    /// Glob matched against the full request URL. `*` matches any run of
    /// characters (including `/`), `?` matches exactly one.
    pub url_pattern: String,
    /// Uppercase HTTP method to match. Absent matches every method.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub method: Option<String>,
    /// HTTP status the page receives.
    #[serde(default = "default_status")]
    pub status: u16,
    /// Headers the page receives, in addition to a sensible default
    /// `content-type` when the rule does not set one.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub headers: Vec<MockHeader>,
    /// Response body, decoded according to `body_encoding`.
    #[serde(default)]
    pub body: String,
    /// How to decode `body`.
    #[serde(default)]
    pub body_encoding: MockBodyEncoding,
    /// Artificial latency before the response resolves, so loading and
    /// error states are reachable without a real slow backend.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub delay_ms: Option<u64>,
    /// Free-form label shown on the rules page.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
}

fn default_enabled() -> bool {
    true
}

fn default_status() -> u16 {
    200
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct MockParams {
    /// Routing/queue/audit handle. Does **not** scope the rule — the rule is
    /// stored per browser profile and outlives the session.
    pub session_id: String,
    pub action: MockAction,
    /// Rule to create. Required by `add`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rule: Option<MockRule>,
    /// Rule id to delete. Required by `remove`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    /// Complete rule set to install. Required by `replace_all`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rules: Option<Vec<MockRule>>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct MockResult {
    /// The action that ran.
    pub action: MockAction,
    /// The rule set in effect *after* the action. Every call returns this so
    /// the caller never has to issue a follow-up `list` to know the state.
    pub rules: Vec<MockRule>,
    /// Id minted by `add`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub created_id: Option<String>,
    /// How many rules `remove` / `clear` / `replace_all` displaced.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub removed: Option<u32>,
    /// Scope note, echoed on every call so agents learn the rule's reach
    /// without reading the docs.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
}

/// Why a rule was rejected. Returned as a message by [`validate_rule`].
pub fn validate_rule(rule: &MockRule) -> Result<(), String> {
    if rule.url_pattern.trim().is_empty() {
        return Err("url_pattern must not be empty".into());
    }
    if rule.url_pattern.len() > MAX_URL_PATTERN_LEN {
        return Err(format!(
            "url_pattern is {} bytes, over the {MAX_URL_PATTERN_LEN} byte limit",
            rule.url_pattern.len()
        ));
    }
    if let Some(method) = &rule.method {
        let upper = method.to_ascii_uppercase();
        if upper.is_empty() || upper.len() > 16 {
            return Err(format!("method {method:?} is not a valid HTTP method"));
        }
        if !upper.bytes().all(|b| b.is_ascii_uppercase()) {
            return Err(format!(
                "method {method:?} must be ASCII letters (e.g. GET, POST)"
            ));
        }
    }
    // 200 is the floor, not 100. The extension materialises a rule through the
    // `Response` constructor, which rejects anything outside 200..=599 with a
    // `RangeError` — Chrome's own words: "The status provided (101) is outside
    // the range [200, 599]". Accepting 1xx here would pass validation, store the
    // rule, and then fail inside the page as an error the user cannot connect
    // back to their rule. A 1xx is informational and never a response a page
    // can be handed anyway.
    if !(200..=599).contains(&rule.status) {
        return Err(format!(
            "status {} out of range (200..=599)",
            rule.status
        ));
    }
    if rule.body.len() > MAX_BODY_LEN {
        return Err(format!(
            "body is {} bytes, over the {MAX_BODY_LEN} byte limit",
            rule.body.len()
        ));
    }
    if let Some(delay) = rule.delay_ms
        && delay > MAX_DELAY_MS
    {
        return Err(format!("delay_ms {delay} over the {MAX_DELAY_MS} ms limit"));
    }
    if let Some(note) = &rule.note
        && note.len() > MAX_NOTE_LEN
    {
        return Err(format!(
            "note is {} bytes, over the {MAX_NOTE_LEN} byte limit",
            note.len()
        ));
    }
    for header in &rule.headers {
        if header.name.trim().is_empty() {
            return Err("header name must not be empty".into());
        }
        if header.name.len() > MAX_HEADER_LEN || header.value.len() > MAX_HEADER_LEN {
            return Err(format!(
                "header {:?} exceeds the {MAX_HEADER_LEN} byte limit",
                header.name
            ));
        }
        if header.name.contains(['\r', '\n']) || header.value.contains(['\r', '\n']) {
            return Err(format!(
                "header {:?} contains a line break, which would allow header injection",
                header.name
            ));
        }
    }
    Ok(())
}

/// Validate a whole rule set, rejecting anything over [`MAX_RULES`].
pub fn validate_rule_set(rules: &[MockRule]) -> Result<(), String> {
    if rules.len() > MAX_RULES {
        return Err(format!(
            "{} rules exceeds the {MAX_RULES} rule limit",
            rules.len()
        ));
    }
    for (index, rule) in rules.iter().enumerate() {
        validate_rule(rule).map_err(|err| format!("rule #{index}: {err}"))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn minimal_rule() -> MockRule {
        MockRule {
            id: None,
            enabled: true,
            url_pattern: "https://api.example.com/user/*".into(),
            method: None,
            status: 200,
            headers: vec![],
            body: String::new(),
            body_encoding: MockBodyEncoding::Text,
            delay_ms: None,
            note: None,
        }
    }

    #[test]
    fn action_serialises_to_snake_case() {
        for (action, wire) in [
            (MockAction::Add, "add"),
            (MockAction::List, "list"),
            (MockAction::Remove, "remove"),
            (MockAction::Clear, "clear"),
            (MockAction::ReplaceAll, "replace_all"),
        ] {
            assert_eq!(serde_json::to_value(action).unwrap(), json!(wire));
            let round: MockAction = serde_json::from_value(json!(wire)).unwrap();
            assert_eq!(round, action);
            assert_eq!(action.as_str(), wire);
        }
    }

    #[test]
    fn body_encoding_defaults_to_text() {
        assert_eq!(MockBodyEncoding::default(), MockBodyEncoding::Text);
        assert_eq!(
            serde_json::to_value(MockBodyEncoding::Base64).unwrap(),
            json!("base64")
        );
    }

    #[test]
    fn minimal_rule_deserialises_with_defaults() {
        let rule: MockRule =
            serde_json::from_value(json!({ "url_pattern": "https://a.test/x" })).unwrap();
        assert!(rule.enabled, "enabled must default to true");
        assert_eq!(rule.status, 200, "status must default to 200");
        assert_eq!(rule.body_encoding, MockBodyEncoding::Text);
        assert!(rule.method.is_none());
        assert!(rule.headers.is_empty());
        assert_eq!(rule.body, "");
        assert!(rule.id.is_none());
    }

    #[test]
    fn rule_omits_optional_fields_when_absent() {
        let value = serde_json::to_value(minimal_rule()).unwrap();
        assert_eq!(
            value,
            json!({
                "enabled": true,
                "url_pattern": "https://api.example.com/user/*",
                "status": 200,
                "body": "",
                "body_encoding": "text"
            })
        );
        let round: MockRule = serde_json::from_value(value).unwrap();
        assert_eq!(round, minimal_rule());
    }

    #[test]
    fn full_rule_round_trips() {
        let rule = MockRule {
            id: Some("m_1".into()),
            enabled: false,
            url_pattern: "https://api.example.com/api/user/*".into(),
            method: Some("POST".into()),
            status: 503,
            headers: vec![MockHeader {
                name: "content-type".into(),
                value: "application/json".into(),
            }],
            body: "{\"error\":\"down\"}".into(),
            body_encoding: MockBodyEncoding::Text,
            delay_ms: Some(250),
            note: Some("backend down".into()),
        };
        let value = serde_json::to_value(&rule).unwrap();
        assert_eq!(value["delay_ms"], json!(250));
        assert_eq!(value["headers"][0]["name"], json!("content-type"));
        let round: MockRule = serde_json::from_value(value).unwrap();
        assert_eq!(round, rule);
    }

    #[test]
    fn params_omit_optional_fields() {
        let params = MockParams {
            session_id: "abcd".into(),
            action: MockAction::List,
            rule: None,
            id: None,
            rules: None,
        };
        assert_eq!(
            serde_json::to_value(&params).unwrap(),
            json!({ "session_id": "abcd", "action": "list" })
        );
    }

    #[test]
    fn add_params_carry_the_rule() {
        let params = MockParams {
            session_id: "abcd".into(),
            action: MockAction::Add,
            rule: Some(minimal_rule()),
            id: None,
            rules: None,
        };
        let value = serde_json::to_value(&params).unwrap();
        assert_eq!(value["action"], json!("add"));
        assert_eq!(
            value["rule"]["url_pattern"],
            json!("https://api.example.com/user/*")
        );
    }

    #[test]
    fn result_echoes_the_rule_set() {
        let result = MockResult {
            action: MockAction::Add,
            rules: vec![MockRule {
                id: Some("m_1".into()),
                ..minimal_rule()
            }],
            created_id: Some("m_1".into()),
            removed: None,
            note: Some("browser-wide".into()),
        };
        let value = serde_json::to_value(&result).unwrap();
        assert_eq!(value["rules"][0]["id"], json!("m_1"));
        assert_eq!(value["created_id"], json!("m_1"));
        assert!(value.get("removed").is_none());
        let round: MockResult = serde_json::from_value(value).unwrap();
        assert_eq!(round, result);
    }

    #[test]
    fn minimal_rule_validates() {
        assert!(validate_rule(&minimal_rule()).is_ok());
    }

    #[test]
    fn empty_url_pattern_is_rejected() {
        let rule = MockRule {
            url_pattern: "   ".into(),
            ..minimal_rule()
        };
        let err = validate_rule(&rule).unwrap_err();
        assert!(err.contains("url_pattern"), "got {err}");
    }

    #[test]
    fn oversized_url_pattern_is_rejected() {
        let rule = MockRule {
            url_pattern: "a".repeat(MAX_URL_PATTERN_LEN + 1),
            ..minimal_rule()
        };
        assert!(validate_rule(&rule).unwrap_err().contains("limit"));
    }

    #[test]
    fn method_must_be_ascii_letters() {
        for bad in ["G3T", "GE T", ""] {
            let rule = MockRule {
                method: Some(bad.into()),
                ..minimal_rule()
            };
            assert!(
                validate_rule(&rule).is_err(),
                "method {bad:?} should be rejected"
            );
        }
        // Lowercase is accepted and normalised by consumers.
        let rule = MockRule {
            method: Some("post".into()),
            ..minimal_rule()
        };
        assert!(validate_rule(&rule).is_ok());
    }

    #[test]
    fn status_range_is_enforced() {
        // 100..199 is included on purpose: `Response` cannot represent it, so a
        // rule carrying one would validate, store, and then throw in the page.
        for bad in [0_u16, 99, 100, 101, 103, 199, 600, 999] {
            let rule = MockRule {
                status: bad,
                ..minimal_rule()
            };
            assert!(validate_rule(&rule).is_err(), "status {bad} should fail");
        }
        for good in [200_u16, 201, 204, 302, 404, 500, 599] {
            let rule = MockRule {
                status: good,
                ..minimal_rule()
            };
            assert!(validate_rule(&rule).is_ok(), "status {good} should pass");
        }
    }

    #[test]
    fn oversized_body_is_rejected() {
        let rule = MockRule {
            body: "x".repeat(MAX_BODY_LEN + 1),
            ..minimal_rule()
        };
        assert!(validate_rule(&rule).unwrap_err().contains("limit"));
    }

    #[test]
    fn oversized_delay_is_rejected() {
        let rule = MockRule {
            delay_ms: Some(MAX_DELAY_MS + 1),
            ..minimal_rule()
        };
        assert!(validate_rule(&rule).unwrap_err().contains("delay_ms"));
        let rule = MockRule {
            delay_ms: Some(MAX_DELAY_MS),
            ..minimal_rule()
        };
        assert!(validate_rule(&rule).is_ok());
    }

    #[test]
    fn header_injection_is_rejected() {
        let rule = MockRule {
            headers: vec![MockHeader {
                name: "x-evil".into(),
                value: "a\r\nSet-Cookie: pwned=1".into(),
            }],
            ..minimal_rule()
        };
        assert!(validate_rule(&rule).unwrap_err().contains("line break"));
    }

    #[test]
    fn empty_header_name_is_rejected() {
        let rule = MockRule {
            headers: vec![MockHeader {
                name: "  ".into(),
                value: "v".into(),
            }],
            ..minimal_rule()
        };
        assert!(validate_rule(&rule).unwrap_err().contains("header name"));
    }

    #[test]
    fn rule_set_size_is_capped() {
        let rules = vec![minimal_rule(); MAX_RULES];
        assert!(validate_rule_set(&rules).is_ok());
        let mut over = rules;
        over.push(minimal_rule());
        let err = validate_rule_set(&over).unwrap_err();
        assert!(err.contains(&MAX_RULES.to_string()), "got {err}");
    }

    #[test]
    fn rule_set_errors_name_the_offending_index() {
        let rules = vec![
            minimal_rule(),
            MockRule {
                url_pattern: "".into(),
                ..minimal_rule()
            },
        ];
        let err = validate_rule_set(&rules).unwrap_err();
        assert!(err.starts_with("rule #1:"), "got {err}");
    }
}
