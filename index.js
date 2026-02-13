require("dotenv").config();
const express = require("express");
const axios = require("axios");
const { Pool } = require("pg");
const { Queue } = require("bullmq");

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static("public"));

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const queue = new Queue("campaign-send", {
  connection: { url: process.env.REDIS_URL },
});

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

// 1) Captura lead: salva + manda boas-vindas
app.post("/leads", async (req, res) => {
  try {
    const { name, phone, source } = req.body;
    if (!name || !phone) {
      return res.status(400).json({ error: "name e phone são obrigatórios" });
    }

    const phone_e164 = normalizePhoneBR(phone);

    // salva/atualiza contato
    const upsert = await pool.query(
      `
      insert into contacts (name, phone_e164, opt_in, opt_in_at, source)
      values ($1, $2, true, now(), $3)
      on conflict (phone_e164)
      do update set name = excluded.name, opt_in = true, opt_in_at = now(), source = excluded.source
      returning *
      `,
      [name, phone_e164, source || "pagina-captura"]
    );

    const contact = upsert.rows[0];

    // manda template boas_vindas (precisa existir e estar aprovado)
    const wa = await sendTemplateMessage({
      to: contact.phone_e164,
      templateName: "boas_vindas",
      params: [contact.name, contact.source || "cadastro"],
    });

    // registra mensagem
    await pool.query(
      `
      insert into messages (contact_id, status, wa_message_id, sent_at)
      values ($1, $2, $3, now())
      `,
      [contact.id, "sent", wa.messages?.[0]?.id || null]
    );

    res.json({ ok: true, contact, wa });
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
    const jobs = [];

    for (const c of contacts.rows) {
      const params = [c.name, c.source || "campanha", "https://seu-link-aqui.com"];
      const job = await queue.add("send", {
        contact_id: c.id,
        phone_e164: c.phone_e164,
        campaign_id: campaign.id,
        template_name: campaign.template_name,
        template_lang: campaign.template_lang,
        params,
      });
      jobs.push(job.id);
    }

    res.json({ ok: true, total: contacts.rowCount, queued: jobs.length });
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

      if (text && ["sair", "parar", "cancelar", "stop"].includes(text)) {
        const candidates = buildPhoneCandidatesBR(from);
        await pool.query(`update contacts set opt_in = false where phone_e164 = any($1)`, [candidates]);
      }
    }

    res.sendStatus(200);
  } catch (err) {
    console.error(err.message);
    res.sendStatus(200);
  }
});

app.get("/", (_, res) => res.send("API WhatsApp ok"));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`rodando em http://localhost:${PORT}`));
