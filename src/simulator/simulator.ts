import * as mqtt from "mqtt";
import * as fs from "fs";
import * as path from "path";
import { LocationClient, CalculateRouteCommand } from "@aws-sdk/client-location";
import type { VehicleConfig } from "./vehicle-config";

/**
 * Name of the IoT rule that ingests GPS positions (IngestionStack -> GpsToKinesisRule).
 * Devices publish to the Basic Ingest reserved topic `$aws/rules/<rule-name>/...`, which
 * delivers straight to this rule and bypasses the pub/sub message broker.
 */
const GPS_INGEST_RULE_NAME = process.env.GPS_INGEST_RULE_NAME ?? "fleet_gps_to_kinesis";

/**
 * Name of the IoT rule that forwards positions to the Amazon Location Service
 * tracker via the native `location` rule action (LocationStack -> GpsToLocationRule).
 *
 * This is a SECOND rule, not a second action on the ingestion rule, because a rule's
 * WHERE clause applies to the whole rule. One rule cannot send every position to
 * DynamoDB while sending only a subset to Location Service.
 */
const GPS_LOCATION_RULE_NAME =
  process.env.GPS_LOCATION_RULE_NAME ?? "fleet_gps_to_location";

/**
 * Proximity filtering (off by default so the demo shows the full capability).
 *
 * Amazon Location bills per tracker position update AND per geofence evaluation, so
 * publishing every position to the tracker is the dominant cost at scale. With this
 * enabled, positions only go to the tracker when the vehicle is near a point of
 * interest — its assigned job destination or its home base.
 *
 * IMPORTANT: the radius must be comfortably LARGER than the geofences being
 * evaluated. Geofence ENTER/EXIT events are derived from position updates, so if we
 * stopped publishing the moment a vehicle left a geofence, the EXIT event would never
 * fire. A wide radius keeps publishing while the vehicle drives away.
 */
const PROXIMITY_FILTER_ENABLED = process.env.LOCATION_PROXIMITY_FILTER === "true";
const PROXIMITY_RADIUS_M = Number(process.env.LOCATION_PROXIMITY_RADIUS_M ?? 2000);

export interface SimulatorOptions {
  iotEndpoint: string;
  certPath: string;
  keyPath: string;
  caPath: string;
  publishIntervalMs: number;
  region?: string;
  routeCalculator?: string;
  enableDeviceShadow?: boolean; // Task 11.6: Enable Device Shadow updates
}

export interface GpsMessage {
  vehicleId: string;
  timestamp: string;
  /**
   * Sample time as Unix epoch milliseconds.
   *
   * The Location rule action needs an epoch value for its `timestamp` parameter, and
   * sending it in the payload lets the rule reference `${timestampMs}` directly.
   * Hardware that only emits ISO-8601 can convert in the rule instead with
   * `time_to_epoch(timestamp, '<pattern>')`, which takes a JDK11 DateTimeFormatter
   * pattern. Omitting the parameter entirely would fall back to message-processing
   * time, which is wrong for positions buffered during a connectivity dead zone.
   */
  timestampMs: number;
  lat: number;
  lng: number;
  speed: number;
  heading: number;
  ignition: boolean;
  accuracy: number;
  status?: string; // Include status in GPS message for dashboard
}

// Task 11.4: Device Shadow state structure
// Requirements: 9.2 - Include vehicleId, position, speed, heading, ignition, status, timestamp
interface DeviceShadowState {
  state: {
    reported: {
      vehicleId: string;
      position: {
        lat: number;
        lng: number;
      };
      speed: number;
      heading: number;
      ignition: boolean;
      status: string;
      timestamp: string;
    };
  };
}

interface JobCommand {
  jobId: string;
  action: "ASSIGN" | "CANCEL";
  destination?: {
    lat: number;
    lng: number;
    address: string;
  };
}

interface RoutePoint {
  lat: number;
  lng: number;
}

type VehicleState = "available" | "en-route" | "returning";

