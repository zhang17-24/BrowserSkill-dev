//! CLI-side IPC client: reads `~/.bsk/daemon.json` for the socket path
//! and issues typed JSON-line RPCs over it.
//!
//! Each [`Client::call`] is a fresh connection (cheap: UDS is local).
//! Future milestones may pool connections for the long-running `bsk
//! events` / `bsk logs -f` commands.
//!
//! On Windows the same line protocol runs over a per-user named pipe.

use std::fmt;

use bsk_protocol::{ResponseBody, RpcError};

/// Hint shown when the IPC link could not be established at all.
pub const HINT_DAEMON_UNREACHABLE: &str =
    "is the daemon running? try `bsk daemon start` or `bsk status`";

/// Hint shown when the daemon answered, but not with something this CLI
/// understands.
///
/// Chasing "is the daemon running?" here costs the user real time: the
/// daemon *is* running. It is a different build — usually an older one that
/// was started before the CLI was rebuilt, so its `Method` enum does not
/// even contain the method being called.
pub const HINT_DAEMON_BUILD_MISMATCH: &str =
    "the daemon is a different build; `bsk daemon stop` and retry so the CLI starts its own";

/// Marker for a failure on the CLI↔daemon link, carrying the hint to show.
///
/// `CliError::Local` is the CLI's catch-all: argument validation, a missing
/// `--body-file`, JSON encoding and the IPC link all land in it. The hint
/// therefore travels *with* the failure that knows what it is, instead of
/// being inferred from the variant — a missing body file used to be told to
/// go start a daemon that was already running.
#[derive(Debug)]
pub struct DaemonLinkError {
    /// Hint to render beneath the error. `None` renders no hint.
    pub hint: Option<&'static str>,
    pub error: anyhow::Error,
}

impl fmt::Display for DaemonLinkError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        // Only the wrapped error's own message, not its whole chain: `this`
        // already sits *inside* that chain, and anyhow renders the chain with
        // `{:#}`. Delegating the full chain here printed every inner cause
        // twice.
        write!(f, "{}", self.error)
    }
}

impl std::error::Error for DaemonLinkError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        // Skip one level for the same reason: the wrapped error's message is
        // what `Display` above already printed.
        self.error.source()
    }
}

/// Tag a failure as belonging to the IPC link.
///
/// Idempotent: an error that already carries a [`DaemonLinkError`] keeps it,
/// so the specific hint the decode paths attach survives. Anything else is
/// treated as "could not reach the daemon", which is what a connect, write
/// or read failure means.
pub fn map_link_error(err: anyhow::Error) -> anyhow::Error {
    if err
        .chain()
        .any(|cause| cause.downcast_ref::<DaemonLinkError>().is_some())
    {
        return err;
    }
    anyhow::Error::new(DaemonLinkError {
        hint: Some(HINT_DAEMON_UNREACHABLE),
        error: err,
    })
}

/// Build a link failure with a specific hint.
fn link_error(hint: &'static str, message: String) -> anyhow::Error {
    anyhow::Error::new(DaemonLinkError {
        hint: Some(hint),
        error: anyhow::anyhow!(message),
    })
}

/// Explanation for a response that could not be correlated to its request.
///
/// A frame carrying an id the caller never sent is a build mismatch, and the
/// daemon's own complaint is the useful part: `invalid frame: unknown variant
/// 'tool.mock'` names the problem, while "id mismatch" only names the symptom.
fn id_mismatch_message(expected: &str, got: &str, body: &ResponseBody) -> String {
    let mut message = format!("IPC response id mismatch: expected {expected}, got {got}");
    if let ResponseBody::Err(err) = body {
        message.push_str(&format!("; the daemon replied: {}", err.message));
    }
    message
}

/// Explanation for a reply that parsed as a frame but not as this CLI's
/// expected result shape — also a build mismatch, in the other direction.
fn result_mismatch_message(error: &serde_json::Error) -> String {
    format!(
        "the daemon's reply does not match this CLI's protocol; \
         the two are different builds ({error})"
    )
}

#[cfg(unix)]
mod platform {
    use std::path::PathBuf;
    use std::time::Duration;

