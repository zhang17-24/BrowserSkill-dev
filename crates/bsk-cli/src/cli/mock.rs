//! `bsk mock` — manage request-mocking rules so frontend work can proceed
//! before the backend exists.
//!
//! A rule matches outgoing page requests by URL glob (and optionally HTTP
//! method) and replaces the response the page receives. The match is
//! fulfilled locally by the extension, so the origin server never sees the
//! request at all — this is response *replacement*, not redirection.
//!
//! Rules live in the extension's `chrome.storage.local`, which is scoped to
//! the browser profile rather than to a session. `--session` therefore only
//! tells the daemon which connection to route the call over; it does not
//! scope the rule. When exactly one session is active the flag may be
//! omitted, because making a browser-wide resource depend on a session
//! handle would be a lie about its lifetime.

use std::path::{Path, PathBuf};
use std::time::Duration;

use anyhow::Context;
use base64::Engine;
use bsk_protocol::ErrorCode;
use bsk_protocol::system::SessionStatusEntry;
use bsk_protocol::tools::{
    MockAction, MockBodyEncoding, MockHeader, MockParams, MockResult, MockRule, validate_rule,
    validate_rule_set,
};
use bsk_protocol::{Method, RpcError};
use clap::{Args, Subcommand};
use serde::Deserialize;

use crate::cli::TOOL_IPC_TIMEOUT;
use crate::cli::ensure_daemon::ensure_daemon;
use crate::cli::error::{CliError, Format};

/// Short timeout for the session lookup that resolves an omitted `--session`.
/// It is a local read of daemon state, not a browser round-trip.
const SESSION_LOOKUP_TIMEOUT: Duration = Duration::from_secs(5);

/// Budget for the best-effort rule count `session stop` issues before it
/// stops anything. Deliberately short: it is a courtesy warning, not part of
/// stopping the session.
const MOCK_COUNT_TIMEOUT: Duration = Duration::from_secs(5);

#[derive(Debug, Args)]
pub struct MockCmd {
    /// Active session id. Omit when exactly one session is active.
    #[arg(long, global = true)]
    pub session: Option<String>,

    #[command(subcommand)]
    pub sub: MockSub,
}

#[derive(Debug, Subcommand)]
pub enum MockSub {
    /// Add one mock rule.
    Add(AddArgs),
    /// Print the rules currently in effect.
    List,
    /// Delete one rule by id.
    #[command(name = "rm")]
    Remove(RemoveArgs),
    /// Delete every rule.
    Clear,
    /// Load a rule set from a JSON file.
    Import(ImportArgs),
    /// Write the current rule set to a JSON file (or stdout).
    Export(ExportArgs),
}

/// The mutually exclusive body flags, shared by `add`.
#[derive(Debug, Clone, Args)]
pub struct BodyArgs {
    /// Response body as literal text.
    #[arg(long)]
    pub body: Option<String>,

    /// Read the response body from a file as UTF-8 text.
    #[arg(long = "body-file")]
    pub body_file: Option<PathBuf>,

    /// Read the response body from a file and base64-encode its bytes.
    /// Use this for images, fonts and other binary payloads.
    #[arg(long = "body-file-base64")]
    pub body_file_base64: Option<PathBuf>,
}

#[derive(Debug, Clone, Args)]
pub struct AddArgs {
    /// Glob matched against the full request URL. `*` matches any run of
    /// characters (including `/`), `?` matches exactly one. Quote it in the
    /// shell, e.g. --url 'https://api.example.com/user/*'.
    #[arg(long = "url", value_name = "GLOB")]
    pub url: String,

    /// Uppercase HTTP method to match. Omit to match every method.
    #[arg(long)]
    pub method: Option<String>,

    /// HTTP status the page receives (200..=599).
    ///
    /// The floor is 200 rather than 100 because the extension builds the
    /// response with the `Response` constructor, which rejects anything below
    /// 200 — a 1xx rule would save and then throw inside the page. A 1xx is
    /// informational and never a response a page can be handed anyway.
    #[arg(long, default_value_t = 200)]
    pub status: u16,

    /// Response header, repeatable: --header 'content-type: application/json'.
    #[arg(long = "header", value_name = "NAME: VALUE")]
    pub headers: Vec<String>,

