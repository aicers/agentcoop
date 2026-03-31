#!/usr/bin/env node

import { runStartup } from "./startup.js";

try {
  const result = await runStartup();

  console.log();
  console.log(
    `Starting pipeline for ${result.owner}/${result.repo}#${result.issue.number}`,
  );
  console.log(`  Agent A: ${result.agentA.model}`);
  console.log(`  Agent B: ${result.agentB.model}`);
  console.log(`  Mode: ${result.executionMode}`);
  console.log(`  Permission: ${result.claudePermissionMode}`);
  console.log(`  Language: ${result.language}`);
} catch (error) {
  if (
    error instanceof Error &&
    error.message.includes("User force closed the prompt")
  ) {
    process.exit(130);
  }
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