    use anyhow::{Context, Result};
    use bsk_protocol::{Frame, Method, RequestFrame, ResponseBody};
    use serde::{Serialize, de::DeserializeOwned};
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
    use tokio::net::UnixStream;
    use tokio::time::timeout;

    use crate::ipc_client::{RpcOutcome, random_id};

    /// Connected IPC client. Holds an open UDS connection plus a buffered
    /// reader/writer pair.
    pub struct Client {
        stream: BufReader<tokio::net::unix::OwnedReadHalf>,
        write: tokio::net::unix::OwnedWriteHalf,
        sock_path: PathBuf,
    }

    impl Client {
        /// PID in the caller's namespace, supplied by the kernel, not JSON.
        pub(crate) fn peer_pid(&self) -> std::io::Result<Option<u32>> {
            let credentials = self.stream.get_ref().as_ref().peer_cred()?;
            Ok(credentials
                .pid()
                .and_then(|pid| u32::try_from(pid).ok())
                .filter(|pid| *pid > 0))
        }

        /// Connect directly to a UDS path (used by tests + auto-spawn
        /// after the parent has just written daemon.json).
        pub async fn connect_path(sock_path: PathBuf) -> Result<Self> {
            let stream = UnixStream::connect(&sock_path)
                .await
                .with_context(|| format!("connect IPC socket {}", sock_path.display()))?;
            let (read, write) = stream.into_split();
            Ok(Self {
                stream: BufReader::new(read),
                write,
                sock_path,
            })
        }

        /// Issue a typed RPC: serialise `params`, send one JSON line, read
        /// one JSON line back, deserialise into `R`. Honours an overall
        /// `timeout`.
        pub async fn call<P: Serialize, R: DeserializeOwned>(
            &mut self,
            method: Method,
            params: &P,
            call_timeout: Duration,
        ) -> Result<RpcOutcome<R>> {
            self.call_with_id(random_id(), method, params, call_timeout)
                .await
        }

        /// Same as [`Client::call`] but uses the caller-provided
        /// `id` as the wire correlation id. Lets the SIGINT cancel
        /// helper refer back to a known id without racing the
        /// random_id() generator (M10.2).
        pub async fn call_with_id<P: Serialize, R: DeserializeOwned>(
            &mut self,
            id: String,
            method: Method,
            params: &P,
            call_timeout: Duration,
        ) -> Result<RpcOutcome<R>> {
            let frame = Frame::Request(RequestFrame {
                id: id.clone(),
                method,
                params: Some(serde_json::to_value(params).context("serialise params")?),
            });
            let mut payload = serde_json::to_string(&frame).context("encode request")?;
            payload.push('\n');

            timeout(call_timeout, async {
                self.write.write_all(payload.as_bytes()).await?;
                self.write.flush().await?;
                Result::<()>::Ok(())
            })
            .await
            .context("IPC write timed out")??;

            let mut line = String::new();
            timeout(call_timeout, self.stream.read_line(&mut line))
                .await
                .context("IPC read timed out")??;

            decode_response(line.trim_end(), &id)
        }

        /// Path of the socket this client connected through (debug helper).
        pub fn sock_path(&self) -> &std::path::Path {
            &self.sock_path
        }
    }

    fn decode_response<R: DeserializeOwned>(line: &str, id: &str) -> Result<RpcOutcome<R>> {
        let frame: Frame = serde_json::from_str(line).context("decode IPC response")?;
        match frame {
            Frame::Response(resp) => {
                if resp.id != id {
                    // A frame carrying an id the caller never sent means the
                    // two sides disagree about the protocol, and the daemon's
                    // own message is the useful half: it names the unknown
                    // method. Dropping it left the caller with only "the ids
                    // disagreed", which reads like version skew at best.
                    return Err(super::link_error(
                        super::HINT_DAEMON_BUILD_MISMATCH,
                        super::id_mismatch_message(id, &resp.id, &resp.body),
                    ));
                }
                match resp.body {
                    ResponseBody::Ok(v) => {
                        let value: R = serde_json::from_value(v).map_err(|err| {
                            super::link_error(
                                super::HINT_DAEMON_BUILD_MISMATCH,
                                super::result_mismatch_message(&err),
                            )
                        })?;
                        Ok(Ok(value))
                    }
                    ResponseBody::Err(e) => Ok(Err(e)),
                }
            }
            other => Err(super::link_error(
                super::HINT_DAEMON_BUILD_MISMATCH,
                format!("unexpected frame from daemon: {other:?}"),
            )),
        }
    }
}

