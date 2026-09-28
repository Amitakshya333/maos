//! R1-06: Evidence chain — canonical serialization, SHA-256 hashing,
//! and hash-linked tamper-evident records.
//!
//! Detects modification, deletion, reordering, truncation, and incorrect previous hashes.
//! Does NOT claim to be "tamper-proof" — it is tamper-EVIDENT.

use crate::protocol::{ErrorResponse, Request, Response, SuccessResponse, PROTOCOL_VERSION};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

/// A single evidence record in the chain.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EvidenceRecord {
    /// Sequence number (0-indexed).
    pub sequence: u64,
    /// SHA-256 hash of the previous record (hex). Empty string for first record.
    pub previous_hash: String,
    /// Timestamp of creation.
    pub timestamp: String,
    /// Source identifier (e.g., agent ID, operation name).
    pub source: String,
    /// Evidence category.
    pub category: String,
    /// Canonical data payload (deterministic JSON).
    pub data: serde_json::Value,
    /// SHA-256 hash of this record's canonical form (hex).
    pub hash: String,
}

/// Compute the canonical representation of a record for hashing.
/// Rules:
/// 1. Sort all object keys alphabetically at every level.
/// 2. Use compact JSON (no whitespace).
/// 3. Hash the UTF-8 bytes of the canonical JSON string.
fn canonical_json(value: &serde_json::Value) -> String {
    match value {
        serde_json::Value::Object(map) => {
            let mut sorted: Vec<_> = map.iter().collect();
            sorted.sort_by_key(|(a, _)| *a);
            let entries: Vec<String> = sorted
                .iter()
                .map(|(k, v)| {
                    format!(
                        "{}:{}",
                        serde_json::to_string(k).unwrap(),
                        canonical_json(v)
                    )
                })
                .collect();
            format!("{{{}}}", entries.join(","))
        }
        serde_json::Value::Array(arr) => {
            let entries: Vec<String> = arr.iter().map(canonical_json).collect();
            format!("[{}]", entries.join(","))
        }
        _ => serde_json::to_string(value).unwrap_or_default(),
    }
}

/// Compute SHA-256 hash of a canonical record representation.
pub fn hash_canonical(
    sequence: u64,
    previous_hash: &str,
    timestamp: &str,
    source: &str,
    category: &str,
    data: &serde_json::Value,
) -> String {
    let canonical_data = canonical_json(data);
    let to_hash =
        format!("{sequence}|{previous_hash}|{timestamp}|{source}|{category}|{canonical_data}");
    let mut hasher = Sha256::new();
    hasher.update(to_hash.as_bytes());
    hex::encode(hasher.finalize())
}

/// Hash arbitrary data (standalone operation).
pub fn hash_data(data: &serde_json::Value) -> String {
    let canonical = canonical_json(data);
    let mut hasher = Sha256::new();
    hasher.update(canonical.as_bytes());
    hex::encode(hasher.finalize())
}

/// Verify an evidence chain for integrity.
/// Checks:
/// 1. Sequence numbers are consecutive starting from 0.
/// 2. Previous hash links match.
/// 3. Each record's hash matches its canonical recomputation.
/// 4. No gaps (deletion detection).
/// 5. Correct ordering (reordering detection).
pub fn verify_chain(chain: &[EvidenceRecord]) -> ChainVerification {
    verify_chain_window(chain, 0, "")
}

