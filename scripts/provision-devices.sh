#!/bin/bash
# Fleet Vehicle Device Provisioning Script
# Creates IoT certificates for each demo vehicle and saves them locally
# Usage: ./scripts/provision-devices.sh

set -e

# Load shared configuration (AWS_REGION, FLEET_VEHICLES, etc.)
source "$(dirname "$0")/lib/config.sh"

CERT_DIR="${CERT_DIR:-./certs}"

echo "Fleet Vehicle Device Provisioning"
echo "=================================="
echo ""

# Create certs directory
mkdir -p "$CERT_DIR"

# Download Amazon Root CA
if [ ! -f "$CERT_DIR/AmazonRootCA1.pem" ]; then
  echo "Downloading Amazon Root CA..."
  curl -s https://www.amazontrust.com/repository/AmazonRootCA1.pem -o "$CERT_DIR/AmazonRootCA1.pem"
fi

# Get IoT endpoint
IOT_ENDPOINT=$(aws iot describe-endpoint --endpoint-type iot:Data-ATS --query 'endpointAddress' --output text --region "$AWS_REGION")
echo "IoT Endpoint: $IOT_ENDPOINT"
echo ""

# Provision each vehicle
for VEHICLE_ID in "${FLEET_VEHICLES[@]}"; do
  echo "Provisioning $VEHICLE_ID..."
  
  VEHICLE_CERT_DIR="$CERT_DIR/$VEHICLE_ID"
  mkdir -p "$VEHICLE_CERT_DIR"
  
  # Check if certificate already exists locally
  if [ -f "$VEHICLE_CERT_DIR/certificate.pem" ] && [ -f "$VEHICLE_CERT_DIR/private.key" ]; then
    echo "  Certificate already exists, skipping..."
    continue
  fi
  
  # Create certificate
  CERT_OUTPUT=$(aws iot create-keys-and-certificate \
    --set-as-active \
    --certificate-pem-outfile "$VEHICLE_CERT_DIR/certificate.pem" \
    --public-key-outfile "$VEHICLE_CERT_DIR/public.key" \
    --private-key-outfile "$VEHICLE_CERT_DIR/private.key" \
    --region "$AWS_REGION")
  
  CERT_ARN=$(echo "$CERT_OUTPUT" | jq -r '.certificateArn')
  
  # Attach policy to certificate
  aws iot attach-policy \
    --policy-name "$FLEET_VEHICLE_POLICY" \
    --target "$CERT_ARN" \
    --region "$AWS_REGION" 2>/dev/null || true
  
  # Attach certificate to thing
  aws iot attach-thing-principal \
    --thing-name "$VEHICLE_ID" \
    --principal "$CERT_ARN" \
    --region "$AWS_REGION" 2>/dev/null || true
  
  echo "  Certificate created and saved to $VEHICLE_CERT_DIR"
done

echo ""
echo "=================================="
echo "Provisioning Complete!"
echo ""
echo "Certificates saved to: $CERT_DIR"
echo "IoT Endpoint: $IOT_ENDPOINT"
echo ""
echo "To start the simulator:"
echo "  ./scripts/start-simulator.sh"