#[cfg(windows)]
mod platform {
    use std::path::{Path, PathBuf};
    use std::time::Duration;

    use anyhow::{Context, Result};
    use bsk_protocol::{Frame, Method, RequestFrame, ResponseBody};
    use serde::{Serialize, de::DeserializeOwned};
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
    use tokio::net::windows::named_pipe::{ClientOptions, NamedPipeClient};
    use tokio::time::{sleep, timeout};
    use windows_sys::Win32::Foundation::ERROR_PIPE_BUSY;

    use crate::ipc_client::{RpcOutcome, random_id};

    pub struct Client {
        stream: BufReader<tokio::io::ReadHalf<NamedPipeClient>>,
        write: tokio::io::WriteHalf<NamedPipeClient>,
        pipe_name: PathBuf,
        peer_pid: std::io::Result<Option<u32>>,
    }

    impl Client {
        pub(crate) fn peer_pid(&self) -> std::io::Result<Option<u32>> {
            self.peer_pid
                .as_ref()
                .copied()
                .map_err(|err| std::io::Error::new(err.kind(), err.to_string()))
        }

        /// Total budget for retrying `ERROR_PIPE_BUSY` while connecting
        /// to the daemon's named pipe. Long enough to ride out a
        /// short-lived burst of clients, short enough that a wedged or
        /// preempted pipe surfaces as a clear error rather than a
        /// silent hang.
        const CONNECT_BUSY_TIMEOUT: Duration = Duration::from_secs(5);

        pub async fn connect_path(pipe_name: PathBuf) -> Result<Self> {
            let name = pipe_name.to_string_lossy().into_owned();
            let connect_loop = async {
                loop {
                    match ClientOptions::new().open(&name) {
                        Ok(client) => return Ok::<NamedPipeClient, anyhow::Error>(client),
                        Err(err) if err.raw_os_error() == Some(ERROR_PIPE_BUSY as i32) => {
                            sleep(Duration::from_millis(50)).await;
                        }
                        Err(err) => {
                            return Err(anyhow::Error::from(err)
                                .context(format!("connect IPC named pipe {name}")));
                        }
                    }
                }
            };
            let client = timeout(Self::CONNECT_BUSY_TIMEOUT, connect_loop)
                .await
                .map_err(|_| {
                    anyhow::anyhow!(
                        "named pipe {name} still busy after {:?}; daemon may be wedged or preempted",
                        Self::CONNECT_BUSY_TIMEOUT
                    )
                })??;
            // Fetch while the pipe handle is directly available; an identity
            // lookup failure affects management only, not normal IPC use.
            use std::os::windows::io::AsRawHandle;
            use windows_sys::Win32::System::Pipes::GetNamedPipeServerProcessId;
            let mut pid = 0;
            let peer_pid =
                if unsafe { GetNamedPipeServerProcessId(client.as_raw_handle(), &mut pid) } != 0 {
                    Ok((pid > 0).then_some(pid))
                } else {
                    Err(std::io::Error::last_os_error())
                };
            let (read, write) = tokio::io::split(client);
            Ok(Self {
                stream: BufReader::new(read),
                write,
                pipe_name,
                peer_pid,
            })
        }

        pub async fn call<P: Serialize, R: DeserializeOwned>(
            &mut self,
            method: Method,
            params: &P,
            call_timeout: Duration,
        ) -> Result<RpcOutcome<R>> {
            self.call_with_id(random_id(), method, params, call_timeout)
                .await
        }

