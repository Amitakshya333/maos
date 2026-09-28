//! R1-05: Threshold and policy engine.
//!
//! Deterministic rule evaluation with exact PASS/WARNING/FAIL boundary behavior.
//! Returns ruleId, observed value, unit, configured bounds, deviation, status, recommendation.
//! Fails closed for missing or unknown rules.

use crate::numeric::{parse_numeric, parse_unit};
use crate::protocol::{ErrorResponse, Request, Response, SuccessResponse, PROTOCOL_VERSION};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

/// Compliance status — deterministic three-level.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "UPPERCASE")]
pub enum ComplianceStatus {
    Pass,
    Warning,
    Fail,
}

/// A threshold rule definition.
#[derive(Debug, Clone, Deserialize)]
pub struct ThresholdRule {
    /// Warning level — can be a number (max) or an object with min/max.
    pub warning: Option<ThresholdBound>,
    /// Critical level — can be a number (max) or an object with min/max.
    pub critical: Option<ThresholdBound>,
    /// Unit of measurement.
    pub unit: Option<String>,
    /// Per-status recommendations.
    #[serde(default)]
    pub recommendations: HashMap<String, String>,
    /// Single recommendation fallback.
    pub recommendation: Option<String>,
}

/// A threshold bound — either a simple max number or min/max range.
#[derive(Debug, Clone, Deserialize)]
#[serde(untagged)]
pub enum ThresholdBound {
    Max(f64),
    Range { min: Option<f64>, max: Option<f64> },
}

impl ThresholdBound {
    pub fn max_value(&self) -> Option<f64> {
        match self {
            ThresholdBound::Max(v) => Some(*v),
            ThresholdBound::Range { max, .. } => *max,
        }
    }

    pub fn min_value(&self) -> Option<f64> {
        match self {
            ThresholdBound::Max(_) => None,
            ThresholdBound::Range { min, .. } => *min,
        }
    }
}

/// A single evaluation finding.
#[derive(Debug, Clone, Serialize)]
pub struct Finding {
    pub rule_id: String,
    pub metric: String,
    pub value: String,
    pub observed_numeric: f64,
    pub unit: Option<String>,
    pub status: ComplianceStatus,
    pub threshold: ThresholdInfo,
    pub deviation: Option<f64>,
    pub recommendation: String,
}

/// Threshold bounds for a finding.
#[derive(Debug, Clone, Serialize)]
pub struct ThresholdInfo {
    pub warning: Option<serde_json::Value>,
    pub critical: Option<serde_json::Value>,
}

/// Evaluation result.
#[derive(Debug, Clone, Serialize)]
pub struct EvaluationResult {
    pub ok: bool,
    pub ruleset_id: Option<String>,
    pub status: ComplianceStatus,
    pub findings: Vec<Finding>,
}

