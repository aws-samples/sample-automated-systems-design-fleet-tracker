/**
 * Shared TypeScript types for Fleet Tracking Platform
 * Used across Lambda functions and dashboard
 * 
 * Requirements: 2.2, 5.3, 6.1
 */

// =============================================================================
// GPS Message Types (from IoT devices)
// Requirements: 2.2 - GPS payload includes vehicleId, latitude, longitude, heading, speed, timestamp, ignition status
// =============================================================================

/**
 * GPS message published by IoT devices via MQTT
 *
 * Devices publish to two Basic Ingest reserved topics, which deliver straight to a
 * named rule and bypass the pub/sub message broker (so neither can be subscribed to):
 *   $aws/rules/fleet_gps_to_kinesis/fleet/vehicles/{vehicleId}/gps   -> every position
 *   $aws/rules/fleet_gps_to_location/fleet/vehicles/{vehicleId}/gps  -> tracker path
 *
 * The tracker path is separate so it can be filtered independently of the DynamoDB
 * pipeline; a rule's WHERE clause applies to the whole rule, not per action.
 */
export interface GpsMessage {
  /** Unique vehicle identifier (e.g., "vehicle-001") */
  vehicleId: string;
  /** Latitude in decimal degrees */
  lat: number;
  /** Longitude in decimal degrees */
  lng: number;
  /** Heading in degrees (0-360, 0 = North) */
  heading: number;
  /** Speed in mph */
  speed: number;
  /** Engine ignition state */
  ignition: boolean;
  /** ISO 8601 timestamp */
  timestamp: string;
  /**
   * Sample time as Unix epoch milliseconds.
   *
   * Present so the Location rule action can reference `${timestampMs}` without date
   * parsing. Optional here because this Lambda reads `timestamp` instead.
   */
  timestampMs?: number;
  /** GPS accuracy in meters (used for Location Service position filtering) */
  accuracy: number;
}

/**
 * Position coordinates
 */
export interface Position {
  lat: number;
  lng: number;
}

// =============================================================================
// Vehicle State Types
// Requirements: 2.6, 5.6 - Vehicle status: available, en-route, offline
// =============================================================================

/**
 * Vehicle status values
 */
export type VehicleStatus = 'available' | 'en-route' | 'on-site' | 'returning' | 'offline' | 'idle';

/**
 * Current state of a vehicle (stored in vehicle-current-state DynamoDB table)
 * Requirements: 6.1 - vehicleId (PK), position, heading, speed, lastSeen, status, assignedJob
 * Task 13.1: Added tenantId for multi-tenant data isolation (Requirement 12.1)
 */
export interface VehicleState {
  /** Primary key - unique vehicle identifier */
  vehicleId: string;
  /** Current GPS position */
  position: Position;
  /** Current heading in degrees (0-360) */
  heading: number;
  /** Current speed in mph */
  speed: number;
  /** Engine ignition state */
  ignition: boolean;
  /** Current vehicle status */
  status: VehicleStatus;
  /** Currently assigned job ID (if any) */
  assignedJobId?: string;
  /** Assigned technician ID */
  technicianId?: string;
  /** Assigned technician display name */
  technicianName?: string;
  /** ISO 8601 timestamp of last GPS update */
  lastSeen: string;
  /** Tenant ID for multi-tenant data isolation (Task 13.1) */
  tenantId?: string;
}

/**
 * Vehicle metadata from IoT Device Shadow
 * Requirements: 1.5 - Device Shadow stores vehicle metadata
 */
export interface VehicleMetadata {
  vehicleId: string;
  make: string;
  model: string;
  technicianId: string;
  technicianName: string;
}

// =============================================================================
// Job/Dispatch Assignment Types
// Requirements: 5.9, 5.10, 5.11, 6.2
// =============================================================================

/**
 * Job/dispatch status values
 */
export type JobStatus = 'pending' | 'assigned' | 'en-route' | 'on-site' | 'completed' | 'cancelled';

/**
 * Dispatch assignment record (stored in dispatch-assignments DynamoDB table)
 * Requirements: 6.2 - jobId PK, vehicleId SK, stores job-to-vehicle mappings with geofenceId
 * Task 13.2: Added tenantId for multi-tenant data isolation (Requirement 12.2)
 */
