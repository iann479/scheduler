import { getStore } from "@netlify/blobs";

export default async (req) => {
  const headers = {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, PUT, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type"
  };

  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers });
  }

  try {
    const store = getStore("uni-smart-planer-store");
    const body = req.method === "GET" ? {} : await req.json();
    const { action, username, passHash, state } = body;

    if (req.method === "GET") {
      return new Response(JSON.stringify({ ok: true, backend: "netlify-blobs" }), { status: 200, headers });
    }

    const cleanUser = String(username || "").trim().toLowerCase().replace(/[^a-z0-9_-]/g, "_");
    if (!cleanUser || !passHash) {
      return new Response(JSON.stringify({ ok: false, error: "Benutzername oder Passwort-Hash fehlt." }), { status: 400, headers });
    }

    const userKey = `user_${cleanUser}`;
    const existing = await store.get(userKey, { type: "json" });

    if (action === "register") {
      if (existing && existing.passHash && existing.passHash !== passHash) {
        return new Response(JSON.stringify({ ok: false, error: "Dieser Benutzername ist bereits vergeben." }), { status: 409, headers });
      }
      const initialRecord = {
        username: cleanUser,
        passHash,
        state: existing?.state || state || null,
        updatedAt: Date.now()
      };
      await store.setJSON(userKey, initialRecord);
      return new Response(JSON.stringify({ ok: true, state: initialRecord.state }), { status: 200, headers });
    }

    if (action === "login") {
      if (!existing) {
        return new Response(JSON.stringify({ ok: false, error: "Benutzerkonto nicht gefunden. Bitte zuerst registrieren." }), { status: 404, headers });
      }
      if (existing.passHash !== passHash) {
        return new Response(JSON.stringify({ ok: false, error: "Falsches Passwort für diesen Benutzernamen." }), { status: 401, headers });
      }
      return new Response(JSON.stringify({ ok: true, state: existing.state || null }), { status: 200, headers });
    }

    if (action === "save") {
      if (existing && existing.passHash !== passHash) {
        return new Response(JSON.stringify({ ok: false, error: "Nicht autorisiert (Passwort-Hash stimmt nicht überein)." }), { status: 401, headers });
      }
      const updatedRecord = {
        username: cleanUser,
        passHash,
        state,
        updatedAt: Date.now()
      };
      await store.setJSON(userKey, updatedRecord);
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers });
    }

    return new Response(JSON.stringify({ ok: false, error: "Unbekannte Aktion." }), { status: 400, headers });
  } catch (err) {
    return new Response(JSON.stringify({ ok: false, error: err.message || "Serverfehler" }), { status: 500, headers });
  }
};
