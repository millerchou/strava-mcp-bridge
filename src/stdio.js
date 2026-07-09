"use strict";

const readline = require("node:readline");
const { classifyBootstrapError } = require("./bootstrap");
const { jsonRpcError } = require("./errors");
const { transformToolResponse } = require("./tool_response");

async function runStdioBridge({ input, output, upstream, policy, streamOutputDir = "" }) {
  const rl = readline.createInterface({
    input,
    crlfDelay: Infinity,
  });

  let chain = Promise.resolve();

  rl.on("line", (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;

    chain = chain
      .then(() => JSON.parse(trimmed))
      .then((message) => handleMessage({ message, output, upstream, policy, streamOutputDir }))
      .catch((error) => {
        const classified = classifyBootstrapError(error);
        const diagnostics = classified.code === "unknown"
          ? undefined
          : { code: classified.code, nextAction: classified.nextAction };
        writeMessage(output, jsonRpcError(null, -32603, error.message, diagnostics));
      });
  });

  return new Promise((resolve) => {
    rl.on("close", () => {
      chain.finally(resolve);
    });
  });
}

async function handleMessage({ message, output, upstream, policy, streamOutputDir = "" }) {
  const decision = policy.evaluate(message);
  if (!decision.allowed) {
    if (decision.response) {
      writeMessage(output, decision.response);
    }
    return;
  }

  const response = await upstream.send(message);
  if (message.id !== undefined && response) {
    writeMessage(output, transformToolResponse({ request: message, response, streamOutputDir, policy }));
  }
}

function writeMessage(output, message) {
  output.write(`${JSON.stringify(message)}\n`);
}

module.exports = {
  handleMessage,
  runStdioBridge,
  writeMessage,
};
