//! Integration: `tool.mock` reaches the extension through the daemon.
//!
//! This is the wiring no unit test can cover and the compiler cannot check.
//! The daemon's method dispatch ends in an `other =>` arm answering
//! `unknown_method`, so a `tool.mock` missing from `is_queued_tool` compiles
//! cleanly and fails only at runtime — and it fails looking like version skew
//! rather than missing wiring. A fake extension stands in for the browser so
//! the whole CLI → daemon → WS path runs without launching Chrome.
//!
//! Properties exercised:
//! 1. `tool.mock` is forwarded to the extension rather than answered locally.
//! 2. The rule the CLI sends arrives byte-for-byte, so the extension sees
//!    exactly what `bsk mock add` meant.
//! 3. The extension's rule set comes back to the caller unchanged.
//! 4. A method outside the forwarding list is still refused, so widening the
//!    list did not turn the fallback arm into a catch-all.

mod support;

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use bsk::daemon::{self, DaemonConfig};
use bsk_protocol::system::{HandshakeParams, HandshakeResult};
use bsk_protocol::tools::{
    MockAction, MockBodyEncoding, MockHeader, MockParams, MockResult, MockRule, SessionStartParams,
    SessionStartResult,
};
use bsk_protocol::{
    BrowserPeerInfo, ErrorCode, Frame, Method, RequestFrame, ResponseBody, ResponseFrame,
};
use futures_util::stream::SplitSink;
use futures_util::{SinkExt, StreamExt};
use rand::Rng;
use serde_json::{Value, json};
use tokio::sync::{Mutex, mpsc};
use tokio_tungstenite::tungstenite::handshake::client::generate_key;
use tokio_tungstenite::tungstenite::http::Request;
use tokio_tungstenite::tungstenite::protocol::Message;

const TEST_EXT_ID: &str = "abcdefghijklmnopabcdefghijklmnop";

/// One forwarded request, as the fake extension saw it.
struct Forwarded {
    method: Method,
    params: Value,
    /// The correlation id the daemon generated. Replies must use this one —
    /// the id the caller passed to `IpcClient::call` never reaches the wire.
    rpc_id: String,
}

fn tempfile_path(prefix: &str) -> PathBuf {
    let mut p = std::env::temp_dir();
    let mut rng = rand::thread_rng();
    let suffix: String = (0..8)
        .map(|_| char::from_digit(rng.gen_range(0..16), 16).unwrap())
        .collect();
    p.push(format!("{prefix}-{}-{suffix}.sock", std::process::id()));
    p
}

async fn spawn_daemon() -> (daemon::DaemonHandle, PathBuf) {
    let sock = tempfile_path("bsk-test-mock");
    let handle = daemon::run(DaemonConfig::new(0), Some(sock.clone()))
        .await
        .unwrap();
    (handle, sock)
}

type Ws =
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

async fn connect_ext(addr: std::net::SocketAddr) -> Ws {
    let origin = format!("chrome-extension://{TEST_EXT_ID}");
    let url = format!("ws://{addr}/");
    let request = Request::builder()
        .uri(url)
        .header("Host", addr.to_string())
        .header("Connection", "Upgrade")
        .header("Upgrade", "websocket")
        .header("Sec-WebSocket-Version", "13")
        .header("Sec-WebSocket-Key", generate_key())
        .header("Origin", origin)
        .body(())
        .unwrap();
    let (ws, _resp) = tokio_tungstenite::connect_async(request).await.unwrap();
    ws
}

async fn handshake_as_ext(ws: &mut Ws) -> HandshakeResult {
    let params = HandshakeParams {
        client: "browser-skill-extension".into(),
        version: "0.1.0-dev.0".parse().unwrap(),
        protocol_version: bsk::daemon::state::PROTOCOL_VERSION.into(),
        instance_id: TEST_EXT_ID.into(),
        browser: BrowserPeerInfo {
            name: "chrome".into(),
            version: "131.0".into(),
        },
        min_compatible_peer: Some("0.1.0-dev.0".parse().unwrap()),
        min_compatible_protocol: Some("1.0".into()),
        label: "MockTest".into(),
    };
    let req = RequestFrame {
        id: "hs".into(),
        method: Method::SystemHandshake,
        params: Some(serde_json::to_value(params).unwrap()),
    };
    ws.send(Message::Text(serde_json::to_string(&req).unwrap()))
        .await
        .unwrap();
    let resp = ws.next().await.unwrap().unwrap();
    let text = match resp {
        Message::Text(t) => t,
        _ => panic!("expected text frame"),
    };
    let resp: ResponseFrame = serde_json::from_str(&text).unwrap();
    match resp.body {
        ResponseBody::Ok(v) => serde_json::from_value(v).unwrap(),
        ResponseBody::Err(e) => panic!("handshake rejected: {e:?}"),
    }
}

