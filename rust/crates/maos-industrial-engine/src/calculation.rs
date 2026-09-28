//! Calculation trace verifier.
//!
//! Authoritatively verifies mathematical calculation traces:
//! - Re-computes RMS from source CSV data
//! - Verifies exact intermediate values: sum of squares, mean square, unrounded and rounded RMS
//! - Enforces unit registry validation (e.g. "mm/s")
//! - Enforces source CSV SHA-256 hash matching
//! - Evaluates warning and critical threshold anomalies
//! - Fails closed on any discrepancy, non-finite number, or overflow

use crate::numeric::{parse_numeric, parse_unit};
use crate::protocol::{ErrorResponse, Request, Response, SuccessResponse, PROTOCOL_VERSION};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

#[derive(Debug, Deserialize)]
pub struct VerifyCalculationRequest {
    pub csv: String,
    pub source_hash: String,
    #[serde(default = "default_measurement_field")]
    pub measurement_field: String,
    pub unit: String,
    pub expected_count: usize,
    pub expected_sum_squares: f64,
    pub expected_mean_square: f64,
    pub expected_rms: f64,
    pub expected_rounded_rms: f64,
    #[serde(default = "default_rounding_decimals")]
    pub rounding_decimals: usize,
    pub warning_threshold: f64,
    pub critical_threshold: f64,
    pub warning_rows: Vec<usize>,
    pub critical_rows: Vec<usize>,
}

fn default_measurement_field() -> String {
    "vibration_rms_mm_s".to_string()
}

fn default_rounding_decimals() -> usize {
    5
}

#[derive(Debug, Serialize)]
pub struct CalculationVerificationResult {
    pub verified: bool,
    pub formula: String,
    pub unit: String,
    pub sample_count: usize,
    pub sum_squares: f64,
    pub mean_square: f64,
    pub unrounded_rms: f64,
    pub rounded_rms: f64,
    pub warning_rows: Vec<usize>,
    pub critical_rows: Vec<usize>,
    pub source_hash: String,
}

