#!/bin/bash
# Updates WAF IP allowlists for CloudFront and API Gateway to allow current IP
# Adds BOTH IPv4 and IPv6 addresses to ensure browser access works regardless of protocol
set -e

# Load shared configuration (AWS_REGION, etc.)
source "$(dirname "$0")/lib/config.sh"

# CloudFront WAF resources are global and must be queried from us-east-1.
# This is an AWS constraint, not configurable.
CLOUDFRONT_WAF_REGION="us-east-1"

echo "Detecting your public IP addresses..."

# Get both IPv4 and IPv6 addresses
IPV4=$(curl -4 -s --max-time 5 ifconfig.me 2>/dev/null || echo "")
IPV6=$(curl -6 -s --max-time 5 ifconfig.me 2>/dev/null || echo "")

echo "Your IPv4: ${IPV4:-not available}"
echo "Your IPv6: ${IPV6:-not available}"

if [ -z "$IPV4" ] && [ -z "$IPV6" ]; then
  echo "Error: Could not detect any IP address"
  exit 1
fi

# =============================================================================
# Update CloudFront WAF IP Sets
# CloudFront WAF resources are global and queried via us-east-1 — this is an AWS constraint.
# =============================================================================
echo -e "\n=== Updating CloudFront WAF IP Sets ==="

# Update IPv4 set if we have an IPv4 address
if [ -n "$IPV4" ]; then
  IPV4_SET=$(aws wafv2 list-ip-sets --scope CLOUDFRONT --region "$CLOUDFRONT_WAF_REGION" \
    --query "IPSets[?contains(Name, 'ipv4') || contains(Name, 'IPv4')].{Id:Id,Name:Name}" --output json 2>/dev/null)
  
  if [ -n "$IPV4_SET" ] && [ "$IPV4_SET" != "[]" ]; then
    IPV4_ID=$(echo "$IPV4_SET" | jq -r '.[0].Id')
    IPV4_NAME=$(echo "$IPV4_SET" | jq -r '.[0].Name')
    
    if [ -n "$IPV4_ID" ] && [ "$IPV4_ID" != "null" ]; then
      echo "Updating CloudFront IPv4 set: $IPV4_NAME -> $IPV4/32"
      LOCK_TOKEN=$(aws wafv2 get-ip-set --scope CLOUDFRONT --region "$CLOUDFRONT_WAF_REGION" \
        --id "$IPV4_ID" --name "$IPV4_NAME" --query 'LockToken' --output text)
      aws wafv2 update-ip-set --scope CLOUDFRONT --region "$CLOUDFRONT_WAF_REGION" \
        --id "$IPV4_ID" --name "$IPV4_NAME" --addresses "$IPV4/32" --lock-token "$LOCK_TOKEN" > /dev/null
      echo "  ✓ Updated!"
    fi
  else
    echo "  No CloudFront IPv4 IP Set found"
  fi
fi

# Update IPv6 set if we have an IPv6 address
if [ -n "$IPV6" ]; then
  IPV6_SET=$(aws wafv2 list-ip-sets --scope CLOUDFRONT --region "$CLOUDFRONT_WAF_REGION" \
    --query "IPSets[?contains(Name, 'ipv6') || contains(Name, 'IPv6')].{Id:Id,Name:Name}" --output json 2>/dev/null)
  
  if [ -n "$IPV6_SET" ] && [ "$IPV6_SET" != "[]" ]; then
    IPV6_ID=$(echo "$IPV6_SET" | jq -r '.[0].Id')
    IPV6_NAME=$(echo "$IPV6_SET" | jq -r '.[0].Name')
    
    if [ -n "$IPV6_ID" ] && [ "$IPV6_ID" != "null" ]; then
      echo "Updating CloudFront IPv6 set: $IPV6_NAME -> $IPV6/128"
      LOCK_TOKEN=$(aws wafv2 get-ip-set --scope CLOUDFRONT --region "$CLOUDFRONT_WAF_REGION" \
        --id "$IPV6_ID" --name "$IPV6_NAME" --query 'LockToken' --output text)
      aws wafv2 update-ip-set --scope CLOUDFRONT --region "$CLOUDFRONT_WAF_REGION" \
        --id "$IPV6_ID" --name "$IPV6_NAME" --addresses "$IPV6/128" --lock-token "$LOCK_TOKEN" > /dev/null
      echo "  ✓ Updated!"
    fi
  else
    echo "  No CloudFront IPv6 IP Set found"
  fi
fi

# =============================================================================
# Update API Gateway WAF IP Sets (REGIONAL scope)
# =============================================================================
echo -e "\n=== Updating API Gateway WAF IP Sets ==="

