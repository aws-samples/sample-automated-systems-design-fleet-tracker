#!/bin/bash
# Fleet Vehicle Simulator Startup Script
# Usage: ./scripts/start-simulator.sh

set -e

# Get IoT endpoint from CloudFormation or environment
if [ -z "$IOT_ENDPOINT" ]; then
  echo "Fetching IoT endpoint from AWS..."
  IOT_ENDPOINT=$(aws iot describe-endpoint --endpoint-type iot:Data-ATS --query 'endpointAddress' --output text)
fi

if [ -z "$IOT_ENDPOINT" ]; then
  echo "Error: Could not determine IoT endpoint"
  echo "Set IOT_ENDPOINT environment variable or ensure AWS CLI is configured"
  exit 1
fi

# Default paths
CERT_PATH="${CERT_PATH:-./certs}"
CA_PATH="${CA_PATH:-./certs/AmazonRootCA1.pem}"
PUBLISH_INTERVAL="${PUBLISH_INTERVAL:-5000}"

# Download Amazon Root CA if not present
if [ ! -f "$CA_PATH" ]; then
  echo "Downloading Amazon Root CA..."
  mkdir -p "$(dirname "$CA_PATH")"
  curl -s https://www.amazontrust.com/repository/AmazonRootCA1.pem -o "$CA_PATH"
fi

echo "Starting Fleet Vehicle Simulator"
echo "================================"
echo "IoT Endpoint: $IOT_ENDPOINT"
echo "Cert Path: $CERT_PATH"
echo "CA Path: $CA_PATH"
echo "Publish Interval: ${PUBLISH_INTERVAL}ms"
echo ""

# Run simulator
IOT_ENDPOINT="$IOT_ENDPOINT" \
CERT_PATH="$CERT_PATH" \
CA_PATH="$CA_PATH" \
PUBLISH_INTERVAL="$PUBLISH_INTERVAL" \
npx ts-node src/simulator/index.ts