/// Evaluate a set of measurements against threshold rules.
///
/// Boundary semantics (matching TypeScript F1-06):
/// - `value >= critical_max` → FAIL
/// - `value <= critical_min` → FAIL
/// - `value >= warning_max` → WARNING
/// - `value <= warning_min` → WARNING
/// - Otherwise → PASS
pub fn evaluate(
    measurements: &HashMap<String, serde_json::Value>,
    rules: &HashMap<String, ThresholdRule>,
    ruleset_id: Option<&str>,
) -> EvaluationResult {
    let mut findings = Vec::new();

    for (metric, value) in measurements {
        let rule = match rules.get(metric) {
            Some(r) => r,
            None => {
                // Fail closed for missing rules
                findings.push(Finding {
                    rule_id: format_rule_id(ruleset_id, metric),
                    metric: metric.clone(),
                    value: value.to_string(),
                    observed_numeric: f64::NAN,
                    unit: None,
                    status: ComplianceStatus::Warning,
                    threshold: ThresholdInfo {
                        warning: None,
                        critical: None,
                    },
                    deviation: None,
                    recommendation: format!(
                        "No threshold rule configured for metric '{}'. Review and configure.",
                        metric
                    ),
                });
                continue;
            }
        };

        let value_str = match value {
            serde_json::Value::Number(n) => n.to_string(),
            serde_json::Value::String(s) => s.clone(),
            _ => value.to_string(),
        };

        let numeric = match parse_numeric(&value_str) {
            Ok(v) => v,
            Err(_) => {
                findings.push(Finding {
                    rule_id: format_rule_id(ruleset_id, metric),
                    metric: metric.clone(),
                    value: value_str,
                    observed_numeric: f64::NAN,
                    unit: rule.unit.clone(),
                    status: ComplianceStatus::Warning,
                    threshold: ThresholdInfo {
                        warning: None,
                        critical: None,
                    },
                    deviation: None,
                    recommendation: "Provide a valid numeric value.".to_string(),
                });
                continue;
            }
        };

        let critical_max = rule.critical.as_ref().and_then(|b| b.max_value());
        let critical_min = rule.critical.as_ref().and_then(|b| b.min_value());
        let warning_max = rule.warning.as_ref().and_then(|b| b.max_value());
        let warning_min = rule.warning.as_ref().and_then(|b| b.min_value());

        let mut status = ComplianceStatus::Pass;
        let mut limit: Option<f64> = None;

        if let Some(cmax) = critical_max {
            if numeric >= cmax {
                status = ComplianceStatus::Fail;
                limit = Some(cmax);
            }
        }
        if status == ComplianceStatus::Pass {
            if let Some(cmin) = critical_min {
                if numeric <= cmin {
                    status = ComplianceStatus::Fail;
                    limit = Some(cmin);
                }
            }
        }
        if status == ComplianceStatus::Pass {
            if let Some(wmax) = warning_max {
                if numeric >= wmax {
                    status = ComplianceStatus::Warning;
                    limit = Some(wmax);
                }
            }
        }
        if status == ComplianceStatus::Pass {
            if let Some(wmin) = warning_min {
                if numeric <= wmin {
                    status = ComplianceStatus::Warning;
                    limit = Some(wmin);
                }
            }
        }

        if status == ComplianceStatus::Pass && limit.is_none() {
            limit = critical_max
                .or(warning_max)
                .or(critical_min)
                .or(warning_min);
        }

        let deviation = limit.map(|l| numeric - l);

        let recommendation = match status {
            ComplianceStatus::Pass => "No action required.".to_string(),
            ComplianceStatus::Warning => rule
                .recommendations
                .get("WARNING")
                .cloned()
                .or_else(|| rule.recommendation.clone())
                .unwrap_or_else(|| "Inspect trend and schedule maintenance.".to_string()),
            ComplianceStatus::Fail => rule
                .recommendations
                .get("FAIL")
                .cloned()
                .or_else(|| rule.recommendation.clone())
                .unwrap_or_else(|| {
                    "Stop or isolate equipment and investigate immediately.".to_string()
                }),
        };

        // Serialize threshold bounds to JSON for output
        let threshold_warning = rule.warning.as_ref().map(|b| match b {
            ThresholdBound::Max(v) => serde_json::json!(v),
            ThresholdBound::Range { min, max } => serde_json::json!({"min": min, "max": max}),
        });
        let threshold_critical = rule.critical.as_ref().map(|b| match b {
            ThresholdBound::Max(v) => serde_json::json!(v),
            ThresholdBound::Range { min, max } => serde_json::json!({"min": min, "max": max}),
        });

        findings.push(Finding {
            rule_id: format_rule_id(ruleset_id, metric),
            metric: metric.clone(),
            value: value_str,
            observed_numeric: numeric,
            unit: rule.unit.clone(),
            status,
            threshold: ThresholdInfo {
                warning: threshold_warning,
                critical: threshold_critical,
            },
            deviation,
            recommendation,
        });
    }

    // Sort findings by metric name for deterministic output
    findings.sort_by(|a, b| a.metric.cmp(&b.metric));

    let overall_status = if findings.iter().any(|f| f.status == ComplianceStatus::Fail) {
        ComplianceStatus::Fail
    } else if findings
        .iter()
        .any(|f| f.status == ComplianceStatus::Warning)
    {
        ComplianceStatus::Warning
    } else {
        ComplianceStatus::Pass
    };

    EvaluationResult {
        ok: true,
        ruleset_id: ruleset_id.map(|s| s.to_string()),
        status: overall_status,
        findings,
    }
}

