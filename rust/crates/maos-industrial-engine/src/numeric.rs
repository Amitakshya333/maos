//! R1-03: Numeric and unit contract.
//!
//! Uses string-based decimal representation internally. All threshold comparisons
//! use f64 after validation to reject NaN, Infinity, and overflow.
//! Units are a closed registry — unknown units are rejected.

use serde::{Deserialize, Serialize};
use std::fmt;

/// Supported measurement units — closed registry.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Unit {
    /// Millimeters per second (vibration velocity)
    #[serde(alias = "mm/s")]
    MmPerS,
    /// Degrees Celsius
    #[serde(alias = "°C", alias = "degC")]
    DegC,
    /// Degrees Fahrenheit
    #[serde(alias = "°F", alias = "degF")]
    DegF,
    /// Hertz
    #[serde(alias = "Hz")]
    Hz,
    /// Kilohertz
    #[serde(alias = "kHz")]
    KHz,
    /// Pascal
    #[serde(alias = "Pa")]
    Pa,
    /// KiloPascal
    #[serde(alias = "kPa")]
    KPa,
    /// Revolutions per minute
    #[serde(alias = "RPM", alias = "rpm")]
    Rpm,
    /// Dimensionless / ratio
    #[serde(alias = "ratio", alias = "-")]
    Dimensionless,
}

impl fmt::Display for Unit {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Unit::MmPerS => write!(f, "mm/s"),
            Unit::DegC => write!(f, "°C"),
            Unit::DegF => write!(f, "°F"),
            Unit::Hz => write!(f, "Hz"),
            Unit::KHz => write!(f, "kHz"),
            Unit::Pa => write!(f, "Pa"),
            Unit::KPa => write!(f, "kPa"),
            Unit::Rpm => write!(f, "RPM"),
            Unit::Dimensionless => write!(f, "-"),
        }
    }
}

/// Parse a unit string from the closed registry. Returns None for unknown units.
pub fn parse_unit(s: &str) -> Option<Unit> {
    match s.trim() {
        "mm/s" | "mm_per_s" => Some(Unit::MmPerS),
        "°C" | "degC" | "deg_c" => Some(Unit::DegC),
        "°F" | "degF" | "deg_f" => Some(Unit::DegF),
        "Hz" | "hz" => Some(Unit::Hz),
        "kHz" | "khz" | "k_hz" => Some(Unit::KHz),
        "Pa" | "pa" => Some(Unit::Pa),
        "kPa" | "kpa" | "k_pa" => Some(Unit::KPa),
        "RPM" | "rpm" => Some(Unit::Rpm),
        "-" | "ratio" | "dimensionless" => Some(Unit::Dimensionless),
        _ => None,
    }
}

/// A validated numeric measurement value.
#[derive(Debug, Clone)]
#[allow(dead_code)]
pub struct Measurement {
    /// Original string representation (preserved for evidence)
    pub raw: String,
    /// Parsed f64 value (guaranteed finite)
    pub value: f64,
    /// Unit of measurement
    pub unit: Unit,
}

/// Validate and parse a numeric string. Rejects NaN, Infinity, and overflow.
pub fn parse_numeric(s: &str) -> Result<f64, NumericError> {
    let trimmed = s.trim();
    if trimmed.is_empty() {
        return Err(NumericError::Empty);
    }

    // Reject obvious non-numeric strings
    let lower = trimmed.to_lowercase();
    if lower == "nan"
        || lower == "infinity"
        || lower == "-infinity"
        || lower == "inf"
        || lower == "-inf"
    {
        return Err(NumericError::NonFinite(trimmed.to_string()));
    }

    match trimmed.parse::<f64>() {
        Ok(v) if v.is_finite() => Ok(v),
        Ok(_) => Err(NumericError::NonFinite(trimmed.to_string())),
        Err(e) => Err(NumericError::ParseFailed(format!("{trimmed}: {e}"))),
    }
}

/// Numeric validation errors.
#[derive(Debug, Clone)]
#[allow(dead_code)]
pub enum NumericError {
    Empty,
    NonFinite(String),
    ParseFailed(String),
    UnknownUnit(String),
    UnitMismatch { expected: Unit, got: Unit },
}