/// A fake extension.
///
/// Session lifecycle is answered inline so a session can be opened without
/// test interaction. Every other request is reported on `forwarded_tx` and
/// left unanswered, so the test decides whether and how to reply — a
/// forwarded `tool.mock` is then proven by its arrival, not by a canned
/// response.
fn run_fake_extension(
    ws: Ws,
    forwarded_tx: mpsc::UnboundedSender<Forwarded>,
    mut replies_rx: mpsc::UnboundedReceiver<(String, Value)>,
) -> tokio::task::JoinHandle<()> {
    let (writer, mut reader) = ws.split();
    let writer: Arc<Mutex<SplitSink<Ws, Message>>> = Arc::new(Mutex::new(writer));

    let writer_task = {
        let writer = Arc::clone(&writer);
        tokio::spawn(async move {
            while let Some((rpc_id, body)) = replies_rx.recv().await {
                let frame = ResponseFrame {
                    id: rpc_id,
                    body: ResponseBody::Ok(body),
                };
                let mut w = writer.lock().await;
                if w.send(Message::Text(serde_json::to_string(&frame).unwrap()))
                    .await
                    .is_err()
                {
                    break;
                }
            }
        })
    };

    let reader_task = tokio::spawn(async move {
        let mut next_window_id = 1_i64;
        while let Some(Ok(msg)) = reader.next().await {
            let text = match msg {
                Message::Text(t) => t,
                Message::Close(_) => break,
                _ => continue,
            };
            let frame: Frame = match serde_json::from_str(&text) {
                Ok(f) => f,
                Err(_) => continue,
            };
            let Frame::Request(req) = frame else { continue };
            let body = match req.method {
                Method::ToolSessionStart => {
                    let _: SessionStartParams =
                        serde_json::from_value(req.params.clone().unwrap()).unwrap();
                    let id = next_window_id;
                    next_window_id += 1;
                    ResponseBody::Ok(
                        serde_json::to_value(SessionStartResult {
                            interaction: None,
                            agent_window_id: Some(id),
                        })
                        .unwrap(),
                    )
                }
                Method::ToolSessionStop => ResponseBody::Ok(json!({})),
                other => {
                    let _ = forwarded_tx.send(Forwarded {
                        method: other.clone(),
                        params: req.params.clone().unwrap_or(Value::Null),
                        rpc_id: req.id.clone(),
                    });
                    continue;
                }
            };
            let reply = ResponseFrame {
                id: req.id.clone(),
                body,
            };
            let mut w = writer.lock().await;
            if w.send(Message::Text(serde_json::to_string(&reply).unwrap()))
                .await
                .is_err()
            {
                break;
            }
        }
    });

    tokio::spawn(async move {
        let _ = reader_task.await;
        writer_task.abort();
    })
}

#[derive(serde::Deserialize)]
struct StartReply {
    session_id: String,
}

async fn ipc_session_start(sock: &PathBuf) -> String {
    let mut ipc = bsk::ipc_client::IpcClient::connect(sock).await.unwrap();
    let r: StartReply = ipc
        .call::<(), _>("qs", Method::SessionStart, None, Duration::from_secs(5))
        .await
        .unwrap()
        .expect("session.start ok");
    r.session_id
}

