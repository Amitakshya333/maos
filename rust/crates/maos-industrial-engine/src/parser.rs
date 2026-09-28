//! R1-04: Deterministic sensor CSV parser.
//!
//! Bounded streaming parser that validates required columns, timestamps,
//! numeric fields, row limits, and malformed records. Malformed input cannot panic.

use crate::numeric::{parse_numeric, parse_unit};
use crate::protocol::{ErrorResponse, Request, Response, SuccessResponse, PROTOCOL_VERSION};
use serde::{Deserialize, Serialize};

/// Maximum rows to parse (prevent memory bombs).
const MAX_ROWS: usize = 10_000;

/// Maximum CSV input size in bytes (10 MB).
const MAX_CSV_BYTES: usize = 10_485_760;

/// A single parsed sensor record with provenance.
#[derive(Debug, Clone, Serialize)]
pub struct SensorRecord {
    pub row_number: usize,
    pub timestamp: String,
    pub metric: String,
    pub value: String,
    pub numeric_value: f64,
    pub unit: String,
    pub source: String,
}

/// Parse errors that don't cause panics.
#[derive(Debug, Clone, Serialize)]
pub struct ParseWarning {
    pub row_number: usize,
    pub column: Option<String>,
    pub message: String,
}

/// Parser configuration.
#[derive(Debug, Deserialize)]
pub struct ParseConfig {
    /// Required columns (case-insensitive matching).
    #[serde(default = "default_required_columns")]
    pub required_columns: Vec<String>,
    /// Maximum rows to parse.
    #[serde(default = "default_max_rows")]
    pub max_rows: usize,
}

fn default_required_columns() -> Vec<String> {
    vec!["timestamp".to_string()]
}

fn default_max_rows() -> usize {
    MAX_ROWS
}

impl Default for ParseConfig {
    fn default() -> Self {
        Self {
            required_columns: default_required_columns(),
            max_rows: default_max_rows(),
        }
    }
}

/// Parse CSV data from a string. Returns records, warnings, and column info.
pub fn parse_csv(csv_data: &str, config: &ParseConfig) -> Result<ParseResult, String> {
    // Size check
    if csv_data.len() > MAX_CSV_BYTES {
        return Err(format!(
            "CSV input exceeds {} byte limit ({} bytes)",
            MAX_CSV_BYTES,
            csv_data.len()
        ));
    }

    let mut reader = csv::ReaderBuilder::new()
        .flexible(true)
        .trim(csv::Trim::All)
        .from_reader(csv_data.as_bytes());

    // Get and validate headers
    let headers = reader
        .headers()
        .map_err(|e| format!("Failed to read CSV headers: {e}"))?
        .clone();

    let header_names: Vec<String> = headers.iter().map(|h| h.to_string()).collect();

    // Check required columns
    for required in &config.required_columns {
        let found = header_names
            .iter()
            .any(|h| h.eq_ignore_ascii_case(required));
        if !found {
            return Err(format!(
                "Required column '{}' not found. Available columns: {:?}",
                required, header_names
            ));
        }
    }

    let mut records = Vec::new();
    let mut warnings = Vec::new();
    let mut seen_rows = std::collections::HashSet::new();
    let effective_max = config.max_rows.min(MAX_ROWS);

    for (idx, result) in reader.records().enumerate() {
        let row_number = idx + 2; // 1-indexed, +1 for header

        if records.len() >= effective_max {
            warnings.push(ParseWarning {
                row_number,
                column: None,
                message: format!("Row limit ({effective_max}) reached, remaining rows skipped"),
            });
            break;
        }

        let record = match result {
            Ok(r) => r,
            Err(e) => {
                warnings.push(ParseWarning {
                    row_number,
                    column: None,
                    message: format!("Malformed row: {e}"),
                });
                continue;
            }
        };

        // Build a row fingerprint for duplicate detection
        let fingerprint: String = record.iter().collect::<Vec<_>>().join("|");
        if !seen_rows.insert(fingerprint.clone()) {
            warnings.push(ParseWarning {
                row_number,
                column: None,
                message: "Duplicate row detected, skipped".to_string(),
            });
            continue;
        }

        // Extract fields by column name
        let get_field = |name: &str| -> Option<String> {
            header_names
                .iter()
                .position(|h| h.eq_ignore_ascii_case(name))
                .and_then(|i| record.get(i))
                .map(|s| s.to_string())
        };

        let timestamp = get_field("timestamp").unwrap_or_default();
        if timestamp.is_empty() {
            warnings.push(ParseWarning {
                row_number,
                column: Some("timestamp".to_string()),
                message: "Empty timestamp".to_string(),
            });
        }

        // Try to find a value column — look for common names
        let value_str = get_field("value")
            .or_else(|| get_field("reading"))
            .or_else(|| get_field("measurement"))
            .unwrap_or_default();

        let numeric_value = match parse_numeric(&value_str) {
            Ok(v) => v,
            Err(e) => {
                warnings.push(ParseWarning {
                    row_number,
                    column: Some("value".to_string()),
                    message: format!("Invalid numeric value '{}': {}", value_str, e),
                });
                continue;
            }
        };

        let metric = get_field("metric")
            .or_else(|| get_field("parameter"))
            .or_else(|| get_field("sensor"))
            .unwrap_or_else(|| "unknown".to_string());

        let unit_str = get_field("unit").unwrap_or_else(|| "-".to_string());
        // The unit registry is closed. Unknown units cannot produce a valid
        // sensor record because downstream policy evaluation would be ambiguous.
        if parse_unit(&unit_str).is_none() {
            return Err(format!("Unknown unit '{}' at row {}", unit_str, row_number));
        }

        let source = get_field("source")
            .or_else(|| get_field("sensor_id"))
            .unwrap_or_else(|| "unknown".to_string());

        records.push(SensorRecord {
            row_number,
            timestamp,
            metric,
            value: value_str,
            numeric_value,
            unit: unit_str,
            source,
        });
    }

    Ok(ParseResult {
        columns: header_names,
        row_count: records.len(),
        records,
        warnings,
    })
}

