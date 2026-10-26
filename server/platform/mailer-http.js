// Envoi d'e-mails sous Cloudflare Workers (pas de SMTP sortant) : API HTTP de Resend.
// Configuré seulement si RESEND_API_KEY et MAIL_FROM (ou SMTP_FROM) sont définis ; sinon aucun e-mail ne part
// (la file reste vide, comme sous Node sans SMTP_HOST).
const from = () => process.env.MAIL_FROM || process.env.SMTP_FROM;

export const transportConfigured = () => !!(process.env.RESEND_API_KEY && from());
export const createTransport = () => ({
  async sendMail({ from: f, to, subject, text, replyTo, headers }) {
    const r = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from: f || from(), to: [to], subject, text, reply_to: replyTo, headers: headers || undefined }),
      signal: AbortSignal.timeout(20_000),
    });
    if (!r.ok) throw new Error(`Resend ${r.status} ${(await r.text()).slice(0, 200)}`);
    return r.json();
  },
});
