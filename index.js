require("dotenv").config();
const express = require("express");
const axios = require("axios");
const { Pool } = require("pg");

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static("public"));

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

function normalizePhoneBR(input) {
  // Mantém só números
  let digits = (input || "").replace(/\D/g, "");
  // Se o usuário colocou 55, mantém. Se não, adiciona.
  if (digits.startsWith("55")) return digits;
  return "55" + digits;
}

function buildPhoneCandidatesBR(input) {
  const digits = (input || "").replace(/\D/g, "");
  const candidates = new Set();
  if (!digits) return [];

  // Always keep the raw digits
  candidates.add(digits);

  // If missing country code, add it
  if (!digits.startsWith("55")) {
    candidates.add("55" + digits);
  }

  // Handle BR mobile extra '9' after DDD
  // Example stored: 55 + DDD + 9 + 8digits (13 total)
  // Incoming from webhook sometimes comes without the extra 9 (12 total)
  if (digits.startsWith("55")) {
    const ddd = digits.slice(2, 4);
    const rest = digits.slice(4);

    if (digits.length === 12) {
      // add missing 9
      candidates.add("55" + ddd + "9" + rest);
    }

    if (digits.length === 13 && rest.startsWith("9")) {
      // remove extra 9
      candidates.add("55" + ddd + rest.slice(1));
    }
  }

  return Array.from(candidates);
}

async function getSettings() {
  const result = await pool.query(`select event_name, coupon_code, photos_link from app_settings where id = 1`);
  if (result.rowCount > 0) return result.rows[0];
  await pool.query(`insert into app_settings (id) values (1) on conflict (id) do nothing`);
  const retry = await pool.query(`select event_name, coupon_code, photos_link from app_settings where id = 1`);
  return retry.rows[0] || { event_name: null, coupon_code: null, photos_link: null };
}

async function updateSettings({ event_name, coupon_code, photos_link }) {
  await pool.query(
    `
    insert into app_settings (id, event_name, coupon_code, photos_link, updated_at)
    values (1, $1, $2, $3, now())
    on conflict (id) do update
    set event_name = excluded.event_name,
        coupon_code = excluded.coupon_code,
        photos_link = excluded.photos_link,
        updated_at = now()
    `,
    [event_name || null, coupon_code || null, photos_link || null]
  );
  return getSettings();
}

async function sendTemplateMessage({ to, templateName, lang = "pt_BR", params = [] }) {
  const url = `https://graph.facebook.com/${process.env.WA_API_VERSION}/${process.env.WA_PHONE_NUMBER_ID}/messages`;

  const payload = {
    messaging_product: "whatsapp",
    to,
    type: "template",
    template: {
      name: templateName,
      language: { code: lang },
    },
  };
  if (params.length > 0) {
    payload.template.components = [
      {
        type: "body",
        parameters: params.map((text) => ({ type: "text", text })),
      },
    ];
  }

  const res = await axios.post(url, payload, {
    headers: {
      Authorization: `Bearer ${process.env.WA_TOKEN}`,
      "Content-Type": "application/json",
    },
  });

  return res.data;
}

async function sendTextMessage({ to, text }) {
  const url = `https://graph.facebook.com/${process.env.WA_API_VERSION}/${process.env.WA_PHONE_NUMBER_ID}/messages`;
  const payload = {
    messaging_product: "whatsapp",
    to,
    type: "text",
    text: { body: text },
  };

  const res = await axios.post(url, payload, {
    headers: {
      Authorization: `Bearer ${process.env.WA_TOKEN}`,
      "Content-Type": "application/json",
    },
  });

  return res.data;
}

async function logChatMessage({ contact_id, direction, body, wa_message_id }) {
  if (!contact_id) return;
  await pool.query(
    `insert into chat_messages (contact_id, direction, body, wa_message_id) values ($1,$2,$3,$4)`,
    [contact_id, direction, body || null, wa_message_id || null]
  );
}

const QUEUE_BATCH_SIZE = Number(process.env.QUEUE_BATCH_SIZE || 20);
const QUEUE_MAX_ATTEMPTS = Number(process.env.QUEUE_MAX_ATTEMPTS || 3);
const QUEUE_POLL_INTERVAL_MS = Number(process.env.QUEUE_POLL_INTERVAL_MS || 1000);

