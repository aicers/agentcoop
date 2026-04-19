import { Box, Text, useInput } from "ink";
import TextInput from "ink-text-input";
import { useCallback, useEffect, useRef, useState } from "react";
import { t } from "../i18n/index.js";

// ---- types -------------------------------------------------------------------

/**
 * Optional hotkey embedded in an `InputRequest`.  Pressing `key`
 * triggers `onPress` without closing the prompt, and the result
 * updates the inline hint rendered at the `{{hk:<id>}}` sentinel
 * inside `message`.
 */
export interface InputHotkey {
  /** Stable id used inside `{{hk:<id>}}` sentinels in the message. */
  id: string;
  /** Single keyboard character that triggers `onPress`. */
  key: string;
  /** Handler invoked on key press.  Must not throw. */
  onPress: () => Promise<"ok" | "error">;
}

export interface InputRequest {
  /** Message shown above the input. */
  message: string;
  /**
   * When set, the input area shows selection options instead of a text
   * field.  The user presses the number key to select.
   */
  choices?: { label: string; value: string }[];
  /**
   * When set, each `key` triggers its `onPress` without closing the
   * prompt.  The matching `{{hk:<id>}}` sentinel in `message` is
   * replaced by `[<key>] copy` / `[<key>] copied` / `[<key>] copy
   * failed` based on the latest result.
   */
  hotkeys?: InputHotkey[];
}

export interface InputAreaProps {
  request: InputRequest | null;
  onSubmit: (value: string) => void;
}

type HotkeyStatus = "idle" | "copied" | "failed";

const COPIED_AUTO_CLEAR_MS = 1000;
const SENTINEL_REGEX = /\{\{hk:([a-zA-Z0-9_-]+)\}\}/g;

// ---- component ---------------------------------------------------------------

export function InputArea({ request, onSubmit }: InputAreaProps) {
  const [text, setText] = useState("");
  const [hotkeyStatus, setHotkeyStatus] = useState<
    Record<string, HotkeyStatus>
  >({});
  const clearTimersRef = useRef<Map<string, NodeJS.Timeout>>(new Map());
  // Per-hotkey sequence counter.  Each press increments the token; a
  // completion only applies if its captured token still matches the
  // latest dispatched press.  Prevents an older in-flight `onPress`
  // from overwriting the result of a newer one when the user presses
  // the same hotkey twice while the first attempt is still pending.
  const hotkeySeqRef = useRef<Map<string, number>>(new Map());
  // Drop hotkeys whose `key` would also select one of the active
  // numeric choices.  Letting them through would shadow the choice
  // dispatch (which runs after the hotkey match) and silently change
  // prompt semantics.
  const hotkeys = filterChoiceCollisions(
    request?.hotkeys,
    request?.choices?.length ?? 0,
  );

  // Reset per-hotkey status whenever the request changes so a stale
  // "copied" label from a previous prompt never leaks into a new one.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset keyed by request identity
  useEffect(() => {
    setHotkeyStatus({});
    for (const timer of clearTimersRef.current.values()) {
      clearTimeout(timer);
    }
    clearTimersRef.current.clear();
    hotkeySeqRef.current.clear();
  }, [request]);

  useEffect(() => {
    return () => {
      for (const timer of clearTimersRef.current.values()) {
        clearTimeout(timer);
      }
      clearTimersRef.current.clear();
      hotkeySeqRef.current.clear();
    };
  }, []);

  const runHotkey = useCallback((hk: InputHotkey) => {
    const seq = (hotkeySeqRef.current.get(hk.id) ?? 0) + 1;
    hotkeySeqRef.current.set(hk.id, seq);
    void hk.onPress().then((result) => {
      // Drop stale completions: a newer press has already been
      // dispatched, so this result must not overwrite its status or
      // touch its auto-clear timer.
      if (hotkeySeqRef.current.get(hk.id) !== seq) return;
      const existing = clearTimersRef.current.get(hk.id);
      if (existing) {
        clearTimeout(existing);
        clearTimersRef.current.delete(hk.id);
      }
      setHotkeyStatus((prev) => ({
        ...prev,
        [hk.id]: result === "ok" ? "copied" : "failed",
      }));
      if (result === "ok") {
        const timer = setTimeout(() => {
          setHotkeyStatus((prev) => {
            if (prev[hk.id] !== "copied") return prev;
            const next = { ...prev };
            delete next[hk.id];
            return next;
          });
          clearTimersRef.current.delete(hk.id);
        }, COPIED_AUTO_CLEAR_MS);
        clearTimersRef.current.set(hk.id, timer);
      }
    });
  }, []);

  useInput(
    (input) => {
      if (hotkeys && hotkeys.length > 0) {
        const match = hotkeys.find((h) => h.key === input);
        if (match) {
          runHotkey(match);
          return;
        }
      }
      if (!request?.choices) return;
      const idx = Number.parseInt(input, 10) - 1;
      if (idx >= 0 && idx < request.choices.length) {
        onSubmit(request.choices[idx].value);
      }
    },
    {
      isActive: !!request?.choices || (!!hotkeys && hotkeys.length > 0),
    },
  );

  if (!request) {
    return (
      <Box paddingX={1}>
        <Text dimColor>{t()["input.pipelineRunning"]}</Text>
      </Box>
    );
  }

  const hotkeyById = new Map((hotkeys ?? []).map((h) => [h.id, h]));

  if (request.choices) {
    return (
      <Box flexDirection="column" paddingX={1} flexShrink={0}>
        {renderMessageLines(request.message, hotkeyById, hotkeyStatus)}
        {request.choices.map((c, i) => (
          <Text key={c.value}>
            {"  "}
            <Text bold color="cyan">
              {i + 1}
            </Text>
            {" — "}
            {c.label}
          </Text>
        ))}
      </Box>
    );
  }

  return (
    <Box flexDirection="column" paddingX={1} flexShrink={0}>
      {renderMessageLines(request.message, hotkeyById, hotkeyStatus)}
      <Box>
        <Text bold color="cyan">
          {">"}{" "}
        </Text>
        <TextInput
          value={text}
          onChange={setText}
          onSubmit={(value) => {
            onSubmit(value);
            setText("");
          }}
        />
      </Box>
    </Box>
  );
}

