//! MAOS Industrial Engine — deterministic safety and evidence engine.
//!
//! This binary reads JSON commands on stdin and writes JSON responses on stdout.
//! Diagnostics go to stderr only. No network, no filesystem writes outside evidence chain.

#![forbid(unsafe_code)]

mod calculation;
mod evidence;
mod numeric;
mod parser;
mod protocol;
mod threshold;

use protocol::{ErrorResponse, Request, Response, PROTOCOL_VERSION};
use std::io::{self, BufRead, Write};

/// Maximum size of a single newline-delimited request.
///
/// MUST stay in sync with `MAX_ENGINE_REQUEST_BYTES` in
/// `src/industrial/rust-engine-bridge.ts`; the TypeScript side rejects larger
/// payloads before spawning this binary, so the two are a matched pair.
///
const MAX_REQUEST_BYTES: usize = 1_048_576;

/// Read one newline-delimited request without allocating beyond the protocol
/// limit. The remainder of an oversized line is discarded before returning so
/// the next request remains framed correctly.
fn read_bounded_line<R: BufRead>(reader: &mut R) -> io::Result<Option<String>> {
    let mut bytes = Vec::new();
    let mut oversized = false;

    loop {
        let chunk = reader.fill_buf()?;
        if chunk.is_empty() {
            if bytes.is_empty() && !oversized {
                return Ok(None);
            }
            break;
        }

        let newline = chunk.iter().position(|byte| *byte == b'\n');
        let consumed = newline.map(|index| index + 1).unwrap_or(chunk.len());
        let payload_len = newline.unwrap_or(chunk.len());

        if !oversized {
            if bytes.len().saturating_add(payload_len) > MAX_REQUEST_BYTES {
                oversized = true;
                bytes.clear();
            } else {
                bytes.extend_from_slice(&chunk[..payload_len]);
            }
        }
        reader.consume(consumed);

        if newline.is_some() {
            break;
        }
    }

    if oversized {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "Request exceeds 1 MiB size limit",
        ));
    }

    String::from_utf8(bytes)
        .map(Some)
        .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))
}

fn main() {
    let stdin = io::stdin();
    let stdout = io::stdout();
    let mut reader = io::BufReader::with_capacity(8192, stdin.lock());
    let mut stdout = stdout.lock();

    loop {
        let line = match read_bounded_line(&mut reader) {
            Ok(Some(line)) => line,
            Ok(None) => break,
            Err(error) if error.kind() == io::ErrorKind::InvalidInput => {
                let err = ErrorResponse::protocol(&error.to_string());
                let _ = serde_json::to_writer(&mut stdout, &err);
                let _ = writeln!(stdout);
                let _ = stdout.flush();
                continue;
            }
            Err(error) => {
                let err = ErrorResponse::internal(&format!("stdin read error: {error}"));
                let _ = serde_json::to_writer(&mut stdout, &err);
                let _ = writeln!(stdout);
                std::process::exit(3);
            }
        };

        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }

        let response = handle_request(trimmed);
        let _ = serde_json::to_writer(&mut stdout, &response);
        let _ = writeln!(stdout);
        let _ = stdout.flush();
    }
}

fn handle_request(input: &str) -> Response {
    let request: Request = match serde_json::from_str(input) {
        Ok(r) => r,
        Err(e) => {
            return Response::Error(ErrorResponse::protocol(&format!(
                "Malformed JSON request: {e}"
            )));
        }
    };

    // Version check
    if request.version != PROTOCOL_VERSION {
        return Response::Error(ErrorResponse::protocol(&format!(
            "Unsupported protocol version '{}'. Expected '{}'",
            request.version, PROTOCOL_VERSION
        )));
    }

    match request.operation.as_str() {
        "health" | "version" => {
            Response::Success(protocol::SuccessResponse {
                request_id: request.request_id,
                operation: request.operation,
                version: PROTOCOL_VERSION.to_string(),
                data: serde_json::json!({
                    "status": "ok",
                    "engine": "maos-industrial-engine",
                    "version": env!("CARGO_PKG_VERSION"),
                    "protocol_version": PROTOCOL_VERSION,
                    "rust_version": "1.95.0",
                    "unsafe_code": false,
                }),
            })
        }
        "parse-sensor" => {
            parser::handle_parse_sensor(&request)
        }
        "evaluate" => {
            threshold::handle_evaluate(&request)
        }
        "hash" => {
            evidence::handle_hash(&request)
        }
        "chain-append" => {
            evidence::handle_chain_append(&request)
        }
        "chain-verify" => {
            evidence::handle_chain_verify(&request)
        }
        "verify-calculation" => {
            calculation::handle_verify_calculation(&request)
        }
        _ => {
            Response::Error(ErrorResponse::protocol(&format!(
                "Unknown operation '{}'. Supported: health, version, parse-sensor, evaluate, hash, chain-append, chain-verify, verify-calculation",
                request.operation
            )))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    #[test]
    fn bounded_reader_accepts_a_request_at_the_limit() {
        let mut input = Cursor::new(vec![b'a'; MAX_REQUEST_BYTES]);
        let line = read_bounded_line(&mut input).expect("bounded read should succeed");
        assert_eq!(
            line.expect("request should be present").len(),
            MAX_REQUEST_BYTES
        );
    }

    #[test]
    fn bounded_reader_rejects_a_request_over_the_limit() {
        let mut input = Cursor::new(vec![b'a'; MAX_REQUEST_BYTES + 1]);
        let error = read_bounded_line(&mut input).expect_err("oversized request should fail");
        assert_eq!(error.kind(), io::ErrorKind::InvalidInput);
        assert!(error.to_string().contains("1 MiB"));
    }
}
