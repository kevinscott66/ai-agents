# Staged Deployment Strategy

## Overview

This document describes the staged/canary deployment approach for the agent-team service to minimize downtime and enable quick rollback on failure.

## Strategy: Blue-Green with Health Gates

Since the agent-team service is a Node.js/Bun application that doesn't support graceful reload (`systemctl reload`), we implement a blue-green deployment strategy with two systemd units:

- `agent-team-blue.service` - Primary service
- `agent-team-green.service` - Staging service for canary deployments

## Deployment Process

1. **Deploy to staging unit** (green) while primary (blue) continues serving
2. **Health check staging** - verify `/api/health` responds correctly
3. **Switch traffic** - stop blue, start green as primary
4. **Final health check** - verify production traffic works
5. **Rollback if needed** - quickly switch back to blue on failure

## Implementation

The deployment workflow will:

1. Detect which service is currently active (blue/green)
2. Deploy code to the inactive service
3. Start the inactive service on alternate port (8788)
4. Health check the staging service
5. If healthy: stop active service, reconfigure staging to production port (8787), rename services
6. If unhealthy: stop staging service, keep production running

## Rollback

On failure:
- Stop the failed new service
- Ensure the previous service is running
- Log the failure for investigation

## Benefits

- Zero downtime deployments
- Quick rollback capability
- Health validation before production traffic
- Maintains service availability during deployment issues