/// Parse result containing records, warnings, and metadata.
#[derive(Debug, Serialize)]
pub struct ParseResult {
    pub columns: Vec<String>,
    pub row_count: usize,
    pub records: Vec<SensorRecord>,
    pub warnings: Vec<ParseWarning>,
}

/// Handle a parse-sensor request.
pub fn handle_parse_sensor(request: &Request) -> Response {
    let csv_data = match request.data.get("csv") {
        Some(serde_json::Value::String(s)) => s.clone(),
        _ => {
            return Response::Error(ErrorResponse::input(
                "parse-sensor requires 'data.csv' as a string field",
            ));
        }
    };

    let config: ParseConfig = match request.data.get("config") {
        Some(v) => serde_json::from_value(v.clone()).unwrap_or_default(),
        None => ParseConfig::default(),
    };

    match parse_csv(&csv_data, &config) {
        Ok(result) => Response::Success(SuccessResponse {
            request_id: request.request_id.clone(),
            operation: "parse-sensor".to_string(),
            version: PROTOCOL_VERSION.to_string(),
            data: serde_json::to_value(result).unwrap_or_default(),
        }),
        Err(e) => Response::Error(ErrorResponse::input(&e)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_valid_csv() {
        let csv = "timestamp,metric,value,unit\n2024-01-01T00:00:00Z,vibration,4.5,mm/s\n2024-01-01T00:01:00Z,temperature,75.2,°C\n";
        let result = parse_csv(csv, &ParseConfig::default()).unwrap();
        assert_eq!(result.row_count, 2);
        assert_eq!(result.records[0].metric, "vibration");
        assert_eq!(result.records[0].numeric_value, 4.5);
        assert_eq!(result.records[1].numeric_value, 75.2);
        assert!(result.warnings.is_empty());
    }

    #[test]
    fn test_missing_required_column() {
        let csv = "time,metric,value\n2024-01-01,vibration,4.5\n";
        let result = parse_csv(csv, &ParseConfig::default());
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("timestamp"));
    }

    #[test]
    fn test_malformed_row_no_panic() {
        let csv = "timestamp,metric,value,unit\n2024-01-01T00:00:00Z,vibration,not_a_number,mm/s\n2024-01-01T00:01:00Z,temperature,75.2,°C\n";
        let result = parse_csv(csv, &ParseConfig::default()).unwrap();
        assert_eq!(result.row_count, 1);
        assert_eq!(result.warnings.len(), 1);
        assert!(result.warnings[0].message.contains("Invalid numeric"));
    }

    #[test]
    fn test_duplicate_row_detection() {
        let csv = "timestamp,metric,value,unit\n2024-01-01,vibration,4.5,mm/s\n2024-01-01,vibration,4.5,mm/s\n";
        let result = parse_csv(csv, &ParseConfig::default()).unwrap();
        assert_eq!(result.row_count, 1);
        assert_eq!(result.warnings.len(), 1);
        assert!(result.warnings[0].message.contains("Duplicate"));
    }

    #[test]
    fn test_row_limit_enforcement() {
        let mut csv = String::from("timestamp,metric,value,unit\n");
        for i in 0..100 {
            csv.push_str(&format!(
                "2024-01-01T{:02}:00:00Z,vibration,{}.0,mm/s\n",
                i % 24,
                i
            ));
        }
        let config = ParseConfig {
            required_columns: vec!["timestamp".to_string()],
            max_rows: 10,
        };
        let result = parse_csv(&csv, &config).unwrap();
        assert_eq!(result.row_count, 10);
        assert!(!result.warnings.is_empty());
    }

    #[test]
    fn test_nan_infinity_rejected() {
        let csv = "timestamp,metric,value,unit\n2024-01-01,vibration,NaN,mm/s\n2024-01-01,vibration,Infinity,mm/s\n";
        let result = parse_csv(csv, &ParseConfig::default()).unwrap();
        assert_eq!(result.row_count, 0);
        assert_eq!(result.warnings.len(), 2);
    }

    #[test]
    fn test_empty_csv_no_panic() {
        let csv = "";
        let result = parse_csv(csv, &ParseConfig::default());
        assert!(result.is_err());
    }
}
