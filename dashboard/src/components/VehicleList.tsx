import type { Vehicle } from "../types";

interface VehicleListProps {
  vehicles: Vehicle[];
  selectedVehicle: string | null;
  onSelectVehicle: (vehicleId: string) => void;
}

export function VehicleList({ vehicles, selectedVehicle, onSelectVehicle }: VehicleListProps) {
  const formatTime = (iso: string) => {
    return new Date(iso).toLocaleTimeString();
  };

  return (
    <ul className="vehicle-list">
      {vehicles.map((vehicle) => (
        <li
          key={vehicle.vehicleId}
          className={`vehicle-item ${selectedVehicle === vehicle.vehicleId ? "selected" : ""}`}
          onClick={() => onSelectVehicle(vehicle.vehicleId)}
        >
          <div className="vehicle-id">{vehicle.vehicleId}</div>
          <div className="vehicle-status">
            <span className={`status-badge status-${vehicle.status}`}>{vehicle.status}</span>
            <span style={{ marginLeft: 8, color: "#666", fontSize: 11 }}>
              {vehicle.speed.toFixed(0)} mph • {formatTime(vehicle.lastUpdate)}
            </span>
          </div>
          {vehicle.technician && (
            <div style={{ fontSize: 12, color: "#666", marginTop: 4 }}>
              {vehicle.technician}
            </div>
          )}
        </li>
      ))}
      {vehicles.length === 0 && (
        <li style={{ padding: 16, color: "#666", textAlign: "center" }}>
          No vehicles found
        </li>
      )}
    </ul>
  );
}
