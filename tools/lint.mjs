import { ESLint } from "eslint";

const eslint = new ESLint();
const patterns = process.argv.slice(2);
const results = await eslint.lintFiles(patterns.length ? patterns : ["."]);
for (const result of results) {
  // A blanket disable must not suppress the rule that requires its justification.
  const hiddenPolicyErrors = result.suppressedMessages.filter(
    (message) => message.ruleId === "quality/justified-disable"
  );
  result.messages.push(...hiddenPolicyErrors);
  result.errorCount += hiddenPolicyErrors.length;
}
const formatter = await eslint.loadFormatter("stylish");
const output = formatter.format(results);
if (output) process.stdout.write(output);
process.exitCode = results.some((result) => result.errorCount || result.warningCount) ? 1 : 0;
