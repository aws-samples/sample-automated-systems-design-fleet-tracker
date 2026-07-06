import type { Vehicle } from "../types";

interface VehicleDetailProps {
  vehicle: Vehicle;
  eta?: string;
  onClose: () => void;
}

// Task 22.6: Check if vehicle data is stale (no update in 2 minutes)
function isStale(lastUpdate: string): boolean {
  const lastUpdateTime = new Date(lastUpdate).getTime();
  const now = Date.now();
  const twoMinutesMs = 2 * 60 * 1000;
  return now - lastUpdateTime > twoMinutesMs;
}

export function VehicleDetail({ vehicle, eta, onClose }: VehicleDetailProps) {
  const formatTime = (iso: string) => {
    return new Date(iso).toLocaleTimeString();
  };

  const stale = isStale(vehicle.lastUpdate);

  return (
    <div className="vehicle-detail">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <h3>{vehicle.vehicleId}</h3>
        <button onClick={onClose} style={{ background: "none", border: "none", cursor: "pointer", fontSize: "18px" }}>
          ×
        </button>
      </div>

      {/* Task 22.6: Stale indicator */}
      {stale && (
        <div style={{
          background: "#FFF3E0",
          color: "#E65100",
          padding: "6px 10px",
          borderRadius: 4,
          fontSize: 12,
          marginBottom: 12,
          display: "flex",
          alignItems: "center",
          gap: 6,
        }}>
          <span>⚠️</span>
          <span>Stale - No update in 2+ minutes</span>
        </div>
      )}

      <div className="detail-row">
        <span className="detail-label">Status</span>
        <span className={`status-badge status-${vehicle.status}`}>{vehicle.status}</span>
      </div>

      <div className="detail-row">
        <span className="detail-label">Position</span>
        <span>{vehicle.latitude.toFixed(5)}, {vehicle.longitude.toFixed(5)}</span>
      </div>

      <div className="detail-row">
        <span className="detail-label">Speed</span>
        <span>{vehicle.speed.toFixed(1)} mph</span>
      </div>

      <div className="detail-row">
        <span className="detail-label">Heading</span>
        <span>{vehicle.heading}°</span>
      </div>

      {/* Task 22.6: Last update timestamp */}
      <div className="detail-row">
        <span className="detail-label">Last Update</span>
        <span style={{ color: stale ? "#E65100" : "inherit" }}>
          {formatTime(vehicle.lastUpdate)}
          {stale && " (stale)"}
        </span>
      </div>

      {vehicle.technician && (
        <div className="detail-row">
          <span className="detail-label">Technician</span>
          <span>{vehicle.technician}</span>
        </div>
      )}

      {vehicle.assignedJob && (
        <div className="detail-row">
          <span className="detail-label">Assigned Job</span>
          <span>{vehicle.assignedJob}</span>
        </div>
      )}

      {eta && (
        <div className="detail-row">
          <span className="detail-label">ETA</span>
          <span style={{ fontWeight: 600, color: "#1976d2" }}>{eta}</span>
        </div>
      )}
    </div>
  );
}