async function fetchQueuedBatch(limit) {
  const result = await pool.query(
    `
    with cte as (
      select m.id
      from messages m
      where m.status = 'queued'
      order by m.created_at
      limit $1
      for update skip locked
    )
    update messages m
    set status = 'processing', locked_at = now(), last_attempt_at = now()
    from cte
    where m.id = cte.id
    returning m.*
    `,
    [limit]
  );
  return result.rows;
}

async function processQueuedMessage(msg) {
  const contactRes = await pool.query(`select phone_e164 from contacts where id = $1`, [msg.contact_id]);
  const phone_e164 = contactRes.rows[0]?.phone_e164;
  if (!phone_e164) {
    throw new Error("contact not found for message");
  }

  const params = Array.isArray(msg.params) ? msg.params : msg.params ? JSON.parse(msg.params) : [];
  const wa = await sendTemplateMessage({
    to: phone_e164,
    templateName: msg.template_name,
    lang: msg.template_lang,
    params,
  });

  await pool.query(
    `update messages set status = 'sent', wa_message_id = $1, sent_at = now() where id = $2`,
    [wa.messages?.[0]?.id || null, msg.id]
  );
}

async function handleQueueFailure(msg, err) {
  const attempts = Number(msg.attempt_count || 0) + 1;
  const errorText = JSON.stringify(err?.response?.data || err?.message || err);

  if (attempts >= QUEUE_MAX_ATTEMPTS) {
    await pool.query(
      `update messages set status = 'failed', attempt_count = $1, error = $2 where id = $3`,
      [attempts, errorText, msg.id]
    );
  } else {
    await pool.query(
      `update messages set status = 'queued', attempt_count = $1, error = $2 where id = $3`,
      [attempts, errorText, msg.id]
    );
  }
}

async function queuePollLoop() {
  try {
    const batch = await fetchQueuedBatch(QUEUE_BATCH_SIZE);
    for (const msg of batch) {
      try {
        await processQueuedMessage(msg);
        // rate limit: 1 msg/seg
        await new Promise((r) => setTimeout(r, 1000));
      } catch (err) {
        await handleQueueFailure(msg, err);
      }
    }
  } catch (err) {
    console.error("queue worker error:", err.message || err);
  }
}

