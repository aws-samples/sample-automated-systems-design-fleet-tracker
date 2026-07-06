import { useState, useCallback } from "react";
import { Authenticator } from "@aws-amplify/ui-react";
import "@aws-amplify/ui-react/styles.css";
import { useVehicles } from "./hooks/useVehicles";
import { FleetMap } from "./components/FleetMap";
import { VehicleList } from "./components/VehicleList";
import { VehicleDetail } from "./components/VehicleDetail";
import { HistoricalTrack } from "./components/HistoricalTrack";
import { DispatchPanel } from "./components/DispatchPanel";
import { AnalyticsPanel } from "./components/AnalyticsPanel";

function Dashboard() {
  const { vehicles, loading, connected, refresh } = useVehicles();
  const [selectedVehicle, setSelectedVehicle] = useState<string | null>(null);
  const [historyTrack, setHistoryTrack] = useState<[number, number][]>([]);

  const handleSelectVehicle = useCallback((vehicleId: string) => {
    setSelectedVehicle((prev) => (prev === vehicleId ? null : vehicleId));
    setHistoryTrack([]);
  }, []);

  const handleTrackLoaded = useCallback((track: [number, number][]) => {
    setHistoryTrack(track);
  }, []);

  const selectedVehicleData = vehicles.find((v) => v.vehicleId === selectedVehicle);

  return (
    <div className="app-container">
      <div className="sidebar">
        <div className="sidebar-header">
          <h1>Fleet Tracking</h1>
          <div style={{ fontSize: 12, marginTop: 4, opacity: 0.9 }}>
            {vehicles.length} vehicles • {loading ? "Loading..." : "Live"}
          </div>
        </div>

        <div className="sidebar-content">
          <VehicleList
            vehicles={vehicles}
            selectedVehicle={selectedVehicle}
            onSelectVehicle={handleSelectVehicle}
          />

          {selectedVehicle && (
            <HistoricalTrack vehicleId={selectedVehicle} onTrackLoaded={handleTrackLoaded} />
          )}

          <AnalyticsPanel selectedVehicle={selectedVehicle} />
        </div>

        <DispatchPanel vehicles={vehicles} onJobCreated={refresh} />
      </div>

      <div className="map-container">
        <FleetMap
          vehicles={vehicles}
          selectedVehicle={selectedVehicle}
          onSelectVehicle={handleSelectVehicle}
          historyTrack={historyTrack}
        />

        <div className={`connection-status ${connected ? "connected" : "disconnected"}`}>
          {connected ? "● Live" : "○ Reconnecting..."}
        </div>

        {selectedVehicleData && (
          <VehicleDetail
            vehicle={selectedVehicleData}
            onClose={() => setSelectedVehicle(null)}
          />
        )}
      </div>
    </div>
  );
}

export default function App() {
  return (
    <Authenticator>
      {({ signOut }) => (
        <>
          <Dashboard />
          <button
            onClick={signOut}
            style={{
              position: "fixed",
              top: 10,
              right: 120,
              padding: "4px 12px",
              background: "rgba(255,255,255,0.9)",
              border: "1px solid #ddd",
              borderRadius: 4,
              cursor: "pointer",
              fontSize: 12,
              zIndex: 1001,
            }}
          >
            Sign Out
          </button>
        </>
      )}
    </Authenticator>
  );
}
