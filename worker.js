require("dotenv").config();
const axios = require("axios");
const { Pool } = require("pg");

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

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

const BATCH_SIZE = Number(process.env.QUEUE_BATCH_SIZE || 20);
const MAX_ATTEMPTS = Number(process.env.QUEUE_MAX_ATTEMPTS || 3);
const INTERVAL_MS = Number(process.env.QUEUE_POLL_INTERVAL_MS || 1000);

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

async function processMessage(msg) {
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

async function handleFailure(msg, err) {
  const attempts = Number(msg.attempt_count || 0) + 1;
  const errorText = JSON.stringify(err?.response?.data || err?.message || err);

  if (attempts >= MAX_ATTEMPTS) {
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

async function pollLoop() {
  try {
    const batch = await fetchQueuedBatch(BATCH_SIZE);
    for (const msg of batch) {
      try {
        await processMessage(msg);
        // rate limit: 1 msg/seg
        await new Promise((r) => setTimeout(r, 1000));
      } catch (err) {
        await handleFailure(msg, err);
      }
    }
  } catch (err) {
    console.error("worker error:", err.message || err);
  }
}

setInterval(pollLoop, INTERVAL_MS);
console.log("worker online (postgres queue)");
