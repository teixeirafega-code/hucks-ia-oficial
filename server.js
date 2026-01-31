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

if (!process.env.OPENAI_API_KEY) {
  console.error("❌ OPENAI_API_KEY não encontrada no .env");
}

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

/* ================= MERCADOPAGO ================= */

const mpClient = new MercadoPagoConfig({
  accessToken: process.env.MP_ACCESS_TOKEN,
});

/* ================= ROTAS ================= */

/* ---------- CONFIG FIREBASE FRONT ---------- */
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

/* ---------- ANÚNCIO (FREE + AUTH) ---------- */
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

      const userRef = db.collection("usuarios").doc(uid);
      const doc = await userRef.get();
      creditos = doc.exists ? doc.data().creditos || 0 : 0;
    } catch {
      uid = null;
      creditos = 0;
    }
  }

  // Free tier: só diagnóstico
  const prompt =
    uid && creditos > 0
      ? `Produto: ${produto}`
      : `Produto: ${produto}\nResponda SOMENTE a parte 1 (diagnóstico).`;

  try {
    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content:
            "Você é um especialista em marketing. Responda em 3 partes separadas por ||| : 1. Diagnóstico de risco, 2. Copy base, 3. Sugestão de imagem.",
        },
        { role: "user", content: prompt },
      ],
    });

    const resposta = completion.choices[0].message.content;

    // Debita crédito só se logado e tiver crédito
    if (uid && creditos > 0) {
      await db
        .collection("usuarios")
        .doc(uid)
        .set({ creditos: creditos - 1 }, { merge: true });
      creditos -= 1;
    }

    res.json({
      resultado: resposta,
      creditosRestantes: creditos,
    });
  } catch (err) {
    console.error("❌ Erro IA:", err.message);
    res.status(500).json({ erro: "Erro ao gerar conteúdo da IA" });
  }
});

/* ---------- PAGAMENTO ---------- */
app.post("/api/pagamento", async (req, res) => {
  const authHeader = req.headers.authorization;
  if (!authHeader) {
    return res.status(401).json({ erro: "Não autenticado" });
  }

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
      back_urls: {
        success: "https://therux.netlify.app",
        failure: "https://therux.netlify.app",
        pending: "https://therux.netlify.app",
      },
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
