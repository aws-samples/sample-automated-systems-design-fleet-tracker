/**
 * Analytics Panel Component
 * Task 22: Dashboard Analytics Integration
 * 
 * Displays job metrics, vehicle utilization, and route efficiency
 */

import { useState, useEffect, useCallback } from "react";
import {
  getJobMetrics,
  getUtilizationMetrics,
  getRouteMetrics,
  exportToCsv,
  JobMetrics,
  UtilizationMetrics,
  RouteMetrics,
} from "../services/api";

interface AnalyticsPanelProps {
  selectedVehicle?: string | null;
}

export function AnalyticsPanel({ selectedVehicle }: AnalyticsPanelProps) {
  const [jobMetrics, setJobMetrics] = useState<JobMetrics | null>(null);
  const [utilization, setUtilization] = useState<UtilizationMetrics | null>(null);
  const [routes, setRoutes] = useState<RouteMetrics | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);

  // Calculate date range (last 30 days)
  const getDateRange = useCallback(() => {
    const end = new Date();
    const start = new Date();
    start.setDate(start.getDate() - 30);
    return {
      startDate: start.toISOString().split("T")[0],
      endDate: end.toISOString().split("T")[0],
    };
  }, []);

  const fetchAnalytics = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const { startDate, endDate } = getDateRange();
      const vehicleId = selectedVehicle || undefined;

      const [jobs, util, routeData] = await Promise.all([
        getJobMetrics(startDate, endDate, vehicleId),
        getUtilizationMetrics(startDate, endDate, vehicleId),
        getRouteMetrics(startDate, endDate, vehicleId),
      ]);

      setJobMetrics(jobs);
      setUtilization(util);
      setRoutes(routeData);
    } catch (err) {
      setError("Failed to load analytics");
      console.error("Analytics error:", err);
    } finally {
      setLoading(false);
    }
  }, [getDateRange, selectedVehicle]);

  useEffect(() => {
    if (expanded) {
      fetchAnalytics();
    }
  }, [expanded, fetchAnalytics]);

  const handleExportJobs = () => {
    if (jobMetrics) {
      exportToCsv([jobMetrics], "job-metrics.csv");
    }
  };

  const handleExportUtilization = () => {
    if (utilization?.vehicles) {
      exportToCsv(utilization.vehicles, "utilization-metrics.csv");
    }
  };

  const handleExportRoutes = () => {
    if (routes?.routes) {
      exportToCsv(routes.routes, "route-efficiency.csv");
    }
  };

  return (
    <div className="analytics-panel">
      <button
        className="analytics-toggle"
        onClick={() => setExpanded(!expanded)}
        style={{
          width: "100%",
          padding: "8px 12px",
          background: expanded ? "#2196F3" : "#f5f5f5",
          color: expanded ? "white" : "#333",
          border: "none",
          borderRadius: 4,
          cursor: "pointer",
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          fontSize: 14,
          fontWeight: 500,
        }}
      >
        <span>📊 Analytics</span>
        <span>{expanded ? "▼" : "▶"}</span>
      </button>

      {expanded && (
        <div style={{ padding: "12px 0" }}>
          {loading && <div style={{ textAlign: "center", padding: 20 }}>Loading...</div>}
          {error && <div style={{ color: "red", padding: 8 }}>{error}</div>}

          {!loading && !error && (
            <>
              {/* Job Metrics Summary (Task 22.1) */}
              {jobMetrics && (
                <div className="metric-card" style={cardStyle}>
                  <div style={cardHeaderStyle}>
                    <span>Job Metrics (30 days)</span>
                    <button onClick={handleExportJobs} style={exportBtnStyle}>
                      Export CSV
                    </button>
                  </div>
                  <div style={metricsGridStyle}>
                    <div style={metricItemStyle}>
                      <div style={metricValueStyle}>{jobMetrics.totalJobs}</div>
                      <div style={metricLabelStyle}>Total Jobs</div>
                    </div>
                    <div style={metricItemStyle}>
                      <div style={metricValueStyle}>{jobMetrics.completedJobs}</div>
                      <div style={metricLabelStyle}>Completed</div>
                    </div>
                    <div style={metricItemStyle}>
                      <div style={metricValueStyle}>{jobMetrics.completionRate.toFixed(1)}%</div>
                      <div style={metricLabelStyle}>Completion Rate</div>
                    </div>
                    <div style={metricItemStyle}>
                      <div style={metricValueStyle}>{jobMetrics.avgDurationMinutes.toFixed(0)}m</div>
                      <div style={metricLabelStyle}>Avg Duration</div>
                    </div>
                  </div>
                </div>
              )}

              {/* Vehicle Utilization (Task 22.2) */}
              {utilization && utilization.vehicles.length > 0 && (
                <div className="metric-card" style={cardStyle}>
                  <div style={cardHeaderStyle}>
                    <span>Vehicle Utilization</span>
                    <button onClick={handleExportUtilization} style={exportBtnStyle}>
                      Export CSV
                    </button>
                  </div>
                  <div style={{ maxHeight: 150, overflowY: "auto" }}>
                    {utilization.vehicles.map((v) => (
                      <div key={v.vehicleId} style={utilizationRowStyle}>
                        <span style={{ fontWeight: 500 }}>{v.vehicleId}</span>
                        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                          <div
                            style={{
                              width: 60,
                              height: 8,
                              background: "#e0e0e0",
                              borderRadius: 4,
                              overflow: "hidden",
                            }}
                          >
                            <div
                              style={{
                                width: `${v.utilizationPercent}%`,
                                height: "100%",
                                background: v.utilizationPercent > 70 ? "#4CAF50" : "#FFC107",
                              }}
                            />
                          </div>
                          <span style={{ fontSize: 12, minWidth: 40 }}>
                            {v.utilizationPercent.toFixed(0)}%
                          </span>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Route Efficiency (Task 22.3) */}
              {routes && routes.routes.length > 0 && (
                <div className="metric-card" style={cardStyle}>
                  <div style={cardHeaderStyle}>
                    <span>Route Efficiency</span>
                    <button onClick={handleExportRoutes} style={exportBtnStyle}>
                      Export CSV
                    </button>
                  </div>
                  <div style={{ maxHeight: 150, overflowY: "auto" }}>
                    {routes.routes.slice(0, 5).map((r) => (
                      <div key={r.jobId} style={routeRowStyle}>
                        <div style={{ flex: 1 }}>
                          <div style={{ fontSize: 12, fontWeight: 500 }}>{r.jobId.slice(0, 8)}...</div>
                          <div style={{ fontSize: 11, color: "#666" }}>
                            {r.plannedDistanceKm.toFixed(1)}km → {r.actualDistanceKm.toFixed(1)}km
                          </div>
                        </div>
                        <div
                          style={{
                            padding: "2px 6px",
                            borderRadius: 4,
                            fontSize: 11,
                            fontWeight: 500,
                            background: r.flaggedForReview ? "#FFEBEE" : "#E8F5E9",
                            color: r.flaggedForReview ? "#C62828" : "#2E7D32",
                          }}
                        >
                          {(r.efficiencyRatio * 100).toFixed(0)}%
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              <button
                onClick={fetchAnalytics}
                style={{
                  width: "100%",
                  padding: "8px",
                  marginTop: 8,
                  background: "#f5f5f5",
                  border: "1px solid #ddd",
                  borderRadius: 4,
                  cursor: "pointer",
                  fontSize: 12,
                }}
              >
                Refresh Analytics
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}

// Styles
const cardStyle: React.CSSProperties = {
  background: "white",
  borderRadius: 8,
  padding: 12,
  marginBottom: 12,
  boxShadow: "0 1px 3px rgba(0,0,0,0.1)",
};

const cardHeaderStyle: React.CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "center",
  marginBottom: 12,
  fontSize: 13,
  fontWeight: 600,
  color: "#333",
};

const exportBtnStyle: React.CSSProperties = {
  padding: "2px 8px",
  fontSize: 10,
  background: "#f5f5f5",
  border: "1px solid #ddd",
  borderRadius: 4,
  cursor: "pointer",
};

const metricsGridStyle: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(2, 1fr)",
  gap: 12,
};

const metricItemStyle: React.CSSProperties = {
  textAlign: "center",
};

const metricValueStyle: React.CSSProperties = {
  fontSize: 20,
  fontWeight: 600,
  color: "#2196F3",
};

const metricLabelStyle: React.CSSProperties = {
  fontSize: 11,
  color: "#666",
  marginTop: 2,
};

const utilizationRowStyle: React.CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "center",
  padding: "6px 0",
  borderBottom: "1px solid #f0f0f0",
  fontSize: 12,
};

const routeRowStyle: React.CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "center",
  padding: "6px 0",
  borderBottom: "1px solid #f0f0f0",
};
