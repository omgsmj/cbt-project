// 1. 필수 라이브러리 로드
const { GoogleGenAI } = require('@google/genai');
const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');
const path = require('path'); 
const multer = require('multer');
require('dotenv').config(); // .env 파일의 보안 정보 로드

const app = express();
const PORT = process.env.PORT || 3000;

// 2. 미들웨어 설정 (서버 통신 규격 세팅)
app.use(cors()); // 프론트엔드 브라우저의 CORS 차단 정책 해제
app.use(express.json()); // 브라우저가 보낸 JSON 데이터를 자바스크립트 객체로 파싱
app.use(express.static(__dirname)); // 서버가 현재 폴더에 있는 HTML 파일들을 브라우저에 직접 보내주도록 설정

// 3. PostgreSQL 데이터베이스 연결 설정 (커넥션 풀 생성)
const pool = new Pool({
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    host: process.env.DB_HOST,
    port: process.env.DB_PORT,
    database: process.env.DB_DATABASE
});

// 🔒 [보안 추가] 파일 업로드 제약 및 확장자 필터링 설정 (최대 15MB)
const upload = multer({ 
    storage: multer.memoryStorage(),
    limits: { fileSize: 15 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
        if (file.mimetype !== 'application/pdf') {
            return cb(new Error('오직 PDF 확장자 파일만 진입할 수 있습니다.'), false);
        }
        cb(null, true);
    }
});

// 라우팅 - 메인 화면 경로
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// ----------------------------------------------------
// [API 1] 기출문제 조회 통로 (GET /api/questions?session=1)
// ----------------------------------------------------
app.get('/api/questions', async (req, res) => {
    const sessionNum = req.query.session; // URL 뒤에 붙은 ?session=1 번호 추출
    
    if(!sessionNum) {
        return res.status(400).json({ error: "회차 번호(session)가 누적되지 않았습니다." });
    }

    try {
        const result = await pool.query(
            'SELECT id, session, number, subject, question, options, answer FROM questions WHERE session = $1 ORDER BY number ASC',
            [sessionNum]
        );
        res.json(result.rows); 
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: "데이터베이스 조회 중 오류가 발생했습니다." });
    }
});

// ----------------------------------------------------
// [API 1-2] 회차별 + 과목별 복합 필터링 기출 조회 통로
// ----------------------------------------------------
app.get('/api/questions/subject', async (req, res) => {
    let { subject, session } = req.query; 
    
    // 💡 [버그 수정] 프론트엔드가 전송하는 4과목 'pro' 규격을 DB용 한글 과목명으로 정적 매핑 교정
    if (subject === "pro") {
        subject = "프로그래밍언어활용";
    }

    try {
        let result;
        if (session) {
            result = await pool.query(
                'SELECT * FROM questions WHERE subject = $1 AND session = $2 ORDER BY number ASC',
                [subject, session]
            );
        } else {
            result = await pool.query(
                'SELECT * FROM questions WHERE subject = $1 ORDER BY session ASC, number ASC',
                [subject]
            );
        }
        res.json(result.rows);
    } catch (err) {
        console.error("과목/회차 필터링 조회 원격 트랜잭션 오류:", err);
        res.status(500).json({ error: "데이터베이스 조회 실패" });
    }
});

// ----------------------------------------------------
// [API 2] 모의고사 결과 제출 및 오답 저장 통로 (POST /api/results)
// ----------------------------------------------------
app.post('/api/results', async (req, res) => {
    const { folderName, examTitle, score, result, wrongQuestions } = req.body;
    const client = await pool.connect();
    try {
        await client.query('BEGIN'); 

        const historyResult = await client.query(
            'INSERT INTO exam_histories (folder_name, exam_title, score, result) VALUES ($1, $2, $3, $4) RETURNING id',
            [folderName, examTitle, score, result]
        );
        const newHistoryId = historyResult.rows[0].id; 

        if (wrongQuestions && wrongQuestions.length > 0) {
            for (let q of wrongQuestions) {
                const qSelect = await client.query(
                    'SELECT id FROM questions WHERE session = $1 AND number = $2',
                    [q.session, q.number]
                );
                
                if(qSelect.rows.length > 0) {
                    const originalQuestionId = qSelect.rows[0].id;
                    await client.query(
                        'INSERT INTO wrong_answers (history_id, question_id, user_answer) VALUES ($1, $2, $3)',
                        [newHistoryId, originalQuestionId, q.userAnswer]
                    );
                }
            }
        }

        await client.query('COMMIT'); 
        res.json({ success: true, message: "시험 결과 및 오답노트가 안전하게 DB에 보관되었습니다." });

    } catch (err) {
        await client.query('ROLLBACK'); 
        console.error(err);
        res.status(500).json({ error: "채점 데이터 저장 중 트랜잭션 에러가 발생하여 취소되었습니다." });
    } finally {
        client.release(); 
    }
});

