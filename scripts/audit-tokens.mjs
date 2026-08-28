import { getSecretName, loadAccountConfig } from "./account-config.mjs";

export function findDuplicateTokens(environment, config = loadAccountConfig()) {
  const byValue = new Map();
  for (const account of config.accounts) {
    const name = getSecretName(account.number);
    const value = String(environment[name] || "").trim();
    if (!value) continue;
    const names = byValue.get(value) || [];
    names.push(name);
    byValue.set(value, names);
  }
  return [...byValue.values()].filter((names) => names.length > 1);
}

if (process.argv[1]?.endsWith("audit-tokens.mjs")) {
  const config = loadAccountConfig();
  const configured = config.accounts.filter((account) => String(process.env[getSecretName(account.number)] || "").trim());
  const duplicates = findDuplicateTokens(process.env, config);
  console.log(`Checked ${configured.length} configured token(s); disabled slots are ignored.`);
  if (duplicates.length === 0) {
    console.log("No duplicate MindVideo token values found.");
    process.exit(0);
  }
  console.log("Duplicate MindVideo token values found:");
  for (const names of duplicates) console.log(`- ${names.join(", ")}`);
  process.exit(1);
}