        pub async fn call_with_id<P: Serialize, R: DeserializeOwned>(
            &mut self,
            id: String,
            method: Method,
            params: &P,
            call_timeout: Duration,
        ) -> Result<RpcOutcome<R>> {
            let frame = Frame::Request(RequestFrame {
                id: id.clone(),
                method,
                params: Some(serde_json::to_value(params).context("serialise params")?),
            });
            let mut payload = serde_json::to_string(&frame).context("encode request")?;
            payload.push('\n');

            timeout(call_timeout, async {
                self.write.write_all(payload.as_bytes()).await?;
                self.write.flush().await?;
                Result::<()>::Ok(())
            })
            .await
            .context("IPC write timed out")??;

            let mut line = String::new();
            timeout(call_timeout, self.stream.read_line(&mut line))
                .await
                .context("IPC read timed out")??;

            decode_response(line.trim_end(), &id)
        }

        pub fn sock_path(&self) -> &Path {
            &self.pipe_name
        }
    }

    fn decode_response<R: DeserializeOwned>(line: &str, id: &str) -> Result<RpcOutcome<R>> {
        let frame: Frame = serde_json::from_str(line).context("decode IPC response")?;
        match frame {
            Frame::Response(resp) => {
                if resp.id != id {
                    // A frame carrying an id the caller never sent means the
                    // two sides disagree about the protocol, and the daemon's
                    // own message is the useful half: it names the unknown
                    // method. Dropping it left the caller with only "the ids
                    // disagreed", which reads like version skew at best.
                    return Err(super::link_error(
                        super::HINT_DAEMON_BUILD_MISMATCH,
                        super::id_mismatch_message(id, &resp.id, &resp.body),
                    ));
                }
                match resp.body {
                    ResponseBody::Ok(v) => {
                        let value: R = serde_json::from_value(v).map_err(|err| {
                            super::link_error(
                                super::HINT_DAEMON_BUILD_MISMATCH,
                                super::result_mismatch_message(&err),
                            )
                        })?;
                        Ok(Ok(value))
                    }
                    ResponseBody::Err(e) => Ok(Err(e)),
                }
            }
            other => Err(super::link_error(
                super::HINT_DAEMON_BUILD_MISMATCH,
                format!("unexpected frame from daemon: {other:?}"),
            )),
        }
    }
}

pub use platform::Client;

impl Client {
    /// Discover and verify the existing daemon without starting one.
    pub async fn connect() -> anyhow::Result<Self> {
        use crate::daemon::probe::{Probe, probe_async};
        match probe_async(
            std::time::Duration::from_secs(2),
            bsk_protocol::StatusParams::default(),
        )
        .await?
        {
            Probe::Ready(daemon) => Ok(daemon.client),
            Probe::Absent(_) => {
                anyhow::bail!("no listening daemon (daemon.json or IPC endpoint missing)")
            }
        }
    }
}

/// Result of a typed RPC: either the deserialised happy-path result or
/// the structured `RpcError` returned by the daemon.
pub type RpcOutcome<T> = std::result::Result<T, RpcError>;

/// Test/embed helper that exposes the M4/M5 `IpcClient` API on top of the
/// production [`Client`]. Skips the `daemon.json` pid-verification step
/// so integration tests can talk to an ad-hoc daemon spawned via
/// [`crate::daemon::run`].
pub struct IpcClient {
    inner: Client,
}

impl IpcClient {
    /// Connect to the daemon's socket.
    ///
    /// A failure here is tagged as a link failure, which is the one place
    /// "is the daemon running?" is genuinely the right thing to say.
    pub async fn connect(sock_path: impl AsRef<std::path::Path>) -> anyhow::Result<Self> {
        let inner = Client::connect_path(sock_path.as_ref().to_path_buf())
            .await
            .map_err(map_link_error)?;
        Ok(Self { inner })
    }

    /// Issue a single RPC. The `_id` argument exists for API parity with
    /// the M4/M5 surface; the underlying [`Client::call`] generates its
    /// own correlation id since the wire id is only meaningful inside
    /// one connection.
    pub async fn call<P, R>(
        &mut self,
        _id: impl Into<bsk_protocol::RpcId>,
        method: bsk_protocol::Method,
        params: Option<P>,
        call_timeout: std::time::Duration,
    ) -> anyhow::Result<std::result::Result<R, RpcError>>
    where
        P: serde::Serialize,
        R: serde::de::DeserializeOwned,
    {
        match params {
            Some(p) => self.inner.call::<P, R>(method, &p, call_timeout).await,
            None => self.inner.call::<(), R>(method, &(), call_timeout).await,
        }
        .map_err(map_link_error)
    }

