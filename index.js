/* =====================================================================
   VYNOL – Website + Anfrageformular
   ---------------------------------------------------------------------
   Liefert die Website aus (Ordner public) und nimmt unter /api/anfrage
   das Anfrageformular entgegen. Die Anfrage geht inklusive Fotos per
   E-Mail an EMPFAENGER (Einstellungen in wrangler.jsonc).
   ===================================================================== */
import { EmailMessage } from "cloudflare:email";

const MAX_FOTOS = 5;
const MAX_FOTO_BYTES = 8 * 1024 * 1024;     // pro Foto
const MAX_GESAMT_BYTES = 20 * 1024 * 1024;  // alle Fotos zusammen

/* ===================== ab hier nichts ändern ===================== */

function antwort(status, daten) {
  return new Response(JSON.stringify(daten), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });
}

function b64(bytes) {
  let bin = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(bin).replace(/.{76}/g, "$&\r\n");
}
const utf8 = (s) => new TextEncoder().encode(s);
const kopfzeile = (s) => "=?UTF-8?B?" + btoa(String.fromCharCode(...utf8(s))) + "?=";
const sauber = (s, max) => String(s || "").replace(/[\r\n]+/g, " ").trim().slice(0, max);
const dateiname = (s) => sauber(s, 80).replace(/[^\w.\-äöüÄÖÜß ]/g, "_") || "foto.jpg";

async function anfrage(request, env) {
  if (!env.MAIL || !env.ABSENDER || !env.EMPFAENGER) {
    return antwort(500, { fehler: "E-Mail-Versand ist noch nicht eingerichtet." });
  }
  let form;
  try { form = await request.formData(); } catch { return antwort(400, { fehler: "Ungültige Anfrage." }); }

  // Spam-Falle: Dieses Feld ist für Menschen unsichtbar
  if (sauber(form.get("website"), 200)) return antwort(200, { ok: true });

  const name = sauber(form.get("name"), 120);
  const email = sauber(form.get("email"), 200);
  const fahrzeug = sauber(form.get("fahrzeug"), 200);
  const farbe = sauber(form.get("farbe"), 400);
  const leistungen = sauber(form.get("leistungen"), 300);
  const nachricht = String(form.get("nachricht") || "").trim().slice(0, 5000);

  if (!name || !nachricht || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return antwort(400, { fehler: "Bitte Name, E-Mail und Nachricht angeben." });
  }

  const fotos = form.getAll("fotos").filter((f) => f && typeof f === "object" && f.size > 0);
  if (fotos.length > MAX_FOTOS) return antwort(400, { fehler: `Maximal ${MAX_FOTOS} Fotos.` });
  let gesamt = 0;
  for (const f of fotos) {
    if (!/^image\//.test(f.type || "")) return antwort(400, { fehler: "Es können nur Bilder angehängt werden." });
    if (f.size > MAX_FOTO_BYTES) return antwort(400, { fehler: "Ein Foto ist zu groß." });
    gesamt += f.size;
  }
  if (gesamt > MAX_GESAMT_BYTES) return antwort(400, { fehler: "Die Fotos sind zusammen zu groß." });

  const text =
    "Neue Anfrage über die VYNOL-Website\n\n" +
    `Name: ${name}\nE-Mail: ${email}\n` +
    (fahrzeug ? `Fahrzeug: ${fahrzeug}\n` : "") +
    (leistungen ? `Leistungen: ${leistungen}\n` : "") +
    (farbe ? `Wunschfarbe: ${farbe}\n` : "") +
    (fotos.length ? `Fotos: ${fotos.length} im Anhang\n` : "") +
    `\nNachricht:\n${nachricht}\n\n` +
    "Zum Antworten einfach auf diese E-Mail antworten.";

  const domain = env.ABSENDER.split("@")[1];
  const grenze = "vynol-" + crypto.randomUUID();
  const betreff = `Neue Anfrage: ${name}` + (leistungen ? ` – ${leistungen}` : "");
  const teile = [
    `From: ${kopfzeile("VYNOL Website")} <${env.ABSENDER}>`,
    `To: <${env.EMPFAENGER}>`,
    `Reply-To: ${kopfzeile(name)} <${email}>`,
    `Subject: ${kopfzeile(betreff)}`,
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: <${crypto.randomUUID()}@${domain}>`,
    "MIME-Version: 1.0",
    `Content-Type: multipart/mixed; boundary="${grenze}"`,
    "",
    `--${grenze}`,
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: base64",
    "",
    b64(utf8(text)),
  ];
  let nr = 1;
  for (const f of fotos) {
    const name = dateiname(f.name || `foto-${nr}.jpg`);
    teile.push(
      `--${grenze}`,
      `Content-Type: ${f.type}; name="${name}"`,
      "Content-Transfer-Encoding: base64",
      `Content-Disposition: attachment; filename="${name}"`,
      "",
      b64(new Uint8Array(await f.arrayBuffer()))
    );
    nr++;
  }
  teile.push(`--${grenze}--`, "");

  try {
    await env.MAIL.send(new EmailMessage(env.ABSENDER, env.EMPFAENGER, teile.join("\r\n")));
  } catch (e) {
    console.error("E-Mail-Versand fehlgeschlagen:", e && e.message);
    return antwort(502, { fehler: "Die Anfrage konnte gerade nicht gesendet werden." });
  }
  return antwort(200, { ok: true });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/api/anfrage") {
      if (request.method !== "POST") return antwort(405, { fehler: "Nur POST." });
      return anfrage(request, env);
    }
    return env.ASSETS.fetch(request);
  },
};
