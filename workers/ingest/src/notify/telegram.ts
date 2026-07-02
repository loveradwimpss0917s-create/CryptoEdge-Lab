// Telegram Bot notifications for critical events (docs/01 §4.5, docs/12 §2).
// Free, no SaaS contract — just a bot token + chat id in Worker Secrets.

export async function notifyTelegram(
  botToken: string,
  chatId: string,
  text: string
): Promise<void> {
  const url = `https://api.telegram.org/bot${botToken}/sendMessage`;
  await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: "Markdown" })
  });
  // Best-effort: a failed notification must never fail the calling tick.
}
