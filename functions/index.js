// 수풀AI Firebase Functions — Claude API 서버 프록시 (API 키 브라우저 노출 방지)
'use strict';

const functions = require('firebase-functions');
const admin = require('firebase-admin');
const cors = require('cors');
const Anthropic = require('@anthropic-ai/sdk');

admin.initializeApp();
const db = admin.firestore();

// CORS: GitHub Pages 도메인만 허용
const corsHandler = cors({
  origin: [
    'https://jinwooshoon-coder.github.io',
    'https://yeon-life.github.io',
    'https://y-life.kr',
    'http://localhost:3000',
    'http://127.0.0.1:3000'
  ],
  methods: ['POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type']
});

// ── 일일 사용 한도 ──────────────────────────────
const DAILY_LIMIT_STUDENT = 20;
const DAILY_LIMIT_TEACHER = 100;

// ── 모델 분기 (비용 최적화) ──────────────────────
// Haiku  : 단순 작업 (힌트, 쉽게, 퀴즈, 채점)   → 약 5원/회
// Sonnet : 추론/설명 (단계, 개념, 그림, 유사, 가르치기, 워크시트, 사진) → 약 22원/회
// Opus   : 사용 금지 (비용 110원/회, 특수 요청 시에만 명시적으로 지정)
const MODEL_HAIKU  = 'claude-haiku-4-5-20251001';
const MODEL_SONNET = 'claude-sonnet-4-6';
const HAIKU_TYPES  = ['hint', 'easier', 'quiz', 'answer_check'];

function selectModel(model, htype) {
  if (model) return model;
  return HAIKU_TYPES.includes(htype) ? MODEL_HAIKU : MODEL_SONNET;
}

// ── Claude 클라이언트 ───────────────────────────
function getClient() {
  const apiKey = process.env.ANTHROPIC_API_KEY
    || (functions.config().anthropic && functions.config().anthropic.key);
  if (!apiKey) throw new Error('서버 API 키 미설정 — Firebase 환경변수를 확인하세요');
  return new Anthropic({ apiKey });
}

// ── 학급 코드 검증 ──────────────────────────────
async function verifyClassCode(classCode) {
  if (!classCode) return false;
  try {
    const snap = await db.doc('config/settings').get();
    if (!snap.exists) return false;
    return snap.data().classCode === classCode;
  } catch (e) {
    console.error('학급 코드 검증 오류:', e);
    return false;
  }
}

// ── 일일 사용량 확인 및 차감 (트랜잭션) ──────────
async function checkAndDecrementUsage(studentName, isTeacher) {
  const today = new Date().toISOString().slice(0, 10);
  const safeKey = (studentName || '_teacher').replace(/[^a-zA-Z0-9가-힣_-]/g, '_');
  const usageRef = db.doc(`usage/${today}/users/${safeKey}`);
  const limit = isTeacher ? DAILY_LIMIT_TEACHER : DAILY_LIMIT_STUDENT;

  return db.runTransaction(async (tx) => {
    const snap = await tx.get(usageRef);
    const current = snap.exists ? (snap.data().count || 0) : 0;
    if (current >= limit) {
      throw new Error(`오늘 사용 한도(${limit}회)를 다 썼어요. 내일 다시 도전해봐요! 🌙`);
    }
    tx.set(usageRef, {
      count: current + 1,
      isTeacher: !!isTeacher,
      lastUsed: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });
    return { count: current + 1, remaining: limit - current - 1 };
  });
}

// ── 사용 로그 기록 ──────────────────────────────
async function saveLog({ classCode, studentName, isTeacher, grade, problem, htype, model, usage }) {
  try {
    await db.collection('logs').add({
      classCode: classCode || null,
      studentName: studentName || null,
      isTeacher: !!isTeacher,
      grade: grade || null,
      problem: problem ? String(problem).slice(0, 100) : null,
      htype: htype || null,
      model: model || MODEL_HAIKU,
      inputTokens: usage?.input_tokens || 0,
      outputTokens: usage?.output_tokens || 0,
      savedAt: admin.firestore.FieldValue.serverTimestamp()
    });
  } catch (e) {
    console.warn('로그 저장 실패:', e.message);
  }
}

