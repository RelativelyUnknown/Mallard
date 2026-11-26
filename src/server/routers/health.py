"""GET /health — dependency-aware health, used as the Kubernetes readiness probe.

Returns 200 only when every hard dependency (InfluxDB and the secret manager)
is reachable, and 503 otherwise, so an unhealthy pod is drained from the
Service instead of continuing to receive traffic it can't serve. Redis is *not*
a hard dependency: the rate limiter fails open to a per-process limiter when it
is down, so its state is reported in the body but never fails readiness (a
Redis outage must not drain every replica at once).
Liveness is a separate TCP-socket probe (see k8s/server/deployment.yaml) so a
transient dependency blip drains the pod without triggering a restart loop.
"""

from __future__ import annotations

from fastapi import APIRouter, Request, Response, status

from ..normalize import KNOWN_SCHEMA_VERSIONS

router = APIRouter()


@router.get("/health", tags=["ops"])
async def health(request: Request, response: Response) -> dict:
    """
    Report per-component health. `status` is "ok" (HTTP 200) only when every
    hard dependency is reachable; otherwise "degraded" (HTTP 503).
    `rate_limiter` is "ok", or "degraded" when Redis is unreachable and limits
    are enforced per replica instead of fleet-wide (status stays 200).

    `min_known_schema_version`/`max_known_schema_version` report the ingest
    payload versions this server understands, so operators can spot version
    skew across a fleet of extension installs at a glance.
    """
    from ..influx import ping_influx  # local import to avoid circular deps at module load

    state = request.app.state

    influx_ok = await ping_influx(state.influx_client)

    verifier = getattr(state, "verifier", None)
    secret_manager_ok = await verifier.healthcheck() if verifier is not None else False

    limiter = getattr(state, "label_limiter", None)
    limiter_ok = await limiter.healthy() if limiter is not None else True

    healthy = influx_ok and secret_manager_ok
    if not healthy:
        response.status_code = status.HTTP_503_SERVICE_UNAVAILABLE

    return {
        "status": "ok" if healthy else "degraded",
        "influx": "pong" if influx_ok else "error",
        "secret_manager": "ok" if secret_manager_ok else "error",
        "rate_limiter": "ok" if limiter_ok else "degraded",
        "min_known_schema_version": KNOWN_SCHEMA_VERSIONS[0],
        "max_known_schema_version": KNOWN_SCHEMA_VERSIONS[-1],
    }
