import { Box, Text, useInput } from "ink";
import TextInput from "ink-text-input";
import { useState } from "react";
import { t } from "../i18n/index.js";

// ---- types -------------------------------------------------------------------

export interface InputRequest {
  /** Message shown above the input. */
  message: string;
  /**
   * When set, the input area shows selection options instead of a text
   * field.  The user presses the number key to select.
   */
  choices?: { label: string; value: string }[];
}

export interface InputAreaProps {
  request: InputRequest | null;
  onSubmit: (value: string) => void;
}

// ---- component ---------------------------------------------------------------

export function InputArea({ request, onSubmit }: InputAreaProps) {
  const [text, setText] = useState("");

  useInput(
    (input) => {
      if (!request?.choices) return;
      const idx = Number.parseInt(input, 10) - 1;
      if (idx >= 0 && idx < request.choices.length) {
        onSubmit(request.choices[idx].value);
      }
    },
    { isActive: !!request?.choices },
  );

  if (!request) {
    return (
      <Box paddingX={1}>
        <Text dimColor>{t()["input.pipelineRunning"]}</Text>
      </Box>
    );
  }

  if (request.choices) {
    return (
      <Box flexDirection="column" paddingX={1} flexShrink={0}>
        {request.message.split("\n").map((line, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: static message lines never reorder
          <Text key={i}>{line || " "}</Text>
        ))}
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
      {request.message.split("\n").map((line, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: static message lines never reorder
        <Text key={i}>{line || " "}</Text>
      ))}
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
