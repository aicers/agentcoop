import { Box, Text } from "ink";
import { useEffect, useState } from "react";
import type { TokenUsage } from "../agent.js";
import type { AuthMode } from "../auth-policy.js";
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

/** Map a CLI identifier to a title-case display name. */
export function cliDisplayName(cli: string): string {
  switch (cli) {
    case "claude":
      return "Claude";
    case "codex":
      return "Codex";
    default:
      return cli;
  }
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
  /** CLI identifier for Agent A (e.g. "claude" or "codex"). */
  cliTypeA?: string;
  /** CLI identifier for Agent B (e.g. "claude" or "codex"). */
  cliTypeB?: string;
  /** Authentication mode for Agent A (env = API key, oauth = subscription). */
  authModeA?: AuthMode;
  /** Authentication mode for Agent B (env = API key, oauth = subscription). */
  authModeB?: AuthMode;
}

export function TokenBar({
  emitter,
  visible = true,
  contentWidth,
  layout = "row",
  cliTypeA,
  cliTypeB,
  authModeA,
  authModeB,
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
    usageA.cachedInputTokens > 0 ||
    usageB.inputTokens > 0 ||
    usageB.outputTokens > 0 ||
    usageB.cachedInputTokens > 0;
  const hasBadge = authModeA !== undefined || authModeB !== undefined;

  if (!visible || (!hasData && !hasBadge)) return null;

  const labelA = cliTypeA
    ? `${m["agent.labelShortA"]} (${cliDisplayName(cliTypeA)})`
    : m["agent.labelARole"];
  const labelB = cliTypeB
    ? `${m["agent.labelShortB"]} (${cliDisplayName(cliTypeB)})`
    : m["agent.labelBRole"];

  function formatUsage(label: string, usage: TokenUsage): string {
    if (usage.cachedInputTokens > 0) {
      return m["tokenBar.agentUsageCached"](
        label,
        formatTokenCount(usage.inputTokens),
        formatTokenCount(usage.cachedInputTokens),
        formatTokenCount(usage.outputTokens),
      );
    }
    return m["tokenBar.agentUsage"](
      label,
      formatTokenCount(usage.inputTokens),
      formatTokenCount(usage.outputTokens),
    );
  }

  function usageHasData(usage: TokenUsage): boolean {
    return (
      usage.inputTokens > 0 ||
      usage.outputTokens > 0 ||
      usage.cachedInputTokens > 0
    );
  }

  const textA = usageHasData(usageA)
    ? formatUsage(labelA, usageA)
    : `${labelA}:`;
  const textB = usageHasData(usageB)
    ? formatUsage(labelB, usageB)
    : `${labelB}:`;

  // The badge is rendered in a separate <Text> so it can keep its own
  // color independent of the rest of the line.
  const reservedForBadge =
    contentWidth !== undefined
      ? Math.max(
          0,
          Math.max(
            authModeA ? authBadgeWidth(authModeA) : 0,
            authModeB ? authBadgeWidth(authModeB) : 0,
          ),
        )
      : 0;
  const usageContentWidth =
    contentWidth !== undefined
      ? Math.max(1, contentWidth - reservedForBadge)
      : undefined;

  const displayA =
    usageContentWidth !== undefined
      ? truncateWithEllipsis(textA, usageContentWidth)
      : textA;
  const displayB =
    usageContentWidth !== undefined
      ? truncateWithEllipsis(textB, usageContentWidth)
      : textB;

  const boxHeight = contentWidth !== undefined ? 3 : undefined;
  // In column layout, flexBasis={0}+flexGrow={1} would collapse the explicit
  // `height` inside a bounded-height parent, leaving only borders.
  const mainAxisSizing = layout === "row" ? { flexGrow: 1, flexBasis: 0 } : {};

  return (
    <Box flexDirection={layout} flexShrink={0}>
      <Box
        {...mainAxisSizing}
        borderStyle="single"
        borderColor="gray"
        paddingX={1}
        height={boxHeight}
        overflow="hidden"
      >
        <Text>
          {displayA}
          {authModeA ? " " : ""}
          {authModeA ? renderBadge(authModeA) : null}
        </Text>
      </Box>
      <Box
        {...mainAxisSizing}
        borderStyle="single"
        borderColor="gray"
        paddingX={1}
        height={boxHeight}
        overflow="hidden"
      >
        <Text>
          {displayB}
          {authModeB ? " " : ""}
          {authModeB ? renderBadge(authModeB) : null}
        </Text>
      </Box>
    </Box>
  );
}

/**
 * Render the auth-mode badge.  `[API]` is yellow to flag the
 * billed-by-token mode; `[OAuth]` is green to flag the subscription
 * mode.  The badge is wrapped in a nested `<Text>` so it inherits the
 * outer line layout while keeping its own color.
 */
function renderBadge(mode: AuthMode) {
  const m = t();
  if (mode === "env") {
    return <Text color="yellow">{`[${m["auth.badgeApi"]}]`}</Text>;
  }
  return <Text color="green">{`[${m["auth.badgeOauth"]}]`}</Text>;
}

export function authBadgeWidth(mode: AuthMode): number {
  const m = t();
  // Brackets + label + leading space.
  return (
    (mode === "env" ? m["auth.badgeApi"] : m["auth.badgeOauth"]).length + 3
  );
}