    /// Same as [`IpcClient::call`] but pins the wire correlation id
    /// so the SIGINT cancel helper can refer back to it (M10.2).
    pub async fn call_with_id<P, R>(
        &mut self,
        id: bsk_protocol::RpcId,
        method: bsk_protocol::Method,
        params: Option<P>,
        call_timeout: std::time::Duration,
    ) -> anyhow::Result<std::result::Result<R, RpcError>>
    where
        P: serde::Serialize,
        R: serde::de::DeserializeOwned,
    {
        match params {
            Some(p) => {
                self.inner
                    .call_with_id::<P, R>(id, method, &p, call_timeout)
                    .await
            }
            None => {
                self.inner
                    .call_with_id::<(), R>(id, method, &(), call_timeout)
                    .await
            }
        }
        .map_err(map_link_error)
    }
}

/// Generate an opaque RPC correlation id (12 lowercase hex chars).
fn random_id() -> String {
    use rand::Rng;
    let mut rng = rand::thread_rng();
    let mut bytes = [0u8; 6];
    rng.fill(&mut bytes[..]);
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The hint carried anywhere in an error's chain.
    fn link_hint(err: &anyhow::Error) -> Option<&'static str> {
        err.chain()
            .find_map(|cause| cause.downcast_ref::<DaemonLinkError>())
            .and_then(|link| link.hint)
    }

    fn daemon_error(message: &str) -> ResponseBody {
        ResponseBody::Err(RpcError {
            code: bsk_protocol::ErrorCode::ProtocolError,
            message: message.into(),
            data: None,
        })
    }

    #[test]
    fn id_mismatch_reports_what_the_daemon_said() {
        // The daemon's own complaint is the actionable half — it names the
        // method it did not recognise. Reporting only "the ids disagreed"
        // sent the user looking for a daemon that was already running.
        let message = id_mismatch_message(
            "abc",
            "0",
            &daemon_error("invalid frame: unknown variant `tool.mock`"),
        );
        assert!(message.contains("expected abc"), "{message}");
        assert!(message.contains("got 0"), "{message}");
        assert!(message.contains("unknown variant `tool.mock`"), "{message}");
    }

    #[test]
    fn id_mismatch_without_a_daemon_message_still_reports_the_mismatch() {
        let message = id_mismatch_message("abc", "0", &ResponseBody::Ok(serde_json::json!({})));
        assert!(message.contains("expected abc"), "{message}");
        assert!(!message.contains("the daemon replied"), "{message}");
    }

    #[test]
    fn tagging_a_link_failure_is_idempotent() {
        let once = map_link_error(anyhow::anyhow!("connect refused"));
        assert_eq!(link_hint(&once), Some(HINT_DAEMON_UNREACHABLE));
        // Re-tagging must not bury the first hint under a second marker.
        let twice = map_link_error(once);
        assert_eq!(link_hint(&twice), Some(HINT_DAEMON_UNREACHABLE));
        assert_eq!(
            twice
                .chain()
                .filter(|cause| cause.downcast_ref::<DaemonLinkError>().is_some())
                .count(),
            1
        );
    }

    #[test]
    fn tagging_preserves_a_specific_hint_and_prints_the_message_once() {
        let specific = anyhow::Error::new(DaemonLinkError {
            hint: Some(HINT_DAEMON_BUILD_MISMATCH),
            error: anyhow::anyhow!("IPC response id mismatch"),
        });
        let tagged = map_link_error(specific);
        assert_eq!(link_hint(&tagged), Some(HINT_DAEMON_BUILD_MISMATCH));
        // The marker forwards `Display` to the wrapped error *and* sits in the
        // chain, so a naive `{:#}` renders the message twice.
        assert_eq!(format!("{tagged:#}"), "IPC response id mismatch");
    }
}
