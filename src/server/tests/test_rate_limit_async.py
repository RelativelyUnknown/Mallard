"""Async rate-limiter backends: in-process wrapper + Redis-backed limiter."""

from __future__ import annotations

import asyncio
import logging

import fakeredis.aioredis as fakeredis
import pytest
from redis.exceptions import ConnectionError as RedisConnectionError
from redis.exceptions import TimeoutError as RedisTimeoutError

from server.rate_limit import (
    InProcessRateLimiter,
    RedisRateLimiter,
    SlidingWindowLimiter,
    create_rate_limiter,
    prune_expired,
)

from .conftest import BrokenRedis


class TestInProcessRateLimiter:
    async def test_allows_then_blocks(self) -> None:
        limiter = InProcessRateLimiter(SlidingWindowLimiter(2, 60))
        assert await limiter.check("k", now=1000.0) is None
        assert await limiter.check("k", now=1000.0) is None
        retry = await limiter.check("k", now=1000.0)
        assert retry is not None and retry > 0

    async def test_cleanup_evicts_expired_keys(self) -> None:
        limiter = InProcessRateLimiter(SlidingWindowLimiter(5, 60))
        await limiter.check("a", now=0.0)
        await limiter.check("b", now=0.0)
        # Well past the window — every key's hits have expired.
        removed = limiter.cleanup(now=1000.0)
        assert removed == 2

    async def test_healthy(self) -> None:
        limiter = InProcessRateLimiter(SlidingWindowLimiter(1, 60))
        assert await limiter.healthy() is True


class TestRedisRateLimiter:
    @pytest.fixture()
    def redis(self):
        return fakeredis.FakeRedis(decode_responses=True)

    async def test_allows_up_to_limit_then_blocks(self, redis) -> None:
        limiter = RedisRateLimiter(redis, limit=2, window_seconds=60)
        assert await limiter.check("team") is None
        assert await limiter.check("team") is None
        retry = await limiter.check("team")
        assert retry is not None and retry > 0

    async def test_keys_are_independent(self, redis) -> None:
        limiter = RedisRateLimiter(redis, limit=1, window_seconds=60)
        assert await limiter.check("team-a") is None
        assert await limiter.check("team-b") is None  # different key, still allowed
        assert await limiter.check("team-a") is not None

    async def test_limit_is_shared_across_replicas(self, redis) -> None:
        """Two limiter instances (simulating two pods) share one Redis, so the
        per-credential limit holds across the fleet instead of being multiplied
        by the replica count."""
        pod_a = RedisRateLimiter(redis, limit=2, window_seconds=60)
        pod_b = RedisRateLimiter(redis, limit=2, window_seconds=60)
        assert await pod_a.check("team") is None
        assert await pod_b.check("team") is None
        # Third request on either pod exceeds the shared limit of 2.
        assert await pod_a.check("team") is not None

    async def test_window_expiry_via_ttl(self, redis) -> None:
        # A fixed wall-clock `now` far in the future frees the window.
        limiter = RedisRateLimiter(redis, limit=1, window_seconds=1)
        assert await limiter.check("team", now=1_000.0) is None
        assert await limiter.check("team", now=1_000.0) is not None
        assert await limiter.check("team", now=1_010.0) is None  # window passed

    async def test_healthy(self, redis) -> None:
        limiter = RedisRateLimiter(redis, limit=1, window_seconds=60)
        assert await limiter.healthy() is True

    async def test_from_string(self, redis) -> None:
        limiter = RedisRateLimiter.from_string(redis, "1/second")
        assert limiter.limit == 1
        assert limiter.window_seconds == 1.0


class TestFactory:
    async def test_returns_in_process_without_redis_url(self) -> None:
        settings = _Settings(rate_limit="60/minute", redis_url="")
        limiter = await create_rate_limiter(settings)
        assert isinstance(limiter, InProcessRateLimiter)

    async def test_returns_redis_when_url_set(self, monkeypatch) -> None:
        import redis.asyncio as aioredis

        monkeypatch.setattr(
            aioredis, "from_url", lambda *a, **k: fakeredis.FakeRedis(decode_responses=True)
        )
        settings = _Settings(rate_limit="60/minute", redis_url="redis://localhost:6379/0")
        limiter = await create_rate_limiter(settings)
        assert isinstance(limiter, RedisRateLimiter)


class _Settings:
    def __init__(self, rate_limit: str, redis_url: str) -> None:
        self.rate_limit = rate_limit
        self.redis_url = redis_url