fn format_rule_id(ruleset_id: Option<&str>, metric: &str) -> String {
    match ruleset_id {
        Some(id) => format!("{id}/{metric}"),
        None => metric.to_string(),
    }
}

/// Handle an evaluate request.
pub fn handle_evaluate(request: &Request) -> Response {
    let measurements: HashMap<String, serde_json::Value> = match request.data.get("measurements") {
        Some(v) => match serde_json::from_value(v.clone()) {
            Ok(m) => m,
            Err(e) => {
                return Response::Error(ErrorResponse::input(&format!(
                    "Invalid measurements: {e}"
                )));
            }
        },
        None => {
            return Response::Error(ErrorResponse::input(
                "evaluate requires 'data.measurements' object",
            ));
        }
    };

    let rules: HashMap<String, ThresholdRule> = match request.data.get("thresholds") {
        Some(v) => match serde_json::from_value(v.clone()) {
            Ok(r) => r,
            Err(e) => {
                return Response::Error(ErrorResponse::input(&format!("Invalid thresholds: {e}")));
            }
        },
        None => {
            return Response::Error(ErrorResponse::input(
                "evaluate requires 'data.thresholds' object",
            ));
        }
    };

    for (metric, rule) in &rules {
        if let Some(unit) = &rule.unit {
            if parse_unit(unit).is_none() {
                return Response::Error(ErrorResponse::input(&format!(
                    "Unknown unit '{}' for threshold rule '{}'",
                    unit, metric
                )));
            }
        }
    }

    let ruleset_id = request
        .data
        .get("ruleset_id")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());

    let result = evaluate(&measurements, &rules, ruleset_id.as_deref());

    Response::Success(SuccessResponse {
        request_id: request.request_id.clone(),
        operation: "evaluate".to_string(),
        version: PROTOCOL_VERSION.to_string(),
        data: serde_json::to_value(result).unwrap_or_default(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_rule(warning: f64, critical: f64, unit: &str) -> ThresholdRule {
        ThresholdRule {
            warning: Some(ThresholdBound::Max(warning)),
            critical: Some(ThresholdBound::Max(critical)),
            unit: Some(unit.to_string()),
            recommendations: HashMap::new(),
            recommendation: None,
        }
    }

    #[test]
    fn test_pass_below_warning() {
        let mut measurements = HashMap::new();
        measurements.insert("vibration".to_string(), serde_json::json!(3.0));
        let mut rules = HashMap::new();
        rules.insert("vibration".to_string(), make_rule(4.5, 7.1, "mm/s"));
        let result = evaluate(&measurements, &rules, None);
        assert_eq!(result.status, ComplianceStatus::Pass);
        assert_eq!(result.findings[0].status, ComplianceStatus::Pass);
    }

    #[test]
    fn test_warning_at_boundary() {
        let mut measurements = HashMap::new();
        measurements.insert("vibration".to_string(), serde_json::json!(4.5));
        let mut rules = HashMap::new();
        rules.insert("vibration".to_string(), make_rule(4.5, 7.1, "mm/s"));
        let result = evaluate(&measurements, &rules, None);
        assert_eq!(result.findings[0].status, ComplianceStatus::Warning);
    }

    #[test]
    fn test_fail_at_critical_boundary() {
        let mut measurements = HashMap::new();
        measurements.insert("vibration".to_string(), serde_json::json!(7.1));
        let mut rules = HashMap::new();
        rules.insert("vibration".to_string(), make_rule(4.5, 7.1, "mm/s"));
        let result = evaluate(&measurements, &rules, None);
        assert_eq!(result.findings[0].status, ComplianceStatus::Fail);
    }

    #[test]
    fn test_fail_above_critical() {
        let mut measurements = HashMap::new();
        measurements.insert("vibration".to_string(), serde_json::json!(10.0));
        let mut rules = HashMap::new();
        rules.insert("vibration".to_string(), make_rule(4.5, 7.1, "mm/s"));
        let result = evaluate(&measurements, &rules, None);
        assert_eq!(result.status, ComplianceStatus::Fail);
        assert!(result.findings[0].deviation.unwrap() > 0.0);
    }

    #[test]
    fn test_missing_rule_fails_closed() {
        let mut measurements = HashMap::new();
        measurements.insert("unknown_metric".to_string(), serde_json::json!(5.0));
        let rules = HashMap::new();
        let result = evaluate(&measurements, &rules, None);
        assert_eq!(result.findings[0].status, ComplianceStatus::Warning);
        assert!(result.findings[0]
            .recommendation
            .contains("No threshold rule"));
    }

    #[test]
    fn test_rule_id_with_ruleset() {
        let mut measurements = HashMap::new();
        measurements.insert("vibration".to_string(), serde_json::json!(3.0));
        let mut rules = HashMap::new();
        rules.insert("vibration".to_string(), make_rule(4.5, 7.1, "mm/s"));
        let result = evaluate(&measurements, &rules, Some("TURBINE-T07"));
        assert_eq!(result.findings[0].rule_id, "TURBINE-T07/vibration");
    }

    #[test]
    fn test_deviation_calculation() {
        let mut measurements = HashMap::new();
        measurements.insert("vibration".to_string(), serde_json::json!(8.0));
        let mut rules = HashMap::new();
        rules.insert("vibration".to_string(), make_rule(4.5, 7.1, "mm/s"));
        let result = evaluate(&measurements, &rules, None);
        let deviation = result.findings[0].deviation.unwrap();
        // 8.0 - 7.1 = 0.9
        assert!((deviation - 0.9).abs() < 1e-10);
    }

    #[test]
    fn test_per_status_recommendations() {
        let mut measurements = HashMap::new();
        measurements.insert("temp".to_string(), serde_json::json!(200.0));
        let mut rules = HashMap::new();
        let mut recs = HashMap::new();
        recs.insert(
            "FAIL".to_string(),
            "Emergency shutdown required.".to_string(),
        );
        recs.insert("WARNING".to_string(), "Monitor closely.".to_string());
        rules.insert(
            "temp".to_string(),
            ThresholdRule {
                warning: Some(ThresholdBound::Max(80.0)),
                critical: Some(ThresholdBound::Max(100.0)),
                unit: Some("°C".to_string()),
                recommendations: recs,
                recommendation: None,
            },
        );
        let result = evaluate(&measurements, &rules, None);
        assert_eq!(
            result.findings[0].recommendation,
            "Emergency shutdown required."
        );
    }

    #[test]
    fn test_overall_status_aggregation() {
        let mut measurements = HashMap::new();
        measurements.insert("metric_a".to_string(), serde_json::json!(3.0));
        measurements.insert("metric_b".to_string(), serde_json::json!(10.0));
        let mut rules = HashMap::new();
        rules.insert("metric_a".to_string(), make_rule(4.5, 7.1, "mm/s"));
        rules.insert("metric_b".to_string(), make_rule(4.5, 7.1, "mm/s"));
        let result = evaluate(&measurements, &rules, None);
        // One PASS + one FAIL → overall FAIL
        assert_eq!(result.status, ComplianceStatus::Fail);
    }
}
