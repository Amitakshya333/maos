//! R1-02: Versioned JSON protocol — bounded request/response/error contracts.
//!
//! All communication uses JSON on stdout. Diagnostics go to stderr only.
//! Each request must include a version, operation, and optional request_id.

use serde::{Deserialize, Serialize};

/// Protocol version — must match between TS bridge and Rust engine.
pub const PROTOCOL_VERSION: &str = "1.0";

/// Maximum allowed data payload size in bytes (for embedded data fields).
#[allow(dead_code)]
pub const MAX_DATA_BYTES: usize = 10_485_760; // 10 MB

/// Incoming request envelope.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Request {
    /// Protocol version (must match PROTOCOL_VERSION).
    pub version: String,
    /// Operation to perform (health, parse-sensor, evaluate, hash, chain-append, chain-verify).
    pub operation: String,
    /// Optional caller-assigned request ID for correlation.
    #[serde(default)]
    pub request_id: Option<String>,
    /// Operation-specific payload.
    #[serde(default)]
    pub data: serde_json::Value,
}

/// Response envelope — either success or error.
#[derive(Debug, Serialize)]
#[serde(untagged)]
pub enum Response {
    Success(SuccessResponse),
    Error(ErrorResponse),
}

/// Successful response.
#[derive(Debug, Serialize)]
pub struct SuccessResponse {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub request_id: Option<String>,
    pub operation: String,
    pub version: String,
    pub data: serde_json::Value,
}

/// Error response with category.
#[derive(Debug, Serialize)]
pub struct ErrorResponse {
    pub error: bool,
    pub category: ErrorCategory,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub request_id: Option<String>,
}

/// Error categories with distinct exit codes.
#[derive(Debug, Serialize, Clone, Copy)]
#[serde(rename_all = "snake_case")]
#[allow(dead_code)]
pub enum ErrorCategory {
    /// Protocol-level error (bad version, unknown operation, malformed request). Exit code: 1
    Protocol,
    /// Input validation error (bad CSV, invalid data). Exit code: 2
    Input,
    /// Policy violation (threshold failure that must fail-closed). Exit code: 4
    Policy,
    /// Internal engine error. Exit code: 3
    Internal,
}

impl ErrorCategory {
    /// Return the process exit code for this error category.
    #[allow(dead_code)]
    pub fn exit_code(self) -> i32 {
        match self {
            ErrorCategory::Protocol => 1,
            ErrorCategory::Input => 2,
            ErrorCategory::Internal => 3,
            ErrorCategory::Policy => 4,
        }
    }
}

impl ErrorResponse {
    pub fn protocol(message: &str) -> Self {
        Self {
            error: true,
            category: ErrorCategory::Protocol,
            message: message.to_string(),
            request_id: None,
        }
    }

    pub fn input(message: &str) -> Self {
        Self {
            error: true,
            category: ErrorCategory::Input,
            message: message.to_string(),
            request_id: None,
        }
    }

    #[allow(dead_code)]
    pub fn policy(message: &str) -> Self {
        Self {
            error: true,
            category: ErrorCategory::Policy,
            message: message.to_string(),
            request_id: None,
        }
    }

    pub fn internal(message: &str) -> Self {
        Self {
            error: true,
            category: ErrorCategory::Internal,
            message: message.to_string(),
            request_id: None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_protocol_version_is_stable() {
        assert_eq!(PROTOCOL_VERSION, "1.0");
    }

    #[test]
    fn test_error_exit_codes() {
        assert_eq!(ErrorCategory::Protocol.exit_code(), 1);
        assert_eq!(ErrorCategory::Input.exit_code(), 2);
        assert_eq!(ErrorCategory::Internal.exit_code(), 3);
        assert_eq!(ErrorCategory::Policy.exit_code(), 4);
    }

    #[test]
    fn test_request_deserialization() {
        let json = r#"{"version":"1.0","operation":"health"}"#;
        let req: Request = serde_json::from_str(json).unwrap();
        assert_eq!(req.version, "1.0");
        assert_eq!(req.operation, "health");
        assert!(req.request_id.is_none());
    }

    #[test]
    fn test_request_with_unknown_fields_rejected() {
        let json = r#"{"version":"1.0","operation":"health","extra":"field"}"#;
        assert!(serde_json::from_str::<Request>(json).is_err());
    }

    #[test]
    fn test_malformed_json_rejected() {
        let json = r#"{"version":"1.0","operation":}"#;
        assert!(serde_json::from_str::<Request>(json).is_err());
    }

    #[test]
    fn test_error_response_serialization() {
        let err = ErrorResponse::protocol("bad version");
        let json = serde_json::to_string(&err).unwrap();
        assert!(json.contains("\"error\":true"));
        assert!(json.contains("\"category\":\"protocol\""));
        assert!(json.contains("bad version"));
    }
}
