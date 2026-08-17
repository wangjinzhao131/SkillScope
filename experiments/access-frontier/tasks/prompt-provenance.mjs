function logicalLines(content) {
  const text = String(content ?? "");
  const withoutTrailingNewline = text.endsWith("\n") ? text.slice(0, -1) : text;
  return withoutTrailingNewline === "" ? [] : withoutTrailingNewline.split("\n");
}

export function validatePromptRefProvenance(promptRef, sourceContent) {
  const errors = [];
  if (!promptRef?.sourcePath) return errors;
  if (!Number.isInteger(promptRef.sourceStartLine) || promptRef.sourceStartLine < 1) {
    errors.push("sourceStartLine must be a positive integer when sourcePath is set");
  }
  if (!Number.isInteger(promptRef.sourceEndLine) || promptRef.sourceEndLine < 1) {
    errors.push("sourceEndLine must be a positive integer when sourcePath is set");
  }
  if (errors.length) return errors;
  if (promptRef.sourceStartLine > promptRef.sourceEndLine) {
    return ["sourceStartLine cannot exceed sourceEndLine"];
  }
  const sourceLines = logicalLines(sourceContent);
  if (promptRef.sourceEndLine > sourceLines.length) {
    return [`sourceEndLine ${promptRef.sourceEndLine} exceeds source length ${sourceLines.length}`];
  }
  const snapshotLines = logicalLines(promptRef.content);
  const selected = sourceLines.slice(promptRef.sourceStartLine - 1, promptRef.sourceEndLine);
  if (selected.length !== snapshotLines.length || selected.some((line, index) => line !== snapshotLines[index])) {
    errors.push("content must exactly equal the declared source line span");
  }
  return errors;
}

export function promptRefCoversAssertion(promptRef, assertion) {
  return promptRef?.sourcePath === assertion?.path
    && Number.isInteger(promptRef.sourceStartLine)
    && Number.isInteger(promptRef.sourceEndLine)
    && promptRef.sourceStartLine <= assertion.startLine
    && promptRef.sourceEndLine >= assertion.endLine
    && String(promptRef.content ?? "").includes(assertion.contains);
}
