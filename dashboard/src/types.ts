// Vehicle state from API
export interface Vehicle {
  vehicleId: string;
  latitude: number;
  longitude: number;
  speed: number;
  heading: number;
  // Mirrors VehicleStatus in src/shared/types.ts. The backend only ever writes
  // "available", "en-route", and "returning"; "offline" is the dashboard's fallback
  // when a vehicle has no status yet. "on-site" and "idle" are declared by the
  // backend union but not currently written by any handler.
  status: "available" | "en-route" | "on-site" | "returning" | "offline" | "idle";
  lastUpdate: string;
  assignedJob?: string;
  technician?: string;
}

// Job assignment
export interface Job {
  jobId: string;
  vehicleId?: string;
  address: string;
  latitude?: number;
  longitude?: number;
  status: "pending" | "assigned" | "in_progress" | "completed";
  eta?: string;
  createdAt: string;
}

// GPS history point
export interface HistoryPoint {
  latitude: number;
  longitude: number;
  timestamp: string;
  speed: number;
}

// WebSocket message types - matches backend format
export interface WsVehicleUpdate {
  type: "VEHICLE_UPDATE";
  data: {
    vehicleId: string;
    position: { lat: number; lng: number };
    heading: number;
    speed: number;
    status: string;
    ignition: boolean;
    assignedJobId?: string;
  };
  timestamp: string;
}

export interface WsJobUpdate {
  type: "JOB_UPDATE" | "JOB_ASSIGNED" | "JOB_COMPLETED";
  data: Job;
  timestamp: string;
}

export type WsMessage = WsVehicleUpdate | WsJobUpdate;
