# SDK first-response deadline

Both text-only inference and tool-enabled Claude SDK queries allow 180 seconds to receive an `assistant` or `result` event. System initialization messages do not reset this deadline. Set `AGENT_SDK_STARTUP_TIMEOUT_MS` between 30000 and 600000 milliseconds to override it; invalid settings use the default.

Expiry closes the SDK query and its CLI transport. The chat returns a timeout message without automatically replaying the task through the raw API. The deadline is removed before yielding the first assistant event, so long-running tool calls are not cut off by this startup guard. Normal completion, exceptions, and early consumer exit also close the query.

This bounds initial inference only. It does not enforce concurrency limits, solve host resource contention, or detect a stall after the first assistant event. Existing running queries are not affected until the updated service is started; do not restart a busy service without reviewing active work.
