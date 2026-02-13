require("dotenv").config();
const axios = require("axios");
const { Pool } = require("pg");
const { Worker } = require("bullmq");

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
      components: [
        {
          type: "body",
          parameters: params.map((text) => ({ type: "text", text })),
        },
      ],
    },
  };

  const res = await axios.post(url, payload, {
    headers: {
      Authorization: `Bearer ${process.env.WA_TOKEN}`,
      "Content-Type": "application/json",
    },
  });

  return res.data;
}

const worker = new Worker(
  "campaign-send",
  async (job) => {
    const {
      contact_id,
      phone_e164,
      campaign_id,
      template_name,
      template_lang,
      params,
    } = job.data;

    const wa = await sendTemplateMessage({
      to: phone_e164,
      templateName: template_name,
      lang: template_lang,
      params,
    });

    await pool.query(
      `insert into messages (contact_id, campaign_id, status, wa_message_id, sent_at)
       values ($1,$2,$3,$4,now())`,
      [contact_id, campaign_id, "sent", wa.messages?.[0]?.id || null]
    );

    return { wa_message_id: wa.messages?.[0]?.id || null };
  },
  {
    connection: { url: process.env.REDIS_URL },
    limiter: {
      max: 1,
      duration: 1000,
    },
  }
);

worker.on("failed", async (job, err) => {
  try {
    if (!job) return;
    const { contact_id, campaign_id } = job.data || {};
    await pool.query(
      `insert into messages (contact_id, campaign_id, status, error)
       values ($1,$2,$3,$4)`,
      [contact_id || null, campaign_id || null, "failed", JSON.stringify(err.message || err)]
    );
  } catch (_) {
    // avoid crashing on logging failures
  }
});

console.log("worker online");
