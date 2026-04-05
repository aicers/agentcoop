import { Box, Text } from "ink";
import { useEffect, useState } from "react";
import type { TokenUsage } from "../agent.js";
import { t } from "../i18n/index.js";
import type {
  AgentUsageEvent,
  PipelineEventEmitter,
} from "../pipeline-events.js";
import { truncateWithEllipsis } from "./StatusBar.js";

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
  /** When false, the bar stays mounted (accumulating data) but renders nothing. */
  visible?: boolean;
  /**
   * Available width for content inside each bordered box.
   * When provided, the content is rendered as a single truncated line and the
   * box height is fixed to 3 rows (top border + content + bottom border) so
   * that wrapping can never inflate the bar beyond what the height model in
   * App.tsx assumes.
   */
  contentWidth?: number;
  /** Layout direction – must match the agent pane layout. */
  layout?: "row" | "column";
}

export function TokenBar({
  emitter,
  visible = true,
  contentWidth,
  layout = "row",
}: TokenBarProps) {
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

  if (!visible || !hasData) return null;

  const labelA = m["agent.labelA"];
  const labelB = m["agent.labelB"];

  const textA = m["tokenBar.agentUsage"](
    labelA,
    formatTokenCount(usageA.inputTokens),
    formatTokenCount(usageA.outputTokens),
  );
  const textB = m["tokenBar.agentUsage"](
    labelB,
    formatTokenCount(usageB.inputTokens),
    formatTokenCount(usageB.outputTokens),
  );

  const displayA =
    contentWidth !== undefined
      ? truncateWithEllipsis(textA, contentWidth)
      : textA;
  const displayB =
    contentWidth !== undefined
      ? truncateWithEllipsis(textB, contentWidth)
      : textB;

  const boxHeight = contentWidth !== undefined ? 3 : undefined;

  return (
    <Box flexDirection={layout} flexShrink={0}>
      <Box
        flexGrow={1}
        flexBasis={0}
        borderStyle="single"
        borderColor="gray"
        paddingX={1}
        height={boxHeight}
        overflow="hidden"
      >
        <Text>{displayA}</Text>
      </Box>
      <Box
        flexGrow={1}
        flexBasis={0}
        borderStyle="single"
        borderColor="gray"
        paddingX={1}
        height={boxHeight}
        overflow="hidden"
      >
        <Text>{displayB}</Text>
      </Box>
    </Box>
  );
}