// ══════════════════════════════════════════════════
// callClaudeAPI — 메인 엔드포인트
// ══════════════════════════════════════════════════
exports.callClaudeAPI = functions
  .region('asia-northeast3')
  .runWith({ timeoutSeconds: 60, memory: '256MB' })
  .https.onRequest((req, res) => {
    corsHandler(req, res, async () => {
      if (req.method === 'OPTIONS') return res.status(204).send('');
      if (req.method !== 'POST') return res.status(405).json({ error: '허용되지 않는 방법' });

      const { classCode, studentName, isTeacher, grade, problem, htype,
              systemPrompt, userContent, model, maxTokens } = req.body;

      const valid = await verifyClassCode(classCode);
      if (!valid) return res.status(403).json({
        error: '학급 코드가 올바르지 않아요. 선생님께 코드를 다시 받으세요 🔒'
      });

      let usageInfo;
      try {
        usageInfo = await checkAndDecrementUsage(studentName, isTeacher);
      } catch (e) {
        return res.status(429).json({ error: e.message });
      }

      const chosenModel = selectModel(model, htype);

      try {
        const client = getClient();
        const response = await client.messages.create({
          model: chosenModel,
          max_tokens: maxTokens || 2800,
          system: systemPrompt || '',
          messages: [{ role: 'user', content: userContent }]
        });

        await saveLog({ classCode, studentName, isTeacher, grade, problem, htype,
                        model: chosenModel, usage: response.usage });

        return res.json({
          content: response.content[0].text,
          usage: response.usage,
          remaining: usageInfo.remaining,
          model: chosenModel
        });
      } catch (e) {
        console.error('Claude API 오류:', e.message);
        const msg = e.message.includes('API 키')
          ? '서버 설정 오류 — 관리자에게 문의하세요'
          : '잠시 오류가 났어요. 다시 시도해봐요! 🔄';
        return res.status(500).json({ error: msg });
      }
    });
  });