    /// Artificial latency in milliseconds before the response resolves.
    #[arg(long)]
    pub delay: Option<u64>,

    /// Free-form label shown on the extension's rules page.
    #[arg(long)]
    pub note: Option<String>,

    /// Store the rule disabled, so it is visible but never matches.
    #[arg(long)]
    pub disabled: bool,

    #[command(flatten)]
    pub body: BodyArgs,
}

#[derive(Debug, Clone, Args)]
pub struct RemoveArgs {
    /// Id of the rule to delete, as printed by `bsk mock list`.
    pub id: String,
}

#[derive(Debug, Clone, Args)]
pub struct ImportArgs {
    /// JSON file holding an array of rules.
    pub file: PathBuf,

    /// Merge into the existing rule set instead of replacing it.
    #[arg(long)]
    pub merge: bool,
}

#[derive(Debug, Clone, Args)]
pub struct ExportArgs {
    /// Destination file. Omit to write the JSON array to stdout.
    #[arg(long)]
    pub out: Option<PathBuf>,
}

/// Where a rule's response body comes from.
///
/// Split out from the flags so the "exactly one source" rule is unit-testable
/// without touching the filesystem.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BodySource {
    /// No body flag was given; the rule answers with an empty text body.
    Empty,
    /// `--body` literal text.
    Literal(String),
    /// `--body-file`, read as UTF-8 text.
    TextFile(PathBuf),
    /// `--body-file-base64`, read as bytes and base64-encoded.
    BinaryFile(PathBuf),
}

impl BodySource {
    /// Materialise the body. Filesystem access happens here and only here.
    pub fn load(self) -> Result<ResolvedBody, CliError> {
        match self {
            BodySource::Empty => Ok(ResolvedBody {
                body: String::new(),
                encoding: MockBodyEncoding::Text,
            }),
            BodySource::Literal(text) => Ok(ResolvedBody {
                body: text,
                encoding: MockBodyEncoding::Text,
            }),
            BodySource::TextFile(path) => {
                let text = std::fs::read_to_string(&path).map_err(|err| {
                    CliError::Local(anyhow::anyhow!(
                        "cannot read --body-file {}: {err}",
                        path.display()
                    ))
                })?;
                Ok(ResolvedBody {
                    body: text,
                    encoding: MockBodyEncoding::Text,
                })
            }
            BodySource::BinaryFile(path) => {
                let bytes = std::fs::read(&path).map_err(|err| {
                    CliError::Local(anyhow::anyhow!(
                        "cannot read --body-file-base64 {}: {err}",
                        path.display()
                    ))
                })?;
                Ok(ResolvedBody {
                    body: base64::engine::general_purpose::STANDARD.encode(&bytes),
                    encoding: MockBodyEncoding::Base64,
                })
            }
        }
    }
}

/// A body that has been read off disk and is ready for the wire.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResolvedBody {
    pub body: String,
    pub encoding: MockBodyEncoding,
}

/// Pick the body source, rejecting conflicting flags.
pub fn body_source(args: &BodyArgs) -> Result<BodySource, CliError> {
    let mut chosen: Vec<BodySource> = Vec::new();
    if let Some(text) = &args.body {
        chosen.push(BodySource::Literal(text.clone()));
    }
    if let Some(path) = &args.body_file {
        chosen.push(BodySource::TextFile(path.clone()));
    }
    if let Some(path) = &args.body_file_base64 {
        chosen.push(BodySource::BinaryFile(path.clone()));
    }
    match chosen.len() {
        0 => Ok(BodySource::Empty),
        1 => Ok(chosen.pop().expect("length checked")),
        _ => Err(invalid_params(
            "--body, --body-file and --body-file-base64 are mutually exclusive",
        )),
    }
}

/// Parse one `--header 'Name: value'` argument.
pub fn parse_header(raw: &str) -> Result<MockHeader, CliError> {
    let (name, value) = raw.split_once(':').ok_or_else(|| {
        invalid_params(&format!(
            "malformed header {raw:?}: expected 'Name: value'"
        ))
    })?;
    let name = name.trim();
    if name.is_empty() {
        return Err(invalid_params(&format!(
            "malformed header {raw:?}: name is empty"
        )));
    }
    Ok(MockHeader {
        name: name.to_string(),
        value: value.trim().to_string(),
    })
}