export interface DispatchAssignment {
  /** Primary key - unique job identifier */
  jobId: string;
  /** Sort key - assigned vehicle ID */
  vehicleId: string;
  /** Job site address */
  address: string;
  /** Geocoded job site coordinates */
  coordinates: Position;
  /** Current job status */
  status: JobStatus;
  /** Location Service geofence ID for auto-arrival detection */
  geofenceId: string;
  /** Estimated time of arrival (ISO 8601) */
  eta?: string;
  /** Estimated distance in kilometers */
  distanceKm?: number;
  /** Job creation timestamp (ISO 8601) */
  createdAt: string;
  /** Job completion timestamp (ISO 8601) */
  completedAt?: string;
  /** TTL for DynamoDB auto-expiry (Unix timestamp) */
  ttl?: number;
  /** Tenant ID for multi-tenant data isolation (Task 13.2) */
  tenantId?: string;
}

/**
 * Request payload for creating a new job
 */
export interface CreateJobRequest {
  /** Job site address to geocode */
  address: string;
  /** Vehicle to assign the job to */
  vehicleId: string;
  /** Optional job description */
  description?: string;
}

/**
 * Response payload for job creation
 */
export interface CreateJobResponse {
  jobId: string;
  vehicleId: string;
  address: string;
  coordinates: Position;
  eta?: string;
  distanceKm?: number;
  geofenceId: string;
}

// =============================================================================
// GPS History Types
// Requirements: 6.3, 6.4, 6.5 - Historical positions for 24h track playback
// =============================================================================

/**
 * GPS history record (stored in gps-history DynamoDB table)
 * Requirements: 6.3 - vehicleId PK, timestamp SK, stores historical positions
 */
export interface GpsHistoryRecord {
  /** Primary key - vehicle identifier */
  vehicleId: string;
  /** Sort key - ISO 8601 timestamp */
  timestamp: string;
  /** GPS position */
  position: Position;
  /** Heading in degrees (0-360) */
  heading: number;
  /** Speed in mph */
  speed: number;
  /** Engine ignition state */
  ignition: boolean;
  /** TTL for auto-expiry after 24 hours (Unix timestamp) */
  ttl: number;
}

// =============================================================================
// WebSocket Message Types
// Requirements: 5.2, 5.12 - Real-time position updates via WebSocket
// =============================================================================

/**
 * WebSocket message types
 */
export type WebSocketMessageType = 
  | 'VEHICLE_UPDATE'
  | 'JOB_ASSIGNED'
  | 'JOB_COMPLETED'
  | 'VEHICLE_OFFLINE'
  | 'CONNECTION_ACK'
  | 'ERROR';

/**
 * Base WebSocket message structure
 */
export interface WebSocketMessage<T = unknown> {
  type: WebSocketMessageType;
  data: T;
  timestamp: string;
}

/**
 * Vehicle position update message
 * Broadcast when vehicle position changes
 */
export interface VehicleUpdateMessage {
  vehicleId: string;
  position: Position;
  heading: number;
  speed: number;
  status: VehicleStatus;
  ignition: boolean;
  assignedJobId?: string;
}

/**
 * Job assigned message
 * Broadcast when a job is assigned to a vehicle
 */
export interface JobAssignedMessage {
  jobId: string;
  vehicleId: string;
  address: string;
  coordinates: Position;
  eta?: string;
}

/**
 * Job completed message
 * Broadcast when a vehicle arrives at job site (geofence trigger)
 */
export interface JobCompletedMessage {
  jobId: string;
  vehicleId: string;
  completedAt: string;
}

/**
 * Job completion notification message (sent to SQS for email processing)
 * Requirements: 3.1, 3.2
 */
export interface JobCompletionNotification {
  type: "JOB_COMPLETED";
  jobId: string;
  vehicleId: string;
  completedAt: string;
  destination: string;
  tenantId: string;
}

/**
 * WebSocket connection record (stored in websocket-connections DynamoDB table)
 * Requirements: 5.13 - Connection management
 */
export interface WebSocketConnection {
  /** Primary key - WebSocket connection ID */
  connectionId: string;
  /** Cognito user ID */
  userId: string;
  /** Connection timestamp (ISO 8601) */
  connectedAt: string;
  /** TTL for auto-cleanup (Unix timestamp) */
  ttl?: number;
}

