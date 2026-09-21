//! `tool.network` — read buffered network responses / failures.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct NetworkParams {
    pub session_id: String,
    /// Optional target tab. Defaults to the Agent Window's currently active tab.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tab_id: Option<i64>,
    /// Return entries with sequence strictly greater than this cursor.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub since: Option<u64>,
    /// Maximum number of entries to return. Extension applies safe defaults and caps.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(range(min = 1))]
    pub limit: Option<u32>,
    /// Maximum characters returned per URL / error text. Extension applies safe defaults and caps.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(range(min = 1))]
    pub max_text_chars: Option<u32>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum NetworkEntryKind {
    /// A response was received (`Network.responseReceived`).
    Response,
    /// The request failed before completing (`Network.loadingFailed`).
    Failure,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct NetworkEntry {
    pub sequence: u64,
    pub kind: NetworkEntryKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub method: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    /// HTTP status code (`response` entries only).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub status: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub status_text: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mime_type: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resource_type: Option<String>,
    /// CDP failure reason (`failure` entries only).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error_text: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub timestamp: Option<f64>,
    #[serde(default)]
    pub truncated: bool,
    /// True when the extension answered this request locally.
    ///
    /// A mocked request never reaches the network stack, so it appears in no
    /// other record — and a rule whose body imitates the real response is
    /// indistinguishable from a real one by reading the payload. Marking it is
    /// what makes "did this request go out?" answerable from the log at all.
    #[serde(default)]
    pub mocked: bool,
    /// Rule that answered, when [`Self::mocked`]. Lets a hit be traced back to
    /// a row in `bsk mock list` without matching on the URL.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rule_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct NetworkResult {
    pub tab_id: i64,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub entries: Vec<NetworkEntry>,
    /// Cursor to pass back as `since`, absent when there is nothing to resume
    /// from.
    ///
    /// A bare `0` was ambiguous: `since` is exclusive and `0` means "from the
    /// beginning", so a caller that read `0` from an empty snapshot and passed
    /// it back got the whole buffer rather than the next slice. Absent says
    /// "nothing captured yet" without also saying "start over".
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub next_since: Option<u64>,
    #[serde(default)]
    pub truncated: bool,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn network_params_omit_optional_fields() {
        let params = NetworkParams {
            session_id: "aa11".into(),
            tab_id: None,
            since: None,
            limit: None,
            max_text_chars: None,
        };
        let value = serde_json::to_value(&params).unwrap();
        assert_eq!(value["session_id"], "aa11");
        assert!(value.get("tab_id").is_none());
        assert!(value.get("since").is_none());
        assert!(value.get("limit").is_none());
        assert!(value.get("max_text_chars").is_none());
        let round: NetworkParams = serde_json::from_value(value).unwrap();
        assert_eq!(round, params);
    }

    #[test]
    fn an_empty_snapshot_omits_the_cursor_rather_than_sending_zero() {
        // `0` is not a cursor: `since` is exclusive and `0` means "from the
        // beginning", so a caller that echoed a `0` back re-read the entire
        // buffer instead of continuing. Absent is the honest answer when there
        // is nothing to resume from.
        let empty = NetworkResult {
            tab_id: 7,
            entries: Vec::new(),
            next_since: None,
            truncated: false,
        };
        let value = serde_json::to_value(&empty).unwrap();
        assert!(
            value.get("next_since").is_none(),
            "an absent cursor must not serialise as 0: {value}"
        );

        // Both shapes a peer can send are still understood.
        let with_cursor: NetworkResult =
            serde_json::from_value(json!({ "tab_id": 7, "next_since": 4 })).unwrap();
        assert_eq!(with_cursor.next_since, Some(4));
        let without: NetworkResult = serde_json::from_value(json!({ "tab_id": 7 })).unwrap();
        assert_eq!(without.next_since, None);
    }

    #[test]
    fn network_result_round_trips_response_and_failure() {
        let result = NetworkResult {
            tab_id: 7,
            entries: vec![
                NetworkEntry {
                    sequence: 3,
                    kind: NetworkEntryKind::Response,
                    method: Some("GET".into()),
                    url: Some("https://example.test/api".into()),
                    status: Some(404),
                    status_text: Some("Not Found".into()),
                    mime_type: Some("application/json".into()),
                    resource_type: Some("Fetch".into()),
                    error_text: None,
                    timestamp: Some(1234.5),
                    truncated: false,
                    mocked: false,
                    rule_id: None,
                },
                NetworkEntry {
                    sequence: 4,
                    kind: NetworkEntryKind::Failure,
                    method: Some("GET".into()),
                    url: None,
                    status: None,
                    status_text: None,
                    mime_type: None,
                    resource_type: Some("Script".into()),
                    error_text: Some("net::ERR_BLOCKED_BY_CLIENT".into()),
                    timestamp: Some(1240.0),
                    truncated: false,
                    mocked: false,
                    rule_id: None,
                },
            ],
            next_since: Some(4),
            truncated: false,
        };
        let value = serde_json::to_value(&result).unwrap();
        assert_eq!(value["entries"][0]["kind"], json!("response"));
        assert_eq!(value["entries"][0]["status"], json!(404));
        assert_eq!(value["entries"][1]["kind"], json!("failure"));
        assert!(value["entries"][1].get("url").is_none());
        assert_eq!(
            value["entries"][1]["error_text"],
            json!("net::ERR_BLOCKED_BY_CLIENT")
        );
        let round: NetworkResult = serde_json::from_value(value).unwrap();
        assert_eq!(round, result);
    }

    #[test]
    fn a_mocked_entry_keeps_its_mark_across_the_wire() {
        // The extension is what produces this field; this struct is what decides
        // whether it survives. A field added only on the TypeScript side is
        // dropped here *silently*, because the struct does not deny unknown
        // fields — so the round trip is the only place that can catch it.
        let value = json!({
            "tab_id": 7,
            "entries": [{
                "sequence": 1,
                "kind": "response",
                "url": "https://api.test/user/1",
                "status": 200,
                "truncated": false,
                "mocked": true,
                "rule_id": "m_abc123"
            }]
        });
        let result: NetworkResult = serde_json::from_value(value).unwrap();
        assert!(result.entries[0].mocked, "the mark must survive decoding");
        assert_eq!(result.entries[0].rule_id.as_deref(), Some("m_abc123"));

        // An entry from a peer that predates the field decodes as unmocked
        // rather than failing, so a version skew cannot break `bsk network`.
        let legacy: NetworkResult = serde_json::from_value(json!({
            "tab_id": 7,
            "entries": [{ "sequence": 1, "kind": "response", "truncated": false }]
        }))
        .unwrap();
        assert!(!legacy.entries[0].mocked);
        assert_eq!(legacy.entries[0].rule_id, None);
    }
}