// ----------------------------------------------------
// [API 3] 폴더별 오답노트 목록 통합 조회 통로 (GET /api/histories)
// ----------------------------------------------------
app.get('/api/histories', async (req, res) => {
    try {
        const sql = `
            SELECT 
                eh.id AS history_id, eh.folder_name, eh.exam_title, eh.score, eh.result,
                wa.user_answer,
                q.session, q.number, q.subject, q.question, q.options, q.answer AS correct_answer,
                q.explanation
            FROM exam_histories eh
            LEFT JOIN wrong_answers wa ON eh.id = wa.history_id
            LEFT JOIN questions q ON wa.question_id = q.id
            ORDER BY eh.created_at DESC, q.number ASC
        `;
        const result = await pool.query(sql);
        
        const historiesMap = {};
        result.rows.forEach(row => {
            if (!historiesMap[row.history_id]) {
                historiesMap[row.history_id] = {
                    id: row.history_id,
                    folderName: row.folder_name,
                    examTitle: row.exam_title,
                    score: row.score,
                    result: row.result,
                    questions: []
                };
            }
            if (row.number) {
                historiesMap[row.history_id].questions.push({
                    session: row.session,
                    number: row.number,
                    subject: row.subject,
                    question: row.question,
                    options: row.options,
                    answer: row.correct_answer,
                    userAnswer: row.user_answer,
                    explanation: row.explanation 
                });
            }
        });

        res.json(Object.values(historiesMap));

    } catch (err) {
        console.error("오답노트 목록 원격 조인 트랜잭션 오류:", err);
        res.status(500).json({ error: "오답노트 기록 로드 중 에러 발생" });
    }
});

// ----------------------------------------------------
// [API 4] 오답노트 폴더 통째로 직접 삭제 통로 (DELETE /api/histories/:id)
// ----------------------------------------------------
app.delete('/api/histories/:id', async (req, res) => {
    const historyId = req.params.id; 
    try {
        await pool.query('DELETE FROM exam_histories WHERE id = $1', [historyId]);
        res.json({ success: true, message: "해당 회차 폴더와 오답 목록이 DB에서 영구 삭제되었습니다." });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: "폴더 삭제 작업 수행 중 에러 발생" });
    }
});

// ----------------------------------------------------
// [API 5] AI 실시간 족집게 해설 요청 통로 (POST /api/explain-ai)
// ----------------------------------------------------
app.post('/api/explain-ai', async (req, res) => {
    const { question, options, subject, number } = req.body;
    
    if (!process.env.GEMINI_API_KEY) {
        return res.status(500).json({ error: "서버에 GEMINI_API_KEY 환경변수가 설정되지 않았습니다." });
    }

    try {
        const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
        
        const prompt = `
            너는 정보처리기사 필기 시험을 완벽하게 마스터한 전문 컴퓨터공학 교수이자 친절한 멘토야.
            사용자가 틀린 아래 문제를 분석하고, 각 보기(①, ②, ③, ④)가 왜 정답이고 왜 오답인지 명쾌하게 설명해줘.
            
            [과목] ${subject}
            [문제 번호] ${number}번
            [문제 내용] ${question}
            [지문 보기]
            1. ${options[0]}
            2. ${options[1]}
            3. ${options[2]}
            4. ${options[3]}
            
            요구사항:
            - 너무 기계적이거나 상투적인 서두는 생략하고 본론만 핵심을 짚어줘.
            - 마크다운 문법을 적절히 활용해서 가독성 좋게 단락을 나누어 작성해줘.
        `;

        const response = await ai.models.generateContent({
            model: 'gemini-2.5-flash',
            contents: prompt,
        });

        res.json({ explanation: response.text });
    } catch (err) {
        console.error("Gemini 원격 연동 트랜잭션 오류:", err);
        res.status(500).json({ error: "AI 해설 생성 중 서버 에러가 발생했습니다." });
    }
});

