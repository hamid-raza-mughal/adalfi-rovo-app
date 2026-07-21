// lib/rovo.js
// Fires ONE Rovo Studio automation flow via its Incoming webhook.
// IMPORTANT: a 200 here is only an ACK that the flow was accepted - it is NOT the agent's answer.
// The answer comes back later to /api/webhook/callback. Never treat this 200 as "done".

export async function fireRovo({ sessionId, correlationId, prompt, callbackUrl }) {
  const url = process.env.ROVO_WEBHOOK_URL;
  const secret = process.env.ROVO_WEBHOOK_SECRET;
  if (!url || !secret) {
    throw new Error("ROVO_WEBHOOK_URL / ROVO_WEBHOOK_SECRET are not set in .env.local");
  }

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      // Confirmed from the trigger's "How to format the request" panel:
      "X-Automation-Webhook-Token": secret,
    },
    body: JSON.stringify({ sessionId, correlationId, prompt, callbackUrl }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Rovo webhook returned ${res.status}. ${text.slice(0, 300)}`);
  }
  return true;
}