/// Build the wire params for `add`.
pub fn build_add_params(
    session: &str,
    args: &AddArgs,
    body: ResolvedBody,
) -> Result<MockParams, CliError> {
    let mut headers = Vec::with_capacity(args.headers.len());
    for raw in &args.headers {
        headers.push(parse_header(raw)?);
    }

    let rule = MockRule {
        id: None,
        enabled: !args.disabled,
        url_pattern: args.url.clone(),
        method: args
            .method
            .as_ref()
            .map(|method| method.trim().to_ascii_uppercase()),
        status: args.status,
        headers,
        body: body.body,
        body_encoding: body.encoding,
        delay_ms: args.delay,
        note: args.note.clone(),
    };

    validate_rule(&rule).map_err(|err| invalid_params(&err))?;

    Ok(MockParams {
        session_id: session.to_string(),
        action: MockAction::Add,
        rule: Some(rule),
        id: None,
        rules: None,
    })
}

/// Build the wire params for `remove`.
pub fn build_remove_params(session: &str, args: &RemoveArgs) -> Result<MockParams, CliError> {
    let id = args.id.trim();
    if id.is_empty() {
        return Err(invalid_params("rule id must not be empty"));
    }
    Ok(MockParams {
        session_id: session.to_string(),
        action: MockAction::Remove,
        rule: None,
        id: Some(id.to_string()),
        rules: None,
    })
}

/// Build the wire params for a rule-set replacement (used by `import`).
pub fn build_replace_params(
    session: &str,
    rules: Vec<MockRule>,
) -> Result<MockParams, CliError> {
    validate_rule_set(&rules).map_err(|err| invalid_params(&err))?;
    Ok(MockParams {
        session_id: session.to_string(),
        action: MockAction::ReplaceAll,
        rule: None,
        id: None,
        rules: Some(rules),
    })
}

/// Build the wire params for a read-only action.
pub fn build_simple_params(session: &str, action: MockAction) -> MockParams {
    MockParams {
        session_id: session.to_string(),
        action,
        rule: None,
        id: None,
        rules: None,
    }
}

/// `session.list` reply, mirrored locally to avoid reaching into another
/// module's private types.
#[derive(Debug, Deserialize)]
struct SessionListReply {
    sessions: Vec<SessionStatusEntry>,
}

/// How many rules are in effect, or `None` when the lookup did not succeed.
///
/// Used by `session stop` to warn about rules that outlive the session.
/// Returning `Option` rather than `Result` is the point: `session stop` runs
/// in `finally`-style cleanup paths (the browser evaluation harness depends on
/// it), so a mock-table read must never be able to make stopping a session
/// fail. The short timeout serves the same goal.
pub(crate) fn count_rules(sock: &Path, session_id: &str) -> Option<usize> {
    let params = build_simple_params(session_id, MockAction::List);
    let reply: MockResult = crate::cli::business_rpc::call::<MockParams, MockResult>(
        sock.to_path_buf(),
        "mock-count",
        Method::ToolMock,
        Some(params),
        MOCK_COUNT_TIMEOUT,
    )
    .ok()?;
    Some(reply.rules.len())
}

fn invalid_params(message: &str) -> CliError {
    CliError::from_rpc(RpcError {
        code: ErrorCode::InvalidParams,
        message: message.to_string(),
        data: None,
    })
}

fn call<P, R>(sock: PathBuf, method: Method, params: Option<P>) -> Result<R, CliError>
where
    P: serde::Serialize + Send + 'static,
    R: serde::de::DeserializeOwned + Send + 'static,
{
    crate::cli::business_rpc::call::<P, R>(sock, "mock", method, params, TOOL_IPC_TIMEOUT)
}

