// Vehicle state from API
export interface Vehicle {
  vehicleId: string;
  latitude: number;
  longitude: number;
  speed: number;
  heading: number;
  status: "moving" | "stopped" | "offline" | "available" | "en-route" | "on-site" | "returning" | "idle";
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
