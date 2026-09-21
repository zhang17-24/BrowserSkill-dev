//! `bsk network` — read buffered page network responses / failures.

use std::path::PathBuf;

use anyhow::Context;
use bsk_protocol::Method;
use bsk_protocol::tools::{NetworkEntry, NetworkParams, NetworkResult};
use clap::Args;

use crate::cli::TOOL_IPC_TIMEOUT;
use crate::cli::ensure_daemon::ensure_daemon;
use crate::cli::error::{CliError, Format};

#[derive(Debug, Clone, Args)]
pub struct NetworkArgs {
    /// Session id (must be active).
    #[arg(long)]
    pub session: String,

    /// Target tab. Defaults to the Agent Window's active tab.
    #[arg(long = "tab-id")]
    pub tab_id: Option<i64>,

    /// Return entries with sequence greater than this cursor (exclusive).
    ///
    /// Combining `--since` with `--limit` pages forward from a known cursor.
    #[arg(long)]
    pub since: Option<u64>,

    /// Maximum number of entries to return. Defaults to 50; extension caps at 200.
    ///
    /// Without `--since` this returns the **newest** entries; with `--since` it
    /// returns the **oldest** after the cursor. The two modes read from opposite
    /// ends of the buffer, so the same `--limit` means different things depending
    /// on whether a cursor is present.
    #[arg(long, value_parser = clap::value_parser!(u32).range(1..))]
    pub limit: Option<u32>,

    /// Maximum characters per URL / error text. Defaults to 1000; extension caps at 4096.
    #[arg(long = "max-text-chars", value_parser = clap::value_parser!(u32).range(1..))]
    pub max_text_chars: Option<u32>,
}

pub fn dispatch(args: NetworkArgs, format: Format) -> Result<(), CliError> {
    let info = ensure_daemon().context("ensure daemon is running")?;
    run(info.sock_path, args, format)
}

fn run(sock: PathBuf, args: NetworkArgs, format: Format) -> Result<(), CliError> {
    let params = NetworkParams {
        session_id: args.session,
        tab_id: args.tab_id,
        since: args.since,
        limit: args.limit,
        max_text_chars: args.max_text_chars,
    };
    let reply: NetworkResult = call(sock, params)?;
    render(&reply, format)
}

fn call(sock: PathBuf, params: NetworkParams) -> Result<NetworkResult, CliError> {
    crate::cli::business_rpc::call::<NetworkParams, NetworkResult>(
        sock,
        "network",
        Method::ToolNetwork,
        Some(params),
        TOOL_IPC_TIMEOUT,
    )
}

fn render(reply: &NetworkResult, format: Format) -> Result<(), CliError> {
    match format {
        Format::Json => {
            let json = serde_json::to_string_pretty(reply)
                .map_err(|e| CliError::Local(anyhow::anyhow!(e)))?;
            println!("{json}");
        }
        Format::Human => {
            if reply.entries.is_empty() {
                println!("(no network activity captured)");
            } else {
                for entry in &reply.entries {
                    println!("{}", render_entry(entry));
                }
            }
            if reply.truncated {
                // An absent `next_since` means nothing has been captured for this
                // tab yet, so there is no cursor to continue from — saying
                // "next_since=0" here invited a caller to resume with `--since 0`,
                // which reads the buffer from the beginning instead.
                match reply.next_since {
                    Some(next) => eprintln!(
                        "warning: network output truncated (next_since={next}). Use --since / --limit / --max-text-chars to request a different slice."
                    ),
                    None => eprintln!(
                        "warning: network output truncated, with no cursor to resume from yet. Use --limit / --max-text-chars to request a different slice."
                    ),
                }
            }
        }
    }
    Ok(())
}

fn render_entry(entry: &NetworkEntry) -> String {
    let method = entry.method.as_deref().unwrap_or("?");
    let url = entry.url.as_deref().unwrap_or("(unknown)");
    // A mocked entry is the one line here that was never on the network. Without
    // the mark it reads as an ordinary response and the reader concludes the
    // request went out — which is exactly the mistake this field exists to make
    // impossible.
    let provenance = if entry.mocked {
        match entry.rule_id.as_deref() {
            Some(rule) => format!("  [MOCKED by {rule}]"),
            None => "  [MOCKED]".to_string(),
        }
    } else {
        String::new()
    };
    match entry.kind {
        bsk_protocol::tools::NetworkEntryKind::Failure => {
            let err = entry.error_text.as_deref().unwrap_or("failed");
            format!(
                "#{} FAILED {method} {url} - {err}{provenance}",
                entry.sequence
            )
        }
        bsk_protocol::tools::NetworkEntryKind::Response => {
            let status = entry
                .status
                .map(|s| s.to_string())
                .unwrap_or_else(|| "?".to_string());
            format!("#{} {status} {method} {url}{provenance}", entry.sequence)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use bsk_protocol::tools::NetworkEntryKind;

    fn entry(kind: NetworkEntryKind) -> NetworkEntry {
        NetworkEntry {
            sequence: 7,
            kind,
            method: Some("GET".into()),
            url: Some("https://api.test/user/1".into()),
            status: Some(200),
            status_text: None,
            mime_type: None,
            resource_type: Some("Fetch".into()),
            error_text: None,
            timestamp: None,
            truncated: false,
            mocked: false,
            rule_id: None,
        }
    }

    #[test]
    fn human_failure_output_uses_ascii_and_displays_unknown_url() {
        let failed = NetworkEntry {
            sequence: 7,
            kind: NetworkEntryKind::Failure,
            url: None,
            error_text: Some("net::ERR_FAILED".into()),
            ..entry(NetworkEntryKind::Failure)
        };

        assert_eq!(
            render_entry(&failed),
            "#7 FAILED GET (unknown) - net::ERR_FAILED"
        );
    }

    #[test]
    fn a_mocked_response_is_marked_and_names_its_rule() {
        // The mark is the whole reason a mocked request is recorded: unmarked it
        // reads as an ordinary response, and the reader concludes the request
        // went out. Naming the rule saves a lookup in `bsk mock list`.
        let mocked = NetworkEntry {
            mocked: true,
            rule_id: Some("m_abc123".into()),
            ..entry(NetworkEntryKind::Response)
        };
        assert_eq!(
            render_entry(&mocked),
            "#7 200 GET https://api.test/user/1  [MOCKED by m_abc123]"
        );

        // A rule id is not guaranteed (an old extension, a hand-written wire
        // message), so the mark must stand on its own.
        let anonymous = NetworkEntry {
            mocked: true,
            ..entry(NetworkEntryKind::Response)
        };
        assert_eq!(
            render_entry(&anonymous),
            "#7 200 GET https://api.test/user/1  [MOCKED]"
        );
    }

    #[test]
    fn an_ordinary_response_carries_no_mark() {
        assert_eq!(
            render_entry(&entry(NetworkEntryKind::Response)),
            "#7 200 GET https://api.test/user/1"
        );
    }
}
