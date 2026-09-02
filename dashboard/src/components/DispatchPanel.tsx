import { useState } from "react";
import type { Vehicle } from "../types";
import { createJob, getVehicleEta } from "../services/api";

interface DispatchPanelProps {
  vehicles: Vehicle[];
  onJobCreated: () => void;
}

export function DispatchPanel({ vehicles, onJobCreated }: DispatchPanelProps) {
  const [address, setAddress] = useState("");
  const [selectedVehicle, setSelectedVehicle] = useState("");
  const [eta, setEta] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // POST /jobs rejects any vehicle whose status is not exactly "available"
  // (see vehicle-api createJob), so only offer those in the dropdown.
  const availableVehicles = vehicles.filter((v) => v.status === "available");

  const handleVehicleChange = async (vehicleId: string) => {
    setSelectedVehicle(vehicleId);
    setEta(null);

    if (vehicleId && address) {
      try {
        const result = await getVehicleEta(vehicleId, address);
        setEta(result.eta);
      } catch (e) {
        console.error("Failed to get ETA:", e);
      }
    }
  };

  const handleAddressChange = async (newAddress: string) => {
    setAddress(newAddress);
    setEta(null);

    if (selectedVehicle && newAddress.length > 5) {
      try {
        const result = await getVehicleEta(selectedVehicle, newAddress);
        setEta(result.eta);
      } catch (e) {
        // Ignore ETA errors during typing
      }
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!address || !selectedVehicle) return;

    setLoading(true);
    setError(null);

    try {
      await createJob({ address, vehicleId: selectedVehicle });
      setAddress("");
      setSelectedVehicle("");
      setEta(null);
      onJobCreated();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to create job");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="dispatch-panel">
      <h3>Create Job</h3>
      <form onSubmit={handleSubmit}>
        <div className="form-group">
          <label htmlFor="address">Destination Address</label>
          <input
            id="address"
            type="text"
            value={address}
            onChange={(e) => handleAddressChange(e.target.value)}
            placeholder="123 Main St, City, State"
            required
          />
        </div>

        <div className="form-group">
          <label htmlFor="vehicle">Assign Vehicle</label>
          <select
            id="vehicle"
            value={selectedVehicle}
            onChange={(e) => handleVehicleChange(e.target.value)}
            required
          >
            <option value="">Select vehicle...</option>
            {availableVehicles.map((v) => (
              <option key={v.vehicleId} value={v.vehicleId}>
                {v.vehicleId} - {v.technician || "Unassigned"}
              </option>
            ))}
          </select>
        </div>

        {eta && (
          <div style={{ marginBottom: 12, padding: 8, background: "#e3f2fd", borderRadius: 4, fontSize: 13 }}>
            Estimated arrival: <strong>{eta}</strong>
          </div>
        )}

        {error && (
          <div style={{ marginBottom: 12, padding: 8, background: "#ffebee", borderRadius: 4, fontSize: 13, color: "#c62828" }}>
            {error}
          </div>
        )}

        <button type="submit" className="btn btn-primary" disabled={loading || !address || !selectedVehicle}>
          {loading ? "Creating..." : "Dispatch"}
        </button>
      </form>
    </div>
  );
}
