Call `scoped_skill_run` exactly once with the following arguments. Do not call any other tool. After the tool returns, report its status and one-sentence diagnosis.

```json
{
  "skill": "analyze-evidence",
  "input": {
    "question": "What caused the import failure, and what is the immediate remediation?",
    "answerStyle": "concise"
  },
  "promptRefs": [
    {
      "kind": "inline",
      "name": "incident ticket",
      "content": "The warehouse import failed after a producer rollout. Diagnose only from granted evidence."
    }
  ],
  "resourceGrants": [
    {
      "path": "logs/import.log",
      "kind": "file",
      "operations": ["read", "search"]
    }
  ],
  "accessMode": "BOUNDED",
  "budgetOverride": {
    "maxTurns": 8,
    "maxToolCalls": 12,
    "timeoutMs": 120000,
    "maxPromptBytes": 131072,
    "maxResultBytes": 32768
  }
}
```
