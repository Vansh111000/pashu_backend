import 'dotenv/config';
import express from 'express';
import nodemailer from 'nodemailer';
import fetch from 'node-fetch';
import multer from 'multer';
import sharp from 'sharp';
import cors from 'cors';
import { createClient } from '@supabase/supabase-js';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;
const SUPABASE_URL = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const SUPABASE_CHAT_IMAGES_BUCKET = process.env.SUPABASE_CHAT_IMAGES_BUCKET || 'chat-images';
const supabaseAdmin = SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY
  ? createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } })
  : null;
let bucketEnsured = false;
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
});

// Mail Transporter for OTP
const mailTransporter = process.env.MAIL_SERVICE_ADDRESS ? nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.MAIL_SERVICE_ADDRESS,
    pass: process.env.MAIL_SERVICE_PASS
  }
}) : null;

const signupOtps = new Map(); // Store OTPs in memory: email -> { otp, expiresAt, password, fullName }

// Allowed domains for CORS
const allowedOrigins = [
  "http://localhost:8080",
  "http://localhost:5173", 
  "https://pashugreenai.netlify.app", // production
    "https://pashu.ai",
  "https://www.pashu.ai",
];

app.use(
  cors({
    origin: function (origin, callback) {
      if (!origin || allowedOrigins.includes(origin)) {
        callback(null, true);
      } else {
        callback(new Error("Not allowed by CORS"));
      }
    },
    credentials: true,
  })
);

app.use(express.json({ limit: '12mb' }));
app.use(express.static(path.join(__dirname, 'dist')));

const REQUIRED_DIAGNOSIS_KEYS = [
  'subject',
  'identified_as',
  'disease',
  'confidence',
  'severity',
  'affected_part',
  'symptoms',
  'solution_steps',
  'medicine',
  'repeat_in_days',
  'see_expert_if',
  'reasoning',
  'farm_size',
  'farm_location',
  'status',
  'predicted_subject',
];

const VISION_PROMPT = `Analysis Task: You are Kisan Mitra, an expert Agriculture & Livestock AI.
Analyze this image of a crop, plant, or livestock.

Context provided (if any): {FARM_CONTEXT}

Instructions:
1. Identify the subject: Detect if it's a Crop/Plant or an Animal/Livestock.
2. IMMEDIATE DIAGNOSIS: Provide a full diagnosis immediately based on the image visual details. DO NOT use confirmation flows for images.
3. 'predicted_subject' should be a short name (e.g., "Tomato plant", "Holstein Cow").

Return ONLY a valid JSON object:
{
  "status": "ready",
  "predicted_subject": "short name",
  "subject": "crop" | "animal",
  "identified_as": "Common name",
  "disease": "Disease name or null",
  "confidence": 0.0 to 1.0,
  "severity": "Healthy" | "Low" | "Medium" | "High" | "Critical",
  "affected_part": "Stem/Leaves/Eyes etc",
  "symptoms": ["..."],
  "solution_steps": ["..."],
  "medicine": "name or null",
  "repeat_in_days": number or null,
  "see_expert_if": "Condition to see expert",
  "reasoning": "Short explanation",
  "farm_size": "{FARM_SIZE}",
  "farm_location": "{FARM_LOCATION}"
}`;

function parseVisionResponse(rawText) {
  const clean = String(rawText || '')
    .replace(/```json/gi, '')
    .replace(/```/g, '')
    .trim();

  const firstBrace = clean.indexOf('{');
  const lastBrace = clean.lastIndexOf('}');
  const jsonCandidate =
    firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace
      ? clean.slice(firstBrace, lastBrace + 1)
      : clean;

  try {
    const data = JSON.parse(jsonCandidate);
    for (const key of REQUIRED_DIAGNOSIS_KEYS) {
      if (!(key in data)) data[key] = null;
    }

    if (typeof data.confidence !== 'number') data.confidence = Number(data.confidence || 0);
    data.confidence = Number.isFinite(data.confidence)
      ? Math.max(0, Math.min(1, data.confidence))
      : 0;

    const allowedSeverity = new Set(['Healthy', 'Low', 'Medium', 'High', 'Critical']);
    if (!allowedSeverity.has(data.severity)) data.severity = 'Medium';
    if (!Array.isArray(data.symptoms)) data.symptoms = data.symptoms ? [String(data.symptoms)] : [];
    if (!Array.isArray(data.solution_steps)) data.solution_steps = data.solution_steps ? [String(data.solution_steps)] : [];
    if (data.repeat_in_days !== null && data.repeat_in_days !== undefined) {
      const n = Number(data.repeat_in_days);
      data.repeat_in_days = Number.isFinite(n) ? n : null;
    } else {
      data.repeat_in_days = null;
    }

    return { ok: true, data };
  } catch {
    return { ok: false, error: 'diagnosis_failed', raw: rawText };
  }
}

