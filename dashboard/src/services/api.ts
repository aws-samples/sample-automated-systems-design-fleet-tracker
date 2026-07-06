import { fetchAuthSession } from "aws-amplify/auth";
import type { Vehicle, Job, HistoryPoint } from "../types";

// Remove trailing slash from API URL if present
const API_URL = (import.meta.env.VITE_API_URL || "").replace(/\/$/, "");

async function getAuthHeaders(): Promise<HeadersInit> {
  try {
    const session = await fetchAuthSession();
    const token = session.tokens?.idToken?.toString();
    if (!token) {
      console.warn("No auth token available - user may not be authenticated");
      throw new Error("Not authenticated");
    }
    return {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${token}`,
    };
  } catch (error) {
    console.error("Failed to get auth session:", error);
    throw error;
  }
}

async function apiRequest<T>(path: string, options: RequestInit = {}): Promise<T> {
  const headers = await getAuthHeaders();
  const response = await fetch(`${API_URL}${path}`, { ...options, headers });
  if (!response.ok) {
    throw new Error(`API error: ${response.status}`);
  }
  return response.json();
}

// Vehicle endpoints
export async function getVehicles(): Promise<Vehicle[]> {
  interface BackendVehicle {
    vehicleId: string;
    position?: { lat: number; lng: number };
    heading?: number;
    speed?: number;
    status?: string;
    lastSeen?: string;
    assignedJobId?: string;
    technicianName?: string;
  }
  const response = await apiRequest<{ vehicles: BackendVehicle[]; count: number }>("/vehicles");
  console.log("Raw API response:", JSON.stringify(response, null, 2));
  // Transform backend format to dashboard format
  const transformed = response.vehicles.map((v) => {
    const vehicle = {
      vehicleId: v.vehicleId,
      latitude: v.position?.lat ?? 0,
      longitude: v.position?.lng ?? 0,
      heading: v.heading ?? 0,
      speed: v.speed ?? 0,
      status: (v.status || "offline") as Vehicle["status"],
      lastUpdate: v.lastSeen || new Date().toISOString(),
      assignedJob: v.assignedJobId,
      technician: v.technicianName,
    };
    console.log(`Transformed ${v.vehicleId}: lat=${vehicle.latitude}, lng=${vehicle.longitude}`);
    return vehicle;
  });
  return transformed;
}

export async function getVehicle(vehicleId: string): Promise<Vehicle> {
  interface BackendVehicleDetail {
    vehicle: {
      vehicleId: string;
      position?: { lat: number; lng: number };
      heading?: number;
      speed?: number;
      status?: string;
      lastSeen?: string;
      assignedJobId?: string;
      technicianName?: string;
    };
    currentJob?: unknown;
  }
  const response = await apiRequest<BackendVehicleDetail>(`/vehicles/${vehicleId}`);
  const v = response.vehicle;
  return {
    vehicleId: v.vehicleId,
    latitude: v.position?.lat ?? 0,
    longitude: v.position?.lng ?? 0,
    heading: v.heading ?? 0,
    speed: v.speed ?? 0,
    status: (v.status || "offline") as Vehicle["status"],
    lastUpdate: v.lastSeen || new Date().toISOString(),
    assignedJob: v.assignedJobId,
    technician: v.technicianName,
  };
}

export async function getVehicleHistory(vehicleId: string): Promise<HistoryPoint[]> {
  interface BackendHistoryResponse {
    vehicleId: string;
    positions: Array<{
      position: { lat: number; lng: number };
      timestamp: string;
      speed: number;
    }>;
    startTime: string;
    endTime: string;
  }
  const response = await apiRequest<BackendHistoryResponse>(`/vehicles/${vehicleId}/history`);
  return response.positions.map((p) => ({
    latitude: p.position.lat,
    longitude: p.position.lng,
    timestamp: p.timestamp,
    speed: p.speed,
  }));
}

export async function getVehicleEta(vehicleId: string, address: string): Promise<{ eta: string }> {
  return apiRequest<{ eta: string }>(`/vehicles/${vehicleId}/eta?destination=${encodeURIComponent(address)}`);
}

// Job endpoints
export async function getJobs(): Promise<Job[]> {
  return apiRequest<Job[]>("/jobs");
}

export async function createJob(job: { address: string; vehicleId?: string }): Promise<Job> {
  return apiRequest<Job>("/jobs", {
    method: "POST",
    body: JSON.stringify(job),
  });
}

export async function updateJob(jobId: string, updates: Partial<Job>): Promise<Job> {
  return apiRequest<Job>(`/jobs/${jobId}`, {
    method: "PUT",
    body: JSON.stringify(updates),
  });
}

// Analytics endpoints (Task 22)
export interface JobMetrics {
  totalJobs: number;
  completedJobs: number;
  completionRate: number;
  avgDurationMinutes: number;
  startDate?: string;
  endDate?: string;
}

export interface VehicleUtilization {
  vehicleId: string;
  activeMinutes: number;
  idleMinutes: number;
  utilizationPercent: number;
}

export interface UtilizationMetrics {
  vehicles: VehicleUtilization[];
  startDate?: string;
  endDate?: string;
}

export interface RouteEfficiency {
  jobId: string;
  vehicleId: string;
  plannedDistanceKm: number;
  actualDistanceKm: number;
  efficiencyRatio: number;
  flaggedForReview: boolean;
}

export interface RouteMetrics {
  routes: RouteEfficiency[];
  startDate?: string;
  endDate?: string;
}

export async function getJobMetrics(
  startDate?: string,
  endDate?: string,
  vehicleId?: string
): Promise<JobMetrics> {
  const params = new URLSearchParams();
  if (startDate) params.append("startDate", startDate);
  if (endDate) params.append("endDate", endDate);
  if (vehicleId) params.append("vehicleId", vehicleId);
  const query = params.toString() ? `?${params.toString()}` : "";
  return apiRequest<JobMetrics>(`/analytics/jobs${query}`);
}

export async function getUtilizationMetrics(
  startDate?: string,
  endDate?: string,
  vehicleId?: string
): Promise<UtilizationMetrics> {
  const params = new URLSearchParams();
  if (startDate) params.append("startDate", startDate);
  if (endDate) params.append("endDate", endDate);
  if (vehicleId) params.append("vehicleId", vehicleId);
  const query = params.toString() ? `?${params.toString()}` : "";
  return apiRequest<UtilizationMetrics>(`/analytics/utilization${query}`);
}

export async function getRouteMetrics(
  startDate?: string,
  endDate?: string,
  vehicleId?: string
): Promise<RouteMetrics> {
  const params = new URLSearchParams();
  if (startDate) params.append("startDate", startDate);
  if (endDate) params.append("endDate", endDate);
  if (vehicleId) params.append("vehicleId", vehicleId);
  const query = params.toString() ? `?${params.toString()}` : "";
  return apiRequest<RouteMetrics>(`/analytics/routes${query}`);
}

// Export chart data as CSV (Task 22.5)
export function exportToCsv<T extends object>(data: T[], filename: string): void {
  if (data.length === 0) return;
  
  const headers = Object.keys(data[0]);
  const csvContent = [
    headers.join(","),
    ...data.map(row => headers.map(h => JSON.stringify((row as Record<string, unknown>)[h] ?? "")).join(","))
  ].join("\n");
  
  const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = filename;
  link.click();
}