// ----------------------------------------------------
// 🚀 [API 6] 안전한 스마트 PDF 업로드 및 토큰 트래커 연동 엔진
// ----------------------------------------------------
app.post('/api/upload-pdf', upload.single('pdfFile'), async (req, res) => {
    const { adminPassword, sessionName } = req.body;
    
    // 🔑 보안 필터링
    if (adminPassword !== "ShinPass2026") { 
        return res.status(403).json({ error: "접근 권한이 없습니다. 마스터 비밀번호가 올바르지 않습니다." });
    }
    if (!sessionName || sessionName.trim() === "") {
        return res.status(400).json({ error: "모의고사 회차 명칭이 누락되었습니다." });
    }
    if (!process.env.GEMINI_API_KEY) {
        return res.status(500).json({ error: "Gemini API 키가 설정되지 않았습니다." });
    }

    try {
        if (!req.file) return res.status(400).json({ error: "업로드된 PDF 파일이 없습니다." });

        // 💡 [원인 전면 차단] 상단 전역 스코프 참조를 끊고 가동 시점에 모듈을 인라인으로 직접 바인딩하여 실행
        const pdfParserEngine = require('pdf-parse');
        const pdfData = await pdfParserEngine(req.file.buffer);
        const rawText = pdfData.text.trim();

        if (!rawText || rawText.length < 150) {
            return res.status(400).json({ error: "PDF 내부 문자를 추출할 수 없습니다. 스캔본 이미지인지 확인하세요." });
        }

        // Gemini JSON 규격 스키마 정의
        const responseSchema = {
            type: "ARRAY",
            description: "추출 및 요약 가공된 정보처리기사 필기 기출문제 리스트 데이터셋",
            items: {
                type: "OBJECT",
                properties: {
                    number: { type: "INTEGER", description: "문제 번호 (1~100)" },
                    subject: { type: "STRING", description: "해당 문제의 과목명" },
                    question: { type: "STRING", description: "기출문제 질문 내용" },
                    options: { 
                        type: "ARRAY", 
                        items: { type: "STRING" }, 
                        description: "기호를 제외한 순수 보기 문장 4개" 
                    },
                    answer: { type: "STRING", description: "정답 인덱스 숫자 번호 (1, 2, 3, 4 중 하나)" },
                    explanation: { type: "STRING", description: "문제를 풀기 위한 명쾌한 해설" }
                },
                required: ["number", "subject", "question", "options", "answer", "explanation"]
            }
        };

        const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
        const prompt = `
            다음은 정보처리기사 기출문제집 PDF에서 스크래핑한 텍스트 원본이야.
            이 데이터를 분석하여 모든 문항을 빠짐없이 스키마 규격에 맞는 깔끔한 JSON 배열로 반환해줘.
            오답 지문까지 파고드는 친절한 해설(explanation)을 풍부하게 생성해줘.

            [추출된 텍스트]
            ${rawText}
        `;

        const aiResponse = await ai.models.generateContent({
            model: 'gemini-2.5-flash',
            contents: prompt,
            config: {
                responseMimeType: "application/json",
                responseSchema: responseSchema,
            }
        });

        const parsedQuestions = JSON.parse(aiResponse.text);

        // PostgreSQL 트랜잭션 주입 (ON CONFLICT Upsert 처리 포함)
        for (let q of parsedQuestions) {
            await pool.query(
                `INSERT INTO questions (session, number, subject, question, options, answer, explanation)
                 VALUES ($1, $2, $3, $4, $5, $6, $7)
                 ON CONFLICT (session, number) DO UPDATE 
                 SET subject = EXCLUDED.subject, question = EXCLUDED.question, options = EXCLUDED.options, answer = EXCLUDED.answer, explanation = EXCLUDED.explanation`,
                [sessionName, q.number, q.subject, q.question, q.options, q.answer, q.explanation]
            );
        }

        // 토큰 소비 영수증 데이터 조립
        const tokenUsage = {
            promptTokens: aiResponse.usageMetadata?.promptTokenCount || 0,
            completionTokens: aiResponse.usageMetadata?.candidatesTokenCount || 0,
            totalTokens: aiResponse.usageMetadata?.totalTokenCount || 0
        };

        res.json({ 
            success: true, 
            count: parsedQuestions.length, 
            sessionInserted: sessionName,
            tokenUsage: tokenUsage 
        });

    } catch (err) {
        console.error("스마트 PDF 업로드 파이프라인 상세 에러 로그:", err);
        
        let errorMessage = err.message || "알 수 없는 시스템 장애";
        
        if (err.status === 429 || errorMessage.includes("Quota")) {
            errorMessage = "🤖 AI 무료 토큰 사용량이 분당/일일 제한에 도달했습니다. 잠시 후 다시 시도해 주세요.";
        } else if (err instanceof SyntaxError) {
            errorMessage = "❌ AI 응답 데이터의 JSON 파싱 실패 (AI가 한도를 초과하여 데이터를 중간에 잘라 먹었을 확률이 높습니다. PDF 분량을 한 과목씩 쪼개서 업로드해 보세요.)";
        } else if (errorMessage.includes("INSERT") || errorMessage.includes("column")) {
            errorMessage = `📊 PostgreSQL DB 적재 실패 (원인: ${errorMessage})`;
        }

        res.status(500).json({ error: errorMessage });
    }
});

// ----------------------------------------------------
// 4. 서버 바인딩 가동 (무조건 소스 코드의 최하단에 위치)
// ----------------------------------------------------
app.listen(PORT, () => {
    console.log(`====================================================`);
    console.log(`🎯 CBT Back-End Server가 http://localhost:${PORT} 에서 활성화되었습니다.`);
    console.log(`====================================================`);
});