export class VehicleSimulator {
  private client: mqtt.MqttClient | null = null;
  private intervalId: NodeJS.Timeout | null = null;
  private locationClient: LocationClient;
  
  // Start position (home base)
  private readonly startLat: number;
  private readonly startLng: number;
  
  // Current position
  private currentLat: number;
  private currentLng: number;
  
  // Job/route state
  private currentJobId: string | null = null;
  private routePoints: RoutePoint[] = [];
  private currentRouteIndex = 0;
  private state: VehicleState = "available";
  // Destination of the active job, retained so proximity filtering can be evaluated
  // on-device without any server-side lookup.
  private destination: RoutePoint | null = null;

  constructor(
    private vehicle: VehicleConfig,
    private options: SimulatorOptions
  ) {
    // Store start position as home base
    this.startLat = vehicle.startPosition.lat;
    this.startLng = vehicle.startPosition.lng;
    this.currentLat = vehicle.startPosition.lat;
    this.currentLng = vehicle.startPosition.lng;
    this.locationClient = new LocationClient({ 
      region: options.region || "us-east-1" 
    });
  }

  async start(): Promise<void> {
    const certDir = path.join(this.options.certPath, this.vehicle.vehicleId);

    // Dead-zone behavior is a client-side concern, not something the broker provides.
    // We rely on mqtt.js defaults here: reconnectPeriod (1s) drives automatic
    // reconnection, and unacknowledged QoS 1 publishes are held in an in-memory store
    // and resent on reconnect. That store does NOT survive a process restart, so this
    // simulator drops positions across a restart. Real GPS hardware should buffer to
    // persistent local storage instead. Note IoT Core persistent sessions would not
    // help: they queue QoS 1 messages sent TO a subscribed device, not telemetry
    // published FROM one.
    this.client = mqtt.connect({
      host: this.options.iotEndpoint,
      port: 8883,
      protocol: "mqtts",
      cert: fs.readFileSync(path.join(certDir, "certificate.pem")),
      key: fs.readFileSync(path.join(certDir, "private.key")),
      ca: fs.readFileSync(this.options.caPath),
      clientId: this.vehicle.vehicleId,
    });

    return new Promise((resolve, reject) => {
      this.client!.on("connect", () => {
        console.log(`[${this.vehicle.vehicleId}] Connected to IoT Core`);
        
        const commandTopic = `fleet/vehicles/${this.vehicle.vehicleId}/commands/job`;
        this.client!.subscribe(commandTopic, { qos: 1 }, (err) => {
          if (err) {
            console.error(`[${this.vehicle.vehicleId}] Failed to subscribe:`, err);
          } else {
            console.log(`[${this.vehicle.vehicleId}] Subscribed to ${commandTopic}`);
          }
        });
        
        this.startPublishing();
        resolve();
      });

      this.client!.on("message", (topic, payload) => {
        this.handleCommand(topic, payload);
      });

      this.client!.on("error", (err) => {
        console.error(`[${this.vehicle.vehicleId}] Connection error:`, err);
        reject(err);
      });
    });
  }

  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
    if (this.client) {
      this.client.end();
      this.client = null;
    }
    console.log(`[${this.vehicle.vehicleId}] Stopped`);
  }

  private async handleCommand(topic: string, payload: Buffer): Promise<void> {
    try {
      const command = JSON.parse(payload.toString()) as JobCommand;
      console.log(`[${this.vehicle.vehicleId}] Received command:`, command);

      if (command.action === "ASSIGN" && command.destination) {
        this.currentJobId = command.jobId;
        this.state = "en-route";
        this.destination = { lat: command.destination.lat, lng: command.destination.lng };
        console.log(`[${this.vehicle.vehicleId}] Job assigned: ${command.jobId}, calculating route to ${command.destination.address}`);
        
        // Calculate route to destination
        await this.calculateRoute(
          this.currentLat, this.currentLng,
          command.destination.lat, command.destination.lng
        );
        
      } else if (command.action === "CANCEL") {
        this.currentJobId = null;
        this.routePoints = [];
        this.currentRouteIndex = 0;
        this.state = "available";
        this.destination = null;
        console.log(`[${this.vehicle.vehicleId}] Job cancelled`);
      }
    } catch (err) {
      console.error(`[${this.vehicle.vehicleId}] Failed to handle command:`, err);
    }
  }

  private async calculateRoute(fromLat: number, fromLng: number, toLat: number, toLng: number): Promise<void> {
    try {
      const calculatorName = this.options.routeCalculator || "fleet-routes";
      
      const response = await this.locationClient.send(new CalculateRouteCommand({
        CalculatorName: calculatorName,
        DeparturePosition: [fromLng, fromLat], // [lng, lat]
        DestinationPosition: [toLng, toLat],
        TravelMode: "Car",
        IncludeLegGeometry: true,
      }));

      // Extract route geometry points from all legs
      this.routePoints = [];
      if (response.Legs) {
        for (const leg of response.Legs) {
          if (leg.Geometry?.LineString) {
            for (const point of leg.Geometry.LineString) {
              this.routePoints.push({
                lng: point[0],
                lat: point[1],
              });
            }
          }
        }
      }

      if (this.routePoints.length > 0) {
        this.currentRouteIndex = 0;
        const distanceKm = (response.Summary?.Distance || 0);
        const durationMin = Math.round((response.Summary?.DurationSeconds || 0) / 60);
        console.log(`[${this.vehicle.vehicleId}] Route calculated: ${this.routePoints.length} points, ${distanceKm.toFixed(1)} km, ~${durationMin} min`);
      } else {
        console.log(`[${this.vehicle.vehicleId}] No route found, using direct path`);
        this.routePoints = [{ lat: toLat, lng: toLng }];
        this.currentRouteIndex = 0;
      }
    } catch (err) {
      console.error(`[${this.vehicle.vehicleId}] Route calculation failed:`, err);
      // Fallback to direct path
      this.routePoints = [{ lat: toLat, lng: toLng }];
      this.currentRouteIndex = 0;
    }
  }

  private startPublishing(): void {
    this.publishPosition();
    
    this.intervalId = setInterval(() => {
      if (this.state !== "available" && this.routePoints.length > 0) {
        this.moveAlongRoute();
      }
      this.publishPosition();
    }, this.options.publishIntervalMs);
  }

  private async moveAlongRoute(): Promise<void> {
    if (this.currentRouteIndex >= this.routePoints.length) {
      // Arrived at current destination
      if (this.state === "en-route") {
        // Arrived at job site - start returning
        console.log(`[${this.vehicle.vehicleId}] Arrived at job site! Starting return trip.`);
        this.state = "returning";
        this.currentJobId = null;
        
        // Calculate route back to start position
        await this.calculateRoute(
          this.currentLat, this.currentLng,
          this.startLat, this.startLng
        );
      } else if (this.state === "returning") {
        // Arrived back at home base
        console.log(`[${this.vehicle.vehicleId}] Returned to base. Now available.`);
        this.state = "available";
        this.routePoints = [];
        this.currentRouteIndex = 0;
        // Snap to exact start position
        this.currentLat = this.startLat;
        this.currentLng = this.startLng;
      }
      return;
    }

    const target = this.routePoints[this.currentRouteIndex];
    const distanceKm = this.haversineDistance(
      this.currentLat, this.currentLng,
      target.lat, target.lng
    );

    // Speed in km per interval (e.g., 30 mph = 48 km/h, in 5s = 0.067 km)
    const speedKmPerInterval = (this.vehicle.baseSpeed * 1.6 * this.options.publishIntervalMs) / (1000 * 3600);

    if (distanceKm <= speedKmPerInterval) {
      // Close enough to waypoint, snap to it and move to next
      this.currentLat = target.lat;
      this.currentLng = target.lng;
      this.currentRouteIndex++;
    } else {
      // Move toward current waypoint
      const bearing = this.calculateBearing(
        this.currentLat, this.currentLng,
        target.lat, target.lng
      );
      const newPos = this.movePoint(this.currentLat, this.currentLng, bearing, speedKmPerInterval);
      this.currentLat = newPos.lat;
      this.currentLng = newPos.lng;
    }
  }

  private publishPosition(): void {
    if (!this.client) return;

    const isMoving = this.state !== "available";
    const speed = isMoving ? this.vehicle.baseSpeed : 0;
    
    // Calculate heading to next waypoint or 0 if parked
    let heading = 0;
    if (isMoving && this.currentRouteIndex < this.routePoints.length) {
      const target = this.routePoints[this.currentRouteIndex];
      heading = this.calculateBearing(this.currentLat, this.currentLng, target.lat, target.lng);
    }

    // Add small GPS jitter (±1 meter)
    const jitter = () => (Math.random() - 0.5) * 0.00002;

    const timestamp = new Date().toISOString();
    const lat = this.currentLat + jitter();
    const lng = this.currentLng + jitter();
    // Jitter only while moving, and never report a negative speed. Applying ±1 mph
    // jitter to a parked vehicle's 0 mph produced "-1 mph" / "-0 mph" in the dashboard.
    const actualSpeed = isMoving ? Math.max(0, speed + (Math.random() - 0.5) * 2) : 0;
    const roundedHeading = Math.round(heading);

    const message: GpsMessage = {
      vehicleId: this.vehicle.vehicleId,
      timestamp,
      timestampMs: Date.parse(timestamp),
      lat,
      lng,
      speed: actualSpeed,
      heading: roundedHeading,
      ignition: true,
      accuracy: 5,
      status: this.state, // Include status for dashboard
    };

    // Basic Ingest reserved topic: invokes the ingestion rule directly and bypasses the
    // pub/sub message broker, which removes IoT Core messaging charges on this high-volume
    // path. IoT strips the `$aws/rules/<rule-name>` prefix before SQL evaluation, so the
    // rule's `FROM 'fleet/vehicles/+/gps'` filter and topic(3) resolve exactly as before.
    // Basic Ingest topics are publish-only, so command/control and Device Shadow updates
    // stay on standard broker topics.
    const topic = `$aws/rules/${GPS_INGEST_RULE_NAME}/fleet/vehicles/${this.vehicle.vehicleId}/gps`;
    // QoS 1 PUBACK confirms delivery to the rules engine, not that the Kinesis action
    // succeeded. The rule's SQS error action captures downstream failures.
    const payload = JSON.stringify(message);
    this.client.publish(topic, payload, { qos: 1 });

    // Second Basic Ingest topic, handled by its own rule, which writes straight to the
    // Location Service tracker via the native `location` action - no Lambda involved.
    // Publishing to both topics is free: Basic Ingest reserved topics incur no
    // messaging charges.
    if (!PROXIMITY_FILTER_ENABLED || this.isNearPointOfInterest(lat, lng)) {
      const locationTopic = `$aws/rules/${GPS_LOCATION_RULE_NAME}/fleet/vehicles/${this.vehicle.vehicleId}/gps`;
      this.client.publish(locationTopic, payload, { qos: 1 });
    }

    // Task 11.6: Update Device Shadow when publishing GPS data
    // Requirements: 9.3 - Update Device Shadow with reported state
    if (this.options.enableDeviceShadow !== false) {
      this.updateDeviceShadow(lat, lng, actualSpeed, roundedHeading, timestamp);
    }

    const statusDisplay = this.state === "available" 
      ? "PARKED" 
      : `${this.state.toUpperCase()} (${this.currentRouteIndex}/${this.routePoints.length})`;
    console.log(
      `[${this.vehicle.vehicleId}] ${statusDisplay}: ${message.lat.toFixed(5)}, ${message.lng.toFixed(5)} @ ${speed.toFixed(0)} mph`
    );
  }

  /**
   * Task 11.6: Update Device Shadow with current vehicle state
   * Requirements: 9.2, 9.3 - Update Device Shadow when publishing GPS data
   */
  private updateDeviceShadow(lat: number, lng: number, speed: number, heading: number, timestamp: string): void {
    if (!this.client) return;

    const shadowUpdate: DeviceShadowState = {
      state: {
        reported: {
          vehicleId: this.vehicle.vehicleId,
          position: { lat, lng },
          speed,
          heading,
          ignition: true,
          status: this.state,
          timestamp,
        },
      },
    };

    const shadowTopic = `$aws/things/${this.vehicle.vehicleId}/shadow/update`;
    this.client.publish(shadowTopic, JSON.stringify(shadowUpdate), { qos: 1 });
  }

  /**
   * True when the vehicle is close enough to a geofenced point of interest that its
   * positions are worth evaluating.
   *
   * Both the active job destination and the home base are included. Home base has its
   * own geofence in this demo, so filtering on the job destination alone would silently
   * drop home-base ENTER/EXIT events.
   *
   * The device can answer this itself because the dispatch command already told it the
   * destination — no DynamoDB lookup and no Lambda required. Doing the same check
   * server-side would mean `get_dynamodb()` in the rule's WHERE clause, which is billed
   * per message like a rule action and is limited to one call per statement.
   */
  private isNearPointOfInterest(lat: number, lng: number): boolean {
    const radiusKm = PROXIMITY_RADIUS_M / 1000;

    if (this.haversineDistance(lat, lng, this.startLat, this.startLng) <= radiusKm) {
      return true;
    }

    if (
      this.destination &&
      this.haversineDistance(lat, lng, this.destination.lat, this.destination.lng) <= radiusKm
    ) {
      return true;
    }

    return false;
  }

  private haversineDistance(lat1: number, lng1: number, lat2: number, lng2: number): number {
    const R = 6371;
    const dLat = this.toRad(lat2 - lat1);
    const dLng = this.toRad(lng2 - lng1);
    const a = Math.sin(dLat / 2) ** 2 +
              Math.cos(this.toRad(lat1)) * Math.cos(this.toRad(lat2)) * Math.sin(dLng / 2) ** 2;
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
  }

  private calculateBearing(lat1: number, lng1: number, lat2: number, lng2: number): number {
    const dLng = this.toRad(lng2 - lng1);
    const lat1Rad = this.toRad(lat1);
    const lat2Rad = this.toRad(lat2);

    const y = Math.sin(dLng) * Math.cos(lat2Rad);
    const x = Math.cos(lat1Rad) * Math.sin(lat2Rad) - 
              Math.sin(lat1Rad) * Math.cos(lat2Rad) * Math.cos(dLng);

    let bearing = Math.atan2(y, x) * 180 / Math.PI;
    return (bearing + 360) % 360;
  }

  private movePoint(lat: number, lng: number, bearing: number, distanceKm: number): RoutePoint {
    const R = 6371;
    const bearingRad = this.toRad(bearing);
    const latRad = this.toRad(lat);
    const lngRad = this.toRad(lng);

    const newLatRad = Math.asin(
      Math.sin(latRad) * Math.cos(distanceKm / R) +
      Math.cos(latRad) * Math.sin(distanceKm / R) * Math.cos(bearingRad)
    );

    const newLngRad = lngRad + Math.atan2(
      Math.sin(bearingRad) * Math.sin(distanceKm / R) * Math.cos(latRad),
      Math.cos(distanceKm / R) - Math.sin(latRad) * Math.sin(newLatRad)
    );

    return {
      lat: newLatRad * 180 / Math.PI,
      lng: newLngRad * 180 / Math.PI,
    };
  }

  private toRad(deg: number): number {
    return deg * Math.PI / 180;
  }
}
