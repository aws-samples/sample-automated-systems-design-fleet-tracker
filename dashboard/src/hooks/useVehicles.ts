import { useState, useEffect, useCallback } from "react";
import type { Vehicle, WsMessage } from "../types";
import { getVehicles } from "../services/api";
import { useWebSocket } from "./useWebSocket";

export function useVehicles() {
  const [vehicles, setVehicles] = useState<Vehicle[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Handle WebSocket messages
  const handleMessage = useCallback((msg: WsMessage) => {
    if (msg.type === "VEHICLE_UPDATE" && msg.data?.vehicleId) {
      const update = msg.data;
      setVehicles((prev) => {
        const idx = prev.findIndex((v) => v.vehicleId === update.vehicleId);
        // Transform backend format to dashboard format
        const vehicle: Vehicle = {
          vehicleId: update.vehicleId,
          latitude: update.position?.lat ?? 0,
          longitude: update.position?.lng ?? 0,
          heading: update.heading ?? 0,
          speed: update.speed ?? 0,
          status: update.status as Vehicle["status"],
          lastUpdate: msg.timestamp,
          assignedJob: update.assignedJobId,
        };
        if (idx >= 0) {
          const updated = [...prev];
          updated[idx] = vehicle;
          return updated;
        }
        return [...prev, vehicle];
      });
    }
  }, []);

  const { connected } = useWebSocket(handleMessage);

  // Initial fetch
  useEffect(() => {
    async function fetchVehicles() {
      try {
        setLoading(true);
        const data = await getVehicles();
        console.log("Fetched vehicles:", data);
        setVehicles(data);
        setError(null);
      } catch (e) {
        console.error("Failed to fetch vehicles:", e);
        setError(e instanceof Error ? e.message : "Failed to fetch vehicles");
      } finally {
        setLoading(false);
      }
    }
    fetchVehicles();
  }, []);

  // Refresh function
  const refresh = useCallback(async () => {
    try {
      const data = await getVehicles();
      setVehicles(data);
    } catch (e) {
      console.error("Failed to refresh vehicles:", e);
    }
  }, []);

  return { vehicles, loading, error, connected, refresh };
}