/// Resolve the routing session.
///
/// An explicit `--session` always wins. Otherwise a single active session is
/// used; zero or several are an error that names what to do next, rather
/// than silently picking one.
fn resolve_session(sock: &Path, explicit: Option<&str>) -> Result<String, CliError> {
    if let Some(id) = explicit {
        if id.trim().is_empty() {
            return Err(invalid_params("--session must not be empty"));
        }
        return Ok(id.to_string());
    }

    let reply: SessionListReply = crate::cli::business_rpc::call::<(), SessionListReply>(
        sock.to_path_buf(),
        "mock-session-list",
        Method::SessionList,
        None,
        SESSION_LOOKUP_TIMEOUT,
    )?;

    match reply.sessions.as_slice() {
        [only] => Ok(only.session_id.clone()),
        [] => Err(invalid_params(
            "no active session: run `bsk session start` first, or pass --session <id>",
        )),
        many => {
            let ids: Vec<&str> = many.iter().map(|s| s.session_id.as_str()).collect();
            Err(invalid_params(&format!(
                "{} active sessions ({}): pass --session <id> to choose one",
                many.len(),
                ids.join(", ")
            )))
        }
    }
}

pub fn dispatch(cmd: MockCmd, format: Format) -> Result<(), CliError> {
    let info = ensure_daemon().context("ensure daemon is running")?;
    let sock = info.sock_path;
    let session = || resolve_session(&sock, cmd.session.as_deref());

    match cmd.sub {
        MockSub::Add(args) => {
            let session = session()?;
            let body = body_source(&args.body)?.load()?;
            let params = build_add_params(&session, &args, body)?;
            let reply: MockResult = call(sock, Method::ToolMock, Some(params))?;
            render(&reply, format, RenderHint::Add)
        }
        MockSub::List => {
            let session = session()?;
            let params = build_simple_params(&session, MockAction::List);
            let reply: MockResult = call(sock, Method::ToolMock, Some(params))?;
            render(&reply, format, RenderHint::List)
        }
        MockSub::Remove(args) => {
            let session = session()?;
            let params = build_remove_params(&session, &args)?;
            let reply: MockResult = call(sock, Method::ToolMock, Some(params))?;
            render(&reply, format, RenderHint::Remove)
        }
        MockSub::Clear => {
            let session = session()?;
            let params = build_simple_params(&session, MockAction::Clear);
            let reply: MockResult = call(sock, Method::ToolMock, Some(params))?;
            render(&reply, format, RenderHint::Clear)
        }
        MockSub::Import(args) => {
            let session = session()?;
            let raw = std::fs::read_to_string(&args.file).map_err(|err| {
                CliError::Local(anyhow::anyhow!(
                    "cannot read {}: {err}",
                    args.file.display()
                ))
            })?;
            let parsed: Vec<MockRule> = serde_json::from_str(&raw).map_err(|err| {
                CliError::Local(anyhow::anyhow!(
                    "{} is not a JSON array of rules: {err}",
                    args.file.display()
                ))
            })?;

            let rules = if args.merge {
                let current: MockResult = call(
                    sock.clone(),
                    Method::ToolMock,
                    Some(build_simple_params(&session, MockAction::List)),
                )?;
                let mut merged = current.rules;
                merged.extend(parsed);
                merged
            } else {
                parsed
            };

            let params = build_replace_params(&session, rules)?;
            let reply: MockResult = call(sock, Method::ToolMock, Some(params))?;
            render(&reply, format, RenderHint::Import)
        }
        MockSub::Export(args) => {
            let session = session()?;
            let params = build_simple_params(&session, MockAction::List);
            let reply: MockResult = call(sock, Method::ToolMock, Some(params))?;
            let json = serde_json::to_string_pretty(&reply.rules)
                .map_err(|e| CliError::Local(anyhow::anyhow!(e)))?;
            match args.out {
                Some(path) => {
                    std::fs::write(&path, format!("{json}\n")).map_err(|err| {
                        CliError::Local(anyhow::anyhow!(
                            "cannot write {}: {err}",
                            path.display()
                        ))
                    })?;
                    if format == Format::Human {
                        println!("wrote {} rule(s) to {}", reply.rules.len(), path.display());
                    }
                }
                None => println!("{json}"),
            }
            Ok(())
        }
    }
}

/// What the command did, so the human renderer can lead with it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum RenderHint {
    Add,
    List,
    Remove,
    Clear,
    Import,
}