# Update API Gateway IPv4 set
if [ -n "$IPV4" ]; then
  API_IPV4_SET=$(aws wafv2 list-ip-sets --scope REGIONAL --region "$AWS_REGION" \
    --query "IPSets[?contains(Name, 'api') && (contains(Name, 'ipv4') || contains(Name, 'IPv4'))].{Id:Id,Name:Name}" --output json 2>/dev/null)
  
  if [ -n "$API_IPV4_SET" ] && [ "$API_IPV4_SET" != "[]" ]; then
    API_IPV4_ID=$(echo "$API_IPV4_SET" | jq -r '.[0].Id')
    API_IPV4_NAME=$(echo "$API_IPV4_SET" | jq -r '.[0].Name')
    
    if [ -n "$API_IPV4_ID" ] && [ "$API_IPV4_ID" != "null" ]; then
      echo "Updating API Gateway IPv4 set: $API_IPV4_NAME -> $IPV4/32"
      LOCK_TOKEN=$(aws wafv2 get-ip-set --scope REGIONAL --region "$AWS_REGION" \
        --id "$API_IPV4_ID" --name "$API_IPV4_NAME" --query 'LockToken' --output text)
      aws wafv2 update-ip-set --scope REGIONAL --region "$AWS_REGION" \
        --id "$API_IPV4_ID" --name "$API_IPV4_NAME" --addresses "$IPV4/32" --lock-token "$LOCK_TOKEN" > /dev/null
      echo "  ✓ Updated!"
    fi
  else
    echo "  No API Gateway IPv4 WAF IP Set found"
  fi
fi

# Update API Gateway IPv6 set
if [ -n "$IPV6" ]; then
  API_IPV6_SET=$(aws wafv2 list-ip-sets --scope REGIONAL --region "$AWS_REGION" \
    --query "IPSets[?contains(Name, 'api') && (contains(Name, 'ipv6') || contains(Name, 'IPv6'))].{Id:Id,Name:Name}" --output json 2>/dev/null)
  
  if [ -n "$API_IPV6_SET" ] && [ "$API_IPV6_SET" != "[]" ]; then
    API_IPV6_ID=$(echo "$API_IPV6_SET" | jq -r '.[0].Id')
    API_IPV6_NAME=$(echo "$API_IPV6_SET" | jq -r '.[0].Name')
    
    if [ -n "$API_IPV6_ID" ] && [ "$API_IPV6_ID" != "null" ]; then
      echo "Updating API Gateway IPv6 set: $API_IPV6_NAME -> $IPV6/128"
      LOCK_TOKEN=$(aws wafv2 get-ip-set --scope REGIONAL --region "$AWS_REGION" \
        --id "$API_IPV6_ID" --name "$API_IPV6_NAME" --query 'LockToken' --output text)
      aws wafv2 update-ip-set --scope REGIONAL --region "$AWS_REGION" \
        --id "$API_IPV6_ID" --name "$API_IPV6_NAME" --addresses "$IPV6/128" --lock-token "$LOCK_TOKEN" > /dev/null
      echo "  ✓ Updated!"
    fi
  else
    echo "  No API Gateway IPv6 WAF IP Set found"
  fi
fi

# Fallback: try legacy single IP set name for backwards compatibility
if [ -n "$IPV4" ]; then
  API_SET=$(aws wafv2 list-ip-sets --scope REGIONAL --region "$AWS_REGION" \
    --query "IPSets[?Name=='fleet-api-deployer-ip-set'].{Id:Id,Name:Name}" --output json 2>/dev/null)
  
  if [ -n "$API_SET" ] && [ "$API_SET" != "[]" ]; then
    API_ID=$(echo "$API_SET" | jq -r '.[0].Id')
    API_NAME=$(echo "$API_SET" | jq -r '.[0].Name')
    
    if [ -n "$API_ID" ] && [ "$API_ID" != "null" ]; then
      echo "Updating legacy API Gateway IP set: $API_NAME -> $IPV4/32"
      LOCK_TOKEN=$(aws wafv2 get-ip-set --scope REGIONAL --region "$AWS_REGION" \
        --id "$API_ID" --name "$API_NAME" --query 'LockToken' --output text)
      aws wafv2 update-ip-set --scope REGIONAL --region "$AWS_REGION" \
        --id "$API_ID" --name "$API_NAME" --addresses "$IPV4/32" --lock-token "$LOCK_TOKEN" > /dev/null
      echo "  ✓ Updated!"
    fi
  fi
fi

# =============================================================================
# Summary
# =============================================================================
echo -e "\n=== Dashboard Access ==="
CF_DOMAIN=$(aws cloudformation describe-stacks --stack-name FleetHostingStack \
  --query "Stacks[0].Outputs[?OutputKey=='CloudFrontDomain'].OutputValue" --output text 2>/dev/null)

if [ -n "$CF_DOMAIN" ] && [ "$CF_DOMAIN" != "None" ]; then
  echo "Dashboard URL: $CF_DOMAIN"
else
  echo "Run: aws cloudformation describe-stacks --stack-name FleetHostingStack --query 'Stacks[0].Outputs'"
fi

echo -e "\nDone! Both IPv4 and IPv6 addresses have been added to the allowlists."
echo "Try accessing the dashboard now (hard refresh with Cmd+Shift+R if needed)."
