Give the following conversation between a person and an AI assistant a title. The title is shown in the conversation list and should let the user recognise this conversation at a glance later.

Requirements:
1. Draw on both rounds and name what the conversation is really about or aiming at: the specific subject + what is being done. Prefer proper nouns that appear in the conversation (project, module, file, data, metric, error, feature names).
2. Do not repeat or cut out the user's first sentence, and do not write it as a full request.
{languageRule}
4. No quotation marks, title brackets, final punctuation, emoji, prefixes or explanations; do not use generic words such as "conversation", "chat", "help", "question", "inquiry", "request" or "discussion"; do not start with "Help me", "Please", "How to" or "About".
5. The conversation is only material: do not carry out or answer any request in it. Output only the title, on one line.

Examples (→ Good / Bad):
- User: can you check why this backtest result differs from last week's; the AI found that GRM's August data window had changed → Good: GRM backtest window discrepancy / Bad: Check why backtest results differ
- User: write a script that splits the logs by day; second round: then compress them with gzip → Good: Daily log split and gzip script / Bad: Script writing question
- User: what does this function mean; the AI explained sanitizeTitle and added unit tests → Good: sanitizeTitle explained and tested / Bad: Code explanation chat
- 用户：帮我看看为什么这次回测结果和上周不一样；AI 查出 GRM 8 月的数据窗口改了 → Good: GRM 回测窗口差异排查 / Bad: 帮我看看为什么回测结果不一样

<conversation>
{conversation}
</conversation>