/**
 * Render `message` line-by-line, substituting `{{hk:<id>}}` tokens
 * with inline hint labels driven by `status`.  Sentinels referring to
 * unknown ids fall through as literal text so caller bugs surface.
 */
function renderMessageLines(
  message: string,
  hotkeyById: Map<string, InputHotkey>,
  status: Record<string, HotkeyStatus>,
) {
  const labels = t();
  return message.split("\n").map((line, lineIdx) => {
    const parts = splitSentinels(line);
    if (parts.length === 1 && parts[0].kind === "text") {
      return (
        // biome-ignore lint/suspicious/noArrayIndexKey: message lines never reorder
        <Text key={lineIdx}>{line || " "}</Text>
      );
    }
    return (
      // biome-ignore lint/suspicious/noArrayIndexKey: message lines never reorder
      <Text key={lineIdx}>
        {parts.map((part, partIdx) => {
          const partKey = `${lineIdx}:${partIdx}`;
          if (part.kind === "text") {
            return <Text key={partKey}>{part.value}</Text>;
          }
          const hk = hotkeyById.get(part.id);
          if (!hk) {
            return <Text key={partKey}>{part.raw}</Text>;
          }
          const currentStatus: HotkeyStatus = status[hk.id] ?? "idle";
          if (currentStatus === "failed") {
            return (
              <Text key={partKey} color="yellow">
                [{hk.key}] {labels["input.copyFailed"]}
              </Text>
            );
          }
          const verb =
            currentStatus === "copied"
              ? labels["input.copied"]
              : labels["input.copy"];
          return (
            <Text key={partKey} dimColor>
              <Text color="cyan">[{hk.key}]</Text> {verb}
            </Text>
          );
        })}
      </Text>
    );
  });
}

function filterChoiceCollisions(
  hotkeys: InputHotkey[] | undefined,
  choiceCount: number,
): InputHotkey[] | undefined {
  if (!hotkeys || hotkeys.length === 0) return hotkeys;
  if (choiceCount <= 0) return hotkeys;
  return hotkeys.filter((h) => {
    if (!/^[0-9]+$/.test(h.key)) return true;
    const idx = Number.parseInt(h.key, 10);
    return !(idx >= 1 && idx <= choiceCount);
  });
}

type Fragment =
  | { kind: "text"; value: string }
  | { kind: "sentinel"; id: string; raw: string };

function splitSentinels(line: string): Fragment[] {
  const parts: Fragment[] = [];
  SENTINEL_REGEX.lastIndex = 0;
  let lastIndex = 0;
  for (;;) {
    const match = SENTINEL_REGEX.exec(line);
    if (!match) break;
    if (match.index > lastIndex) {
      parts.push({ kind: "text", value: line.slice(lastIndex, match.index) });
    }
    parts.push({ kind: "sentinel", id: match[1], raw: match[0] });
    lastIndex = match.index + match[0].length;
  }
  if (lastIndex < line.length) {
    parts.push({ kind: "text", value: line.slice(lastIndex) });
  }
  if (parts.length === 0) {
    parts.push({ kind: "text", value: "" });
  }
  return parts;
}