// =============================================================================
// DynamoDB Entity Types (for type-safe DynamoDB operations)
// =============================================================================

/**
 * DynamoDB table names
 */
export const DynamoDBTables = {
  VEHICLE_CURRENT_STATE: 'vehicle-current-state',
  DISPATCH_ASSIGNMENTS: 'dispatch-assignments',
  GPS_HISTORY: 'gps-history',
  WEBSOCKET_CONNECTIONS: 'websocket-connections',
} as const;

/**
 * DynamoDB key schema for vehicle-current-state table
 */
export interface VehicleStateKey {
  vehicleId: string;
}

/**
 * DynamoDB key schema for dispatch-assignments table
 */
export interface DispatchAssignmentKey {
  jobId: string;
  vehicleId: string;
}

/**
 * DynamoDB key schema for gps-history table
 */
export interface GpsHistoryKey {
  vehicleId: string;
  timestamp: string;
}

/**
 * DynamoDB key schema for websocket-connections table
 */
export interface WebSocketConnectionKey {
  connectionId: string;
}

// =============================================================================
// API Response Types
// Requirements: 5.3 - REST API responses
// =============================================================================

/**
 * Vehicle list response
 */
export interface VehicleListResponse {
  vehicles: VehicleState[];
  count: number;
}

/**
 * Vehicle detail response with optional history
 */
export interface VehicleDetailResponse {
  vehicle: VehicleState;
  currentJob?: DispatchAssignment;
}

/**
 * Vehicle history response
 */
export interface VehicleHistoryResponse {
  vehicleId: string;
  positions: GpsHistoryRecord[];
  startTime: string;
  endTime: string;
}

/**
 * ETA calculation response
 */
export interface EtaResponse {
  vehicleId: string;
  destination: Position;
  eta: string;
  durationMinutes: number;
  distanceKm: number;
}

/**
 * Job list response
 */
export interface JobListResponse {
  jobs: DispatchAssignment[];
  count: number;
}

// =============================================================================
// Geofence Types
// Requirements: 3.6, 3.7, 3.8, 3.9 - Geofence for auto-arrival detection
// =============================================================================

/**
 * Geofence event types from Amazon Location Service
 */
export type GeofenceEventType = 'ENTER' | 'EXIT';

/**
 * Geofence event from EventBridge
 */
export interface GeofenceEvent {
  /** Event type (ENTER or EXIT) */
  eventType: GeofenceEventType;
  /** Geofence ID (format: job-{jobId}) */
  geofenceId: string;
  /** Device/vehicle ID */
  deviceId: string;
  /** Position where event occurred */
  position: Position;
  /** Event timestamp (ISO 8601) */
  sampleTime: string;
}

// =============================================================================
// IoT Types
// Requirements: 2.1, 2.3, 2.4 - IoT Core message routing
// =============================================================================

/**
 * IoT Rule action error for dead letter queue
 */
export interface IoTRuleError {
  ruleName: string;
  topic: string;
  message: GpsMessage;
  errorCode: string;
  errorMessage: string;
  timestamp: string;
}

// =============================================================================
// Vehicle Telemetry Types (Phase 2 - Deferred)
// =============================================================================

/**
 * Vehicle OBD-II telemetry data (Phase 2)
 */
export interface VehicleTelemetry {
  vehicleId: string;
  timestamp: string;
  engineRpm: number;
  coolantTemp: number;
  fuelLevel: number;
  batteryVoltage: number;
  odometer: number;
  dtcCodes: string[];
}

// =============================================================================
// Utility Types
// =============================================================================

/**
 * Pagination parameters for list operations
 */
export interface PaginationParams {
  limit?: number;
  lastEvaluatedKey?: Record<string, unknown>;
}

/**
 * Paginated response wrapper
 */
export interface PaginatedResponse<T> {
  items: T[];
  count: number;
  lastEvaluatedKey?: Record<string, unknown>;
  hasMore: boolean;
}

/**
 * API error response
 */
export interface ApiErrorResponse {
  error: string;
  message: string;
  statusCode: number;
  requestId?: string;
}

/**
 * Lambda handler context (subset of AWS Lambda context)
 */
export interface LambdaContext {
  awsRequestId: string;
  functionName: string;
  functionVersion: string;
  invokedFunctionArn: string;
  memoryLimitInMB: string;
  logGroupName: string;
  logStreamName: string;
}