// Admin: settings + contacts (public for now)
app.get("/admin/settings", async (_, res) => {
  try {
    const settings = await getSettings();
    res.json(settings);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/admin/settings", async (req, res) => {
  try {
    const { event_name, coupon_code, photos_link } = req.body || {};
    const updated = await updateSettings({ event_name, coupon_code, photos_link });
    res.json(updated);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/admin/contacts", async (req, res) => {
  try {
    const { opt_in, q, campaign_id } = req.query;
    const params = [];
    let where = "1=1";

    if (opt_in === "true" || opt_in === "false") {
      params.push(opt_in === "true");
      where += ` and c.opt_in = $${params.length}`;
    }

    if (q) {
      params.push(`%${q}%`);
      where += ` and (c.name ilike $${params.length} or c.phone_e164 ilike $${params.length})`;
    }

    let query = `
      select c.*
      from contacts c
      where ${where}
      order by c.created_at desc
      limit 500
    `;

    if (campaign_id) {
      params.push(campaign_id);
      query = `
        select distinct c.*
        from contacts c
        join messages m on m.contact_id = c.id
        where ${where} and m.campaign_id = $${params.length}
        order by c.created_at desc
        limit 500
      `;
    }

    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete("/admin/contacts/:id", async (req, res) => {
  try {
    await pool.query(`delete from contacts where id = $1`, [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/admin/chats", async (req, res) => {
  try {
    const q = (req.query.q || "").toString().trim();
    const params = [];
    let where = "1=1";
    if (q) {
      params.push(`%${q}%`);
      where += ` and (c.name ilike $${params.length} or c.phone_e164 ilike $${params.length})`;
    }

    const result = await pool.query(
      `
      select
        c.id,
        c.name,
        c.phone_e164,
        c.opt_in,
        c.first_inbound_at,
        c.last_inbound_at,
        c.created_at,
        cm.body as last_message,
        cm.created_at as last_message_at,
        cm.direction as last_direction
      from contacts c
      left join lateral (
        select body, created_at, direction
        from chat_messages
        where contact_id = c.id
        order by created_at desc
        limit 1
      ) cm on true
      where ${where}
      order by cm.created_at desc nulls last, c.created_at desc
      limit 500
      `,
      params
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/admin/chats/:contact_id", async (req, res) => {
  try {
    const contact = await pool.query(
      `select id, name, phone_e164, first_inbound_at, last_inbound_at from contacts where id = $1`,
      [req.params.contact_id]
    );
    const result = await pool.query(
      `
      select id, direction, body, wa_message_id, created_at
      from chat_messages
      where contact_id = $1
      order by created_at asc
      limit 500
      `,
      [req.params.contact_id]
    );
    res.json({ contact: contact.rows[0] || null, messages: result.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/admin/chats/:contact_id/send", async (req, res) => {
  try {
    const { text } = req.body || {};
    if (!text || !text.trim()) return res.status(400).json({ error: "texto obrigatório" });

    const contactRes = await pool.query(`select phone_e164 from contacts where id = $1`, [req.params.contact_id]);
    const phone = contactRes.rows[0]?.phone_e164;
    if (!phone) return res.status(404).json({ error: "contato não encontrado" });

    const wa = await sendTextMessage({ to: phone, text: text.trim() });
    await logChatMessage({
      contact_id: req.params.contact_id,
      direction: "out",
      body: text.trim(),
      wa_message_id: wa?.messages?.[0]?.id || null,
    });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.response?.data || err.message });
  }
});

app.post("/admin/send-link", async (_, res) => {
  try {
    const settings = await getSettings();
    if (!settings?.photos_link) return res.status(400).json({ error: "photos_link não configurado" });
    if (!settings?.event_name) return res.status(400).json({ error: "event_name não configurado" });

    const contacts = await pool.query(`select * from contacts where opt_in = true`);
    for (const c of contacts.rows) {
      const params = [c.name, settings.event_name, settings.photos_link];
      await pool.query(
        `
        insert into messages (contact_id, campaign_id, template_name, template_lang, params, status)
        values ($1, null, $2, $3, $4, 'queued')
        `,
        [c.id, "link_fotos", "pt_BR", JSON.stringify(params)]
      );
    }

    res.json({ ok: true, queued: contacts.rowCount });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/admin/reset", async (_, res) => {
  try {
    await pool.query("delete from messages");
    await pool.query("delete from contacts");
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 1) Captura lead: salva + manda boas-vindas
app.post("/leads", async (req, res) => {
  try {
    const { name, phone, source } = req.body;
    if (!name || !phone) {
      return res.status(400).json({ error: "name e phone são obrigatórios" });
    }

    const phone_e164 = normalizePhoneBR(phone);
    const settings = await getSettings();
    const eventName = settings?.event_name || "evento";

    // salva/atualiza contato
    const upsert = await pool.query(
      `
      insert into contacts (name, phone_e164, opt_in, opt_in_at, coupon_status, source)
      values ($1, $2, true, now(), 'pending', $3)
      on conflict (phone_e164)
      do update set name = excluded.name, opt_in = true, opt_in_at = now(), coupon_status = 'pending', source = excluded.source
      returning *
      `,
      [name, phone_e164, source || "pagina-captura"]
    );

    const contact = upsert.rows[0];

    // Não inicia conversa aqui (fluxo novo). Apenas salva.
    res.json({ ok: true, contact });
  } catch (err) {
    console.error(err.response?.data || err.message);
    res.status(500).json({ error: "erro ao salvar/enviar", details: err.response?.data || err.message });
  }
});

// 2) Criar campanha
app.post("/campaigns", async (req, res) => {
  const { name, template_name, template_lang } = req.body;
  if (!name || !template_name) return res.status(400).json({ error: "name e template_name são obrigatórios" });

  const result = await pool.query(
    `insert into campaigns (name, template_name, template_lang) values ($1, $2, $3) returning *`,
    [name, template_name, template_lang || "pt_BR"]
  );
  res.json(result.rows[0]);
});

// 3) Disparar campanha para todos opt-in (MVP)
app.post("/campaigns/:id/send", async (req, res) => {
  try {
    const campaignId = req.params.id;

    const camp = await pool.query(`select * from campaigns where id = $1`, [campaignId]);
    if (camp.rowCount === 0) return res.status(404).json({ error: "campanha não encontrada" });
    const campaign = camp.rows[0];

    const contacts = await pool.query(`select * from contacts where opt_in = true`);

    for (const c of contacts.rows) {
      const params = [c.name, "https://seu-link-aqui.com"];
      await pool.query(
        `
        insert into messages (contact_id, campaign_id, template_name, template_lang, params, status)
        values ($1, $2, $3, $4, $5, 'queued')
        `,
        [c.id, campaign.id, campaign.template_name, campaign.template_lang, JSON.stringify(params)]
      );
    }

    res.json({ ok: true, total: contacts.rowCount, queued: contacts.rowCount });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 4) Webhook verification (GET)
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === process.env.WEBHOOK_VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

// 5) Webhook receiver (POST)
app.post("/webhook", async (req, res) => {
  try {
    console.log("Webhook recebido:", JSON.stringify(req.body));
    const entry = req.body.entry?.[0];
    const changes = entry?.changes?.[0]?.value;

    const messages = changes?.messages;
    if (messages && messages.length) {
      const msg = messages[0];
      const from = msg.from; // número do usuário em formato e164 sem "+"
      const text = msg.text?.body?.trim()?.toLowerCase();
      const buttonTitle = msg.interactive?.button_reply?.title?.trim()?.toLowerCase();
      const isYes = buttonTitle && buttonTitle.startsWith("sim");
      const isYesText = text === "sim" || text === "s" || text === "ok";

      if (text && ["sair", "parar", "cancelar", "stop"].includes(text)) {
        const candidates = buildPhoneCandidatesBR(from);
        await pool.query(`update contacts set opt_in = false where phone_e164 = any($1)`, [candidates]);
        return res.sendStatus(200);
      }

      if (isYes || isYesText) {
        const candidates = buildPhoneCandidatesBR(from);
        const settings = await getSettings();
        const result = await pool.query(
          `update contacts set coupon_status = 'accepted' where phone_e164 = any($1) returning name, phone_e164, id`,
          [candidates]
        );
        const contactName = result.rows[0]?.name || changes?.contacts?.[0]?.profile?.name || "cliente";
        const contactId = result.rows[0]?.id;
        if (settings?.coupon_code) {
          const textMsg = `Perfeito, ${contactName}! Seu cupom é: ${settings.coupon_code}. Quando as fotos estiverem disponíveis, enviaremos o link por aqui.`;
          const wa = await sendTextMessage({
            to: result.rows[0]?.phone_e164 || from,
            text: textMsg,
          });
          await logChatMessage({
            contact_id: contactId,
            direction: "out",
            body: textMsg,
            wa_message_id: wa?.messages?.[0]?.id || null,
          });
        }
        return res.sendStatus(200);
      }

      // Primeira mensagem do cliente: salva/atualiza contato e responde perguntando do cupom
      const settings = await getSettings();
      const eventName = settings?.event_name || "evento";
      const upsert = await pool.query(
        `
        insert into contacts (name, phone_e164, opt_in, opt_in_at, coupon_status, source)
        values ($1, $2, true, now(), 'pending', $3)
        on conflict (phone_e164)
        do update set opt_in = true, opt_in_at = now(), coupon_status = 'pending'
        returning id, first_inbound_at, last_inbound_at
        `,
        [changes?.contacts?.[0]?.profile?.name || "cliente", from, "whatsapp"]
      );
      const contactId = upsert.rows[0]?.id;
      await pool.query(
        `
        update contacts
        set
          first_inbound_at = coalesce(first_inbound_at, now()),
          last_inbound_at = now()
        where id = $1
        `,
        [contactId]
      );
      await logChatMessage({
        contact_id: contactId,
        direction: "in",
        body: msg.text?.body || "[mensagem]",
        wa_message_id: msg.id,
      });
      await sendTextMessage({
        to: from,
        text: `Oi! Vi que você se interessou nas fotos da ${eventName}. Quer receber seu cupom? Responda SIM.`,
      });
      await logChatMessage({
        contact_id: contactId,
        direction: "out",
        body: `Oi! Vi que você se interessou nas fotos da ${eventName}. Quer receber seu cupom? Responda SIM.`,
      });
    }

    res.sendStatus(200);
  } catch (err) {
    console.error(err.message);
    res.sendStatus(200);
  }
});

app.get("/", (_, res) => res.send("API WhatsApp ok"));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`rodando em http://localhost:${PORT}`);
  if (process.env.RUN_WORKER_IN_API === "true") {
    setInterval(queuePollLoop, QUEUE_POLL_INTERVAL_MS);
    console.log("queue worker ativo dentro da API");
  }
});
