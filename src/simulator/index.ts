import { VehicleSimulator, SimulatorOptions } from "./simulator";
import { demoVehicles } from "./vehicle-config";

const IOT_ENDPOINT = process.env.IOT_ENDPOINT || "";
const CERT_PATH = process.env.CERT_PATH || "./certs";
const CA_PATH = process.env.CA_PATH || "./certs/AmazonRootCA1.pem";
const PUBLISH_INTERVAL = parseInt(process.env.PUBLISH_INTERVAL || "5000", 10);
const AWS_REGION = process.env.AWS_REGION || "us-east-1";
const ROUTE_CALCULATOR = process.env.ROUTE_CALCULATOR || "fleet-routes";

async function main() {
  if (!IOT_ENDPOINT) {
    console.error("Error: IOT_ENDPOINT environment variable is required");
    console.log("Usage: IOT_ENDPOINT=xxx.iot.region.amazonaws.com npm run simulator:start");
    process.exit(1);
  }

  const options: SimulatorOptions = {
    iotEndpoint: IOT_ENDPOINT,
    certPath: CERT_PATH,
    keyPath: CERT_PATH,
    caPath: CA_PATH,
    publishIntervalMs: PUBLISH_INTERVAL,
    region: AWS_REGION,
    routeCalculator: ROUTE_CALCULATOR,
  };

  console.log("Starting Fleet Vehicle Simulator");
  console.log(`IoT Endpoint: ${IOT_ENDPOINT}`);
  console.log(`AWS Region: ${AWS_REGION}`);
  console.log(`Route Calculator: ${ROUTE_CALCULATOR}`);
  console.log(`Publish Interval: ${PUBLISH_INTERVAL}ms`);
  console.log(`Vehicles: ${demoVehicles.length}`);
  console.log("");
  console.log("Vehicles will start PARKED at their initial positions.");
  console.log("Send a job command via MQTT to make them move.");
  console.log("Topic: fleet/vehicles/{vehicleId}/commands/job");
  console.log('Payload: {"action":"ASSIGN","jobId":"xxx","destination":{"lat":37.xx,"lng":-122.xx,"address":"..."}}');
  console.log("");

  const simulators: VehicleSimulator[] = [];

  // Start all vehicle simulators
  for (const vehicle of demoVehicles) {
    const simulator = new VehicleSimulator(vehicle, options);
    simulators.push(simulator);

    try {
      await simulator.start();
    } catch (err) {
      console.error(`[${vehicle.vehicleId}] Failed to start:`, err);
    }
  }

  console.log(`\nSimulator running with ${simulators.length} vehicles (all parked)`);
  console.log("Press Ctrl+C to stop\n");

  // Handle graceful shutdown
  process.on("SIGINT", () => {
    console.log("\nShutting down simulators...");
    simulators.forEach((s) => s.stop());
    process.exit(0);
  });

  process.on("SIGTERM", () => {
    console.log("\nShutting down simulators...");
    simulators.forEach((s) => s.stop());
    process.exit(0);
  });
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