impl fmt::Display for NumericError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            NumericError::Empty => write!(f, "empty numeric value"),
            NumericError::NonFinite(v) => write!(f, "non-finite value: {v}"),
            NumericError::ParseFailed(v) => write!(f, "parse failed: {v}"),
            NumericError::UnknownUnit(u) => write!(f, "unknown unit: {u}"),
            NumericError::UnitMismatch { expected, got } => {
                write!(f, "unit mismatch: expected {expected}, got {got}")
            }
        }
    }
}

/// Convert between compatible units. Returns None for incompatible conversions.
#[allow(dead_code)]
pub fn convert_units(value: f64, from: &Unit, to: &Unit) -> Option<f64> {
    if from == to {
        return Some(value);
    }
    match (from, to) {
        (Unit::DegC, Unit::DegF) => Some(value * 9.0 / 5.0 + 32.0),
        (Unit::DegF, Unit::DegC) => Some((value - 32.0) * 5.0 / 9.0),
        (Unit::Hz, Unit::KHz) => Some(value / 1000.0),
        (Unit::KHz, Unit::Hz) => Some(value * 1000.0),
        (Unit::Pa, Unit::KPa) => Some(value / 1000.0),
        (Unit::KPa, Unit::Pa) => Some(value * 1000.0),
        _ => None, // Incompatible units
    }
}

/// Boundary semantics documentation:
///
/// Threshold comparisons follow these exact rules:
/// - `value >= critical_max` → FAIL
/// - `value <= critical_min` → FAIL
/// - `value >= warning_max` → WARNING
/// - `value <= warning_min` → WARNING
/// - Otherwise → PASS
///
/// The boundary value itself is INCLUSIVE for the violation status:
/// - A value exactly equal to `critical_max` is a FAIL
/// - A value exactly equal to `warning_max` is a WARNING
/// - A value exactly equal to `warning_min` is a WARNING
///
/// This matches the TypeScript implementation's >= and <= semantics.
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_valid_numbers() {
        assert_eq!(parse_numeric("3.15").unwrap(), 3.15);
        assert_eq!(parse_numeric("-42").unwrap(), -42.0);
        assert_eq!(parse_numeric("0").unwrap(), 0.0);
        assert_eq!(parse_numeric("  7.5  ").unwrap(), 7.5);
    }

    #[test]
    fn test_reject_nan() {
        assert!(parse_numeric("NaN").is_err());
        assert!(parse_numeric("nan").is_err());
    }

    #[test]
    fn test_reject_infinity() {
        assert!(parse_numeric("Infinity").is_err());
        assert!(parse_numeric("-Infinity").is_err());
        assert!(parse_numeric("inf").is_err());
        assert!(parse_numeric("-inf").is_err());
    }

    #[test]
    fn test_reject_empty() {
        assert!(parse_numeric("").is_err());
        assert!(parse_numeric("   ").is_err());
    }

    #[test]
    fn test_reject_non_numeric() {
        assert!(parse_numeric("hello").is_err());
        assert!(parse_numeric("12.34.56").is_err());
    }

    #[test]
    fn test_parse_unit() {
        assert_eq!(parse_unit("mm/s"), Some(Unit::MmPerS));
        assert_eq!(parse_unit("°C"), Some(Unit::DegC));
        assert_eq!(parse_unit("RPM"), Some(Unit::Rpm));
        assert_eq!(parse_unit("unknown"), None);
    }

    #[test]
    fn test_unit_conversion() {
        // C to F: 100°C = 212°F
        let f = convert_units(100.0, &Unit::DegC, &Unit::DegF).unwrap();
        assert!((f - 212.0).abs() < 1e-10);

        // F to C: 32°F = 0°C
        let c = convert_units(32.0, &Unit::DegF, &Unit::DegC).unwrap();
        assert!((c - 0.0).abs() < 1e-10);

        // Incompatible: mm/s to °C
        assert!(convert_units(1.0, &Unit::MmPerS, &Unit::DegC).is_none());

        // Identity
        assert_eq!(convert_units(42.0, &Unit::Hz, &Unit::Hz), Some(42.0));
    }
}