fn render(reply: &MockResult, format: Format, hint: RenderHint) -> Result<(), CliError> {
    if format == Format::Json {
        let json = serde_json::to_string_pretty(reply)
            .map_err(|e| CliError::Local(anyhow::anyhow!(e)))?;
        println!("{json}");
        return Ok(());
    }

    match hint {
        RenderHint::Add => match &reply.created_id {
            Some(id) => println!("added rule {id}"),
            None => println!("added rule"),
        },
        RenderHint::Remove | RenderHint::Clear | RenderHint::Import => {
            match reply.removed {
                Some(count) => println!("removed {count} rule(s)"),
                None => println!("updated rule set"),
            }
        }
        RenderHint::List => {}
    }

    if reply.rules.is_empty() {
        println!("(no mock rules)");
    } else {
        println!(
            "{:<12}  {:<5}  {:<7}  {:<6}  {}",
            "ID", "STATE", "METHOD", "STATUS", "URL PATTERN"
        );
        for rule in &reply.rules {
            let id = rule.id.as_deref().unwrap_or("-");
            let state = if rule.enabled { "on" } else { "off" };
            let method = rule.method.as_deref().unwrap_or("ANY");
            println!(
                "{:<12}  {:<5}  {:<7}  {:<6}  {}",
                id, state, method, rule.status, rule.url_pattern
            );
        }
    }

    if let Some(note) = &reply.note {
        println!("note: {note}");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn add_args() -> AddArgs {
        AddArgs {
            url: "https://api.example.com/user/*".into(),
            method: None,
            status: 200,
            headers: vec![],
            delay: None,
            note: None,
            disabled: false,
            body: BodyArgs {
                body: None,
                body_file: None,
                body_file_base64: None,
            },
        }
    }

    fn text_body(body: &str) -> ResolvedBody {
        ResolvedBody {
            body: body.to_string(),
            encoding: MockBodyEncoding::Text,
        }
    }

    #[test]
    fn add_defaults_to_an_enabled_any_method_200_rule() {
        let params = build_add_params("abcd", &add_args(), text_body("")).unwrap();
        assert_eq!(params.session_id, "abcd");
        assert_eq!(params.action, MockAction::Add);
        assert!(params.rule.is_none() == false);
        let rule = params.rule.unwrap();
        assert!(rule.enabled);
        assert_eq!(rule.status, 200);
        assert_eq!(rule.method, None);
        assert!(rule.headers.is_empty());
        assert_eq!(rule.body_encoding, MockBodyEncoding::Text);
    }

    #[test]
    fn add_carries_every_flag_onto_the_rule() {
        let args = AddArgs {
            method: Some("post".into()),
            status: 503,
            headers: vec!["content-type: application/json".into()],
            delay: Some(250),
            note: Some("backend down".into()),
            ..add_args()
        };
        let rule = build_add_params("abcd", &args, text_body("{}"))
            .unwrap()
            .rule
            .unwrap();
        assert_eq!(rule.method.as_deref(), Some("POST"), "method is upcased");
        assert_eq!(rule.status, 503);
        assert_eq!(rule.delay_ms, Some(250));
        assert_eq!(rule.note.as_deref(), Some("backend down"));
        assert_eq!(rule.headers[0].name, "content-type");
        assert_eq!(rule.headers[0].value, "application/json");
    }

    #[test]
    fn disabled_flag_stores_the_rule_off() {
        let args = AddArgs {
            disabled: true,
            ..add_args()
        };
        let rule = build_add_params("abcd", &args, text_body(""))
            .unwrap()
            .rule
            .unwrap();
        assert!(!rule.enabled);
    }

    #[test]
    fn add_rejects_an_empty_url_pattern() {
        let args = AddArgs {
            url: "  ".into(),
            ..add_args()
        };
        let err = build_add_params("abcd", &args, text_body("")).unwrap_err();
        assert!(err.to_string().contains("url_pattern"), "{err}");
    }

    #[test]
    fn add_rejects_an_out_of_range_status() {
        let args = AddArgs {
            status: 999,
            ..add_args()
        };
        let err = build_add_params("abcd", &args, text_body("")).unwrap_err();
        assert!(err.to_string().contains("status"), "{err}");
    }

    #[test]
    fn header_without_a_colon_is_rejected() {
        let err = parse_header("content-type").unwrap_err();
        assert!(err.to_string().contains("Name: value"), "{err}");
    }

    #[test]
    fn header_with_an_empty_name_is_rejected() {
        let err = parse_header("  : value").unwrap_err();
        assert!(err.to_string().contains("empty"), "{err}");
    }

    #[test]
    fn header_splits_on_the_first_colon_only() {
        let header = parse_header("x-forwarded-for: 1.2.3.4:5678").unwrap();
        assert_eq!(header.name, "x-forwarded-for");
        assert_eq!(header.value, "1.2.3.4:5678");
    }

    #[test]
    fn header_injection_through_a_flag_is_rejected() {
        let args = AddArgs {
            headers: vec!["x-evil: a\r\nSet-Cookie: pwned=1".into()],
            ..add_args()
        };
        let err = build_add_params("abcd", &args, text_body("")).unwrap_err();
        assert!(err.to_string().contains("line break"), "{err}");
    }

    #[test]
    fn body_source_defaults_to_empty() {
        let source = body_source(&BodyArgs {
            body: None,
            body_file: None,
            body_file_base64: None,
        })
        .unwrap();
        assert_eq!(source, BodySource::Empty);
        let resolved = source.load().unwrap();
        assert_eq!(resolved.body, "");
        assert_eq!(resolved.encoding, MockBodyEncoding::Text);
    }

    #[test]
    fn body_source_prefers_the_only_flag_set() {
        let source = body_source(&BodyArgs {
            body: Some("{\"a\":1}".into()),
            body_file: None,
            body_file_base64: None,
        })
        .unwrap();
        assert_eq!(source, BodySource::Literal("{\"a\":1}".into()));
    }

    #[test]
    fn conflicting_body_flags_are_rejected() {
        let err = body_source(&BodyArgs {
            body: Some("x".into()),
            body_file: Some(PathBuf::from("/tmp/a")),
            body_file_base64: None,
        })
        .unwrap_err();
        assert!(err.to_string().contains("mutually exclusive"), "{err}");
    }

    #[test]
    fn binary_body_source_encodes_file_bytes() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("pixel.bin");
        std::fs::write(&path, [0x89u8, 0x50, 0x4e, 0x47]).unwrap();

        let resolved = BodySource::BinaryFile(path).load().unwrap();
        assert_eq!(resolved.encoding, MockBodyEncoding::Base64);
        assert_eq!(resolved.body, "iVBORw==");
    }

    #[test]
    fn text_body_source_reads_utf8() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("body.json");
        std::fs::write(&path, "{\"ok\":true}").unwrap();

        let resolved = BodySource::TextFile(path).load().unwrap();
        assert_eq!(resolved.encoding, MockBodyEncoding::Text);
        assert_eq!(resolved.body, "{\"ok\":true}");
    }

    #[test]
    fn missing_body_file_is_a_local_error() {
        let err = BodySource::TextFile(PathBuf::from("/nonexistent/bsk-mock-body"))
            .load()
            .unwrap_err();
        assert!(err.to_string().contains("cannot read"), "{err}");
    }

    #[test]
    fn remove_requires_a_non_empty_id() {
        let err = build_remove_params("abcd", &RemoveArgs { id: "  ".into() }).unwrap_err();
        assert!(err.to_string().contains("must not be empty"), "{err}");

        let params = build_remove_params("abcd", &RemoveArgs { id: " m_1 ".into() }).unwrap();
        assert_eq!(params.action, MockAction::Remove);
        assert_eq!(params.id.as_deref(), Some("m_1"), "id is trimmed");
    }

    #[test]
    fn replace_validates_the_whole_set() {
        let good = MockRule {
            id: None,
            enabled: true,
            url_pattern: "https://a.test/x".into(),
            method: None,
            status: 200,
            headers: vec![],
            body: String::new(),
            body_encoding: MockBodyEncoding::Text,
            delay_ms: None,
            note: None,
        };
        let params = build_replace_params("abcd", vec![good.clone()]).unwrap();
        assert_eq!(params.action, MockAction::ReplaceAll);
        assert_eq!(params.rules.unwrap().len(), 1);

        let bad = MockRule {
            url_pattern: String::new(),
            ..good
        };
        let err = build_replace_params("abcd", vec![bad]).unwrap_err();
        assert!(err.to_string().contains("rule #0"), "{err}");
    }

    #[test]
    fn simple_params_carry_only_the_action() {
        let params = build_simple_params("abcd", MockAction::List);
        assert_eq!(params.action, MockAction::List);
        assert!(params.rule.is_none());
        assert!(params.id.is_none());
        assert!(params.rules.is_none());
    }
}
