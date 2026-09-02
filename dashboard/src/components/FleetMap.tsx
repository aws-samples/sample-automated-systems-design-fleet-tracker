import { useRef, useEffect, useState, useCallback } from "react";
// maplibre-gl v6 is ESM-only and no longer provides a default export.
import * as maplibregl from "maplibre-gl";
// v6 ships its worker as a separate ES module that imports a shared chunk, resolved
// internally via `import.meta.url`. Bundlers can't follow that, so without an explicit
// worker URL the worker 404s: vector tiles are never parsed and the map renders only the
// style's background layer (a flat blue for Esri Navigation) with no markers, because
// `load` never fires. Vite's `?worker&url` emits the worker as an asset and inlines the
// shared chunk. Must be called once before any Map is constructed.
import maplibreWorkerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url";
import { fetchAuthSession } from "aws-amplify/auth";
import { Signer } from "@aws-amplify/core/internals/utils";
import type { Vehicle } from "../types";

maplibregl.setWorkerUrl(maplibreWorkerUrl);

interface FleetMapProps {
  vehicles: Vehicle[];
  selectedVehicle: string | null;
  onSelectVehicle: (vehicleId: string) => void;
  historyTrack?: [number, number][];
}

// Extract vehicle number from ID (e.g., "vehicle-001" -> "001")
function getVehicleNumber(vehicleId: string): string {
  const match = vehicleId.match(/(\d+)$/);
  return match ? match[1] : vehicleId;
}