class _Clock:
    def __init__(self) -> None:
        self.now = 1000.0

    def __call__(self) -> float:
        return self.now


class TestRedisFailsOpen:
    """A Redis outage must degrade the limit to per-process, never raise (which
    surfaced as a 500 on every ingest request)."""

    async def test_check_does_not_raise_and_still_limits_locally(self) -> None:
        limiter = RedisRateLimiter(BrokenRedis(), limit=2, window_seconds=60)
        assert await limiter.check("team") is None
        assert await limiter.check("team") is None
        retry = await limiter.check("team")
        assert retry is not None and retry > 0  # the local fallback still enforces the limit

    @pytest.mark.parametrize(
        "exc",
        [RedisConnectionError("refused"), RedisTimeoutError("slow"), OSError("reset"), asyncio.TimeoutError()],
    )
    async def test_every_redis_failure_mode_fails_open(self, exc: Exception) -> None:
        limiter = RedisRateLimiter(BrokenRedis(exc), limit=1, window_seconds=60)
        assert await limiter.check("team") is None

    async def test_keys_stay_independent_in_the_fallback(self) -> None:
        limiter = RedisRateLimiter(BrokenRedis(), limit=1, window_seconds=60)
        assert await limiter.check("team-a") is None
        assert await limiter.check("team-b") is None
        assert await limiter.check("team-a") is not None

    async def test_skips_redis_while_backing_off_then_retries(self) -> None:
        clock = _Clock()
        broken = BrokenRedis()
        limiter = RedisRateLimiter(broken, limit=100, window_seconds=60, clock=clock)
        await limiter.check("team")
        await limiter.check("team")
        await limiter.check("team")
        assert broken.eval_calls == 1  # one failure, then no per-request Redis timeout
        clock.now += 6.0  # past the retry delay
        await limiter.check("team")
        assert broken.eval_calls == 2

    async def test_recovers_to_shared_limit_when_redis_returns(self) -> None:
        redis = fakeredis.FakeRedis(decode_responses=True)
        clock = _Clock()
        limiter = RedisRateLimiter(BrokenRedis(), limit=1, window_seconds=60, clock=clock)
        assert await limiter.check("team") is None  # served by the fallback
        limiter._redis = redis  # Redis comes back
        clock.now += 6.0
        assert await limiter.check("team") is None  # now counted in Redis (fresh window there)
        assert await limiter.check("team") is not None

    async def test_outage_is_logged_once_per_interval(self, caplog) -> None:
        clock = _Clock()
        limiter = RedisRateLimiter(BrokenRedis(), limit=1000, window_seconds=60, clock=clock)
        with caplog.at_level(logging.ERROR, logger="server.rate_limit"):
            for _ in range(5):
                await limiter.check("team")
                clock.now += 6.0  # every call retries Redis and fails again
            assert len([r for r in caplog.records if "Redis rate limiter" in r.message]) == 1
            clock.now += 60.0
            await limiter.check("team")
            assert len([r for r in caplog.records if "Redis rate limiter" in r.message]) == 2

    async def test_healthy_is_false_when_redis_down(self) -> None:
        assert await RedisRateLimiter(BrokenRedis(), limit=1, window_seconds=60).healthy() is False

    async def test_cleanup_prunes_the_fallback(self) -> None:
        limiter = RedisRateLimiter(BrokenRedis(), limit=5, window_seconds=60)
        await limiter.check("a", now=0.0)
        assert limiter.cleanup(now=1000.0) == 1

    async def test_client_gets_bounded_timeouts(self, monkeypatch) -> None:
        """redis-py defaults to no socket timeout; a black-holed Redis would hang
        every ingest request instead of failing open."""
        import redis.asyncio as aioredis

        seen: dict = {}

        def fake_from_url(url, **kwargs):
            seen.update(kwargs)
            return fakeredis.FakeRedis(decode_responses=True)

        monkeypatch.setattr(aioredis, "from_url", fake_from_url)
        await create_rate_limiter(_Settings(rate_limit="60/minute", redis_url="redis://x:6379/0"))
        assert 0 < seen["socket_timeout"] <= 5
        assert 0 < seen["socket_connect_timeout"] <= 5


class TestPruneExpired:
    async def test_prunes_periodically_until_cancelled(self) -> None:
        limiter = SlidingWindowLimiter(5, 0.01)
        limiter.check("a")
        task = asyncio.create_task(prune_expired(limiter, interval=0.01))
        await asyncio.sleep(0.1)
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
        assert limiter._hits == {}