/// Verify a bounded chain window using the absolute sequence and hash anchor
/// from the preceding window. This lets callers verify arbitrarily long chains
/// without sending an unbounded request to the engine.
pub fn verify_chain_window(
    chain: &[EvidenceRecord],
    start_sequence: u64,
    preceding_hash: &str,
) -> ChainVerification {
    let mut errors = Vec::new();

    if chain.is_empty() {
        return ChainVerification {
            valid: true,
            record_count: 0,
            errors,
        };
    }

    // Validate the first record against the supplied cross-window anchor.
    if chain[0].sequence != start_sequence {
        if start_sequence == 0 {
            errors.push(format!(
                "First record has sequence {} (expected 0) — possible truncation",
                chain[0].sequence
            ));
        } else {
            errors.push(format!(
                "First record in verification window has sequence {} (expected {})",
                chain[0].sequence, start_sequence
            ));
        }
    }

    if chain[0].previous_hash != preceding_hash {
        if start_sequence == 0 {
            errors.push(format!(
                "First record has non-empty previous_hash '{}' (expected empty)",
                chain[0].previous_hash
            ));
        } else {
            errors.push(format!(
                "Record {} previous_hash does not match the preceding verification-window anchor",
                start_sequence
            ));
        }
    }

    for (i, record) in chain.iter().enumerate() {
        let expected_sequence = start_sequence.saturating_add(i as u64);
        // Check sequence
        if record.sequence != expected_sequence {
            errors.push(format!(
                "Record {} has sequence {} (expected {}) — possible reordering or deletion",
                expected_sequence, record.sequence, expected_sequence
            ));
        }

        // Verify hash
        let expected_hash = hash_canonical(
            record.sequence,
            &record.previous_hash,
            &record.timestamp,
            &record.source,
            &record.category,
            &record.data,
        );

        if record.hash != expected_hash {
            errors.push(format!(
                "Record {} hash mismatch: stored={}, computed={} — possible modification",
                expected_sequence, record.hash, expected_hash
            ));
        }

        // Check previous hash link (for records after the first)
        if i > 0 && record.previous_hash != chain[i - 1].hash {
            errors.push(format!(
                "Record {} previous_hash does not match record {} hash — possible reordering or insertion",
                expected_sequence, expected_sequence.saturating_sub(1)
            ));
        }
    }

    ChainVerification {
        valid: errors.is_empty(),
        record_count: chain.len(),
        errors,
    }
}

/// Chain verification result.
#[derive(Debug, Serialize)]
pub struct ChainVerification {
    pub valid: bool,
    pub record_count: usize,
    pub errors: Vec<String>,
}

/// Create a new evidence record.
pub fn create_record(
    sequence: u64,
    previous_hash: &str,
    timestamp: &str,
    source: &str,
    category: &str,
    data: serde_json::Value,
) -> EvidenceRecord {
    let hash = hash_canonical(sequence, previous_hash, timestamp, source, category, &data);
    EvidenceRecord {
        sequence,
        previous_hash: previous_hash.to_string(),
        timestamp: timestamp.to_string(),
        source: source.to_string(),
        category: category.to_string(),
        data,
        hash,
    }
}

/// Handle a hash request.
pub fn handle_hash(request: &Request) -> Response {
    let data = &request.data;
    let hash = hash_data(data);
    let canonical = canonical_json(data);

    Response::Success(SuccessResponse {
        request_id: request.request_id.clone(),
        operation: "hash".to_string(),
        version: PROTOCOL_VERSION.to_string(),
        data: serde_json::json!({
            "hash": hash,
            "algorithm": "sha256",
            "canonical_bytes": canonical.len(),
        }),
    })
}

/// Handle a chain-append request.
pub fn handle_chain_append(request: &Request) -> Response {
    let sequence = request
        .data
        .get("sequence")
        .and_then(|v| v.as_u64())
        .unwrap_or(0);
    let previous_hash = request
        .data
        .get("previous_hash")
        .and_then(|v| v.as_str())
        .unwrap_or("");
    let timestamp = request
        .data
        .get("timestamp")
        .and_then(|v| v.as_str())
        .unwrap_or("");
    let source = request
        .data
        .get("source")
        .and_then(|v| v.as_str())
        .unwrap_or("unknown");
    let category = request
        .data
        .get("category")
        .and_then(|v| v.as_str())
        .unwrap_or("general");
    let data = request
        .data
        .get("data")
        .cloned()
        .unwrap_or(serde_json::Value::Null);

    if timestamp.is_empty() {
        return Response::Error(ErrorResponse::input(
            "chain-append requires 'data.timestamp'",
        ));
    }

    let record = create_record(sequence, previous_hash, timestamp, source, category, data);

    Response::Success(SuccessResponse {
        request_id: request.request_id.clone(),
        operation: "chain-append".to_string(),
        version: PROTOCOL_VERSION.to_string(),
        data: serde_json::to_value(record).unwrap_or_default(),
    })
}

