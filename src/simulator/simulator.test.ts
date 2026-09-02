import { VehicleConfig, demoVehicles } from "./vehicle-config";
import { GpsMessage } from "./simulator";

describe("Vehicle Configuration", () => {
  describe("demoVehicles", () => {
    it("should have 5 demo vehicles", () => {
      expect(demoVehicles).toHaveLength(5);
    });

    it("should have unique vehicle IDs", () => {
      const ids = demoVehicles.map((v) => v.vehicleId);
      const uniqueIds = new Set(ids);
      expect(uniqueIds.size).toBe(ids.length);
    });

    it("should have valid vehicle IDs matching pattern vehicle-XXX", () => {
      demoVehicles.forEach((vehicle) => {
        expect(vehicle.vehicleId).toMatch(/^vehicle-\d{3}$/);
      });
    });

    it("should have valid start positions", () => {
      demoVehicles.forEach((vehicle) => {
        expect(vehicle.startPosition).toBeDefined();
        expect(vehicle.startPosition.lat).toBeGreaterThanOrEqual(-90);
        expect(vehicle.startPosition.lat).toBeLessThanOrEqual(90);
        expect(vehicle.startPosition.lng).toBeGreaterThanOrEqual(-180);
        expect(vehicle.startPosition.lng).toBeLessThanOrEqual(180);
      });
    });

    it("should have valid base speeds", () => {
      demoVehicles.forEach((vehicle) => {
        expect(vehicle.baseSpeed).toBeGreaterThanOrEqual(0);
        expect(vehicle.baseSpeed).toBeLessThanOrEqual(100);
      });
    });

    it("should have required metadata fields", () => {
      demoVehicles.forEach((vehicle) => {
        expect(vehicle.technician).toBeTruthy();
        expect(vehicle.make).toBeTruthy();
        expect(vehicle.model).toBeTruthy();
      });
    });
  });
});

describe("GPS Message Format", () => {
  it("should create valid GPS message structure", () => {
    const vehicle = demoVehicles[0];
    const timestamp = new Date().toISOString();
    const message: GpsMessage = {
      vehicleId: vehicle.vehicleId,
      timestamp,
      timestampMs: Date.parse(timestamp),
      lat: vehicle.startPosition.lat,
      lng: vehicle.startPosition.lng,
      speed: 0,
      heading: 0,
      ignition: true,
      accuracy: 5,
    };

    expect(message.vehicleId).toBe(vehicle.vehicleId);
    expect(message.lat).toBe(vehicle.startPosition.lat);
    expect(message.lng).toBe(vehicle.startPosition.lng);
    expect(message.speed).toBe(0);
    expect(message.ignition).toBe(true);
    expect(message.accuracy).toBe(5);
  });

  it("should have valid timestamp format", () => {
    const timestamp = new Date().toISOString();
    expect(timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}.\d{3}Z$/);
  });
});