async function ensureChatImagesBucket() {
  if (!supabaseAdmin || bucketEnsured) return;

  const { data: buckets, error: listError } = await supabaseAdmin.storage.listBuckets();
  if (listError) {
    throw new Error(`bucket_list_failed: ${listError.message || 'unknown'}`);
  }

  const exists = Array.isArray(buckets)
    ? buckets.some((b) => b.name === SUPABASE_CHAT_IMAGES_BUCKET || b.id === SUPABASE_CHAT_IMAGES_BUCKET)
    : false;

  if (!exists) {
    const { error: createError } = await supabaseAdmin.storage.createBucket(SUPABASE_CHAT_IMAGES_BUCKET, {
      public: false,
      fileSizeLimit: '10MB',
      allowedMimeTypes: ['image/jpeg', 'image/png'],
    });
    if (createError) {
      throw new Error(`bucket_create_failed: ${createError.message || 'unknown'}`);
    }
    console.log(`Created private storage bucket: ${SUPABASE_CHAT_IMAGES_BUCKET}`);
  }

  bucketEnsured = true;
}

app.use(express.static(path.join(__dirname, 'dist')));

// ─── Custom Email OTP Routes ──────────────────────────────────────
app.post('/api/send-signup-otp', async (req, res) => {
  try {
    const { email, password, fullName } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'missing_data' });

    if (!mailTransporter) {
      return res.status(500).json({ error: 'mail_service_not_configured' });
    }

    // Generate 6 digit OTP
    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    const expiresAt = Date.now() + 10 * 60 * 1000; // 10 minutes

    signupOtps.set(email.toLowerCase(), { otp, expiresAt, password, fullName });

    await mailTransporter.sendMail({
      from: `"PashuAI" <${process.env.MAIL_SERVICE_ADDRESS}>`,
      to: email,
      subject: "Your PashuAI Verification Code",
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #e0e0e0; border-radius: 10px;">
          <h2 style="color: #2e7d32; text-align: center;">Welcome to PashuAI!</h2>
          <p style="font-size: 16px; color: #333;">Hello ${fullName || 'Farmer'},</p>
          <p style="font-size: 16px; color: #333;">Thank you for signing up for PashuAI. To complete your registration, please use the verification code below:</p>
          <div style="text-align: center; margin: 30px 0;">
            <span style="font-size: 32px; font-weight: bold; background-color: #f1f8e9; padding: 10px 20px; border-radius: 8px; color: #2e7d32; letter-spacing: 5px;">${otp}</span>
          </div>
          <p style="font-size: 14px; color: #666;">This code is valid for 10 minutes. If you did not request this code, you can safely ignore this email.</p>
          <hr style="border: 0; border-top: 1px solid #e0e0e0; margin: 20px 0;">
          <p style="font-size: 12px; color: #999; text-align: center;">&copy; ${new Date().getFullYear()} PashuAI. All rights reserved.</p>
        </div>
      `
    });

    res.json({ success: true, message: 'OTP sent to email' });
  } catch (error) {
    console.error('Failed to send OTP email:', error);
    res.status(500).json({ error: 'failed_to_send_email' });
  }
});

app.post('/api/verify-signup-otp', async (req, res) => {
  try {
    const { email, otp } = req.body;
    if (!email || !otp) return res.status(400).json({ error: 'missing_data' });

    const targetEmail = email.toLowerCase();
    const record = signupOtps.get(targetEmail);

    if (!record) return res.status(400).json({ error: 'otp_not_found_or_expired' });
    
    if (Date.now() > record.expiresAt) {
      signupOtps.delete(targetEmail);
      return res.status(400).json({ error: 'otp_expired' });
    }

    if (record.otp !== otp) {
      return res.status(400).json({ error: 'invalid_otp' });
    }

    // OTP is valid. Create user securely via Supabase Admin API
    if (!supabaseAdmin) {
      return res.status(500).json({ error: 'supabase_admin_not_configured' });
    }

    const { data: userRecord, error: createError } = await supabaseAdmin.auth.admin.createUser({
      email: targetEmail,
      password: record.password,
      email_confirm: true,
      user_metadata: { full_name: record.fullName }
    });

    if (createError) throw createError;

    // Create profile
    if (userRecord.user) {
      const { error: profileError } = await supabaseAdmin.from('profiles').upsert({
        id: userRecord.user.id,
        full_name: (record.fullName || '').trim(),
        updated_at: new Date().toISOString(),
      });
      if (profileError) console.error("Failed to create profile:", profileError);
    }

    // Clear OTP after successful creation
    signupOtps.delete(targetEmail);
    
    res.json({ success: true, message: 'User created successfully' });
  } catch (error) {
    console.error('Error creating user via admin API:', error);
    res.status(500).json({ error: error.message || 'failed_to_create_user' });
  }
});

// ─── Weather Cache & Rate Limiting ───────────────────────────────
const weatherCache = {};
const CACHE_DURATION = 10 * 60 * 1000; // 10 minutes
let dailyCallCount = 0;
let lastResetDate = new Date().toDateString();
const DAILY_LIMIT = 900;

function checkAndResetDaily() {
  const today = new Date().toDateString();
  if (today !== lastResetDate) {
    console.log(`🔄 New day — resetting call count (was ${dailyCallCount})`);
    dailyCallCount = 0;
    lastResetDate = today;
  }
}

// ─── Current Weather Route ────────────────────────────────────────
app.get('/api/weather', async (req, res) => {
  const city = req.query.city || 'New Delhi';

  checkAndResetDaily();

  if (dailyCallCount >= DAILY_LIMIT) {
    console.warn('⚠️ Daily API limit reached!');
    if (weatherCache[city]) return res.json(weatherCache[city].data);
    return res.status(429).json({ error: 'Daily limit reached. Try again tomorrow.' });
  }

  if (weatherCache[city] && Date.now() - weatherCache[city].timestamp < CACHE_DURATION) {
    console.log(`📦 Serving cached weather for "${city}"`);
    return res.json(weatherCache[city].data);
  }

  const url = `https://api.openweathermap.org/data/2.5/weather?q=${encodeURIComponent(city)}&appid=${process.env.WEATHER_API_KEY}&units=metric`;

  try {
    const response = await fetch(url);
    const data = await response.json();

    if (data.cod !== 200) {
      return res.status(404).json({ error: data.message || 'City not found' });
    }

    weatherCache[city] = { data, timestamp: Date.now() };
    dailyCallCount++;
    console.log(`🌤️ Weather fetched for "${city}" | Calls today: ${dailyCallCount}/${DAILY_LIMIT}`);

    res.json(data);
  } catch (err) {
    console.error('Weather API error:', err);
    res.status(500).json({ error: 'Failed to fetch weather' });
  }
});

// ─── Forecast Route ───────────────────────────────────────────────
app.get('/api/forecast', async (req, res) => {
  const city = req.query.city || 'New Delhi';

  checkAndResetDaily();

  if (dailyCallCount >= DAILY_LIMIT) {
    console.warn('⚠️ Daily API limit reached!');
    return res.status(429).json({ error: 'Daily limit reached. Try again tomorrow.' });
  }

  const url = `https://api.openweathermap.org/data/2.5/forecast?q=${encodeURIComponent(city)}&appid=${process.env.WEATHER_API_KEY}&units=metric`;

  try {
    const response = await fetch(url);
    const data = await response.json();

    if (data.cod !== '200') {
      return res.status(404).json({ error: data.message || 'City not found' });
    }

    dailyCallCount++;
    console.log(`📅 Forecast fetched for "${city}" | Calls today: ${dailyCallCount}/${DAILY_LIMIT}`);

    res.json(data);
  } catch (err) {
    console.error('Forecast API error:', err);
    res.status(500).json({ error: 'Failed to fetch forecast' });
  }
});

// ─── Mandi Route ──────────────────────────────────────────────────
app.get('/api/mandi', async (req, res) => {
  const { limit = 50 } = req.query;
  const url = `https://api.data.gov.in/resource/${process.env.MANDI_RESOURCE_ID}?api-key=${process.env.MANDI_API_KEY}&format=json&limit=${limit}`;

  try {
    const response = await fetch(url);
    const data = await response.json();
    console.log(`🌾 Mandi records fetched: ${data.records?.length || 0}`);
    res.json(data);
  } catch (err) {
    console.error('Mandi API error:', err);
    res.status(500).json({ error: 'Failed to fetch mandi prices' });
  }
});

// ─── Image Diagnosis Route ───────────────────────────────────────
app.post('/chat/image', upload.single('image_file'), async (req, res) => {
  try {
    const file = req.file;
    const optionalNote = String(req.body?.optional_note || '').trim();
    if (!supabaseAdmin) {
      return res.status(500).json({ error: 'storage_not_configured' });
    }

    await ensureChatImagesBucket();

    const authHeader = String(req.headers.authorization || '');
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
    if (!token) {
      return res.status(401).json({ error: 'missing_auth_token' });
    }

    const { data: authData, error: authError } = await supabaseAdmin.auth.getUser(token);
    if (authError || !authData?.user?.id) {
      return res.status(401).json({ error: 'invalid_auth_token' });
    }

    const userId = authData.user.id;
    const conversationId = String(req.body?.conversation_id || 'temp').trim() || 'temp';

    if (!file) {
      return res.status(400).json({ error: 'missing_image_file' });
    }

    // Fetch Farm Context
    const { data: farm } = await supabaseAdmin.from('farms').select('farm_name, farm_size, location').eq('user_id', userId).single();
    const farmContextStr = farm
      ? `Farm Name: ${farm.farm_name}, Size: ${farm.farm_size}, Location: ${farm.location}`
      : "No farm profile context.";

    const allowedMimes = new Set(['image/jpeg', 'image/png']);
    if (!allowedMimes.has(file.mimetype)) {
      return res.status(400).json({ error: 'invalid_file_type', message: 'Only JPG/PNG are allowed.' });
    }

    // Multer already enforces 10MB, but keep explicit defensive check.
    if (file.size > 10 * 1024 * 1024) {
      return res.status(400).json({ error: 'file_too_large', message: 'Max allowed size is 10MB.' });
    }
    const { bucket, path: objectPath, buffer: resizedBuffer } = await uploadToBucket(file, userId, conversationId);

    const geminiKey = process.env.GEMINI_API_KEY;
    if (!geminiKey) {
      return res.status(500).json({ error: 'missing_gemini_api_key' });
    }

    const configuredModel = process.env.GEMINI_VISION_MODEL || 'gemini-2.5-flash';
    const fallbackModels = [configuredModel, 'gemini-3.1-flash-lite-preview', 'gemini-2.5-flash', 'gemini-2.5-flash-lite', 'gemini-2.5-pro'];
    const modelsToTry = [...new Set(fallbackModels.filter(Boolean))];

    const noteLine = optionalNote ? `\n\nFarmer note: ${optionalNote}` : '';
    const personalizedPrompt = VISION_PROMPT
      .replace('{FARM_CONTEXT}', farmContextStr)
      .replace('{FARM_SIZE}', farm?.farm_size || 'N/A')
      .replace('{FARM_LOCATION}', farm?.location || 'N/A');

    const requestBody = {
      contents: [
        {
          parts: [
            { text: `${personalizedPrompt}${noteLine}` },
            {
              inline_data: {
                mime_type: file.mimetype,
                data: resizedBuffer.toString('base64'),
              },
            },
          ],
        },
      ],
      generationConfig: {
        temperature: 0.1,
      },
    };

    let geminiData = null;
    let selectedModel = null;
    let lastFailure = null;

    for (const model of modelsToTry) {
      const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${geminiKey}`;
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(requestBody),
      });

      const data = await response.json().catch(() => ({}));
      if (response.ok) {
        geminiData = data;
        selectedModel = model;
        break;
      }

      lastFailure = {
        model,
        status: response.status,
        details: data,
      };

      console.error('Gemini vision call failed:', {
        model,
        status: response.status,
        error: data?.error?.message || data,
      });
    }

    if (!geminiData || !selectedModel) {
      return res.status(502).json({
        error: 'vision_api_failed',
        message: lastFailure?.details?.error?.message || 'Gemini returned a non-success response.',
        model_tried: modelsToTry,
        last_failure: lastFailure,
      });
    }

    const rawText =
      geminiData?.candidates?.[0]?.content?.parts
        ?.map((p) => p?.text)
        .filter(Boolean)
        .join('\n') || '';

    const parsed = parseVisionResponse(rawText);
    if (!parsed.ok) {
      return res.status(422).json(parsed);
    }

    // Returning immediate diagnosis
    return res.json({
      diagnosis: parsed.data,
      model_used: selectedModel,
      image_meta: {
        name: file.originalname,
        mime_type: file.mimetype,
        resized_bytes: resizedBuffer.length,
      },
      image_storage: {
        bucket: SUPABASE_CHAT_IMAGES_BUCKET,
        path: objectPath,
      },
    });
  } catch (err) {
    console.error('Image diagnosis error:', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});

// Helper for general image uploads
async function uploadToBucket(file, userId, conversationId) {
  const resizedBuffer = await sharp(file.buffer)
    .resize({ width: 800, height: 800, fit: 'inside', withoutEnlargement: true })
    .toBuffer();

  const safeName = String(file.originalname || 'image')
    .replace(/[^a-zA-Z0-9._-]/g, '_')
    .slice(-120);
  const objectPath = `${userId}/${conversationId}/${Date.now()}-${safeName}`;

  const { error: uploadError } = await supabaseAdmin.storage
    .from(SUPABASE_CHAT_IMAGES_BUCKET)
    .upload(objectPath, resizedBuffer, {
      contentType: file.mimetype || 'image/jpeg',
      upsert: false,
    });

  if (uploadError) throw uploadError;
  return { bucket: SUPABASE_CHAT_IMAGES_BUCKET, path: objectPath, buffer: resizedBuffer };
}

// ─── General Chat Image Upload Route ───────────────────────────
app.post('/api/upload-attachment', upload.single('file'), async (req, res) => {
  try {
    const file = req.file;
    const conversationId = req.body.conversation_id || 'temp';
    if (!file || !supabaseAdmin) return res.status(400).json({ error: 'missing_data' });

    await ensureChatImagesBucket();

    // Verification
    const authHeader = String(req.headers.authorization || '');
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
    const { data: authData, error: authError } = await supabaseAdmin.auth.getUser(token);
    if (authError || !authData?.user?.id) return res.status(401).json({ error: 'unauthorized' });

    const userId = authData.user.id;
    const { bucket, path } = await uploadToBucket(file, userId, conversationId);

    return res.json({ bucket, path });
  } catch (err) {
    console.error('Upload Error:', err);
    res.status(500).json({ error: 'upload_failed' });
  }
});

// -------------------- HEALTH CHECK ROUTE --------------------
app.get('/ping', (req, res) => {
  res.status(200).send("OK");
});

// Catch-all to serve React app (only if dist exists)
app.use((req, res, next) => {
  const indexPath = path.join(__dirname, 'dist', 'index.html');
  res.sendFile(indexPath, (err) => {
    if (err) {
      // If index.html is missing (e.g. dev mode without build), just return 404 for non-API routes
      if (req.path.startsWith('/api')) {
        next();
      } else {
        res.status(404).send('Not Found (and dist/index.html missing)');
      }
    }
  });
});

app.listen(PORT, () => {
  console.log(`✅ PashuAI server running at http://localhost:${PORT}`);

  // Health check ping every 14 minutes to keep Render instances awake
  const SELF_URL = process.env.SELF_URL || `http://localhost:${PORT}`;
  setInterval(async () => {
    try {
      await fetch(`${SELF_URL}/ping`);
      console.log("🔁 Health check ping sent:", new Date().toISOString());
    } catch (err) {
      console.error("❌ Health check failed:", err.message);
    }
  }, 14 * 60 * 1000);
});