fn sample_rule() -> MockRule {
    MockRule {
        id: None,
        enabled: true,
        url_pattern: "https://api.example.com/api/user/*".into(),
        method: Some("GET".into()),
        status: 503,
        headers: vec![MockHeader {
            name: "content-type".into(),
            value: "application/json".into(),
        }],
        body: "{\"error\":\"down\"}".into(),
        body_encoding: MockBodyEncoding::Text,
        delay_ms: Some(250),
        note: Some("integration".into()),
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn mock_add_is_forwarded_with_the_rule_intact() {
    let (handle, sock) = spawn_daemon().await;
    let mut ws = connect_ext(handle.ws_addr()).await;
    let _ = handshake_as_ext(&mut ws).await;
    let (forwarded_tx, mut forwarded_rx) = mpsc::unbounded_channel();
    let (_replies_tx, replies_rx) = mpsc::unbounded_channel();
    let fake = run_fake_extension(ws, forwarded_tx, replies_rx);

    let session_id = ipc_session_start(&sock).await;

    let params = MockParams {
        session_id: session_id.clone(),
        action: MockAction::Add,
        rule: Some(sample_rule()),
        id: None,
        rules: None,
    };
    let mut ipc = bsk::ipc_client::IpcClient::connect(&sock).await.unwrap();
    let call = tokio::spawn(async move {
        ipc.call::<MockParams, MockResult>(
            "mock-1",
            Method::ToolMock,
            Some(params),
            Duration::from_secs(5),
        )
        .await
    });

    // The decisive assertion: the request reached the extension at all. A
    // `tool.mock` missing from the daemon's forwarding list would come back
    // as `unknown_method` and never appear here.
    let forwarded = tokio::time::timeout(Duration::from_secs(3), forwarded_rx.recv())
        .await
        .expect("tool.mock did not reach the extension")
        .expect("forwarding channel closed");
    assert_eq!(forwarded.method, Method::ToolMock);
    assert_eq!(forwarded.params["session_id"], json!(session_id));
    assert_eq!(forwarded.params["action"], json!("add"));

    let rule = &forwarded.params["rule"];
    assert_eq!(
        rule["url_pattern"],
        json!("https://api.example.com/api/user/*")
    );
    assert_eq!(rule["method"], json!("GET"));
    assert_eq!(rule["status"], json!(503));
    assert_eq!(rule["delay_ms"], json!(250));
    assert_eq!(rule["body"], json!("{\"error\":\"down\"}"));
    assert_eq!(rule["headers"][0]["name"], json!("content-type"));
    // `add` mints the id extension-side, so the caller must not be sending one.
    assert!(rule.get("id").is_none());

    fake.abort();
    drop(call);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn mock_result_travels_back_to_the_caller() {
    let (handle, sock) = spawn_daemon().await;
    let mut ws = connect_ext(handle.ws_addr()).await;
    let _ = handshake_as_ext(&mut ws).await;
    let (forwarded_tx, mut forwarded_rx) = mpsc::unbounded_channel();
    let (replies_tx, replies_rx) = mpsc::unbounded_channel();
    let fake = run_fake_extension(ws, forwarded_tx, replies_rx);

    let session_id = ipc_session_start(&sock).await;

    let params = MockParams {
        session_id: session_id.clone(),
        action: MockAction::List,
        rule: None,
        id: None,
        rules: None,
    };
    let mut ipc = bsk::ipc_client::IpcClient::connect(&sock).await.unwrap();
    let call = tokio::spawn(async move {
        ipc.call::<MockParams, MockResult>(
            "mock-2",
            Method::ToolMock,
            Some(params),
            Duration::from_secs(5),
        )
        .await
    });

    let forwarded = tokio::time::timeout(Duration::from_secs(3), forwarded_rx.recv())
        .await
        .expect("tool.mock list did not reach the extension")
        .expect("forwarding channel closed");
    assert_eq!(forwarded.method, Method::ToolMock);
    assert_eq!(forwarded.params["action"], json!("list"));

    // Reply the way the real extension would, using the daemon-generated
    // correlation id rather than the one the caller passed.
    let stored = MockRule {
        id: Some("m_1".into()),
        ..sample_rule()
    };
    replies_tx
        .send((
            forwarded.rpc_id.clone(),
            serde_json::to_value(MockResult {
                action: MockAction::List,
                rules: vec![stored.clone()],
                created_id: None,
                removed: None,
                note: Some("browser-profile".into()),
            })
            .unwrap(),
        ))
        .unwrap();

    let outcome = tokio::time::timeout(Duration::from_secs(3), call)
        .await
        .expect("call did not settle")
        .expect("call task ok")
        .expect("transport ok")
        .expect("daemon returned a result");

    assert_eq!(outcome.action, MockAction::List);
    assert_eq!(outcome.rules.len(), 1);
    assert_eq!(outcome.rules[0], stored);
    assert_eq!(outcome.note.as_deref(), Some("browser-profile"));

    fake.abort();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_method_outside_the_forwarding_list_is_still_refused() {
    // The other half of the routing rule: widening the forwarding list must
    // not turn the `unknown_method` arm into a catch-all.
    let (handle, sock) = spawn_daemon().await;
    let mut ws = connect_ext(handle.ws_addr()).await;
    let _ = handshake_as_ext(&mut ws).await;
    let (forwarded_tx, mut forwarded_rx) = mpsc::unbounded_channel();
    let (_replies_tx, replies_rx) = mpsc::unbounded_channel();
    let fake = run_fake_extension(ws, forwarded_tx, replies_rx);

    let _session_id = ipc_session_start(&sock).await;

    // `audit.request` is served by the extension-facing WS handler, not by the
    // CLI's IPC handler, so the CLI must not be able to forward it.
    let mut ipc = bsk::ipc_client::IpcClient::connect(&sock).await.unwrap();
    let outcome = ipc
        .call::<(), Value>(
            "bogus-1",
            Method::AuditRequest,
            Some(()),
            Duration::from_secs(3),
        )
        .await
        .expect("transport ok");

    match outcome {
        Ok(value) => panic!("expected a refusal, got {value:?}"),
        Err(error) => assert_eq!(error.code, ErrorCode::UnknownMethod),
    }
    assert!(
        forwarded_rx.try_recv().is_err(),
        "a non-forwarded method must not reach the extension"
    );

    fake.abort();
}
