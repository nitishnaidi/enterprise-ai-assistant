// Verifies a tool's validation + handler in isolation, no Claude involved -
// so you can trust the tool actually works before an LLM ever gets near it.
// Usage: npm run test:tools --workspace api -- getOrder '{"orderId":"ORD-123"}'
import "dotenv/config";
import { getTool, getAllTools } from "../tools/registry.js";

async function main() {
  const name = process.argv[2];
  const rawArgs = process.argv[3];

  if (!name) {
    console.log("Registered tools:\n");
    for (const tool of getAllTools()) {
      console.log(`- ${tool.name} (${tool.operationType})`);
      console.log(`  ${tool.description}`);
    }
    console.log('\nUsage: npm run test:tools --workspace api -- <toolName> \'{"arg":"value"}\'');
    return;
  }

  const tool = getTool(name);
  if (!tool) {
    console.error(`Unknown tool "${name}". Run with no arguments to list registered tools.`);
    process.exit(1);
  }

  let args: unknown = {};
  if (rawArgs) {
    try {
      args = JSON.parse(rawArgs);
    } catch {
      console.error("Second argument must be valid JSON, e.g. '{\"orderId\":\"ORD-123\"}'");
      process.exit(1);
    }
  }

  console.log(`Tool: ${tool.name} (${tool.operationType})`);
  console.log(`Args: ${JSON.stringify(args)}\n`);

  const validation = tool.validate(args);
  if (!validation.valid) {
    console.log(`Validation FAILED: ${validation.error}`);
    return;
  }
  console.log(`Validation OK: ${JSON.stringify(validation.value)}\n`);

  const result = await tool.handler(validation.value);
  console.log("Result:", JSON.stringify(result, null, 2));
}

main().catch((err) => {
  console.error("Tool test failed:", err);
  process.exit(1);
});