pub fn handle_verify_calculation(request: &Request) -> Response {
    let params: VerifyCalculationRequest = match serde_json::from_value(request.data.clone()) {
        Ok(p) => p,
        Err(e) => {
            return Response::Error(ErrorResponse::input(&format!(
                "Invalid verify-calculation data: {e}"
            )))
        }
    };

    // 1. Verify Unit from closed registry
    if params.unit.trim().is_empty() {
        return Response::Error(ErrorResponse::input("Missing unit in calculation trace"));
    }
    let parsed_unit = match parse_unit(&params.unit) {
        Some(u) => u,
        None => {
            return Response::Error(ErrorResponse::input(&format!(
                "Unknown or unapproved unit '{}'",
                params.unit
            )))
        }
    };

    // 2. Verify source CSV hash
    if params.source_hash.trim().is_empty() {
        return Response::Error(ErrorResponse::input(
            "Missing source_hash in calculation trace",
        ));
    }
    let mut hasher = Sha256::new();
    hasher.update(params.csv.as_bytes());
    let actual_hash = hex::encode(hasher.finalize());
    if actual_hash.to_lowercase() != params.source_hash.trim().to_lowercase() {
        return Response::Error(ErrorResponse::policy(&format!(
            "Source CSV hash mismatch: expected '{}', got '{}'",
            params.source_hash, actual_hash
        )));
    }

    // 3. Parse CSV rows
    let mut rdr = csv::ReaderBuilder::new()
        .has_headers(true)
        .from_reader(params.csv.as_bytes());

    let headers = match rdr.headers() {
        Ok(h) => h.clone(),
        Err(e) => {
            return Response::Error(ErrorResponse::input(&format!(
                "Failed to read CSV headers: {e}"
            )))
        }
    };

    let field_index = match headers
        .iter()
        .position(|col| col.eq_ignore_ascii_case(&params.measurement_field))
    {
        Some(idx) => idx,
        None => {
            return Response::Error(ErrorResponse::input(&format!(
                "Measurement field '{}' not found in CSV headers",
                params.measurement_field
            )))
        }
    };

    let mut count: usize = 0;
    let mut sum_sq: f64 = 0.0;
    let mut actual_warning_rows: Vec<usize> = Vec::new();
    let mut actual_critical_rows: Vec<usize> = Vec::new();

    for (row_idx, record_res) in rdr.records().enumerate() {
        let row_num = row_idx + 1; // 1-based index matching findings
        let record = match record_res {
            Ok(r) => r,
            Err(e) => {
                return Response::Error(ErrorResponse::input(&format!(
                    "CSV parse error at row {row_num}: {e}"
                )))
            }
        };

        let val_str = match record.get(field_index) {
            Some(v) => v,
            None => {
                return Response::Error(ErrorResponse::input(&format!(
                    "Missing column value at row {row_num}"
                )))
            }
        };

        let val = match parse_numeric(val_str) {
            Ok(v) => v,
            Err(e) => {
                return Response::Error(ErrorResponse::input(&format!(
                    "Non-finite numeric value at row {row_num}: {e}"
                )))
            }
        };

        let val_sq = val * val;
        if !val_sq.is_finite() {
            return Response::Error(ErrorResponse::input(&format!(
                "Numeric overflow computing square at row {row_num}"
            )));
        }

        sum_sq += val_sq;
        if !sum_sq.is_finite() {
            return Response::Error(ErrorResponse::input(
                "Numeric overflow in sum of squares accumulation",
            ));
        }

        if val >= params.critical_threshold {
            actual_critical_rows.push(row_num);
        }
        if val >= params.warning_threshold {
            actual_warning_rows.push(row_num);
        }

        count += 1;
    }

    if count == 0 {
        return Response::Error(ErrorResponse::input("CSV contains zero data rows"));
    }

    // 4. Check sample count
    if count != params.expected_count {
        return Response::Error(ErrorResponse::policy(&format!(
            "Sample count mismatch: expected {}, calculated {}",
            params.expected_count, count
        )));
    }

    // 5. Check sum of squares
    let sum_sq_diff = (sum_sq - params.expected_sum_squares).abs();
    if sum_sq_diff > 1e-6 {
        return Response::Error(ErrorResponse::policy(&format!(
            "Sum of squares mismatch: expected {:.10}, calculated {:.10}",
            params.expected_sum_squares, sum_sq
        )));
    }

    // 6. Check mean square
    let mean_sq = sum_sq / (count as f64);
    let mean_sq_diff = (mean_sq - params.expected_mean_square).abs();
    if mean_sq_diff > 1e-9 {
        return Response::Error(ErrorResponse::policy(&format!(
            "Mean square mismatch: expected {:.10}, calculated {:.10}",
            params.expected_mean_square, mean_sq
        )));
    }

    // 7. Check unrounded RMS
    let unrounded_rms = mean_sq.sqrt();
    if !unrounded_rms.is_finite() {
        return Response::Error(ErrorResponse::input(
            "Numeric non-finite result for sqrt(mean_square)",
        ));
    }
    let rms_diff = (unrounded_rms - params.expected_rms).abs();
    if rms_diff > 1e-9 {
        return Response::Error(ErrorResponse::policy(&format!(
            "RMS result mismatch: expected {:.12}, calculated {:.12}",
            params.expected_rms, unrounded_rms
        )));
    }

    // 8. Rounding verification
    let multiplier = 10f64.powi(params.rounding_decimals as i32);
    let calculated_rounded = (unrounded_rms * multiplier).round() / multiplier;
    let rounded_diff = (calculated_rounded - params.expected_rounded_rms).abs();
    if rounded_diff > 1e-6 {
        return Response::Error(ErrorResponse::policy(&format!(
            "Rounded RMS mismatch: expected {:.6}, calculated {:.6}",
            params.expected_rounded_rms, calculated_rounded
        )));
    }

    // 9. Threshold rows verification
    if actual_warning_rows != params.warning_rows {
        return Response::Error(ErrorResponse::policy(&format!(
            "Warning rows mismatch: expected {:?}, found {:?}",
            params.warning_rows, actual_warning_rows
        )));
    }
    if actual_critical_rows != params.critical_rows {
        return Response::Error(ErrorResponse::policy(&format!(
            "Critical rows mismatch: expected {:?}, found {:?}",
            params.critical_rows, actual_critical_rows
        )));
    }

    Response::Success(SuccessResponse {
        request_id: request.request_id.clone(),
        operation: "verify-calculation".to_string(),
        version: PROTOCOL_VERSION.to_string(),
        data: serde_json::to_value(CalculationVerificationResult {
            verified: true,
            formula: "RMS = sqrt((x₁² + x₂² + ... + xₙ²) / n)".to_string(),
            unit: parsed_unit.to_string(),
            sample_count: count,
            sum_squares: sum_sq,
            mean_square: mean_sq,
            unrounded_rms,
            rounded_rms: calculated_rounded,
            warning_rows: actual_warning_rows,
            critical_rows: actual_critical_rows,
            source_hash: actual_hash,
        })
        .unwrap_or_default(),
    })
}
