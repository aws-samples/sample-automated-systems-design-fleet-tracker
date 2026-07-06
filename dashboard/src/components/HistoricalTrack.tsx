import { useState, useEffect } from "react";
import { getVehicleHistory } from "../services/api";
import type { HistoryPoint } from "../types";

interface HistoricalTrackProps {
  vehicleId: string;
  onTrackLoaded: (track: [number, number][]) => void;
}

export function HistoricalTrack({ vehicleId, onTrackLoaded }: HistoricalTrackProps) {
  const [loading, setLoading] = useState(false);
  const [history, setHistory] = useState<HistoryPoint[]>([]);
  const [showTrack, setShowTrack] = useState(false);

  useEffect(() => {
    async function fetchHistory() {
      setLoading(true);
      try {
        const data = await getVehicleHistory(vehicleId);
        setHistory(data);
      } catch (e) {
        console.error("Failed to fetch history:", e);
      } finally {
        setLoading(false);
      }
    }
    fetchHistory();
  }, [vehicleId]);

  useEffect(() => {
    if (showTrack && history.length > 0) {
      const track: [number, number][] = history.map((p) => [p.longitude, p.latitude]);
      onTrackLoaded(track);
    } else {
      onTrackLoaded([]);
    }
  }, [showTrack, history, onTrackLoaded]);

  return (
    <div style={{ padding: "8px 16px", borderTop: "1px solid #e0e0e0" }}>
      <label style={{ display: "flex", alignItems: "center", cursor: "pointer", fontSize: 13 }}>
        <input
          type="checkbox"
          checked={showTrack}
          onChange={(e) => setShowTrack(e.target.checked)}
          disabled={loading || history.length === 0}
          style={{ marginRight: 8 }}
        />
        Show 24h track ({loading ? "loading..." : `${history.length} points`})
      </label>
    </div>
  );
}
