import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import OpenAI from "openai";
import admin from "firebase-admin";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { MercadoPagoConfig, Preference } from 'mercadopago';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors({ origin: "*" }));
app.use(express.json());
app.use(express.static(__dirname)); 

// --- FIREBASE ---
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
            credential: admin.credential.cert(serviceAccount)
        });
        console.log("🚀 Firebase Admin conectado!");
    }
} catch (error) {
    console.error("❌ Erro Firebase:", error.message);
}

const db = admin.firestore();
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// --- MERCADOPAGO (CONFIGURAÇÃO NOVA V2) ---
const client = new MercadoPagoConfig({ 
    accessToken: process.env.MP_ACCESS_TOKEN 
});

// Middleware de autenticação
const autenticar = async (req, res, next) => {
    const authHeader = req.headers.authorization;
    if (!authHeader) return res.status(401).json({ erro: "Não autorizado" });
    const token = authHeader.split(" ")[1];
    try {
        const decodedToken = await admin.auth().verifyIdToken(token);
        req.uid = decodedToken.uid;
        next();
    } catch (err) {
        res.status(401).json({ erro: "Token inválido" });
    }
};

// --- ROTAS ---
app.get("/api/config", (req, res) => {
    res.json({
        apiKey: process.env.FIREBASE_API_KEY,
        authDomain: process.env.FIREBASE_AUTH_DOMAIN,
        projectId: process.env.FIREBASE_PROJECT_ID,
        storageBucket: process.env.FIREBASE_STORAGE_BUCKET,
        messagingSenderId: process.env.FIREBASE_MESSAGING_SENDER_ID,
        appId: process.env.FIREBASE_APP_ID
    });
});

app.post("/api/anuncio", autenticar, async (req, res) => {
    const { produto } = req.body;
    try {
        const userRef = db.collection("usuarios").doc(req.uid);
        const doc = await userRef.get();
        let creditos = doc.exists ? doc.data().creditos : 1;

        if (produto === "") return res.json({ creditosRestantes: creditos });
        if (creditos <= 0) return res.status(403).json({ erro: "Créditos esgotados" });

        const completion = await openai.chat.completions.create({
            model: "gpt-3.5-turbo",
            messages: [{ 
                role: "system", 
                content: "Especialista em marketing. Responda em 3 partes com |||: 1. Diagnóstico, 2. Amostra, 3. Imagem." 
            }, { role: "user", content: `Produto: ${produto}` }],
        });

        await userRef.set({ creditos: creditos - 1 }, { merge: true });
        res.json({ resultado: completion.choices[0].message.content, creditosRestantes: creditos - 1 });
    } catch (err) {
        res.status(500).json({ erro: "Erro na IA" });
    }
});

// --- ROTA PAGAMENTO CORRIGIDA ---
app.post("/api/pagamento", autenticar, async (req, res) => {
    try {
        const preference = new Preference(client);
        
        const body = {
            items: [
                {
                    id: 'pack-10',
                    title: "Pack 10 Créditos Hucks IA",
                    quantity: 1,
                    unit_price: 7.99,
                    currency_id: "BRL"
                }
            ],
            metadata: { uid: req.uid },
            back_urls: {
                success: "https://therux.netlify.app",
                failure: "https://therux.netlify.app",
                pending: "https://therux.netlify.app"
            },
            auto_return: "approved",
        };

        const response = await preference.create({ body });
        res.json({ checkout_url: response.init_point });

    } catch (err) {
        console.error("Erro MP:", err);
        res.status(500).json({ erro: "Erro ao criar preferência de pagamento" });
    }
});

app.listen(PORT, () => console.log(`🚀 Servidor rodando na porta ${PORT}`));