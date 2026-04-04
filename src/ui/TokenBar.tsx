import { Box, Text } from "ink";
import { useEffect, useState } from "react";
import type { TokenUsage } from "../agent.js";
import { t } from "../i18n/index.js";
import type {
  AgentUsageEvent,
  PipelineEventEmitter,
} from "../pipeline-events.js";

/**
 * Format a token count with K/M suffixes for readability.
 *
 * - Below 1 000: show the exact number (e.g. "842")
 * - 1 000 – 999 999: show with one decimal K (e.g. "12.3K")
 * - 1 000 000+: show with one decimal M (e.g. "1.2M")
 */
export function formatTokenCount(n: number): string {
  if (n < 1_000) return String(n);
  if (n < 1_000_000) {
    const k = n / 1_000;
    return k >= 100 ? `${Math.round(k)}K` : `${k.toFixed(1)}K`;
  }
  const m = n / 1_000_000;
  return `${m.toFixed(1)}M`;
}

interface TokenBarProps {
  emitter: PipelineEventEmitter;
}

export function TokenBar({ emitter }: TokenBarProps) {
  const [usageA, setUsageA] = useState<TokenUsage>({
    inputTokens: 0,
    outputTokens: 0,
    cachedInputTokens: 0,
  });
  const [usageB, setUsageB] = useState<TokenUsage>({
    inputTokens: 0,
    outputTokens: 0,
    cachedInputTokens: 0,
  });

  useEffect(() => {
    const onUsage = (ev: AgentUsageEvent) => {
      const update = (prev: TokenUsage): TokenUsage => ({
        inputTokens: prev.inputTokens + ev.usage.inputTokens,
        outputTokens: prev.outputTokens + ev.usage.outputTokens,
        cachedInputTokens: prev.cachedInputTokens + ev.usage.cachedInputTokens,
      });
      if (ev.agent === "a") setUsageA(update);
      else setUsageB(update);
    };
    emitter.on("agent:usage", onUsage);
    return () => {
      emitter.off("agent:usage", onUsage);
    };
  }, [emitter]);

  const m = t();
  const hasData =
    usageA.inputTokens > 0 ||
    usageA.outputTokens > 0 ||
    usageB.inputTokens > 0 ||
    usageB.outputTokens > 0;

  if (!hasData) return null;

  const labelA = m["agent.labelA"];
  const labelB = m["agent.labelB"];

  return (
    <Box borderStyle="single" borderColor="gray" paddingX={1}>
      <Text>
        {m["tokenBar.agentUsage"](
          labelA,
          formatTokenCount(usageA.inputTokens),
          formatTokenCount(usageA.outputTokens),
        )}
      </Text>
      <Text>{"  |  "}</Text>
      <Text>
        {m["tokenBar.agentUsage"](
          labelB,
          formatTokenCount(usageB.inputTokens),
          formatTokenCount(usageB.outputTokens),
        )}
      </Text>
    </Box>
  );
}
