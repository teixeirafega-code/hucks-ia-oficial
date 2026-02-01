import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import OpenAI from "openai";
import admin from "firebase-admin";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { MercadoPagoConfig, Preference } from "mercadopago";

dotenv.config();

/* ================= SETUP ================= */

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors({ origin: "*" }));
app.use(express.json());
app.use(express.static(__dirname));

/* ================= FIREBASE ADMIN ================= */

let serviceAccount;
const firebaseKeyPath = path.join(__dirname, "firebase-key.json");

try {
  if (process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON) {
    serviceAccount = JSON.parse(process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON);
  } else if (fs.existsSync(firebaseKeyPath)) {
    serviceAccount = JSON.parse(fs.readFileSync(firebaseKeyPath, "utf8"));
  }

  if (serviceAccount && !admin.apps.length) {
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
    });
    console.log("🔥 Firebase Admin conectado");
  }
} catch (err) {
  console.error("❌ Erro Firebase:", err.message);
}

const db = admin.firestore();

/* ================= OPENAI ================= */

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

/* ================= MERCADOPAGO ================= */

const mpClient = new MercadoPagoConfig({
  accessToken: process.env.MP_ACCESS_TOKEN,
});

/* ================= ROTAS ================= */

/* ---------- CONFIG FIREBASE ---------- */
app.get("/api/config", (req, res) => {
  res.json({
    apiKey: process.env.FIREBASE_API_KEY,
    authDomain: process.env.FIREBASE_AUTH_DOMAIN,
    projectId: process.env.FIREBASE_PROJECT_ID,
    storageBucket: process.env.FIREBASE_STORAGE_BUCKET,
    messagingSenderId: process.env.FIREBASE_MESSAGING_SENDER_ID,
    appId: process.env.FIREBASE_APP_ID,
  });
});

/* ---------- ANÚNCIO ---------- */
app.post("/api/anuncio", async (req, res) => {
  const { produto } = req.body;
  if (!produto) {
    return res.status(400).json({ erro: "Produto não informado" });
  }

  let uid = null;
  let creditos = 0;

  const authHeader = req.headers.authorization;
  if (authHeader) {
    try {
      const token = authHeader.split(" ")[1];
      const decoded = await admin.auth().verifyIdToken(token);
      uid = decoded.uid;

      const userDoc = await db.collection("usuarios").doc(uid).get();
      creditos = userDoc.exists ? userDoc.data().creditos || 0 : 0;
    } catch {
      uid = null;
      creditos = 0;
    }
  }

  const acessoCompleto = uid && creditos > 0;

  const prompt = `
Produto: ${produto}

Você é um especialista em anúncios pagos para microempreendedores.

Responda APENAS em JSON válido, no formato:

{
  "risco": "ALTO | MÉDIO | BAIXO",
  "porque": "Explique claramente por que esse produto corre esse risco ao anunciar.",
  "impacto": "Explique o impacto real disso em dinheiro, cliques errados ou falta de conversão.",
  "copy": ${acessoCompleto ? `"Gere uma copy curta, persuasiva e direta sobre esse produto."` : `null`}
}

Regras:
- Seja específico
- Nada genérico
- Linguagem simples e direta
`;

  try {
    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content:
            "Você age como um estrategista de tráfego pago focado em reduzir desperdício.",
        },
        { role: "user", content: prompt },
      ],
    });

    const raw = completion.choices[0].message.content;
    const data = JSON.parse(raw);

    if (acessoCompleto) {
      await db
        .collection("usuarios")
        .doc(uid)
        .set({ creditos: creditos - 1 }, { merge: true });
      creditos -= 1;
    }

  res.json({
  resultado: {
    risco: data.risco,
    causa: data.porque,
    consequencia: data.impacto,
    copy_base: data.copy || null,
  },
  creditosRestantes: creditos,
});

  } catch (err) {
    console.error("❌ Erro IA:", err.message);
    res.status(500).json({ erro: "Erro ao gerar diagnóstico" });
  }
});

/* ---------- PAGAMENTO ---------- */
app.post("/api/pagamento", async (req, res) => {
  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).json({ erro: "Não autenticado" });

  try {
    const token = authHeader.split(" ")[1];
    const decoded = await admin.auth().verifyIdToken(token);
    const uid = decoded.uid;

    const preference = new Preference(mpClient);

    const body = {
      items: [
        {
          id: "pack-10",
          title: "Pack 10 Créditos Hucks IA",
          quantity: 1,
          unit_price: 7.99,
          currency_id: "BRL",
        },
      ],
      metadata: { uid },
      auto_return: "approved",
    };

    const response = await preference.create({ body });
    res.json({ checkout_url: response.init_point });
  } catch (err) {
    console.error("❌ Erro MP:", err.message);
    res.status(500).json({ erro: "Erro no pagamento" });
  }
});

/* ================= START ================= */

app.listen(PORT, () => {
  console.log(`🔥 Backend rodando em http://localhost:${PORT}`);
});
