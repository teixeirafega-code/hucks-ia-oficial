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
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

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

/* ---------- CRÉDITOS (dá 1 inicial se novo) ---------- */
app.get("/api/creditos", async (req, res) => {
  const authHeader = req.headers.authorization;
  if (!authHeader) return res.json({ creditos: 0 });

  try {
    const token = authHeader.split(" ")[1];
    const decoded = await admin.auth().verifyIdToken(token);
    const uid = decoded.uid;

    const userRef = db.collection("usuarios").doc(uid);
    const snap = await userRef.get();

    if (!snap.exists) {
      await userRef.set({ creditos: 1, usouGratis: false });
      return res.json({ creditos: 1 });
    }

    res.json({
      creditos: snap.data().creditos || 0,
    });
  } catch (err) {
    console.error("Erro ao buscar créditos:", err.message);
    res.json({ creditos: 0 });
  }
});

/* ---------- ANÚNCIO (DIAGNÓSTICO + FUNIL) ---------- */
app.post("/api/anuncio", async (req, res) => {
  const { produto } = req.body;
  if (!produto) {
    return res.status(400).json({ erro: "Produto não informado" });
  }

  let uid = null;
  let creditos = 0;
  let acessoCompleto = false;

  const authHeader = req.headers.authorization;
  if (authHeader) {
    try {
      const token = authHeader.split(" ")[1];
      const decoded = await admin.auth().verifyIdToken(token);
      uid = decoded.uid;

      const userDoc = await db.collection("usuarios").doc(uid).get();
      if (userDoc.exists) {
        creditos = userDoc.data().creditos || 0;
        acessoCompleto = creditos > 0;
      }
    } catch (err) {
      console.error("Erro auth:", err.message);
    }
  }

  const prompt = `
Produto: ${produto}

Você é um especialista em anúncios pagos (Meta Ads / Google Ads) para microempreendedores brasileiros.

Analise o risco do produto para anúncios pagos e explique de forma clara e detalhada.

Responda APENAS com JSON válido, sem texto extra, sem markdown:

{
  "risco": "ALTO" | "MÉDIO" | "BAIXO",
  "causa": "Explique detalhadamente o porquê desse nível de risco, incluindo o erro comum que 90% cometem ao anunciar esse tipo de produto, exemplos reais e razões específicas baseadas no produto",
  "consequencia": "Explique o impacto real em detalhes, incluindo perda de verba em R$, cliques errados, conversão baixa, exemplos numéricos estimados e como isso afeta o negócio do microempreendedor",
  "publico": ${acessoCompleto ? `"Público-alvo específico (idade, gênero, dores principais, comportamentos)"` : `null`},
  "angulo": ${acessoCompleto ? `"Ângulo emocional forte que conecta com a dor ou desejo do público"` : `null`},
  "imagem": ${acessoCompleto ? `"Descrição clara e detalhada da imagem ideal para o anúncio (estilo, composição, cores, elementos)"` : `null`},
  "copy_base": ${acessoCompleto ? `"Copy curta (3-6 linhas), persuasiva, tom brasileiro natural (pessoa pra pessoa), com emojis estratégicos e CTA forte"` : `"Versão básica grátis focada em clareza simples"`},
  "ctas": ${acessoCompleto ? `["CTA para topo de funil (awareness)", "CTA para meio de funil (consideração)", "CTA para fundo de funil (conversão)"]` : `null`}
}
`;

  try {
    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: "Responda SOMENTE JSON válido, sem texto extra, sem markdown, sem ```." },
        { role: "user", content: prompt },
      ],
      temperature: 0.7,
    });

    let raw = completion.choices[0].message.content.trim();
    raw = raw.replace(/```json\s*/g, '').replace(/```/g, '').trim();
    const data = JSON.parse(raw);

    if (acessoCompleto && uid) {
      await db.collection("usuarios").doc(uid).update({
        creditos: admin.firestore.FieldValue.increment(-1)
      });
      creditos -= 1;
    }

    res.json({
      resultado: {
        risco: data.risco,
        causa: data.causa,
        consequencia: data.consequencia,
        publico: data.publico,
        angulo: data.angulo,
        imagem: data.imagem,
        copy_base: data.copy_base,
        ctas: data.ctas
      },
      creditosRestantes: creditos,
      acessoCompleto
    });
  } catch (err) {
    console.error("❌ Erro IA completo:", err.message);
    res.status(500).json({ erro: "Erro ao gerar diagnóstico", detalhes: err.message });
  }
});

/* ---------- PAGAMENTO (Preference) ---------- */
app.post("/api/pagamento", async (req, res) => {
  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).json({ erro: "Não autenticado" });

  try {
    const token = authHeader.split(" ")[1];
    const decoded = await admin.auth().verifyIdToken(token);
    const uid = decoded.uid;

    const preference = new Preference(mpClient);

    const response = await preference.create({
      body: {
        items: [
          {
            id: "pack-10",
            title: "Pack 10 Créditos Huncks IA",
            quantity: 1,
            unit_price: 7.99,
            currency_id: "BRL",
          },
        ],
        metadata: { uid },
        back_urls: {
          success: "https://therux-backend.onrender.com/success",
          failure: "https://therux-backend.onrender.com/failure",
          pending: "https://therux-backend.onrender.com/pending"
        }
      },
    });

    console.log("Success! Preference ID:", response.id);
    console.log("Checkout URL:", response.init_point);

    res.json({ checkout_url: response.init_point });
  } catch (err) {
    console.error("❌ Erro MP:", err.message);
    console.error("Stack:", err.stack || "sem stack");
    res.status(500).json({ erro: "Erro no pagamento", detalhes: err.message });
  }
});

/* ================= START ================= */
app.listen(PORT, () => {
  console.log(`🔥 Backend rodando em http://localhost:${PORT}`);
});