// ══════════════════════════════════════════════════
// setApiKey — 관리자 전용
// ══════════════════════════════════════════════════
exports.setApiKey = functions
  .region('asia-northeast3')
  .https.onRequest((req, res) => {
    corsHandler(req, res, async () => {
      if (req.method !== 'POST') return res.status(405).json({ error: '허용되지 않는 방법' });
      const { adminCode, apiKey, classCode } = req.body;
      if (!adminCode || !apiKey) return res.status(400).json({ error: '관리자 코드와 API 키가 필요합니다' });
      try {
        const snap = await db.doc('config/settings').get();
        const storedAdmin = snap.exists ? snap.data().adminCode : null;
        if (storedAdmin && storedAdmin !== adminCode) return res.status(403).json({ error: '관리자 코드가 틀렸어요 🔒' });
        await db.doc('config/teacher').set({ apiKey, updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
        const settingsUpdate = { adminCode, updatedAt: admin.firestore.FieldValue.serverTimestamp() };
        if (classCode) settingsUpdate.classCode = classCode;
        await db.doc('config/settings').set(settingsUpdate, { merge: true });
        return res.json({ success: true, message: '설정이 서버에 저장됐어요 ✅' });
      } catch (e) {
        return res.status(500).json({ error: '저장 중 오류: ' + e.message });
      }
    });
  });

// ══════════════════════════════════════════════════
// getUsageStats — 선생님용 사용량 조회
// ══════════════════════════════════════════════════
exports.getUsageStats = functions
  .region('asia-northeast3')
  .https.onRequest((req, res) => {
    corsHandler(req, res, async () => {
      if (req.method !== 'POST') return res.status(405).json({ error: '허용되지 않는 방법' });
      const { classCode, days = 7 } = req.body;
      const valid = await verifyClassCode(classCode);
      if (!valid) return res.status(403).json({ error: '학급 코드 불일치' });
      try {
        const results = [];
        for (let i = 0; i < Math.min(days, 30); i++) {
          const d = new Date(); d.setDate(d.getDate() - i);
          const dateStr = d.toISOString().slice(0, 10);
          const snap = await db.collection(`usage/${dateStr}/users`).get();
          let total = 0; const students = [];
          snap.forEach(doc => {
            const data = doc.data();
            total += data.count || 0;
            students.push({ name: doc.id, count: data.count || 0, isTeacher: data.isTeacher });
          });
          results.push({ date: dateStr, total, students });
        }
        return res.json({ stats: results });
      } catch (e) {
        return res.status(500).json({ error: e.message });
      }
    });
  });

// ══════════════════════════════════════════════════
// 학생 PIN 시스템
// ══════════════════════════════════════════════════

// 6자리 PIN 생성
function generatePin() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

// 이름 → Firestore 키 (공백 제거, 정규화)
function safeStudentKey(name) {
  return (name || '').trim().replace(/\s+/g, '_');
}

// 학생 PIN 내부 검증
async function verifyStudentPinInternal(classCode, studentName, pin) {
  if (!classCode || !studentName || !pin) return null;
  try {
    const safeName = safeStudentKey(studentName);
    const snap = await db.doc(`students/${classCode}/list/${safeName}`).get();
    if (!snap.exists) return null;
    const data = snap.data();
    if (data.active === false) return null;
    if (data.pin !== String(pin)) return null;
    return data; // { pin, grade, active, createdAt }
  } catch (e) {
    console.error('학생 PIN 검증 오류:', e);
    return null;
  }
}

// ── verifyStudentPin — 학생 로그인 검증 ──────────
exports.verifyStudentPin = functions
  .region('asia-northeast3')
  .runWith({ timeoutSeconds: 30, memory: '256MB' })
  .https.onRequest((req, res) => {
    corsHandler(req, res, async () => {
      if (req.method === 'OPTIONS') return res.status(204).send('');
      if (req.method !== 'POST') return res.status(405).json({ error: '허용되지 않는 방법' });

      const { classCode, studentName, pin } = req.body;

      // 학급 코드 먼저 확인
      const codeOk = await verifyClassCode(classCode);
      if (!codeOk) return res.status(403).json({ valid: false, error: '학급 코드 오류' });

      const studentData = await verifyStudentPinInternal(classCode, studentName, pin);
      if (!studentData) return res.status(401).json({ valid: false });

      return res.json({ valid: true, grade: studentData.grade || 3 });
    });
  });

// ── registerStudentByTeacher — 선생님이 학생 등록 ─
exports.registerStudentByTeacher = functions
  .region('asia-northeast3')
  .runWith({ timeoutSeconds: 30, memory: '256MB' })
  .https.onRequest((req, res) => {
    corsHandler(req, res, async () => {
      if (req.method === 'OPTIONS') return res.status(204).send('');
      if (req.method !== 'POST') return res.status(405).json({ error: '허용되지 않는 방법' });

      const { adminCode, classCode, studentName, grade } = req.body;
      if (!adminCode || !classCode || !studentName) {
        return res.status(400).json({ error: '필수 값 누락' });
      }

      // 관리자 코드 검증
      try {
        const snap = await db.doc('config/settings').get();
        const storedAdmin = snap.exists ? snap.data().adminCode : null;
        if (storedAdmin && storedAdmin !== adminCode) {
          return res.status(403).json({ error: '관리자 코드가 틀렸어요 🔒' });
        }

        const pin = generatePin();
        const safeName = safeStudentKey(studentName);

        await db.doc(`students/${classCode}/list/${safeName}`).set({
          name: studentName,
          pin,
          grade: Number(grade) || 3,
          active: true,
          createdAt: admin.firestore.FieldValue.serverTimestamp()
        });

        return res.json({ success: true, studentName, pin, grade: Number(grade) || 3 });
      } catch (e) {
        console.error('학생 등록 오류:', e);
        return res.status(500).json({ error: '등록 중 오류: ' + e.message });
      }
    });
  });

// ── listStudents — 선생님용 학생 목록 조회 ────────
exports.listStudents = functions
  .region('asia-northeast3')
  .runWith({ timeoutSeconds: 30, memory: '256MB' })
  .https.onRequest((req, res) => {
    corsHandler(req, res, async () => {
      if (req.method === 'OPTIONS') return res.status(204).send('');
      if (req.method !== 'POST') return res.status(405).json({ error: '허용되지 않는 방법' });

      const { adminCode, classCode } = req.body;

      try {
        const snap = await db.doc('config/settings').get();
        const storedAdmin = snap.exists ? snap.data().adminCode : null;
        if (storedAdmin && storedAdmin !== adminCode) {
          return res.status(403).json({ error: '관리자 코드가 틀렸어요 🔒' });
        }

        const listSnap = await db.collection(`students/${classCode}/list`).get();
        const students = [];
        listSnap.forEach(doc => {
          const d = doc.data();
          students.push({ name: d.name, pin: d.pin, grade: d.grade, active: d.active !== false });
        });
        students.sort((a, b) => (a.grade - b.grade) || a.name.localeCompare(b.name));
        return res.json({ students });
      } catch (e) {
        return res.status(500).json({ error: e.message });
      }
    });
  });

// ── resetStudentPin — PIN 초기화 ──────────────────
exports.resetStudentPin = functions
  .region('asia-northeast3')
  .runWith({ timeoutSeconds: 30, memory: '256MB' })
  .https.onRequest((req, res) => {
    corsHandler(req, res, async () => {
      if (req.method === 'OPTIONS') return res.status(204).send('');
      if (req.method !== 'POST') return res.status(405).json({ error: '허용되지 않는 방법' });

      const { adminCode, classCode, studentName } = req.body;

      try {
        const snap = await db.doc('config/settings').get();
        const storedAdmin = snap.exists ? snap.data().adminCode : null;
        if (storedAdmin && storedAdmin !== adminCode) {
          return res.status(403).json({ error: '관리자 코드가 틀렸어요 🔒' });
        }

        const newPin = generatePin();
        const safeName = safeStudentKey(studentName);
        await db.doc(`students/${classCode}/list/${safeName}`).update({
          pin: newPin,
          updatedAt: admin.firestore.FieldValue.serverTimestamp()
        });

        return res.json({ success: true, studentName, pin: newPin });
      } catch (e) {
        return res.status(500).json({ error: e.message });
      }
    });
  });