/// Handle a chain-verify request.
pub fn handle_chain_verify(request: &Request) -> Response {
    let chain: Vec<EvidenceRecord> = match request.data.get("chain") {
        Some(v) => match serde_json::from_value(v.clone()) {
            Ok(c) => c,
            Err(e) => {
                return Response::Error(ErrorResponse::input(&format!(
                    "Invalid evidence chain: {e}"
                )));
            }
        },
        None => {
            return Response::Error(ErrorResponse::input(
                "chain-verify requires 'data.chain' array",
            ));
        }
    };

    let start_sequence = match request.data.get("start_sequence") {
        Some(value) => match value.as_u64() {
            Some(sequence) => sequence,
            None => {
                return Response::Error(ErrorResponse::input(
                    "chain-verify 'start_sequence' must be a non-negative integer",
                ));
            }
        },
        None => 0,
    };
    let preceding_hash = match request.data.get("previous_hash") {
        Some(value) => match value.as_str() {
            Some(hash) => hash,
            None => {
                return Response::Error(ErrorResponse::input(
                    "chain-verify 'previous_hash' must be a string",
                ));
            }
        },
        None => "",
    };

    let result = if start_sequence == 0 && preceding_hash.is_empty() {
        verify_chain(&chain)
    } else {
        verify_chain_window(&chain, start_sequence, preceding_hash)
    };

    Response::Success(SuccessResponse {
        request_id: request.request_id.clone(),
        operation: "chain-verify".to_string(),
        version: PROTOCOL_VERSION.to_string(),
        data: serde_json::to_value(result).unwrap_or_default(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_canonical_json_sorts_keys() {
        let value = serde_json::json!({"b": 2, "a": 1, "c": {"z": 1, "y": 2}});
        let canonical = canonical_json(&value);
        assert_eq!(canonical, r#"{"a":1,"b":2,"c":{"y":2,"z":1}}"#);
    }

    #[test]
    fn test_canonical_json_arrays_preserved() {
        let value = serde_json::json!([3, 1, 2]);
        assert_eq!(canonical_json(&value), "[3,1,2]");
    }

    #[test]
    fn test_hash_is_deterministic() {
        let data = serde_json::json!({"key": "value"});
        let h1 = hash_data(&data);
        let h2 = hash_data(&data);
        assert_eq!(h1, h2);
    }

    #[test]
    fn test_hash_changes_with_data() {
        let d1 = serde_json::json!({"key": "value1"});
        let d2 = serde_json::json!({"key": "value2"});
        assert_ne!(hash_data(&d1), hash_data(&d2));
    }

    #[test]
    fn test_chain_valid() {
        let r0 = create_record(
            0,
            "",
            "2024-01-01T00:00:00Z",
            "test",
            "general",
            serde_json::json!({"step": 1}),
        );
        let r1 = create_record(
            1,
            &r0.hash,
            "2024-01-01T00:01:00Z",
            "test",
            "general",
            serde_json::json!({"step": 2}),
        );
        let r2 = create_record(
            2,
            &r1.hash,
            "2024-01-01T00:02:00Z",
            "test",
            "general",
            serde_json::json!({"step": 3}),
        );

        let result = verify_chain(&[r0, r1, r2]);
        assert!(result.valid);
        assert_eq!(result.record_count, 3);
        assert!(result.errors.is_empty());
    }

    #[test]
    fn test_chain_window_validates_absolute_sequence_and_anchor() {
        let r0 = create_record(
            0,
            "",
            "2024-01-01T00:00:00Z",
            "test",
            "general",
            serde_json::json!({"step": 1}),
        );
        let r1 = create_record(
            1,
            &r0.hash,
            "2024-01-01T00:01:00Z",
            "test",
            "general",
            serde_json::json!({"step": 2}),
        );
        let r2 = create_record(
            2,
            &r1.hash,
            "2024-01-01T00:02:00Z",
            "test",
            "general",
            serde_json::json!({"step": 3}),
        );

        let result = verify_chain_window(&[r1.clone(), r2], 1, &r0.hash);
        assert!(result.valid);
        assert_eq!(result.record_count, 2);
        assert!(result.errors.is_empty());

        let bad_anchor = verify_chain_window(&[r1], 1, &"0".repeat(64));
        assert!(!bad_anchor.valid);
        assert!(bad_anchor
            .errors
            .iter()
            .any(|error| error.contains("window anchor")));
    }

    #[test]
    fn test_chain_detects_modification() {
        let r0 = create_record(
            0,
            "",
            "2024-01-01T00:00:00Z",
            "test",
            "general",
            serde_json::json!({"step": 1}),
        );
        let mut r1 = create_record(
            1,
            &r0.hash,
            "2024-01-01T00:01:00Z",
            "test",
            "general",
            serde_json::json!({"step": 2}),
        );
        r1.data = serde_json::json!({"step": 999}); // tampered!

        let result = verify_chain(&[r0, r1]);
        assert!(!result.valid);
        assert!(result.errors.iter().any(|e| e.contains("hash mismatch")));
    }

    #[test]
    fn test_chain_detects_reordering() {
        let r0 = create_record(
            0,
            "",
            "2024-01-01T00:00:00Z",
            "test",
            "general",
            serde_json::json!({"step": 1}),
        );
        let r1 = create_record(
            1,
            &r0.hash,
            "2024-01-01T00:01:00Z",
            "test",
            "general",
            serde_json::json!({"step": 2}),
        );

        // Swap order
        let result = verify_chain(&[r1, r0]);
        assert!(!result.valid);
    }

    #[test]
    fn test_chain_detects_deletion() {
        let r0 = create_record(
            0,
            "",
            "2024-01-01T00:00:00Z",
            "test",
            "general",
            serde_json::json!({"step": 1}),
        );
        let r1 = create_record(
            1,
            &r0.hash,
            "2024-01-01T00:01:00Z",
            "test",
            "general",
            serde_json::json!({"step": 2}),
        );
        let r2 = create_record(
            2,
            &r1.hash,
            "2024-01-01T00:02:00Z",
            "test",
            "general",
            serde_json::json!({"step": 3}),
        );

        // Skip r1
        let result = verify_chain(&[r0, r2]);
        assert!(!result.valid);
        assert!(result.errors.iter().any(|e| e.contains("sequence")));
    }

    #[test]
    fn test_chain_detects_truncation() {
        let r1 = create_record(
            1,
            "abc123",
            "2024-01-01T00:01:00Z",
            "test",
            "general",
            serde_json::json!({}),
        );
        // Chain starts at sequence 1, not 0
        let result = verify_chain(&[r1]);
        assert!(!result.valid);
        assert!(result.errors.iter().any(|e| e.contains("truncation")));
    }

    #[test]
    fn test_empty_chain_valid() {
        let result = verify_chain(&[]);
        assert!(result.valid);
    }

    #[test]
    fn test_canonical_key_order_independence() {
        let v1 = serde_json::json!({"a": 1, "b": 2});
        let v2 = serde_json::json!({"b": 2, "a": 1});
        assert_eq!(hash_data(&v1), hash_data(&v2));
    }
}