export function FleetMap({ vehicles, selectedVehicle, onSelectVehicle, historyTrack }: FleetMapProps) {
  const mapContainer = useRef<HTMLDivElement>(null);
  const map = useRef<maplibregl.Map | null>(null);
  const markers = useRef<Map<string, maplibregl.Marker>>(new Map());
  const [mapError, setMapError] = useState<string | null>(null);
  const [mapReady, setMapReady] = useState(false);

  // Create marker element with truck icon and label
  const createMarkerElement = useCallback((vehicle: Vehicle, onClick: () => void) => {
    const container = document.createElement("div");
    container.className = "vehicle-marker-container";
    container.style.cssText = `
      display: flex;
      flex-direction: column;
      align-items: center;
      cursor: pointer;
    `;

    // Truck icon
    const icon = document.createElement("img");
    icon.src = "/truck_icon.png";
    icon.alt = vehicle.vehicleId;
    icon.style.cssText = `
      width: 32px;
      height: 32px;
      filter: drop-shadow(0 2px 3px rgba(0,0,0,0.3));
    `;

    // Label with vehicle number
    const label = document.createElement("div");
    label.textContent = getVehicleNumber(vehicle.vehicleId);
    label.style.cssText = `
      background: rgba(0, 0, 0, 0.75);
      color: white;
      padding: 2px 6px;
      border-radius: 3px;
      font-size: 11px;
      font-weight: bold;
      margin-top: 2px;
      white-space: nowrap;
    `;

    container.appendChild(icon);
    container.appendChild(label);
    container.onclick = onClick;

    return container;
  }, []);

  // Initialize map with Amazon Location Service
  useEffect(() => {
    if (!mapContainer.current || map.current) return;

    let cancelled = false;

    const initMap = async () => {
      try {
        const region = import.meta.env.VITE_AWS_REGION || "us-east-1";
        const mapName = "fleet-map";

        const session = await fetchAuthSession();
        const credentials = session.credentials;

        if (!credentials) {
          setMapError("Unable to get AWS credentials. Please sign in.");
          return;
        }

        if (cancelled) return;

        const transformRequest = (url: string, _resourceType?: string) => {
          if (url.includes("amazonaws.com")) {
            const signedUrl = Signer.signUrl(url, {
              access_key: credentials.accessKeyId,
              secret_key: credentials.secretAccessKey,
              session_token: credentials.sessionToken,
            });
            return { url: signedUrl };
          }
          return { url };
        };

        map.current = new maplibregl.Map({
          container: mapContainer.current!,
          style: `https://maps.geo.${region}.amazonaws.com/maps/v0/maps/${mapName}/style-descriptor`,
          center: [-122.4194, 37.7749],
          zoom: 10,
          transformRequest,
        });

        map.current.addControl(new maplibregl.NavigationControl(), "top-right");
        
        map.current.on("load", () => {
          if (!cancelled) setMapReady(true);
        });

        map.current.on("error", (e: maplibregl.ErrorEvent) => {
          console.error("Map error:", e.error ?? e);
        });
      } catch (error) {
        console.error("Failed to initialize map:", error);
        if (!cancelled) {
          setMapError("Failed to initialize map. Please refresh the page.");
        }
      }
    };

    initMap();

    return () => {
      cancelled = true;
      map.current?.remove();
      map.current = null;
      setMapReady(false);
    };
  }, []);

  // Update vehicle markers
  useEffect(() => {
    if (!map.current || !mapReady) return;

    const currentIds = new Set(vehicles.map((v) => v.vehicleId));

    // Remove markers for vehicles no longer in list
    markers.current.forEach((marker, id) => {
      if (!currentIds.has(id)) {
        marker.remove();
        markers.current.delete(id);
      }
    });

    // Add or update markers
    vehicles.forEach((vehicle) => {
      // Skip vehicles without valid coordinates
      if (vehicle.longitude === undefined || vehicle.longitude === null || 
          vehicle.latitude === undefined || vehicle.latitude === null ||
          isNaN(vehicle.longitude) || isNaN(vehicle.latitude)) {
        const existing = markers.current.get(vehicle.vehicleId);
        if (existing) {
          existing.remove();
          markers.current.delete(vehicle.vehicleId);
        }
        return;
      }

      const existing = markers.current.get(vehicle.vehicleId);

      if (existing) {
        // Update existing marker position
        existing.setLngLat([vehicle.longitude, vehicle.latitude]);
      } else {
        // Create new marker with truck icon
        const el = createMarkerElement(vehicle, () => onSelectVehicle(vehicle.vehicleId));

        const marker = new maplibregl.Marker({ 
          element: el,
          anchor: "bottom" // Anchor at bottom so icon points to location
        })
          .setLngLat([vehicle.longitude, vehicle.latitude])
          .addTo(map.current!);

        markers.current.set(vehicle.vehicleId, marker);
      }
    });

    // Center on selected vehicle
    if (selectedVehicle) {
      const vehicle = vehicles.find((v) => v.vehicleId === selectedVehicle);
      if (vehicle && vehicle.longitude && vehicle.latitude) {
        map.current.flyTo({
          center: [vehicle.longitude, vehicle.latitude],
          zoom: 14,
        });
      }
    }
  }, [vehicles, selectedVehicle, onSelectVehicle, mapReady, createMarkerElement]);

  // Draw history track
  useEffect(() => {
    if (!map.current || !mapReady || !historyTrack) return;

    const sourceId = "history-track";
    const layerId = "history-track-line";

    if (map.current.getLayer(layerId)) {
      map.current.removeLayer(layerId);
    }
    if (map.current.getSource(sourceId)) {
      map.current.removeSource(sourceId);
    }

    if (historyTrack.length > 1) {
      map.current.addSource(sourceId, {
        type: "geojson",
        data: {
          type: "Feature",
          properties: {},
          geometry: {
            type: "LineString",
            coordinates: historyTrack,
          },
        },
      });

      map.current.addLayer({
        id: layerId,
        type: "line",
        source: sourceId,
        paint: {
          "line-color": "#1976d2",
          "line-width": 3,
          "line-opacity": 0.7,
        },
      });
    }
  }, [historyTrack, mapReady]);

  if (mapError) {
    return (
      <div style={{ 
        width: "100%", 
        height: "100%", 
        display: "flex", 
        alignItems: "center", 
        justifyContent: "center",
        backgroundColor: "#f5f5f5",
        color: "#666"
      }}>
        <div style={{ textAlign: "center" }}>
          <p>{mapError}</p>
          <button 
            onClick={() => window.location.reload()}
            style={{ marginTop: 10, padding: "8px 16px", cursor: "pointer" }}
          >
            Refresh Page
          </button>
        </div>
      </div>
    );
  }

  return <div ref={mapContainer} style={{ width: "100%", height: "100%" }} />;
}
